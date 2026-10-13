import assert from 'node:assert/strict';
import { projectResponseTiming, timingStats, summarizeResponseTiming } from '../chat/response-timing.mjs';
const start = Date.parse('2026-10-12T10:00:00Z');
const req = { requestId:'q', acceptedAt:start, settledAt:start+90000, options:{sourceContext:{connector:'feishu'}}, deliveries:[] };
const d = (kind, at, extra={}) => ({connector:'feishu',kind:'content',state:'delivered',surfaceKind:kind,deliveredAt:start+at,...extra});
const got = projectResponseTiming({...req,deliveries:[
  d('opening',1000,{kind:'session_entry'}), d('reply',2000,{state:'unknown'}), d('reply',3000,{publicationRequestId:'other'}),
  d('reply',-1), d('opening',4000), d('progress',5000), d('question',8000), d('final',95000),
]});
assert.deepEqual(got,{firstContentAt:start+4000,firstReplyAt:start+8000});
assert.equal(projectResponseTiming({...req,nativeDispatchRunId:'old'}),null);
for (const field of ['internalOperation','deliveryOnly','triggerId','scheduleId','automationTitle'])
  assert.equal(projectResponseTiming({...req,options:{...req.options,[field]:'set'}}),null);
assert.equal(projectResponseTiming({...req,options:{sourceContext:{connector:'email'}}}),null);
assert.deepEqual(projectResponseTiming(req),{firstContentAt:null,firstReplyAt:null});
assert.deepEqual(projectResponseTiming({...req,deliveries:[d('',10000,{createdAt:start+5000})]}),{firstContentAt:null,firstReplyAt:null});
assert.deepEqual(projectResponseTiming({...req,deliveries:[d('',91000,{createdAt:start+90000})]}),{firstContentAt:start+91000,firstReplyAt:start+91000});
assert.equal(projectResponseTiming({...req,deliveries:[d('reply',0)]}).firstReplyAt,start);
assert.deepEqual(timingStats([0,null,10,30,NaN,-1]),{count:3,mean:40/3,median:10,p95:30});
assert.equal(timingStats([20,0,10,30]).median,15);
assert.equal(timingStats([]).median,null);
const now=Date.parse('2026-10-13T12:00:00Z');
const samples=[{responseEligible:true,responseAt:start,metrics:{firstContentMs:4000,firstReplyMs:8000}},
 {responseEligible:true,responseAt:start+1,metrics:{firstContentMs:6000,firstReplyMs:null}},
 {responseEligible:false,responseAt:start+2,metrics:{firstContentMs:0,firstReplyMs:0}},
 {responseEligible:true,responseAt:now+1000,metrics:{firstContentMs:0,firstReplyMs:0}}];
const result=summarizeResponseTiming(samples,7,now);
assert.equal(result.eligible,2);assert.equal(result.firstContent.median,5000);assert.equal(result.firstReply.count,1);
assert.equal(result.days.at(-2).eligible,2);assert.equal(result.days.at(-1).firstContent.median,null);
assert.equal(summarizeResponseTiming(samples,1,now).eligible,0,'one UTC day excludes yesterday');
console.log('response timing: delivery role/scope, failed and foreign receipts, legacy finals, zero/unknown, quantiles and daily attribution passed');
