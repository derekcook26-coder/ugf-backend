"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const test=require("node:test");
const {GUIDANCE,MEMBER_TODAY_FLAG,enabled,hash,parse}=require("../src/goals-coach/gymmaster-member-today");
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
