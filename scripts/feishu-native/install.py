"""Run on the Mac after placing a verified build at ROOT/v8-build.
Only the existing independent trial copy is modified. The official App is read-only.
"""
import pathlib,json,struct,hashlib,subprocess,shutil,os,signal,select,plistlib
r=pathlib.Path.home()/'Library/Application Support/RemoteLab/Feishu Native Trial'
app=r/'Feishu Native Trial.app';binary=app/'Contents/MacOS/Feishu'
assert not app.is_symlink() and plistlib.loads((app/'Contents/Info.plist').read_bytes()).get('CFBundleIdentifier')=='dev.remotelab.feishu-native-trial','Refusing to modify a different application'
rows=subprocess.check_output(['/bin/ps','-axo','pid=,comm='],text=True).splitlines()
active=[x for x in rows if str(app) in x]
assert not active,'Trial app is running; preserve current editor and meeting, exit it before installing'
a=app/'Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar'
b=a.read_bytes();current=hashlib.sha256(b).hexdigest()
previous=json.loads((r/'native-asset-deployment.json').read_text())
assert current==previous['archiveAfterSha256'],'Trial resources changed since the verified baseline'
backup=r/'before-native-v8';backup.mkdir(exist_ok=True)
assert not (backup/'messenger.asar').exists(),'Existing v8 backup requires explicit inspection, not overwrite'
shutil.copy2(a,backup/'messenger.asar')
for name in ['native_asset_bridge.cjs','native_asset_loader.js','native-asset-runtime.js','web-display-choice.json','native-asset-deployment.json','launch_web_replica.py']:
 if (r/name).exists():shutil.copy2(r/name,backup/name)
manifest=json.loads((r/'v8-build/source-manifest.json').read_text())
loader=(r/'v8-build/runtime-template.js').read_text()
assert hashlib.sha256(loader.encode()).hexdigest()==manifest['runtimeSha256']
loader=loader.replace('__CAPABILITY__',json.dumps((r/'native-asset-capability').read_text().strip()))
(r/'native-asset-runtime.js').write_text(loader);(r/'native-asset-runtime.js').chmod(0o600)
q=subprocess.run(['/usr/local/bin/node','--check',str(r/'native-asset-runtime.js')],capture_output=True,text=True);assert q.returncode==0,q.stderr
_,n,_,l=struct.unpack('<4I',b[:16]);h=json.loads(b[16:16+l]);body=bytearray(b[8+n:])
assert 'remotelab-native-v7.js' in h['files']
h['files']['remotelab-native-v7.js']={'size':len(loader.encode()),'offset':str(len(body))};body.extend(loader.encode())
hb=json.dumps(h,ensure_ascii=False,separators=(',',':')).encode();hp=struct.pack('<I',len(hb))+hb;hp+=b'\0'*((-len(hp))%4);pick=struct.pack('<I',len(hp))+hp;packed=struct.pack('<II',4,len(pick))+pick+body
# The loader reference is unchanged. Every pre-existing entry is untouched.
a.write_bytes(packed)
shutil.copy2(r/'v8-build/native_asset_bridge.cjs',r/'native_asset_bridge.cjs')
shutil.copy2(r/'v8-build/live-source.cjs',r/'live-source.cjs')
for target in [app/'Contents/Frameworks/Lark Framework.framework',app]:
 q=subprocess.run(['/usr/bin/codesign','--force','--sign','-','--preserve-metadata=entitlements',str(target)],capture_output=True,text=True,timeout=60);assert q.returncode==0,q.stderr
q=subprocess.run(['/usr/bin/codesign','--verify','--strict','--deep',str(app)],capture_output=True,text=True,timeout=60);assert q.returncode==0,q.stderr
manifest.update({'archiveBeforeSha256':current,'archiveAfterSha256':hashlib.sha256(packed).hexdigest(),'strictSignatureValid':True,'backup':str(backup)})
(r/'native-v8-deployment.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest))
