"""Exercise launch decisions without stopping any real application or helper."""
import json
import os
import pathlib
import runpy
import tempfile
import unittest.mock as mock
import urllib.error

script = pathlib.Path(__file__).resolve().parents[1]/'scripts/feishu-native/launch.py'
with tempfile.TemporaryDirectory(prefix='feishu-launch-') as tmp:
 home=pathlib.Path(tmp);root=home/'Library/Application Support/RemoteLab/Feishu Native Trial';root.mkdir(parents=True)
 app=root/'Feishu Native Trial.app';binary=app/'Contents/MacOS/Feishu'
 (root/'native-v8-deployment.json').write_text('{"revision":9}')
 (root/'native-asset-capability').write_text('fixture-only')
 (root/'node-path').write_text('/private/runtime/node')
 for running in (False,True):
  rows=f'123 {binary}\n' if running else '1 /sbin/launchd\n'
  with mock.patch.dict(os.environ,{'RLFE_INSTALL_HOME':str(home)}), mock.patch('subprocess.check_output',return_value=rows), mock.patch('urllib.request.urlopen',side_effect=urllib.error.URLError('offline')), mock.patch('subprocess.run') as run, mock.patch('subprocess.Popen') as popen, mock.patch('socket.socket'), mock.patch('fcntl.flock'):
   popen.return_value.pid=234
   try: runpy.run_path(str(script))
   except SystemExit as e: assert e.code==0
   if running:
    popen.assert_not_called()
    run.assert_called_once_with(['/usr/bin/open','-a',str(app)],check=True)
   else:
    run.assert_not_called()
    assert popen.call_count==3
    calls=popen.call_args_list
    assert calls[0].args[0][0]=='/private/runtime/node'
    assert calls[0].kwargs['env']['RLFE_TRIAL_ROOT']==str(root)
    assert calls[1].args[0]==[str(binary),'--user-data-dir='+str(home/'Library/Application Support/RlfeTrial')]
    assert calls[2].args[0][0]==__import__('sys').executable
    assert json.loads((root/'started.json').read_text())['profile'].startswith(tmp)
print('Launcher: one cold start, private runtime/root, existing process activated without restart')
