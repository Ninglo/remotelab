"""Launch only the independent test copy and its private display bridge."""
import pathlib,json,subprocess,urllib.request,fcntl,socket,sys,os
# Serialize double clicks without changing or stopping an existing App.
lock=None
trial_home=pathlib.Path(os.environ.get('RLFE_INSTALL_HOME',str(pathlib.Path.home())))
r=trial_home/'Library/Application Support/RemoteLab/Feishu Native Trial'
app=r/'Feishu Native Trial.app';binary=app/'Contents/MacOS/Feishu'
lock=(r/'launcher.lock').open('a')
fcntl.flock(lock,fcntl.LOCK_EX)
def focus(pid):
 # Only activate an already running exact-path App. A cold start uses one
 # direct launch; a second LaunchServices launch during startup drops flags.
 subprocess.run(['/usr/bin/open','-a',str(app)],check=True)
deployment=json.loads((r/'native-v8-deployment.json').read_text())
revision=deployment['revision']
rows=subprocess.check_output(['/bin/ps','-axo','pid=,comm='],text=True).splitlines()
pids=[int(x.strip().split(None,1)[0]) for x in rows if x.strip().split(None,1)[1]==str(binary)]
cap=(r/'native-asset-capability').read_text().strip()
def status():
 req=urllib.request.Request('http://127.0.0.1:19342/status',headers={'Authorization':'Bearer '+cap})
 return json.load(urllib.request.urlopen(req,timeout=2))
try:connected=status()
except Exception:connected=None
if pids:
 focus(pids[0])
 if connected:print('已打开飞书增强版，第 '+str(connected.get('revision',revision))+' 版。')
 else:print('试验窗口仍在运行，但显示服务没有连接。为保留当前输入，本次未重启；退出试验副本后再打开此入口。')
 raise SystemExit(0)
if connected:raise SystemExit('上次显示服务尚未退出；未启动第二份服务。')
with socket.socket() as probe:
 try:probe.bind(('127.0.0.1',19342))
 except OSError:raise SystemExit('19342 端口被其他程序占用；未启动第二份服务。')
with (r/'native-asset-bridge.log').open('ab') as log:
 bridge=subprocess.Popen([(r/'node-path').read_text().strip() if (r/'node-path').exists() else '/usr/local/bin/node',str(r/'native_asset_bridge.cjs')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env={**os.environ,'RLFE_TRIAL_ROOT':str(r)})
with (r/'startup.log').open('ab') as log:
 proc=subprocess.Popen([str(binary),'--user-data-dir='+str(trial_home/'Library/Application Support/RlfeTrial')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
(r/'started.json').write_text(json.dumps({'pid':proc.pid,'app':str(app),'profile':str(trial_home/'Library/Application Support/RlfeTrial'),'revision':revision,'bridgePid':bridge.pid}))
with (r/'native-app-observer.log').open('ab') as log:
 subprocess.Popen([sys.executable,str(r/'observe_native_app.py'),str(proc.pid),str(bridge.pid)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
print('已启动飞书增强版，第 '+str(revision)+' 版。')
