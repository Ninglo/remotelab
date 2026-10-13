"""Launch the independent App only after its own loopback helper is ready."""
import fcntl
import json
import os
import pathlib
import select
import signal
import subprocess
import sys
import time
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# Never send the private helper capability through a system/environment proxy.
local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


STATUS_URL = 'http://127.0.0.1:19342/status'


def status(cap):
    req = urllib.request.Request(STATUS_URL,
                                 headers={'Authorization': 'Bearer '+cap})
    try:
        with local_http.open(req, timeout=0.5) as response:
            data = json.load(response)
        if isinstance(data, dict) and type(data.get('pid')) is int and data['pid'] > 1:
            return data
    except (OSError, ValueError):
        pass
    return None


def own_helper(pid, root, node):
    if type(pid) is not int or pid <= 1:
        return False
    result = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'uid=,command='],
                            capture_output=True, text=True)
    row = result.stdout.strip().split(None, 1)
    return (len(row) == 2 and row[0] == str(os.getuid()) and
            row[1] == node+' '+str(root/'native_asset_bridge.cjs'))


def stop_helper(pid, root, node):
    """Only terminate a verified helper of this installation, never a port owner."""
    queue = select.kqueue()
    try:
        queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC,
                      flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                      fflags=select.KQ_NOTE_EXIT)], 0, 0)
        if not own_helper(pid, root, node):
            raise SystemExit('旧服务身份已变化，未停止任何程序。请重新打开增强版。')
        os.kill(pid, signal.SIGTERM)
        if not queue.control([], 1, 5):
            raise SystemExit('旧增强服务未退出，已保留当前数据。请把这条提示发回。')
    except ProcessLookupError:
        pass
    finally:
        queue.close()


def await_ready(bridge, cap):
    # Bounded startup observation: stop on process exit or authenticated readiness.
    deadline = time.monotonic()+8
    delay = 0.25
    while True:
        if bridge.poll() is not None:
            return None
        connected = status(cap)
        if connected and connected['pid'] == bridge.pid:
            return connected
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            return None
        try:
            bridge.wait(timeout=min(delay, remaining))
            return None
        except subprocess.TimeoutExpired:
            delay = min(delay*2, 2)


def await_app(binary, timeout=10):
    deadline = time.monotonic()+timeout
    delay = .25
    while True:
        rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True).splitlines()
        for line in rows:
            row = line.strip().split(None, 1)
            if len(row) == 2 and row[1] == str(binary):
                return int(row[0])
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise RuntimeError('系统未启动飞书增强版；账号与草稿已保留。')
        time.sleep(min(delay, remaining))
        delay = min(delay*2, 2)


def main():
    home = pathlib.Path(os.environ.get('RLFE_INSTALL_HOME', str(pathlib.Path.home())))
    root = home/'Library/Application Support/RemoteLab/Feishu Native Trial'
    app = root/'Feishu Native Trial.app'
    binary = app/'Contents/MacOS/Feishu'
    with (root/'launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        revision = json.loads((root/'native-v8-deployment.json').read_text())['revision']
        node = (root/'node-path').read_text().strip() if (root/'node-path').exists() else '/usr/local/bin/node'
        rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True).splitlines()
        pids = [int(row[0]) for line in rows if len(row := line.strip().split(None, 1)) == 2 and row[1] == str(binary)]
        cap = (root/'native-asset-capability').read_text().strip()
        connected = status(cap)
        if pids and connected:
            subprocess.run(['/usr/bin/open', '-a', str(app)], check=True)
            print('已打开飞书增强版，第 '+str(connected.get('revision', revision))+' 版。')
            return
        # An old observer may still own a lingering helper. Start a fresh helper
        # for a cold App, rather than inheriting that observer's lifetime.
        candidates = [connected.get('pid')] if connected else []
        for name, field in [('native-asset-status.json', 'pid'), ('started.json', 'bridgePid')]:
            try:
                candidates.append(json.loads((root/name).read_text()).get(field))
            except (OSError, ValueError):
                pass
        for pid in set(candidates):
            if own_helper(pid, root, node):
                stop_helper(pid, root, node)
        # Do not probe with bind(): on macOS TIME_WAIT can reject the probe even
        # when no listener exists. Let Node bind with its normal SO_REUSEADDR.
        with (root/'native-asset-bridge.log').open('ab') as log:
            bridge = subprocess.Popen([node, str(root/'native_asset_bridge.cjs')],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                env={**os.environ, 'RLFE_TRIAL_ROOT': str(root)})
        if not await_ready(bridge, cap):
            if bridge.poll() is None:
                bridge.terminate()
                try:
                    bridge.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
            raise SystemExit('本机增强服务未就绪，未启动新飞书窗口。账号和草稿已保留。\n'
                             '请反馈此提示；服务日志：'+str(root/'native-asset-bridge.log'))
        with (root/'startup.log').open('ab') as log:
            if pids:
                app_pid = pids[0]
                subprocess.run(['/usr/bin/open', '-a', str(app)], check=True)
            else:
                # Launch the bundle through macOS so device-permission requests
                # are attributed to the App, not a directly spawned script child.
                subprocess.run(['/usr/bin/open', '-a', str(app), '--args',
                                '--user-data-dir='+str(home/'Library/Application Support/RlfeTrial')],
                               check=True, stdout=log, stderr=log)
                app_pid = await_app(binary)
        (root/'started.json').write_text(json.dumps({'pid': app_pid, 'app': str(app),
            'profile': str(home/'Library/Application Support/RlfeTrial'), 'revision': revision, 'bridgePid': bridge.pid}))
        with (root/'native-app-observer.log').open('ab') as log:
            subprocess.Popen([sys.executable, str(root/'observe_native_app.py'), str(app_pid), str(bridge.pid)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        print('本机服务已连接，已'+('恢复' if pids else '启动')+'飞书增强版，第 '+str(revision)+' 版。')


if __name__ == '__main__':
    main()
