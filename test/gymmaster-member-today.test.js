"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const test=require("node:test");
const {GUIDANCE,MEMBER_TODAY_FLAG,decide,enabled,hash,parse}=require("../src/goals-coach/gymmaster-member-today");
const {createGymMasterMemberTodayStartup}=require("../src/goals-coach/gymmaster-member-today-startup");

test("member today flag is exact-string disabled and startup isolated",()=>{
  assert.equal(MEMBER_TODAY_FLAG,"GOALS_COACH_MEMBER_TODAY_ENABLED");
  assert.equal(enabled("true"),true); for(const value of [undefined,"false","TRUE"," true",true])assert.equal(enabled(value),false);
  let calls=0; const startup=createGymMasterMemberTodayStartup({environment:{GOALS_COACH_MEMBER_TODAY_ENABLED:"false"},db:{connect(){calls++;}},fetchImpl(){calls++;}});
  assert.equal(startup.status,"disabled"); assert.equal(startup.router,null); assert.equal(calls,0); assert.equal(startup.providerCallsPermitted,false);
  assert.match(fs.readFileSync(".env.example","utf8"),/^GOALS_COACH_MEMBER_TODAY_ENABLED=false$/m);
});
test("member today has strict privacy-safe initial and continuation contracts",()=>{
  const first=parse({clientRequestId:"00000000-0000-4000-8000-000000000001"}); assert.deepEqual(first,{clientRequestId:"00000000-0000-4000-8000-000000000001"});
  const next=parse({clientRequestId:"00000000-0000-4000-8000-000000000002",continuation:{attemptId:first.clientRequestId,optionId:"option-1"}}); assert.notEqual(hash(first),hash(next));
  for(const body of [{clientRequestId:first.clientRequestId,text:"pain"},{clientRequestId:"bad"},{clientRequestId:first.clientRequestId,continuation:{attemptId:first.clientRequestId,optionId:"other",answer:"text"}}])assert.throws(()=>parse(body),(error)=>error.code==="MEMBER_TODAY_INVALID");
});
test("member today uses fixed safety wording and imports no provider",()=>{
  assert.equal(GUIDANCE.MODIFICATION_REQUIRED,"Use comfortable, pain-free movement; reduce intensity or range, and stop if symptoms increase.");
  const source=fs.readFileSync("src/goals-coach/gymmaster-member-today.js","utf8")+fs.readFileSync("src/goals-coach/gymmaster-member-today-startup.js","utf8");
  assert.doesNotMatch(source,/require\(["'](?:openai|\.\/transcription-adapter|\.\/coaching-engine)["']\)/i);
});
test("READY replay is overridden by the member's current safety stop",async()=>{
  const input={clientRequestId:"00000000-0000-4000-8000-000000000003"};
  const client={async query(sql){
    if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
    if(sql.includes("safety_intake_v2"))return {rows:[{outcome:"URGENT_STOP"}]};
    if(sql.includes("member_today_attempts WHERE"))return {rows:[{state_code:"READY",request_hash:hash(input),plan_id:"10",plan_item_id:"20"}]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  const result=await decide(client,"1","2",{authProvider:"clerk",authSubject:"subject"},input);
  assert.deepEqual(result,{body:{state:"URGENT_STOP",guidance:GUIDANCE.URGENT_STOP},replay:true});
});
test("continuation resolves the item persisted for its option, not the current item position",async()=>{
  const attemptId="00000000-0000-4000-8000-000000000004",input={clientRequestId:"00000000-0000-4000-8000-000000000005",continuation:{attemptId,optionId:"option-1"}};
  const plan={id:"10",created_at:new Date("2026-01-01T00:00:00.000Z")}; let selectedQuery;
  const client={async query(sql,params){
    if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
    if(sql.includes("safety_intake_v2"))return {rows:[{outcome:"SCREEN_COMPLETE"}]};
    if(sql.includes("member_today_attempts WHERE member_id=$1 AND client_request_id=$2")&&!sql.includes("state_code"))return {rows:[]};
    if(sql.includes("coaching_consents"))return {rows:[{}]};
    if(sql.includes("FROM coach_plans"))return {rows:[plan]};
    if(sql.includes("status='active'"))return {rows:[{id:"77",exercise_name:"New first item",prescription_json:{reps:5},sequence_number:1}]};
    if(sql.includes("state_code='QUESTION_REQUIRED'"))return {rows:[{id:"30",plan_id:"10",plan_version:plan.created_at,option_ids:["option-1"],option_item_ids:{"option-1":"99"}}]};
    if(sql.includes("FROM coach_plan_exercises WHERE id=$1")){selectedQuery=params;return {rows:[{id:"99",exercise_name:"Original choice",prescription_json:{reps:8},sequence_number:2}]};}
    if(sql.startsWith("UPDATE goals_coach_member_today_attempts"))return {rows:[]};
    if(sql.startsWith("INSERT INTO goals_coach_member_today_attempts"))return {rows:[{state_code:"READY",safety_outcome:"SCREEN_COMPLETE",plan_id:"10",plan_version:plan.created_at,plan_item_id:"99"}]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  const result=await decide(client,"1","2",{authProvider:"clerk",authSubject:"subject"},input);
  assert.deepEqual(selectedQuery,["99","10"]); assert.equal(result.body.action.itemId,"99"); assert.equal(result.body.action.name,"Original choice");
});
