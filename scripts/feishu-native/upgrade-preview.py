"""Upgrade a verified isolated preview; retain the profile and a local rollback."""
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import signal
import struct
import subprocess
import time


def replace_runtime(original, runtime):
    _, size, _, length = struct.unpack('<4I', original[:16])
    header = json.loads(original[16:16+length])
    entry = header['files']['remotelab-native-v7.js']
    assert entry['size'] > 0 and int(entry['offset']) >= 0
    body = original[8+size:]
    entry.clear()
    entry.update(size=len(runtime), offset=str(len(body)))
    encoded = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode()
    payload = struct.pack('<I', len(encoded)) + encoded
    payload += b'\0' * (-len(payload) % 4)
    pickle = struct.pack('<I', len(payload)) + payload
    return struct.pack('<II', 4, len(pickle)) + pickle + body + runtime


def upgrade(root, package, home, node):
    app = root/'Feishu Native Trial.app'
    assert not app.is_symlink()
    assert plistlib.loads((app/'Contents/Info.plist').read_bytes())['CFBundleIdentifier'] == 'dev.remotelab.feishu-native-trial'
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True).splitlines()
    if any(str(app) in row for row in rows):
        raise SystemExit('更新已准备好。请先用 ⌘Q 退出“飞书增强版”，再运行同一条命令；账号、草稿和设置会保留。')
    previous = json.loads((root/'native-v8-deployment.json').read_text())
    incoming = json.loads((package/'v8-build/source-manifest.json').read_text())
    template = (package/'v8-build/runtime-template.js').read_text()
    sha = lambda data: hashlib.sha256(data).hexdigest()
    assert sha(template.encode()) == incoming['runtimeSha256']
    archive = pathlib.Path('Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar')
    original = (app/archive).read_bytes()
    assert sha(original) == previous['archiveAfterSha256'], 'Installed archive changed; preserved'
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', '--deep', str(app)], check=True, capture_output=True)
    backup = root/('before-r'+str(incoming['revision'])+'-'+str(time.time_ns()))
    backup.mkdir(mode=0o700)
    staged = backup/'next.app'
    subprocess.run(['/bin/cp', '-cR', str(app), str(staged)], check=True)
    cap = (root/'native-asset-capability').read_text().strip()
    runtime = template.replace('__CAPABILITY__', json.dumps(cap)).encode()
    packed = replace_runtime(original, runtime)
    (staged/archive).write_bytes(packed)
    for target in [staged/'Contents/Frameworks/Lark Framework.framework', staged]:
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--preserve-metadata=entitlements', str(target)], check=True, capture_output=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', '--deep', str(staged)], check=True, capture_output=True)
    names = ['native_asset_bridge.cjs', 'live-source.cjs', 'topic-source.cjs','native-connection.cjs', 'observe_native_app.py',
             'native-asset-runtime.js', 'native-v8-deployment.json', 'install-receipt.json', 'node-path']
    present = {name for name in names if (root/name).is_file()}
    for name in present:
        shutil.copy2(root/name, backup/name)
    # Only stop the exact old private helper after the App has exited.
    status = root/'native-asset-status.json'
    if status.exists():
        pid = json.loads(status.read_text()).get('pid')
        if isinstance(pid, int):
            command = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
            if str(root/'native_asset_bridge.cjs') in command:
                import select
                queue = select.kqueue()
                try:
                    queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)], 0, 0)
                    os.kill(pid, signal.SIGTERM)
                    assert queue.control([], 1, 10), 'Old helper did not exit'
                except ProcessLookupError:
                    pass
                finally:
                    queue.close()
    old_app = backup/'previous.app'
    app.rename(old_app)
    try:
        staged.rename(app)
        for name in ['native_asset_bridge.cjs', 'live-source.cjs', 'topic-source.cjs','native-connection.cjs']:
            shutil.copy2(package/'v8-build'/name, root/name)
        shutil.copy2(package/'observe_native_app.py', root/'observe_native_app.py')
        (root/'native-asset-runtime.js').write_bytes(runtime)
        (root/'native-asset-runtime.js').chmod(0o600)
        (root/'node-path').write_text(node)
        incoming.update(archiveBeforeSha256=previous['archiveBeforeSha256'], archiveAfterSha256=sha(packed), backup=str(backup), strictSignatureValid=True)
        (root/'native-v8-deployment.json').write_text(json.dumps(incoming, indent=2))
        receipt = json.loads((root/'install-receipt.json').read_text())
        receipt.update(revision=incoming['revision'], updatedAt=time.time())
        (root/'install-receipt.json').write_text(json.dumps(receipt, indent=2))
    except BaseException:
        if app.exists():
            app.rename(backup/'failed.app')
        old_app.rename(app)
        for name in names:
            if name in present:
                shutil.copy2(backup/name, root/name)
            else:
                (root/name).unlink(missing_ok=True)
        raise
    print('已更新至 r'+str(incoming['revision'])+'，账号、草稿和设置保留；旧版备份：'+str(backup))
