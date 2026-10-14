"""Publish reviewed helper patches with a separately held Ed25519 release key."""
import argparse
import base64
import hashlib
import html
import importlib.util
import json
import pathlib
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--spec', type=pathlib.Path, required=True)
p.add_argument('--key', type=pathlib.Path, required=True)
p.add_argument('--output', type=pathlib.Path, required=True)
a = p.parse_args()
source = pathlib.Path(__file__).resolve().parent
module_spec = importlib.util.spec_from_file_location('helper_update', source/'helper-update.py')
updater_module = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(updater_module)
public_key = subprocess.check_output(['openssl', 'pkey', '-in', str(a.key), '-pubout'], text=True)
assert public_key.strip() == updater_module.PUBLIC_KEY.strip(), 'release key does not match updater'
base = 'https://index.jiujianian.dev/public-pages/feishu-native-updates'
spec = json.loads(a.spec.read_text())
manifest = {'schema': 1, 'revision': 16, 'serial': spec['serial'],
            'bridgeHashes': spec['bridgeHashes'], 'files': {}}
assert type(spec['serial']) is int and spec['serial'] > 0
a.output.mkdir(parents=True, exist_ok=True)
for name, previous in spec['files'].items():
    assert name in {'topic-source.cjs', 'native-connection.cjs', 'live-source.cjs'}
    content = (source/name).read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    target = a.output/'objects'/digest/name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    manifest['files'][name] = {'sha256': digest, 'from': previous}
payload = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
with tempfile.TemporaryDirectory() as tmp:
    data = pathlib.Path(tmp)/'payload'
    data.write_bytes(payload)
    signature = subprocess.check_output(['openssl', 'pkeyutl', '-sign', '-rawin',
                                        '-inkey', str(a.key), '-in', str(data)])
(a.output/'stable.json').write_text(json.dumps({'payload': base64.b64encode(payload).decode(),
                                              'signature': base64.b64encode(signature).decode()})+'\n')
updater = (source/'helper-update.py').read_bytes()
digest = hashlib.sha256(updater).hexdigest()
(a.output/'helper-update.py').write_bytes(updater)
script = '''#!/bin/bash
set -euo pipefail
ROOT="$HOME/Library/Application Support/RemoteLab/Feishu Native Trial"
if [[ ! -f "$ROOT/python-path" ]]; then
  echo '未找到已安装的飞书增强版，未修改任何应用。' >&2
  exit 1
fi
PYTHON=$(cat "$ROOT/python-path")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PROXY_ARGS=()
PROXY_CONFIG=$(/usr/sbin/scutil --proxy)
PROXY_ENABLED=$(echo "$PROXY_CONFIG" | /usr/bin/awk '/HTTPSEnable :/{print $3}')
PROXY_HOST=$(echo "$PROXY_CONFIG" | /usr/bin/awk '/HTTPSProxy :/{print $3}')
PROXY_PORT=$(echo "$PROXY_CONFIG" | /usr/bin/awk '/HTTPSPort :/{print $3}')
if [[ "$PROXY_ENABLED" == 1 && "$PROXY_HOST" =~ ^[a-zA-Z0-9.:-]+$ && "$PROXY_PORT" =~ ^[0-9]+$ ]]; then
  PROXY_ARGS=(--proxy "http://$PROXY_HOST:$PROXY_PORT")
fi
/usr/bin/curl -fSs --proto '=https' --connect-timeout 10 --max-time 60 "${PROXY_ARGS[@]}" '__BASE__/helper-update.py' -o "$TMP/helper-update.py"
ACTUAL=$(/usr/bin/shasum -a 256 "$TMP/helper-update.py" | /usr/bin/awk '{print $1}')
[[ "$ACTUAL" == '__SHA__' ]] || { echo '更新组件校验失败，未安装。' >&2; exit 1; }
"$PYTHON" "$TMP/helper-update.py" --install
'''.replace('__BASE__', base).replace('__SHA__', digest)
(a.output/'enable.sh').write_text(script)
command = f'curl -fSs --proto "=https" --connect-timeout 10 --max-time 60 {base}/enable.sh -o /tmp/feishu-enable-updates.sh && /bin/bash /tmp/feishu-enable-updates.sh'
(a.output/'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>飞书增强版小补丁更新</title><body><h1>飞书增强版小补丁更新</h1><p>适用于已安装 v16 的 M 系列 Mac。每台仅接入一次，无需退出或重新安装飞书。</p><pre>'+html.escape(command)+'</pre><p>每15分钟检查签名发布，只更新兼容的同步服务文件；失败恢复旧文件。账号、草稿、系统权限和签名 App 保留。界面代码更新仍需单独升级。接入不向服务器上传设备、账号或草稿信息。</p><p>检查结果保存在本机 RemoteLab/Feishu Native Trial 下的 helper-update-check.json；停用与维护说明见原安装说明。</p></body></html>')
print(json.dumps({'serial': spec['serial'], 'files': manifest['files'], 'updaterSha256': digest, 'command': command}))
