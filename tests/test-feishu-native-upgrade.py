"""Exercise upgrade failure boundaries without touching a real App or profile."""
import sys
import hashlib,importlib.util,json,pathlib,plistlib,struct,tempfile,unittest.mock as mock,shutil,subprocess
source=pathlib.Path(__file__).resolve().parents[1]/'scripts/feishu-native/upgrade-preview.py'
sys.path.insert(0,str(source.parent))
spec=importlib.util.spec_from_file_location('upgrade',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
body=b'old-runtimeKEEP'
header={'files':{'remotelab-native-v7.js':{'size':11,'offset':'0'},'untouched':{'size':4,'offset':'11'}}}
raw=json.dumps(header).encode();hp=struct.pack('<I',len(raw))+raw;hp+=b'\0'*(-len(hp)%4);pick=struct.pack('<I',len(hp))+hp
original=struct.pack('<II',4,len(pick))+pick+body
def read_entry(data,name):
 _,n,_,l=struct.unpack('<4I',data[:16]);e=json.loads(data[16:16+l])['files'][name];start=8+n+int(e['offset']);return data[start:start+e['size']]
updated=m.replace_runtime(original,b'new-runtime')
assert read_entry(updated,'untouched')==b'KEEP'
assert read_entry(updated,'remotelab-native-v7.js')==b'new-runtime'
with tempfile.TemporaryDirectory() as temp:
 home=pathlib.Path(temp);root=home/'root';root.mkdir();package=home/'package';build=package/'v8-build';build.mkdir(parents=True)
 app=root/'Feishu Native Trial.app';archive=app/'Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar';archive.parent.mkdir(parents=True);archive.write_bytes(original)
 (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'dev.remotelab.feishu-native-trial'}))
 sha=lambda b:hashlib.sha256(b).hexdigest()
 (root/'native-v8-deployment.json').write_text(json.dumps({'revision':9,'archiveBeforeSha256':'source','archiveAfterSha256':sha(original)}))
 (root/'install-receipt.json').write_text('{"version":"8.1.17"}')
 (root/'native-asset-capability').write_text('private-fixture')
 (root/'native-v8-storage.json').write_text('preserved settings')
 (build/'runtime-template.js').write_text('new-runtime')
 (build/'source-manifest.json').write_text(json.dumps({'revision':10,'runtimeSha256':sha(b'new-runtime')}))
 for name in ['native_asset_bridge.cjs','live-source.cjs','topic-source.cjs']:
  (build/name).write_text('new');(root/name).write_text('old')
 (package/'observe_native_app.py').write_text('new')
 shutil.copy2(source.parent/'RemoteLabEnhanced.icns', package/'RemoteLabEnhanced.icns')
 baseline={p.name:p.read_bytes() for p in root.iterdir() if p.is_file()}
 copy=shutil.copy2
 def fake_run(args,**kwargs):
  if args[:2]==['/bin/cp','-cR']:shutil.copytree(args[2],args[3])
  return subprocess.CompletedProcess(args,0)
 def fail_copy(src,dst,*args,**kwargs):
  if pathlib.Path(src)==build/'live-source.cjs':raise OSError('injected disk failure')
  return copy(src,dst,*args,**kwargs)
 with mock.patch('subprocess.check_output',return_value=''),mock.patch('subprocess.run',side_effect=fake_run),mock.patch('shutil.copy2',side_effect=fail_copy):
  try:m.upgrade(root,package,home,'/runtime/node');raise AssertionError('expected failure')
  except OSError as e:assert 'injected' in str(e)
 assert archive.read_bytes()==original
 assert baseline=={p.name:p.read_bytes() for p in root.iterdir() if p.is_file()}
 print('Upgrade preserves unrelated archive entries and restores old App/helper/receipts after interrupted replacement')
