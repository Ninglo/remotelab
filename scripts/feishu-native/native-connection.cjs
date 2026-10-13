const origin='http://127.0.0.1:19342';
const specs={settings:['messageConnection','fwset'],workspace:['workspaceConnection','fwspace'],topics:['topicConnection','fwtops']};
const key=(kind,account)=>'feishuWebExplore.'+specs[kind][0]+'.v1:'+encodeURIComponent(origin+':'+account);
function valid(kind,g,account){return g&&g.origin===origin&&g.nativeAccount===account&&Number.isFinite(g.expiresAt)&&g.expiresAt>Date.now()&&new RegExp('^'+specs[kind][1]+'_[\\w-]{43}$').test(g.token||'')&&typeof g.person?.id==='string'&&!!g.person.id;}
function validateBundle(data,p){
 if(data?.type!=='remotelab:feishu-native-connected'||data.state!==p.state||data.origin!==origin||data.nativeAccount!==p.account||!data.grants||Object.keys(data.grants).length!==3)throw Error('账号连接信息不匹配');
 const values={};let person;
 for(const kind of Object.keys(specs)){const g=data.grants[kind];if(!valid(kind,g,p.account)||kind==='topics'&&g.topicReadAck!==true||person&&person!==g.person.id)throw Error('账号连接信息不匹配');person=g.person.id;values[key(kind,p.account)]={...g,type:'remotelab:feishu-'+kind+'-connected',state:p.state};}
 return values;
}
function reusable(storage,account){const grants={};let person;for(const kind of Object.keys(specs)){const g=storage[key(kind,account)];if(!valid(kind,g,account)||kind==='topics'&&g.topicReadAck!==true||person&&person!==g.person.id)return null;person=g.person.id;grants[kind]=g;}return grants;}
module.exports={key,validateBundle,reusable};
