"""Opt-in, signed helper-only updates; never modify the App or user profile."""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import plistlib
import platform
import re
import subprocess
import sys
import tempfile
import time

BASE = 'https://index.jiujianian.dev/public-pages/feishu-native-updates'
PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPPSJHzzaHqBU8l9k/6UVi0X32CUgvX2X8f9fRt+aMwo=\n-----END PUBLIC KEY-----\n'
LABEL = 'dev.remotelab.feishu-helper-update'
ALLOWED = {'topic-source.cjs', 'native-connection.cjs', 'live-source.cjs'}
MAX_FILE = 2 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path, fallback=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def atomic(path, data):
    if path.is_symlink():
        raise ValueError('拒绝替换符号链接：'+path.name)
    fd, name = tempfile.mkstemp(prefix='.update-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def save(path, data):
    atomic(path, (json.dumps(data, ensure_ascii=False, indent=2)+'\n').encode())


def fetch(url):
    # Fixed HTTPS origin, no redirect/cookies/auth; bounded size and runtime.
    if not url.startswith(BASE+'/'):
        raise ValueError('更新来源不匹配')
    proxy = []
    # curl does not read macOS proxy preferences. Follow an explicitly enabled
    # HTTPS proxy without altering those preferences or exposing credentials.
    settings = subprocess.check_output(['/usr/sbin/scutil', '--proxy'], text=True, timeout=5)
    fields = dict(re.findall(r'^\s*(HTTPS\w+)\s*:\s*(\S+)\s*$', settings, re.M))
    host, port = fields.get('HTTPSProxy', ''), fields.get('HTTPSPort', '')
    if (fields.get('HTTPSEnable') == '1' and re.fullmatch(r'[A-Za-z0-9.\[\]:-]+', host)
            and port.isdigit() and 0 < int(port) < 65536):
        proxy = ['--proxy', 'http://'+host+':'+port]
    with tempfile.TemporaryDirectory(prefix='feishu-update-download-') as tmp:
        target = pathlib.Path(tmp)/'download'
        subprocess.run(['/usr/bin/curl', '--fail', '--silent', '--show-error',
                        '--proto', '=https', '--connect-timeout', '10', '--max-time', '40',
                        '--max-filesize', str(MAX_FILE), '--output', str(target), *proxy, url],
                       check=True, timeout=45, capture_output=True)
        data = target.read_bytes()
        if len(data) > MAX_FILE:
            raise ValueError('更新文件过大')
        return data


def verify_envelope(raw, node, public_key=PUBLIC_KEY):
    envelope = json.loads(raw)
    payload = base64.b64decode(envelope['payload'], validate=True)
    signature = base64.b64decode(envelope['signature'], validate=True)
    # Verification is performed by the already installed Node crypto module.
    # Manifest content is stdin data, never interpolated into executable code.
    script = """const {verify}=require('node:crypto');let s='';
process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
try{const x=JSON.parse(s);process.exit(verify(null,Buffer.from(x.payload,'base64'),x.key,Buffer.from(x.signature,'base64'))?0:1)}catch{process.exit(1)}});"""
    subprocess.run([node, '-e', script], input=json.dumps({
        'payload': base64.b64encode(payload).decode(),
        'signature': base64.b64encode(signature).decode(), 'key': public_key}),
        text=True, check=True, timeout=10, capture_output=True)
    return json.loads(payload)


def validate(manifest, root, receipt):
    if manifest.get('schema') != 1 or manifest.get('revision') != 16:
        raise ValueError('不支持的补丁协议')
    serial = manifest.get('serial')
    if type(serial) is not int or serial < 1 or serial < receipt.get('serial', 0):
        raise ValueError('拒绝过期补丁序号')
    if read_json(root/'native-v8-deployment.json')['revision'] != manifest['revision']:
        raise ValueError('此增强版需要先进行兼容性升级')
    bridge = root/'native_asset_bridge.cjs'
    if bridge.is_symlink() or sha(bridge.read_bytes()) not in manifest.get('bridgeHashes', []):
        raise ValueError('本机服务版本与补丁不兼容，已保留现状')
    files = manifest.get('files')
    if not isinstance(files, dict) or not files or not set(files).issubset(ALLOWED):
        raise ValueError('补丁包含不允许更新的文件')
    for name, record in files.items():
        digest = record.get('sha256', '')
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('无效的文件校验值')
        path = root/name
        if path.is_symlink() or sha(path.read_bytes()) not in record.get('from', [])+[digest]:
            raise ValueError('本机文件已有其他修改：'+name)
    return files


class Runtime:
    def __init__(self, root):
        self.root = root
        self.node = (root/'node-path').read_text().strip()
        self.cap = (root/'native-asset-capability').read_text().strip()
        spec = importlib.util.spec_from_file_location('feishu_launcher', root/'launch_web_replica.py')
        self.launch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launch)

    def apps(self):
        binary = str(self.root/'Feishu Native Trial.app/Contents/MacOS/Feishu')
        rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True, timeout=5)
        return [int(row[0]) for line in rows.splitlines()
                if len(row := line.strip().split(None, 1)) == 2 and row[1] == binary]

    def status(self):
        return self.launch.status(self.cap)

    def stop(self, pid):
        if not self.launch.own_helper(pid, self.root, self.node):
            raise RuntimeError('服务身份已变化，未停止任何程序')
        self.launch.stop_helper(pid, self.root, self.node)

    def start(self, app_pid):
        with (self.root/'native-asset-bridge.log').open('ab') as log:
            child = subprocess.Popen([self.node, str(self.root/'native_asset_bridge.cjs')],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                env={**os.environ, 'RLFE_TRIAL_ROOT': str(self.root)})
        if not self.launch.await_ready(child, self.cap):
            if self.launch.own_helper(child.pid, self.root, self.node):
                self.stop(child.pid)
            raise RuntimeError('补丁服务启动失败')
        with (self.root/'native-app-observer.log').open('ab') as log:
            subprocess.Popen([(self.root/'python-path').read_text().strip(),
                str(self.root/'observe_native_app.py'), str(app_pid), str(child.pid)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        started = read_json(self.root/'started.json', {})
        started.update(pid=app_pid, bridgePid=child.pid)
        save(self.root/'started.json', started)
        return child.pid

    def await_pages(self, pid, apps, before):
        clients = {p['id'] for p in before.get('pages', [])}
        deadline, delay = time.monotonic()+30, .25
        while True:
            if self.apps() != apps:
                raise RuntimeError('更新期间飞书进程改变')
            current = self.status()
            pages = current.get('pages', []) if current else []
            if (current and current['pid'] == pid and clients.issubset({p['id'] for p in pages})
                    and all(p.get('sync', {}).get('state') == 'connected' for p in pages)):
                return {'pageCount': len(pages), 'sameClients': clients == {p['id'] for p in pages},
                        'draftPresence': [p.get('hasDraft') for p in pages]}
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise RuntimeError('原页面未在30秒内恢复同步')
            time.sleep(min(delay, remaining))
            delay = min(delay*2, 2)


def restore(root, runtime, transaction):
    current = runtime.status()
    if current:
        runtime.stop(current['pid'])
    backup = root/'helper-update-backups'/transaction['backup']
    for name, digest in transaction['originals'].items():
        if name not in ALLOWED:
            raise ValueError('无效回退文件')
        data = (backup/name).read_bytes()
        if sha(data) != digest:
            raise ValueError('回退文件校验失败')
        atomic(root/name, data)
    apps = runtime.apps()
    if len(apps) == 1:
        runtime.start(apps[0])


def apply(root, runtime, manifest, downloader=fetch):
    """Caller holds launcher.lock. Journal survives updater interruption."""
    receipt_path = root/'helper-update-receipt.json'
    receipt = read_json(receipt_path, {})
    pending_path = root/'helper-update-pending.json'
    pending = read_json(pending_path)
    if pending:
        restore(root, runtime, pending)
        receipt.update(blockedSerial=pending['serial'], state='rolled-back',
                       reason='上次更新被中断，已恢复备份')
        save(receipt_path, receipt)
        pending_path.unlink()
        return receipt
    files = validate(manifest, root, receipt)
    if receipt.get('blockedSerial') == manifest['serial']:
        return {**receipt, 'state': 'held', 'reason': '已回退此补丁，等待修订版'}
    changes = {n: r for n, r in files.items() if sha((root/n).read_bytes()) != r['sha256']}
    if not changes:
        receipt.update(state='current', serial=manifest['serial'], files={n: r['sha256'] for n, r in files.items()})
        save(receipt_path, receipt)
        return receipt
    staged = {}
    for name, record in changes.items():
        data = downloader(BASE+'/objects/'+record['sha256']+'/'+name)
        if len(data) > MAX_FILE or sha(data) != record['sha256']:
            raise ValueError('补丁下载校验失败：'+name)
        with tempfile.TemporaryDirectory() as tmp:
            candidate = pathlib.Path(tmp)/name
            candidate.write_bytes(data)
            subprocess.run([runtime.node, '--check', str(candidate)], check=True,
                           timeout=10, capture_output=True)
        staged[name] = data
    apps, before = runtime.apps(), runtime.status()
    if len(apps) > 1 or (not apps and before) or (apps and (not before or not before.get('pages') or
            any(p.get('sync', {}).get('state') != 'connected' for p in before['pages']))):
        return {'state': 'deferred', 'reason': '等待飞书同步健康或完全退出后再更新'}
    backup = root/'helper-update-backups'/str(time.time_ns())
    backup.mkdir(parents=True, mode=0o700)
    originals = {name: (root/name).read_bytes() for name in changes}
    for name, data in originals.items():
        atomic(backup/name, data)
    transaction = {'backup': backup.name, 'serial': manifest['serial'],
                   'originals': {n: sha(d) for n, d in originals.items()}}
    save(pending_path, transaction)
    try:
        if before:
            runtime.stop(before['pid'])
        if runtime.apps() != apps:
            raise RuntimeError('飞书进程改变，恢复旧版')
        for name, data in staged.items():
            atomic(root/name, data)
        verification = {}
        if apps:
            pid = runtime.start(apps[0])
            verification = runtime.await_pages(pid, apps, before)
        receipt.update(state='updated', serial=manifest['serial'], backup=backup.name,
                       files={n: r['sha256'] for n, r in files.items()},
                       appPid=apps[0] if apps else None, verification=verification)
        save(receipt_path, receipt)
        pending_path.unlink()
        return receipt
    except Exception as error:
        restore(root, runtime, transaction)
        receipt.update(state='rolled-back', blockedSerial=manifest['serial'], reason=str(error), backup=backup.name)
        save(receipt_path, receipt)
        pending_path.unlink()
        return receipt


def install_agent(root):
    agent = pathlib.Path.home()/'Library/LaunchAgents'/ (LABEL+'.plist')
    agent.parent.mkdir(parents=True, exist_ok=True)
    data = {'Label': LABEL, 'ProgramArguments': [(root/'python-path').read_text().strip(),
            str(root/'helper-update.py')], 'StartInterval': 900, 'RunAtLoad': True,
            'ProcessType': 'Background', 'StandardOutPath': str(root/'helper-update.log'),
            'StandardErrorPath': str(root/'helper-update.log')}
    atomic(agent, plistlib.dumps(data))
    domain = 'gui/'+str(os.getuid())
    # Re-registration is idempotent, and never targets a Feishu process.
    subprocess.run(['/bin/launchctl', 'bootout', domain+'/'+LABEL], capture_output=True, timeout=10)
    subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(agent)], check=True, timeout=10)
    return {'state': 'enrolled', 'intervalSeconds': 900, 'agent': LABEL}


def first_check(root, since):
    deadline, delay = time.monotonic()+50, .25
    while True:
        result = read_json(root/'helper-update-check.json', {})
        if result.get('checkedAt', 0) >= since:
            return result
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            return {'state': 'pending', 'reason': '自动检查已注册，首次结果尚未返回'}
        time.sleep(min(delay, remaining))
        delay = min(delay*2, 2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--disable', action='store_true')
    args = parser.parse_args()
    root = pathlib.Path.home()/'Library/Application Support/RemoteLab/Feishu Native Trial'
    if root.is_symlink() or not root.is_dir():
        raise SystemExit('未找到受支持的飞书增强版安装；没有修改任何应用。')
    if args.status:
        print(json.dumps({'receipt': read_json(root/'helper-update-receipt.json'),
                          'lastCheck': read_json(root/'helper-update-check.json')}, ensure_ascii=False))
        return
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('仅支持 M 系列 Mac。')
    if args.disable:
        subprocess.run(['/bin/launchctl', 'bootout', 'gui/'+str(os.getuid())+'/'+LABEL], capture_output=True, timeout=10)
        (pathlib.Path.home()/'Library/LaunchAgents'/(LABEL+'.plist')).unlink(missing_ok=True)
        print('已关闭自动更新，当前增强版保留。')
        return
    runtime = Runtime(root)
    if args.install:
        manifest = verify_envelope(fetch(BASE+'/stable.json'), runtime.node)
        validate(manifest, root, read_json(root/'helper-update-receipt.json', {}))
        with (root/'launcher.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            atomic(root/'helper-update.py', pathlib.Path(__file__).read_bytes())
        since = time.time()
        enrollment = install_agent(root)
        print(json.dumps({'enrollment': enrollment, 'firstCheck': first_check(root, since)}, ensure_ascii=False))
        return
    with (root/'helper-update.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            # Recover an interrupted transaction even while offline.
            pending = read_json(root/'helper-update-pending.json')
            manifest = None if pending else verify_envelope(fetch(BASE+'/stable.json'), runtime.node)
            # Slow downloads must not block the normal launcher. Revalidate
            # current files after taking its short cutover lock below.
            downloads = {}
            if manifest:
                files = validate(manifest, root, read_json(root/'helper-update-receipt.json', {}))
                for name, record in files.items():
                    if sha((root/name).read_bytes()) != record['sha256']:
                        url = BASE+'/objects/'+record['sha256']+'/'+name
                        downloads[url] = fetch(url)
            with (root/'launcher.lock').open('a') as launch_lock:
                fcntl.flock(launch_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = apply(root, runtime, manifest, lambda url: downloads[url])
        except BlockingIOError:
            result = {'state': 'deferred', 'reason': '启动器正在运行，下一次检查继续'}
        except Exception as error:
            result = {'state': 'error', 'reason': str(error)}
        save(root/'helper-update-check.json', {'checkedAt': time.time(), **result})
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
