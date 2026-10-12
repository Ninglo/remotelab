"""Native process exit observation; no polling or scheduled AI work."""
import os,select,signal,subprocess,sys,pathlib
app_pid,bridge_pid=map(int,sys.argv[1:]);r=pathlib.Path.home()/'Library/Application Support/RemoteLab/Feishu Native Trial'
try:
 q=select.kqueue();q.control([select.kevent(app_pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],0,0);q.control([],1,None);q.close()
except ProcessLookupError:pass
cmd=subprocess.run(['/bin/ps','-p',str(bridge_pid),'-o','command='],capture_output=True,text=True).stdout
if str(r/'native_asset_bridge.cjs') in cmd:os.kill(bridge_pid,signal.SIGTERM)
