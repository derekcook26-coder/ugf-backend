"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { validGymMasterIdentity } = require("./gymmaster-member-authorization");
const { memberAccessDependencyUnavailable } = require("./gymmaster-gatekeeper-membership");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  runBoundedPostgresTransaction,
} = require("./bounded-postgres-transaction");

const MEMBER_TODAY_FLAG = "GOALS_COACH_MEMBER_TODAY_ENABLED";
const CONSENT_VERSION = "GC-MEMBER-COACHING-CONSENT-1";
const SAFETY_VERSION = "GC-MEMBER-SAFETY-NOTICE-2";
const MAX_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[1-9]\d{0,18}$/;
const GUIDANCE = Object.freeze({
  URGENT_STOP: "Stop now and seek immediate emergency help.",
  MEDICAL_REVIEW_REQUIRED: "Stop this session and contact an appropriate qualified healthcare professional.",
  MODIFICATION_REQUIRED: "Use comfortable, pain-free movement; reduce intensity or range, and stop if symptoms increase.",
});
function enabled(value) { return value === "true"; }
function error(statusCode, code) { const e = new Error(code); e.statusCode = statusCode; e.code = code; e.exposeMessage = false; return e; }
function exact(value) { return value && typeof value === "object" && !Array.isArray(value); }
function parse(body) {
  if (!exact(body) || Object.keys(body).some((key) => !["clientRequestId", "continuation"].includes(key)) || !UUID.test(body.clientRequestId)) throw error(400, "MEMBER_TODAY_INVALID");
  if (body.continuation === undefined) return { clientRequestId: body.clientRequestId };
  const c = body.continuation;
  if (!exact(c) || Object.keys(c).some((key) => !["attemptId", "optionId"].includes(key)) || !UUID.test(c.attemptId) || typeof c.optionId !== "string" || !/^option-[1-9]\d{0,2}$/.test(c.optionId)) throw error(400, "MEMBER_TODAY_INVALID");
  return { clientRequestId: body.clientRequestId, continuation: { attemptId: c.attemptId, optionId: c.optionId } };
}
function hash(input) { return crypto.createHash("sha256").update(JSON.stringify(input.continuation || {})).digest("hex"); }
function authError() { return error(401, "MEMBER_AUTHENTICATION_REQUIRED"); }
function responseFrom(row, item) {
  const out = { state: row.state_code };
  if (row.state_code === "URGENT_STOP" || row.state_code === "MEDICAL_REVIEW_REQUIRED") out.guidance = GUIDANCE[row.state_code];
  if (row.state_code === "QUESTION_REQUIRED") { out.attemptId = row.client_request_id; out.question = { id: "TODAY_PLAN_ITEM", prompt: "Which planned item are you ready to start?", options: row.options }; if (row.safety_outcome === "MODIFICATION_REQUIRED") out.safetyConstraint = GUIDANCE.MODIFICATION_REQUIRED; }
  if (row.state_code === "READY") { out.action = { planId: String(row.plan_id), planVersion: new Date(row.plan_version).toISOString(), itemId: String(row.plan_item_id), name: item.exercise_name, prescription: item.prescription_json }; if (row.safety_outcome === "MODIFICATION_REQUIRED") out.safetyConstraint = GUIDANCE.MODIFICATION_REQUIRED; }
  return out;
}
async function decide(client, memberId, mappingId, identity, input) {
  const requestHash = hash(input);
  const mapping = await client.query("SELECT id FROM goals_coach_member_auth_mappings WHERE id=$1 AND member_id=$2 AND auth_provider=$3 AND auth_subject=$4 AND active=TRUE FOR UPDATE",[mappingId,memberId,identity.authProvider,identity.authSubject]);
  if (!mapping.rows.length) throw authError();
  const safety=(await client.query("SELECT outcome FROM goals_coach_member_safety_intake_v2_assessments WHERE member_id=$1 AND notice_version=$2 AND valid_until>NOW() ORDER BY submitted_at DESC,id DESC LIMIT 1",[memberId,SAFETY_VERSION])).rows[0];
  const replay = await client.query("SELECT * FROM goals_coach_member_today_attempts WHERE member_id=$1 AND client_request_id=$2", [memberId,input.clientRequestId]);
  if (replay.rows.length) {
    if (safety && ["URGENT_STOP","MEDICAL_REVIEW_REQUIRED"].includes(safety.outcome)) return { body:responseFrom({state_code:safety.outcome}),replay:true };
    if (replay.rows[0].request_hash !== requestHash) throw error(409,"MEMBER_TODAY_IDEMPOTENCY_CONFLICT");
    let row=replay.rows[0];
    if (["READY","QUESTION_REQUIRED"].includes(row.state_code)) {
      if (!safety) return { body:responseFrom({state_code:"SAFETY_REQUIRED"}),replay:true };
      const consent=(await client.query("SELECT 1 FROM goals_coach_member_coaching_consents WHERE member_id=$1 AND notice_version=$2 AND status='accepted'",[memberId,CONSENT_VERSION])).rows[0];
      if (!consent) return { body:responseFrom({state_code:"CONSENT_REQUIRED"}),replay:true };
      const latestPlan=(await client.query("SELECT id,created_at FROM coach_plans WHERE member_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[memberId])).rows[0];
      if (!latestPlan || String(row.plan_id)!==String(latestPlan.id) || new Date(row.plan_version).getTime()!==new Date(latestPlan.created_at).getTime()) return { body:responseFrom({state_code:"UNAVAILABLE"}),replay:true };
      row={...row,safety_outcome:safety.outcome};
    }
    let item = null; if (row.plan_item_id) item=(await client.query("SELECT exercise_name,prescription_json FROM coach_plan_exercises WHERE id=$1 AND plan_id=$2",[row.plan_item_id,row.plan_id])).rows[0];
    let options=[]; if(row.state_code==="QUESTION_REQUIRED"){const associations=row.option_item_ids||{};const itemIds=(row.option_ids||[]).map((id)=>associations[id]).filter(Boolean);const items=(await client.query("SELECT id,exercise_name FROM coach_plan_exercises WHERE plan_id=$1 AND id=ANY($2::bigint[])",[row.plan_id,itemIds])).rows;const labels=new Map(items.map((entry)=>[String(entry.id),entry.exercise_name]));options=(row.option_ids||[]).map((id)=>({id,label:labels.get(String(associations[id]))})).filter((entry)=>entry.label);}
    return { body: responseFrom({...row,options},item), replay:true };
  }
  let state, plan=null, item=null, options=[], optionItemIds={}, original=null;
  if (!safety) state="SAFETY_REQUIRED";
  else if (["URGENT_STOP","MEDICAL_REVIEW_REQUIRED"].includes(safety.outcome)) state=safety.outcome;
  else {
    const consent=(await client.query("SELECT 1 FROM goals_coach_member_coaching_consents WHERE member_id=$1 AND notice_version=$2 AND status='accepted'",[memberId,CONSENT_VERSION])).rows[0];
    if (!consent) state="CONSENT_REQUIRED";
    else {
      plan=(await client.query("SELECT id,created_at FROM coach_plans WHERE member_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[memberId])).rows[0];
      if (!plan) { state="UNAVAILABLE"; }
      else if (input.continuation) {
        original=(await client.query("SELECT * FROM goals_coach_member_today_attempts WHERE member_id=$1 AND client_request_id=$2 AND state_code='QUESTION_REQUIRED' FOR UPDATE",[memberId,input.continuation.attemptId])).rows[0];
        const selectedItemId=original&&original.option_item_ids&&original.option_item_ids[input.continuation.optionId];
        if (!original || original.consumed_at || String(original.plan_id)!==String(plan.id) || new Date(original.plan_version).getTime()!==new Date(plan.created_at).getTime() || !(original.option_ids||[]).includes(input.continuation.optionId) || !selectedItemId) throw error(409,"MEMBER_TODAY_CONTINUATION_CONFLICT");
        item=(await client.query("SELECT id,exercise_name,prescription_json,sequence_number FROM coach_plan_exercises WHERE id=$1 AND plan_id=$2",[selectedItemId,original.plan_id])).rows[0]; if (!item) throw error(409,"MEMBER_TODAY_CONTINUATION_CONFLICT"); state="READY";
        await client.query("UPDATE goals_coach_member_today_attempts SET consumed_at=NOW() WHERE id=$1 AND consumed_at IS NULL",[original.id]);
      } else {
        const items=(await client.query("SELECT id,exercise_name,prescription_json,sequence_number FROM coach_plan_exercises WHERE plan_id=$1 AND status='active' AND intent_validation_status='validated' ORDER BY sequence_number,id",[plan.id])).rows;
        if (!items.length) { state="UNAVAILABLE"; plan=null; }
        else if (items.length===1) { state="READY"; item=items[0]; }
        else { state="QUESTION_REQUIRED"; options=items.slice(0,20).map((entry,index)=>({ id:`option-${index+1}`, label:entry.exercise_name })); optionItemIds=Object.fromEntries(options.map((entry,index)=>[entry.id,String(items[index].id)])); }
      }
    }
  }
  const inserted=(await client.query("INSERT INTO goals_coach_member_today_attempts(member_id,auth_mapping_id,client_request_id,request_hash,original_attempt_id,state_code,safety_outcome,plan_id,plan_version,plan_item_id,option_ids,option_item_ids,selected_option_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",[memberId,mappingId,input.clientRequestId,requestHash,original&&original.id,state,safety&&safety.outcome,plan&&plan.id,plan&&plan.created_at,item&&item.id,JSON.stringify(options.map((entry)=>entry.id)),JSON.stringify(optionItemIds),input.continuation&&input.continuation.optionId])).rows[0];
  inserted.options=options; return { body:responseFrom(inserted,item),replay:false };
}
async function execute(db, identity, authorization, input) {
  if (!validGymMasterIdentity(identity) || !authorization || authorization.active!==true || !ID.test(String(authorization.memberId)) || !ID.test(String(authorization.mappingId))) throw authError();
  const started=monotonicNow();
  try {
    const result=await runBoundedPostgresTransaction({pool:db,outerDeadlineNs:deadlineAfter(started,5000),phaseMilliseconds:5000,terminalState:createTerminalState(),work:(client)=>decide(client,String(authorization.memberId),String(authorization.mappingId),identity,input)});
    return result.value;
  } catch(e) {
    if(e&&e.code==="work_failed"&&e.cause)throw e.cause;
    throw e;
  }
}
function createRateLimit(){return rateLimit({windowMs:15*60*1000,max:30,standardHeaders:true,legacyHeaders:false,keyGenerator:(req)=>`member:${req.alphaMemberIdentity.authSubject}`,handler:(_req,res)=>res.status(429).json({error:"RATE_LIMITED"})});}
function createRouter(options={}) {
  const {db,authenticateSession,authorizeIdentity,origin}=options; if(!db||typeof db.connect!=="function"||typeof authenticateSession!=="function"||typeof authorizeIdentity!=="function"||!origin) throw new Error("Member today dependencies are incomplete");
  const router=express.Router(), limiter=options.rateLimit||createRateLimit(), parser=express.json({inflate:false,limit:MAX_BYTES,strict:true});
  router.post("/",(req,res,next)=>{res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");if(req.headers.origin!==origin)return res.status(403).json({error:"MEMBER_ORIGIN_NOT_ALLOWED"});return authenticateSession(req,res,next);},limiter,(req,res,next)=>{if(Object.keys(req.query).length||req.headers["content-type"]!=="application/json")return next(error(400,"MEMBER_TODAY_INVALID"));return parser(req,res,next);},async(req,res,next)=>{try{const authorization=await authorizeIdentity(req.alphaMemberIdentity);if(memberAccessDependencyUnavailable(authorization))return res.status(503).json({error:"MEMBER_TODAY_UNAVAILABLE"});if(!authorization.active)throw authError();req.todayAuthorization=authorization;next();}catch(e){if(e.statusCode)return next(e);return res.status(503).json({error:"MEMBER_TODAY_UNAVAILABLE"});}},async(req,res,next)=>{try{const result=await execute(db,req.alphaMemberIdentity,req.todayAuthorization,parse(req.body));return res.status(200).json({...result.body,idempotentReplay:result.replay});}catch(e){return next(e);}});
  return router;
}
module.exports={CONSENT_VERSION,GUIDANCE,MAX_BYTES,MEMBER_TODAY_FLAG,SAFETY_VERSION,createRouter,enabled,execute,hash,parse};
