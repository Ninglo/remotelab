"""Launch recovery, proxy isolation, occupied ports and Mac TIME_WAIT regression."""
import importlib.util
import io
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import unittest.mock as mock

source = pathlib.Path(__file__).resolve().parents[1]/'scripts/feishu-native/launch.py'
spec = importlib.util.spec_from_file_location('launcher', source)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

with tempfile.TemporaryDirectory(prefix='feishu-launch-') as tmp:
    home = pathlib.Path(tmp)
    root = home/'Library/Application Support/RemoteLab/Feishu Native Trial'
    root.mkdir(parents=True)
    app = root/'Feishu Native Trial.app'
    binary = app/'Contents/MacOS/Feishu'
    (root/'native-v8-deployment.json').write_text('{"revision":11}')
    (root/'native-asset-capability').write_text('fixture-only')
    (root/'node-path').write_text('/private/runtime/node')
    (root/'draft').write_text('keep my draft')
    for case in ('cold', 'running', 'orphan', 'running-offline', 'foreign-port', 'stale-pid'):
        running = case in ('running', 'running-offline')
        rows = f'123 {binary}\n' if running else '1 /sbin/launchd\n'
        connected = {'pid': 222, 'revision': 11} if case in ('running', 'orphan') else None
        (root/'started.json').write_text('{"bridgePid":222}')
        bridge = mock.Mock(pid=234)
        with mock.patch.dict(os.environ, {'RLFE_INSTALL_HOME': str(home)}), \
             mock.patch('subprocess.check_output', return_value=rows), \
             mock.patch.object(launcher, 'status', return_value=connected), \
             mock.patch.object(launcher, 'own_helper', return_value=case=='orphan'), \
             mock.patch.object(launcher, 'stop_helper') as stop, \
             mock.patch.object(launcher, 'await_ready', return_value=None if case=='foreign-port' else {'pid':234}), \
             mock.patch.object(launcher, 'await_app', return_value=345), \
             mock.patch('subprocess.run') as run, \
             mock.patch('subprocess.Popen') as popen:
            popen.side_effect = [bridge, mock.Mock(pid=345), mock.Mock(pid=456)]
            try:
                launcher.main()
                assert case != 'foreign-port'
            except SystemExit as exc:
                assert case == 'foreign-port' and '未就绪' in str(exc)
            if case == 'running':
                popen.assert_not_called()
                run.assert_called_once_with(['/usr/bin/open', '-a', str(app)], check=True)
            elif case == 'foreign-port':
                assert popen.call_count == 1  # no App or observer after bind failure
                stop.assert_not_called()
            else:
                assert popen.call_count == 2
                assert all(c.args[0][0] != str(binary) for c in popen.call_args_list)
                if not running:
                    assert any(c.args[0] == ['/usr/bin/open', '-a', str(app), '--args', '--user-data-dir='+str(home/'Library/Application Support/RlfeTrial')] for c in run.call_args_list)
                assert popen.call_args_list[0].kwargs['env']['RLFE_TRIAL_ROOT'] == str(root)
                assert json.loads((root/'started.json').read_text())['bridgePid'] == 234
                if case == 'orphan': stop.assert_called_once_with(222, root, '/private/runtime/node')
                else: stop.assert_not_called()
            assert (root/'draft').read_text() == 'keep my draft'

    with mock.patch('subprocess.check_output', side_effect=['10 /Applications/Lark.app/Contents/MacOS/Feishu\n', f'345 {binary}\n']), mock.patch('time.sleep'):
        assert launcher.await_app(binary) == 345
    with mock.patch('subprocess.check_output', return_value='10 /Applications/Lark.app/Contents/MacOS/Feishu\n'):
        try:
            launcher.await_app(binary, timeout=0)
            raise AssertionError('An unrelated official App was accepted')
        except RuntimeError:
            pass

    expected = f'{os.getuid()} /private/runtime/node {root}/native_asset_bridge.cjs\n'
    for command, accepted in [(expected, True), (expected+' other\n', False),
                              (expected.replace('native_asset_bridge.cjs','native_asset_bridge.cjs.other'), False),
                              (f'{os.getuid()+1} '+expected.split(None,1)[1], False)]:
        with mock.patch('subprocess.run', return_value=mock.Mock(stdout=command)):
            assert launcher.own_helper(222, root, '/private/runtime/node') is accepted

    bridge = mock.Mock(pid=234)
    bridge.poll.return_value = None
    bridge.wait.side_effect = subprocess.TimeoutExpired('fixture', .25)
    with mock.patch.object(launcher, 'status', side_effect=[None, {'pid':999}, {'pid':234}]):
        assert launcher.await_ready(bridge, 'fixture')['pid'] == 234
        assert bridge.wait.call_count == 2
    bridge.poll.return_value = 1
    with mock.patch.object(launcher, 'status') as status:
        assert launcher.await_ready(bridge, 'fixture') is None
        status.assert_not_called()

    # Real localhost HTTP exchange with all proxy routes deliberately invalid.
    # Then leave a TIME_WAIT socket and prove Node can still bind and become ready.
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    token = 'launcher-regression-fixture'
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.headers['Authorization'] == 'Bearer '+token
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({'pid':os.getpid(),'revision':11}).encode())
        def log_message(self, *args): pass
    class Server(HTTPServer): allow_reuse_address = True
    server = Server(('127.0.0.1',0), Handler)
    port = server.server_port
    launcher.STATUS_URL = f'http://127.0.0.1:{port}/status'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with mock.patch.dict(os.environ, {'http_proxy':'http://127.0.0.1:1', 'HTTP_PROXY':'http://127.0.0.1:1', 'NO_PROXY':'', 'no_proxy':''}):
        assert launcher.status(token)['pid'] == os.getpid()
    node = __import__('shutil').which('node')
    fixture = root/'native_asset_bridge.cjs'
    fixture.write_text("require('node:http').createServer((q,r)=>{r.end(JSON.stringify({pid:process.pid,revision:11}))}).listen("+str(port)+",'127.0.0.1')")
    foreign = subprocess.Popen([node,str(fixture)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert launcher.await_ready(foreign, token) is None
    assert foreign.wait(timeout=3) != 0
    assert launcher.status(token)['pid'] == os.getpid()
    server.shutdown(); server.server_close(); thread.join()
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1',port))
            rejected = False
        except OSError:
            rejected = True
    print('Old bind probe rejected without listener:', rejected)
    bridge = subprocess.Popen([node,str(fixture)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        assert launcher.await_ready(bridge, token)['pid'] == bridge.pid
        if __import__('sys').platform == 'darwin':
            assert launcher.own_helper(bridge.pid, root, node)
            launcher.stop_helper(bridge.pid, root, node)
            assert bridge.wait(timeout=3) is not None
            print('Mac kqueue: verified orphan helper terminated')
    finally:
        if bridge.poll() is None: bridge.terminate()
        bridge.wait(timeout=3)

print('Launcher passed: cold/reopen/recovery, exact helper ownership, foreign port refusal, readiness PID, proxy-free HTTP and socket reuse; drafts retained')
