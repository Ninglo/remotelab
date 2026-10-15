import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'routing-roster-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  const { GROUP_ROUTING_PILOT_FILE } = await import('../lib/group-routing-pilot.mjs');
  const { personalRoutingCardView } = await import('../connectors/feishu/personal-routing-card.mjs');
  const { buildGroupConfigurationCard } = await import('../connectors/feishu/group-configuration-card.mjs');
  const { createParticipationController } = await import('../connectors/feishu/participation-state.mjs');
  await updateAuthDocument(doc => {
    doc.people = ['enabled', 'disabled', 'foreign'].map(name => ({id:name,name,credentials:[],
      identities:[{id:`id_${name}`,kind:'feishu',realm:name==='foreign'?'other':'bot',subjectId:name}],
      preferences:{messageReplies:{version:1,revision:1,active:{version:3,scope:'person',personId:name,routing:name==='disabled'?'none':'experimental'}}}}));
    doc.primaryPersonId='enabled';
  });
  const source={sourceRouteId:'bot',chatId:'chat',tenantKey:'tenant'};
  const conversation={connector:'feishu',sourceRouteId:'bot',target:source};
  const config={version:2,enabled:true,personalOptIn:true,publicRoster:true,groups:[{...source,folder:home}]};
  await writeFile(GROUP_ROUTING_PILOT_FILE,JSON.stringify(config));
  let view=await personalRoutingCardView(conversation);
  assert.deepEqual(view.enabledNames,['enabled']);
  const card=buildGroupConfigurationCard({key:'key',mode:'active'}, {routingTrial:view});
  const content=JSON.stringify(card);
  assert.match(content,/信息分流机制/);
  assert.match(content,/试点已开启/);
  assert.doesNotMatch(content,/个人分流与并行试用/);
  assert.ok(card.body.elements.some(e=>e.tag==='collapsible_panel'&&e.expanded===false));
  await updateAuthDocument(doc=>{doc.people.find(p=>p.id==='enabled').preferences.messageReplies.active.routing='none';});
  assert.deepEqual((await personalRoutingCardView(conversation)).enabledNames,[]);
  await writeFile(GROUP_ROUTING_PILOT_FILE,JSON.stringify({...config,publicRoster:false}));
  assert.equal((await personalRoutingCardView(conversation)).enabledNames,undefined,'no roster without explicit publication setting');
  assert.equal(await personalRoutingCardView({...conversation,target:{...source,chatId:'outside'}}),null);
  let creates=0,patches=0,pins=0;
  const controller=createParticipationController({config:{sourceRouteId:'bot',storageDir:home},appClient:{im:{v1:{
    message:{create:async()=>{creates++;throw Error('must not send');},patch:async()=>{patches++;return{code:0};}},
    chatTopNotice:{putTopNotice:async()=>{pins++;return{code:0};}},
  }}}});
  const record={key:'a'.repeat(24),source,mode:'active'};
  await controller.publish(record,{existingOnly:true});
  assert.equal(creates,0,'missing original card is not silently replaced');
  await controller.publish({...record,cardMessageId:'old',cardCreatedAt:1,pinPending:true},{existingOnly:true});
  assert.equal(patches,1,'even aged cards use patch only');
  assert.equal(creates,0);assert.equal(pins,0,'no extra message or top-notice update');
  console.log('Public routing roster: explicit scope, personal state, removal, compact copy and patch-only refresh passed');
} finally {await rm(home,{recursive:true,force:true});}
