"""Build the public one-command release from a reviewed runtime and pinned tools."""
import argparse
import hashlib
import html
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

p = argparse.ArgumentParser()
p.add_argument('build', type=pathlib.Path)
p.add_argument('font_license', type=pathlib.Path)
p.add_argument('output', type=pathlib.Path)
p.add_argument('public_base')
a = p.parse_args()
source = pathlib.Path(__file__).resolve().parent
base = a.public_base.rstrip('/')
assert base.startswith('https://') and not any(c in base for c in '\"\'$`\\\n ')
runtimes = {
 'node-v22.23.3-darwin-arm64.tar.gz': {
  'sha256':'23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53',
  'source':'https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz'},
 'python-3.12.15-darwin-arm64.tar.gz': {
  'sha256':'233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f',
  'source':'https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.12.15%2B20261009-aarch64-apple-darwin-install_only_stripped.tar.gz'}
}
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
for name, spec in runtimes.items():
 assert sha(a.output/'runtime'/name) == spec['sha256'], name
with tempfile.TemporaryDirectory(prefix='feishu-cli-package-') as tmp:
 subprocess.run([sys.executable,str(source/'package-preview.py'),str(a.build),str(a.font_license),tmp],check=True)
 shutil.copyfile(pathlib.Path(tmp)/'Feishu-Native-M2-8.1.17-preview9.zip',a.output/'preview9-cli1.zip')
digest = sha(a.output/'preview9-cli1.zip')
parts = []
for archive in [a.output/'runtime'/name for name in runtimes] + [a.output/'preview9-cli1.zip']:
 whole = sha(archive)
 directory = a.output/'chunks'/whole
 directory.mkdir(parents=True,exist_ok=True)
 records = []
 with archive.open('rb') as stream:
  offset = 0
  for index, data in enumerate(iter(lambda:stream.read(1024*1024),b'')):
   name = f'{index:04d}'
   (directory/name).write_bytes(data)
   records.append(f'{name} {hashlib.sha256(data).hexdigest()} {offset} {offset+len(data)-1}')
   offset += len(data)
 parts.append('    '+whole+") cat <<'RLFE_PARTS'\n"+'\n'.join(records)+"\nRLFE_PARTS\n      ;;")
script = (source/'bootstrap.sh').read_text().replace('__PUBLIC_BASE__',base).replace('__PACKAGE_SHA256__',digest).replace('__DOWNLOAD_PARTS__','\n'.join(parts))
assert all(pin not in script for pin in ['__PUBLIC_BASE__','__PACKAGE_SHA256__','__DOWNLOAD_PARTS__'])
(a.output/'install.sh').write_text(script)
(a.output/'release.json').write_text(json.dumps({'release':'preview15-cli1','supportedFeishu':'8.1.17','architecture':'arm64','packageSha256':digest,'runtimes':runtimes},indent=2)+'\n')
command = 'curl -fL --retry 5 --retry-all-errors --connect-timeout 15 --max-time 120 '+base+'/install.sh -o /tmp/feishu-native-install.sh && /bin/bash /tmp/feishu-native-install.sh'
(a.output/'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>飞书增强版试装</title><body><h1>飞书增强版试装</h1><p>M 系列 Mac · 飞书 8.1.17</p><p>在终端执行，安装完成后自动打开；首次使用登录本人账号。</p><pre>'+html.escape(command)+'</pre><p>原飞书和数据保留。个人入口、消息设置、群看板和已读同步只需一次本人连接。当前不支持代码热更新。</p></body></html>')
print(json.dumps({'command':command,'packageSha256':digest,'bootstrapSha256':sha(a.output/'install.sh')}))
