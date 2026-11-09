import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {handleOrganizationWork} from '../chat/router-organization-work.mjs';
import {memberRouteAllowed} from '../chat/session-access.mjs';
const id='work_'+ 'a'.repeat(24);
test('T12 scoped detail: anonymous, cross-session denied, valid owner, GET only and XSS escaped',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'org-detail-')),file=path.join(dir,id+'.json');await fs.writeFile(file,JSON.stringify({workId:id,title:'<script>private</script>',goal:'PRIVATE GOAL',sessions:[{id:'s1'},{id:'s2'}],sourceRefs:[{sessionId:'s3',seq:7}]}));
 async function call(actor,allowed,method='GET'){const res={writeHead(code,headers){this.code=code;this.headers=headers},end(body){this.body=body}};await handleOrganizationWork({req:{url:'/api/monitoring/organization-work?id='+id,method},res,pathname:'/api/monitoring/organization-work',authSession:actor,canRead:async(a,s)=>allowed.includes(s),configOverride:{organizationRecordsDir:dir}});return res}
 assert.equal((await call(null,[])).code,401);const denied=await call({personId:'p'},['s1']);assert.equal(denied.code,404);assert.equal(denied.body.includes('PRIVATE'),false);assert.equal((await call({personId:'p'},['s1','s2'])).code,404);const ok=await call({personId:'p'},['s1','s2','s3']);assert.equal(ok.code,200);assert.ok(ok.body.includes('&lt;script&gt;'));assert.ok(!ok.body.includes('<script>'));assert.equal((await call({personId:'p'},['s1','s2'],'POST')).code,405);assert.ok(memberRouteAllowed('GET','/api/monitoring/organization-work','p'));assert.equal(memberRouteAllowed('POST','/api/monitoring/organization-work','p'),false);await fs.rm(dir,{recursive:true});
});
