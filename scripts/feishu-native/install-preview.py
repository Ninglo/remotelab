"""First install only: clone a supported official App, never reuse its profile."""
import hashlib,json,mmap,os,pathlib,plistlib,shutil,subprocess,time,platform,sys,socket,argparse
from archive_patch import patch_archive
package=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--check',action='store_true')
parser.add_argument('--source',type=pathlib.Path,default=pathlib.Path('/Applications/Lark.app'))
parser.add_argument('--test-home',type=pathlib.Path)
args=parser.parse_args()
src=args.source
home=args.test_home or pathlib.Path.home()
if platform.system()!='Darwin' or platform.machine()!='arm64':
 raise SystemExit('此试装包仅支持 Apple 芯片 Mac，请勿在 Intel 或 Rosetta 终端安装。')
if not src.is_dir():raise SystemExit('请先正常安装飞书到 /Applications/Lark.app。')
manifest_src=src/'Contents/Frameworks/Lark Framework.framework/Resources/manifest.json'
version=json.loads(manifest_src.read_text()).get('appVersion')
if version!='8.1.17':raise SystemExit('当前飞书版本 '+str(version)+'；此试装包只适配 8.1.17，未修改任何文件。请把版本号发回原话题。')
if not (src/'Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar').is_file():raise SystemExit('飞书内部构建不同，停止安装。')
expected_archive='ee29206c3e424adced06ea95533e46e7f52c5e28f41a380e1d430b670c83a80a'
source_archive=src/'Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar'
if hashlib.sha256(source_archive.read_bytes()).hexdigest()!=expected_archive:raise SystemExit('8.1.17 内部资源与已核版本不同，未修改任何文件。请反馈版本与安装来源。')
subprocess.run(['/usr/bin/codesign','--verify','--strict','--deep',str(src)],check=True)
node=None
for candidate in [os.environ.get('RLFE_NODE'),shutil.which('node'),'/opt/homebrew/bin/node','/usr/local/bin/node']:
 if not candidate or not pathlib.Path(candidate).is_file():continue
 try:
  v=subprocess.check_output([candidate,'-p','process.versions.node'],text=True).strip()
  if int(v.split('.')[0])>=20:node=candidate;break
 except (OSError,ValueError,subprocess.CalledProcessError):pass
if not node:raise SystemExit('请先安装 Node.js 22 或更新的 LTS 版，再重新打开安装入口。')
expected=json.loads((package/'checksums.json').read_text())
for name,digest in expected.items():
 if hashlib.sha256((package/name).read_bytes()).hexdigest()!=digest:raise SystemExit('试装包文件不完整：'+name+'，请重新解压原包。')
print('检查通过：Apple 芯片，飞书 '+version+'，Node '+v,flush=True)
if args.check:raise SystemExit(0)
def install_runtime(root,app,node):
 import secrets
 build=package/'v8-build'
 manifest=json.loads((build/'source-manifest.json').read_text())
 template=(build/'runtime-template.js').read_text()
 assert hashlib.sha256(template.encode()).hexdigest()==manifest['runtimeSha256']
 cap=secrets.token_urlsafe(32)
 (root/'native-asset-capability').write_text(cap);(root/'native-asset-capability').chmod(0o600)
 runtime=template.replace('__CAPABILITY__',json.dumps(cap))
 (root/'native-asset-runtime.js').write_text(runtime);(root/'native-asset-runtime.js').chmod(0o600)
 subprocess.run([node,'--check',str(root/'native-asset-runtime.js')],check=True)
 archive=app/'Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar'
 original=archive.read_bytes();packed,report=patch_archive(original,runtime.encode());archive.write_bytes(packed)
 for name in ['native_asset_bridge.cjs','live-source.cjs','topic-source.cjs']:shutil.copy2(build/name,root/name)
 shutil.copy2(package/'observe_native_app.py',root/'observe_native_app.py')
 (root/'node-path').write_text(node)
 (root/'web-display-choice.json').write_text('{}')
 manifest.update(report);manifest.update({'archiveBeforeSha256':hashlib.sha256(original).hexdigest(),'archiveAfterSha256':hashlib.sha256(packed).hexdigest(),'distribution':'standalone-ui-preview','liveSourceConnected':False})
 (root/'native-v8-deployment.json').write_text(json.dumps(manifest,indent=2))
root=home/'Library/Application Support/RemoteLab/Feishu Native Trial'
dst=root/'Feishu Native Trial.app'
profile=home/'Library/Application Support/RlfeTrial'
old=b'LarkShell';new=b'RlfeTrial'
assert len(old)==len(new)
if root.exists():
 receipt_path=root/'install-receipt.json'
 if receipt_path.is_file():
  installed=json.loads(receipt_path.read_text());deployed=json.loads((root/'native-v8-deployment.json').read_text());incoming=json.loads((package/'v8-build/source-manifest.json').read_text())
  archive=dst/'Contents/Frameworks/Lark Framework.framework/Resources/webcontent/messenger.asar'
  if installed.get('version')==version and deployed.get('runtimeSha256')==incoming['runtimeSha256'] and hashlib.sha256(archive.read_bytes()).hexdigest()==deployed['archiveAfterSha256']:
   subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(dst)],check=True)
   subprocess.run([sys.executable,str(package/'install-launcher.py')],check=True,env={**os.environ,'RLFE_INSTALL_HOME':str(home)})
   (root/'node-path').write_text(node)
   print('已经是本次试装版本，保留账号、草稿与设置。');raise SystemExit(0)
  if installed.get('version')==version and deployed.get('revision',0)<incoming['revision']:
   from importlib.machinery import SourceFileLoader
   upgrade=SourceFileLoader('native_upgrade',str(package/'upgrade-preview.py')).load_module()
   upgrade.upgrade(root,package,home,node)
   subprocess.run([sys.executable,str(package/'install-launcher.py')],check=True,env={**os.environ,'RLFE_INSTALL_HOME':str(home)})
   raise SystemExit(0)
 raise SystemExit('检测到不同版本或未完成的旧安装，已保留原目录。请反馈这条提示，不需要删除原飞书。')
assert src.is_dir() and not root.exists() and not profile.exists(), '已有试装目录，未覆盖。请先退出增强版，并按说明将旧试装目录移入废纸篓。'
root.mkdir(parents=True,exist_ok=False);os.chmod(root,0o700)
manifest_src=src/'Contents/Frameworks/Lark Framework.framework/Resources/manifest.json'
key_files=[src/'Contents/MacOS/Feishu',src/'Contents/Frameworks/Lark Framework.framework/Lark Framework',manifest_src,source_archive]
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
before={str(p):sha(p) for p in key_files}
(root/'source-baseline.json').write_text(json.dumps({'hashes':before,'version':version},indent=2))
copy=subprocess.run(['/bin/cp','-cR',str(src),str(dst)],capture_output=True)
if copy.returncode:subprocess.run(['/usr/bin/ditto',str(src),str(dst)],check=True)
print('Copied app to independent trial directory',flush=True)
info_path=dst/'Contents/Info.plist'
info=plistlib.loads(info_path.read_bytes());info['CFBundleIdentifier']='dev.remotelab.feishu-native-trial';info['CFBundleName']='Feishu Native Trial';info['CFBundleDisplayName']='飞书原生增强试验'
for k in ('CFBundleURLTypes','CFBundleDocumentTypes'):info.pop(k,None)
info_path.write_bytes(plistlib.dumps(info))
patched=[]
for p in dst.rglob('*'):
 if p.is_symlink() or not p.is_file() or not p.stat().st_size:continue
 assert p.resolve().is_relative_to(dst.resolve()),str(p)
 with p.open('r+b') as f:
  with mmap.mmap(f.fileno(),0) as data:
   count=0;pos=data.find(old)
   while pos>=0:
    data[pos:pos+len(old)]=new;count+=1;pos=data.find(old,pos+len(old))
   if count:patched.append({'file':str(p.relative_to(dst)),'count':count})
assert patched, 'No native profile directory reference was found'
# Manifest path and legacy migration source belong to this test profile too.
mp=dst/'Contents/Frameworks/Lark Framework.framework/Resources/manifest.json'
manifest=json.loads(mp.read_text());manifest['userDataPath']=str(profile);manifest['oldDataDirectory']='RlfeTrial';manifest['supportScheme']=[];manifest['customSchema']=[]
mp.write_text(json.dumps(manifest,separators=(',',':')))
# Prevent this test copy from replacing itself with an official build sharing the main profile.
updaters=list(dst.glob('Contents/Frameworks/*.framework/Versions/*/Libraries/darwin_updater'))
seen=set()
for p in updaters:
 p=p.resolve()
 if p in seen:continue
 seen.add(p);shutil.copyfile('/usr/bin/true',p);os.chmod(p,0o755)
profile.mkdir(mode=0o700)
update=profile/'update';update.mkdir();os.chmod(update,0o500)
# Inject the reviewed runtime before signing the isolated copy.
install_runtime(root, dst, node)
# Preserve declared device/JIT entitlements; rebuild signatures from the inside out.
# This changes only the test app identity, not system policy or the installed app.
objects=[]
for p in dst.rglob('*'):
 if p.is_symlink():continue
 if p.is_file():
  with p.open('rb') as f:magic=f.read(4)
  if magic in (b'\xcf\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xfe\xed\xfa\xcf',b'\xbe\xba\xfe\xca'):
   objects.append(p)
 elif p.is_dir() and p.suffix in ('.app','.xpc','.framework'):objects.append(p)
objects.sort(key=lambda p:len(p.parts),reverse=True);objects.append(dst)
for idx,p in enumerate(objects):
 existing=subprocess.run(['codesign','-d','--entitlements',':-',str(p)],capture_output=True)
 try:entitlements=plistlib.loads(existing.stdout)
 except Exception:entitlements={}
 allowed={k:v for k,v in entitlements.items() if k.startswith('com.apple.security.') and isinstance(v,bool)}
 entitlement_file=root/'signing-entitlements.plist';entitlement_file.write_bytes(plistlib.dumps(allowed))
 r=subprocess.run(['/usr/bin/codesign','--force','--sign','-','--entitlements',str(entitlement_file),str(p)],capture_output=True,text=True)
 if r.returncode:raise RuntimeError('Signing failed: '+str(p.relative_to(dst))+' '+r.stderr[-600:])
print('Signed '+str(len(objects))+' components',flush=True)
check=subprocess.run(['/usr/bin/codesign','--verify','--strict','--deep',str(dst)],capture_output=True,text=True)
assert check.returncode==0,check.stderr
assert before=={str(p):sha(p) for p in key_files},'Source app changed; stop'
result={'trialApp':str(dst),'trialProfile':str(profile),'version':manifest['appVersion'],'patchedDirectoryReferences':patched,'signedComponents':len(objects),'strictSignatureValid':True,'sourceHashesUnchanged':True,'urlHandlersRemoved':True,'cloneUpdaterDisabled':bool(seen)}
(root/'prepare-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
result['revision']=json.loads((package/'v8-build/source-manifest.json').read_text())['revision']
result['installedAt']=time.time()
(root/'install-receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
subprocess.run([sys.executable,str(package/'install-launcher.py')],check=True,env={**os.environ,'RLFE_INSTALL_HOME':str(home)})
print('安装完成。“飞书增强版”已放入个人应用程序目录。')
print('首次使用请在设置里连接状态同步，并在浏览器核对本人姓名。')
