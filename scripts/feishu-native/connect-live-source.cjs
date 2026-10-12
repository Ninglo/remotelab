// Restore only the pre-existing, same-account Mac Web Live read-only source.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {browserAccount}=require('./live-source.cjs');
(async()=>{
 const root=path.join(os.homedir(),'Library/Application Support/RemoteLab/Feishu Native Trial');
 const cap=fs.readFileSync(path.join(root,'native-asset-capability'),'utf8').trim();
 const response=await fetch('http://127.0.0.1:19342/status',{headers:{Authorization:'Bearer '+cap},signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('原生增强服务未连接');
 const status=await response.json(),accounts=new Set(status.pages.map(p=>p.account));
 const account=await browserAccount();
 if(!/^\d{10,30}$/.test(account)||accounts.size!==1||!accounts.has(account))throw Error('原生与已授权来源账号不一致');
 const file=path.join(root,'native-source-account.json');
 if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8')).account!==account)throw Error('已记录来源账号变化，需重新核对原授权');
 fs.writeFileSync(file,JSON.stringify({account,origin:'https://qcnatfwzm13g.feishu.cn',evidence:'Web Live account equals current native Passport account'}),{mode:0o600});
 console.log('Existing Web Live source account matches the native account. No personal grant was created.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
