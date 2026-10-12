import plistlib,pathlib,json,subprocess,select,os,signal,struct,hashlib,shutil
r=pathlib.Path.home()/'Library/Application Support/RemoteLab/Feishu Native Trial';app=r/'Feishu Native Trial.app';binary=app/'Contents/MacOS/Feishu';s=json.loads((r/'native-asset-status.json').read_text())
assert not app.is_symlink() and plistlib.loads((app/'Contents/Info.plist').read_bytes())['CFBundleIdentifier']=='dev.remotelab.feishu-native-trial'
assert all(not p.get('open') and not p.get('previewing') and not p.get('workspace',{}).get('visible') for p in s['pages']),'A person is using enhanced settings; preserve their work'
rows=subprocess.check_output(['/bin/ps','-axo','pid=,comm='],text=True).splitlines();assert not any(str(app) in x and 'Iron.app' in x for x in rows),'Trial meeting active'
pids=[int(x.strip().split(None,1)[0]) for x in rows if x.strip().split(None,1)[1]==str(binary)]
a=app/'Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar';b=a.read_bytes();previous=json.loads((r/'native-v8-deployment.json').read_text());assert hashlib.sha256(b).hexdigest()==previous['archiveAfterSha256']
for pid in pids:
 q=select.kqueue();q.control([select.kevent(pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],0,0);os.kill(pid,signal.SIGTERM);assert q.control([],1,10);q.close()
# A topic reopened after launch can restore a durable editor draft. Graceful
# shutdown lets Feishu flush its existing store; clone the isolated profile
# before replacing assets. No draft is cleared or sent.
if any(p.get('hasDraft') for p in s['pages']):
 profile=pathlib.Path.home()/'Library/Application Support/RlfeTrial'
 assert profile.is_dir() and not profile.is_symlink(),'Unknown isolated profile'
 snapshot=r/('profile-before-update-'+str(os.getpid()))
 try:subprocess.run(['/bin/cp','-cR',str(profile),str(snapshot)],check=True,capture_output=True,timeout=90)
 except Exception:
  exec((r/'launch_web_replica.py').read_text());raise
 snapshot.chmod(0o700)
 print(json.dumps({'isolatedProfileSnapshot':snapshot.name,'isolatedProfileSnapshotPresent':snapshot.is_dir()}),flush=True)
cmd=subprocess.run(['ps','-p',str(s['pid']),'-o','command='],capture_output=True,text=True).stdout
if str(r/'native_asset_bridge.cjs') in cmd:
 try:os.kill(s['pid'],signal.SIGTERM)
 except ProcessLookupError:pass
loader=(r/'v8-build/runtime-template.js').read_text();m=json.loads((r/'v8-build/source-manifest.json').read_text());assert hashlib.sha256(loader.encode()).hexdigest()==m['runtimeSha256'];loader=loader.replace('__CAPABILITY__',json.dumps((r/'native-asset-capability').read_text().strip()))
(r/'native-asset-runtime.js').write_text(loader);(r/'native-asset-runtime.js').chmod(0o600)
_,n,_,l=struct.unpack('<4I',b[:16]);h=json.loads(b[16:16+l]);body=bytearray(b[8+n:]);h['files']['remotelab-native-v7.js']={'size':len(loader.encode()),'offset':str(len(body))};body.extend(loader.encode());hb=json.dumps(h,ensure_ascii=False,separators=(',',':')).encode();hp=struct.pack('<I',len(hb))+hb;hp+=b'\0'*((-len(hp))%4);pick=struct.pack('<I',len(hp))+hp;packed=struct.pack('<II',4,len(pick))+pick+body;a.write_bytes(packed)
shutil.copy2(r/'v8-build/native_asset_bridge.cjs',r/'native_asset_bridge.cjs')
shutil.copy2(r/'v8-build/live-source.cjs',r/'live-source.cjs')
for target in [app/'Contents/Frameworks/Lark Framework.framework',app]:
 q=subprocess.run(['/usr/bin/codesign','--force','--sign','-','--preserve-metadata=entitlements',str(target)],capture_output=True,text=True,timeout=60);assert q.returncode==0,q.stderr
subprocess.run(['/usr/bin/codesign','--verify','--strict','--deep',str(app)],check=True,capture_output=True,timeout=60)
m.update({'archiveBeforeSha256':previous['archiveBeforeSha256'],'archiveAfterSha256':hashlib.sha256(packed).hexdigest(),'strictSignatureValid':True,'backup':previous['backup']});(r/'native-v8-deployment.json').write_text(json.dumps(m,indent=2));print(json.dumps({'updated':True,'webVersion':m['webVersion'],'runtimeSha256':m['runtimeSha256']}))
exec((r/'launch_web_replica.py').read_text())
