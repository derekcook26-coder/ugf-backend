"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const test=require("node:test");
const {GUIDANCE,MEMBER_TODAY_FLAG,enabled,execute,hash,parse}=require("../src/goals-coach/gymmaster-member-today");
const {createGymMasterMemberTodayStartup}=require("../src/goals-coach/gymmaster-member-today-startup");
const {createApplicationJsonParser}=require("../src/goals-coach/transcription-route");
const {goalsCoachErrorHandler}=require("../src/goals-coach/http-error-handler");
function database(query){return {async connect(){return {query(sql,params){if(String(sql).includes("set_config('lock_timeout'"))return Promise.resolve({rows:[]});return query(sql,params);},release(){}};}};}
const identity={authProvider:"gymmaster",authSubject:"gymmaster:10482"},authorization={active:true,memberId:"1",mappingId:"2"};

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
test("application JSON parser leaves the today body for its authenticated route parser",()=>{
  const parser=createApplicationJsonParser();
  for(const originalUrl of ["/goalscoach/member/today","/goalscoach/member/today/"]){
    let continued=false;
    parser({method:"POST",originalUrl,headers:{}},{},()=>{continued=true;});
    assert.equal(continued,true,originalUrl);
  }
});
test("member today parser errors are concealed for both accepted path forms",()=>{
  for(const path of ["/goalscoach/member/today","/goalscoach/member/today/"]){
    let result;
    const res={headers:{},setHeader(name,value){this.headers[name]=value;},status(status){result={status};return this;},json(body){result.body=body;return this;}};
    goalsCoachErrorHandler(Object.assign(new Error("body parser detail"),{type:"entity.parse.failed"}),{path},res,()=>assert.fail("error should be handled"));
    assert.deepEqual(result,{status:400,body:{error:"MEMBER_TODAY_INVALID"}}); assert.equal(res.headers["Cache-Control"],"no-store");
  }
});
test("every replay applies current mandatory safety-stop guidance",async(t)=>{
  const input={clientRequestId:"00000000-0000-4000-8000-000000000007"};
  for(const state of ["SAFETY_REQUIRED","CONSENT_REQUIRED","UNAVAILABLE"]){
    for(const safety of ["URGENT_STOP","MEDICAL_REVIEW_REQUIRED"])await t.test(`${state} replay with ${safety}`,async()=>{
      let downstreamQueries=0;
      const db=database(async(sql)=>{
        if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
        if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
        if(sql.includes("safety_intake_v2"))return {rows:[{outcome:safety}]};
        if(sql.includes("member_today_attempts WHERE"))return {rows:[{state_code:state,request_hash:hash(input)}]};
        downstreamQueries++;
        assert.fail(`unexpected query: ${sql}`);
      });
      assert.deepEqual(await execute(db,identity,authorization,input),{body:{state:safety,guidance:GUIDANCE[safety]},replay:true});
      assert.equal(downstreamQueries,0);
    });
  }
});
test("READY replay applies expired and newer safety outcomes before returning an action",async(t)=>{
  const cases=[
    {name:"expired assessment",safety:null,body:{state:"SAFETY_REQUIRED"}},
    {name:"new urgent stop",safety:"URGENT_STOP",body:{state:"URGENT_STOP",guidance:GUIDANCE.URGENT_STOP}},
    {name:"new medical review",safety:"MEDICAL_REVIEW_REQUIRED",body:{state:"MEDICAL_REVIEW_REQUIRED",guidance:GUIDANCE.MEDICAL_REVIEW_REQUIRED}},
    {name:"new modification",safety:"MODIFICATION_REQUIRED",body:{state:"READY",action:{planId:"10",planVersion:"2026-01-01T00:00:00.000Z",itemId:"20",name:"Original choice",prescription:{reps:8}},safetyConstraint:GUIDANCE.MODIFICATION_REQUIRED}},
  ];
  for(const entry of cases)await t.test(entry.name,async()=>{
    const input={clientRequestId:"00000000-0000-4000-8000-000000000003"}; let itemQueries=0;
    const db=database(async(sql)=>{
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
      if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
      if(sql.includes("safety_intake_v2"))return {rows:entry.safety?[{outcome:entry.safety}]:[]};
      if(sql.includes("member_today_attempts WHERE"))return {rows:[{state_code:"READY",request_hash:hash(input),plan_id:"10",plan_version:new Date("2026-01-01T00:00:00.000Z"),plan_item_id:"20",safety_outcome:"SCREEN_COMPLETE"}]};
      if(sql.includes("coaching_consents"))return {rows:[{}]};
      if(sql.includes("FROM coach_plans"))return {rows:[{id:"10",created_at:new Date("2026-01-01T00:00:00.000Z")}]};
      if(sql.includes("FROM coach_plan_exercises")){itemQueries++;return {rows:[{exercise_name:"Original choice",prescription_json:{reps:8}}]};}
      assert.fail(`unexpected query: ${sql}`);
    });
    const result=await execute(db,identity,authorization,input);
    assert.deepEqual(result,{body:entry.body,replay:true}); assert.equal(itemQueries,entry.safety==="MODIFICATION_REQUIRED"?1:0);
  });
});
test("plan-guidance replays apply current safety and consent before disclosure",async(t)=>{
  const input={clientRequestId:"00000000-0000-4000-8000-000000000006"};
  const cases=[
    {name:"question replay with expired safety",state:"QUESTION_REQUIRED",safety:null,consent:true,body:{state:"SAFETY_REQUIRED"}},
    {name:"question replay with urgent stop",state:"QUESTION_REQUIRED",safety:"URGENT_STOP",consent:true,body:{state:"URGENT_STOP",guidance:GUIDANCE.URGENT_STOP}},
    {name:"question replay after consent withdrawal",state:"QUESTION_REQUIRED",safety:"SCREEN_COMPLETE",consent:false,body:{state:"CONSENT_REQUIRED"}},
    {name:"ready replay after consent withdrawal",state:"READY",safety:"SCREEN_COMPLETE",consent:false,body:{state:"CONSENT_REQUIRED"}},
    {name:"question replay with modification",state:"QUESTION_REQUIRED",safety:"MODIFICATION_REQUIRED",consent:true,body:{state:"QUESTION_REQUIRED",attemptId:input.clientRequestId,question:{id:"TODAY_PLAN_ITEM",prompt:"Which planned item are you ready to start?",options:[{id:"option-1",label:"Original choice"}]},safetyConstraint:GUIDANCE.MODIFICATION_REQUIRED}},
  ];
  for(const entry of cases)await t.test(entry.name,async()=>{
    let planQueries=0;
    const db=database(async(sql)=>{
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
      if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
      if(sql.includes("safety_intake_v2"))return {rows:entry.safety?[{outcome:entry.safety}]:[]};
      if(sql.includes("member_today_attempts WHERE"))return {rows:[{state_code:entry.state,client_request_id:input.clientRequestId,request_hash:hash(input),plan_id:"10",plan_version:new Date("2026-01-01T00:00:00.000Z"),plan_item_id:entry.state==="READY"?"20":null,option_ids:["option-1"],option_item_ids:{"option-1":"20"}}]};
      if(sql.includes("coaching_consents"))return {rows:entry.consent?[{}]:[]};
      if(sql.includes("FROM coach_plans"))return {rows:[{id:"10",created_at:new Date("2026-01-01T00:00:00.000Z")}]};
      if(sql.includes("FROM coach_plan_exercises")){planQueries++;return {rows:[entry.state==="READY"?{exercise_name:"Original choice",prescription_json:{reps:8}}:{id:"20",exercise_name:"Original choice"}]};}
      assert.fail(`unexpected query: ${sql}`);
    });
    assert.deepEqual(await execute(db,identity,authorization,input),{body:entry.body,replay:true});
    assert.equal(planQueries,entry.safety==="MODIFICATION_REQUIRED"?1:0);
  });
});
test("plan-guidance replays fail closed when the stored plan is no longer latest",async(t)=>{
  const input={clientRequestId:"00000000-0000-4000-8000-000000000016"};
  const cases=[
    {name:"ready replay after a newer plan",state:"READY",latest:{id:"11",created_at:new Date("2026-02-01T00:00:00.000Z")}},
    {name:"question replay after the plan version changes",state:"QUESTION_REQUIRED",latest:{id:"10",created_at:new Date("2026-02-01T00:00:00.000Z")}},
    {name:"ready replay after plans become unavailable",state:"READY",latest:null},
  ];
  for(const entry of cases)await t.test(entry.name,async()=>{
    let itemQueries=0;
    const db=database(async(sql)=>{
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
      if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
      if(sql.includes("safety_intake_v2"))return {rows:[{outcome:"SCREEN_COMPLETE"}]};
      if(sql.includes("member_today_attempts WHERE"))return {rows:[{state_code:entry.state,client_request_id:input.clientRequestId,request_hash:hash(input),plan_id:"10",plan_version:new Date("2026-01-01T00:00:00.000Z"),plan_item_id:entry.state==="READY"?"20":null,option_ids:["option-1"],option_item_ids:{"option-1":"20"}}]};
      if(sql.includes("coaching_consents"))return {rows:[{}]};
      if(sql.includes("FROM coach_plans"))return {rows:entry.latest?[entry.latest]:[]};
      if(sql.includes("FROM coach_plan_exercises")){itemQueries++;return {rows:[]};}
      assert.fail(`unexpected query: ${sql}`);
    });
    assert.deepEqual(await execute(db,identity,authorization,input),{body:{state:"UNAVAILABLE"},replay:true});
    assert.equal(itemQueries,0);
  });
});
test("continuation keeps the originally offered item after retirement, insertion, and reordering",async()=>{
  const attemptId="00000000-0000-4000-8000-000000000004",input={clientRequestId:"00000000-0000-4000-8000-000000000005",continuation:{attemptId,optionId:"option-1"}};
  const plan={id:"10",created_at:new Date("2026-01-01T00:00:00.000Z")}; let selectedQuery;
  const db=database(async(sql,params)=>{
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
    if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
    if(sql.includes("safety_intake_v2"))return {rows:[{outcome:"SCREEN_COMPLETE"}]};
    if(sql.includes("member_today_attempts WHERE member_id=$1 AND client_request_id=$2")&&!sql.includes("state_code"))return {rows:[]};
    if(sql.includes("coaching_consents"))return {rows:[{}]};
    if(sql.includes("FROM coach_plans"))return {rows:[plan]};
    if(sql.includes("status='active'"))return {rows:[{id:"77",exercise_name:"Inserted item",prescription_json:{reps:5},sequence_number:1},{id:"88",exercise_name:"Reordered item",prescription_json:{reps:6},sequence_number:2}]};
    if(sql.includes("state_code='QUESTION_REQUIRED'"))return {rows:[{id:"30",plan_id:"10",plan_version:plan.created_at,option_ids:["option-1"],option_item_ids:{"option-1":"99"}}]};
    if(sql.includes("FROM coach_plan_exercises WHERE id=$1")){selectedQuery=params;return {rows:[{id:"99",exercise_name:"Original choice",prescription_json:{reps:8},sequence_number:2}]};}
    if(sql.startsWith("UPDATE goals_coach_member_today_attempts"))return {rows:[]};
    if(sql.startsWith("INSERT INTO goals_coach_member_today_attempts"))return {rows:[{state_code:"READY",safety_outcome:"SCREEN_COMPLETE",plan_id:"10",plan_version:plan.created_at,plan_item_id:"99"}]};
    assert.fail(`unexpected query: ${sql}`);
  });
  const result=await execute(db,identity,authorization,input);
  assert.deepEqual(selectedQuery,["99","10"]); assert.equal(result.body.action.itemId,"99"); assert.equal(result.body.action.name,"Original choice");
});
test("continuation keeps the original choice when every active item was retired",async()=>{
  const attemptId="00000000-0000-4000-8000-000000000014",input={clientRequestId:"00000000-0000-4000-8000-000000000015",continuation:{attemptId,optionId:"option-1"}};
  const plan={id:"10",created_at:new Date("2026-01-01T00:00:00.000Z")}; let activeItemsQueried=false;
  const db=database(async(sql)=>{
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
    if(sql.includes("auth_mappings"))return {rows:[{id:"2"}]};
    if(sql.includes("safety_intake_v2"))return {rows:[{outcome:"SCREEN_COMPLETE"}]};
    if(sql.includes("member_today_attempts WHERE member_id=$1 AND client_request_id=$2")&&!sql.includes("state_code"))return {rows:[]};
    if(sql.includes("coaching_consents"))return {rows:[{}]};
    if(sql.includes("FROM coach_plans"))return {rows:[plan]};
    if(sql.includes("status='active'")){activeItemsQueried=true;return {rows:[]};}
    if(sql.includes("state_code='QUESTION_REQUIRED'"))return {rows:[{id:"30",plan_id:"10",plan_version:plan.created_at,option_ids:["option-1"],option_item_ids:{"option-1":"99"}}]};
    if(sql.includes("FROM coach_plan_exercises WHERE id=$1"))return {rows:[{id:"99",exercise_name:"Retired original choice",prescription_json:{reps:8}}]};
    if(sql.startsWith("UPDATE goals_coach_member_today_attempts"))return {rows:[]};
    if(sql.startsWith("INSERT INTO goals_coach_member_today_attempts"))return {rows:[{state_code:"READY",safety_outcome:"SCREEN_COMPLETE",plan_id:"10",plan_version:plan.created_at,plan_item_id:"99"}]};
    assert.fail(`unexpected query: ${sql}`);
  });
  const result=await execute(db,identity,authorization,input);
  assert.equal(activeItemsQueried,false); assert.equal(result.body.state,"READY"); assert.equal(result.body.action.itemId,"99");
});
