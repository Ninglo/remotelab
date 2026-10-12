"""Real HTTP failures: resume verified parts, reject corruption, fall back by Range."""
import collections
import hashlib
import http.server
import pathlib
import shlex
import socket
import subprocess
import tempfile
import threading

payload = bytes(range(256)) * 16000
chunk_size = 1024*1024
parts = [payload[i:i+chunk_size] for i in range(0,len(payload),chunk_size)]
whole = hashlib.sha256(payload).hexdigest()
counts = collections.Counter()
mode = 'fail'
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  counts[self.path]+=1
  if self.path=='/upstream':
   start,end=map(int,self.headers['Range'][6:].split('-'))
   data=payload[start:end+1]
   self.send_response(206);self.send_header('Content-Length',str(len(data)));self.send_header('Content-Range',f'bytes {start}-{end}/{len(payload)}');self.end_headers();self.wfile.write(data);return
  index=int(self.path.rsplit('/',1)[1]);data=parts[index]
  if mode=='fallback' or (mode=='fail' and index==1):
   self.send_response(520);self.end_headers();return
  if index==2 and counts[self.path]==1:
   self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data[:40000]);self.wfile.flush();self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
  if index==3 and counts[self.path]==1:data=b'corrupt response'
  self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
source=pathlib.Path(__file__).resolve().parents[1]/'scripts/feishu-native/bootstrap.sh'
manifest='\n'.join(f'{i:04d} {hashlib.sha256(b).hexdigest()} {i*chunk_size} {i*chunk_size+len(b)-1}' for i,b in enumerate(parts))
case=whole+") cat <<'RLFE_PARTS'\n"+manifest+'\nRLFE_PARTS\n;;'
script=source.read_text().replace('__PUBLIC_BASE__',base).replace('__DOWNLOAD_PARTS__',case).replace('\nmain "$@"\n','\n')
# Tests use loopback HTTP for the exact upstream range code path; releases only
# accept their pinned HTTPS upstream arguments.
script=script.replace('https://*) upstream=', 'http://*) upstream=')
try:
 with tempfile.TemporaryDirectory(prefix='feishu-download-') as tmp:
  root=pathlib.Path(tmp);file=root/'download.sh';file.write_text(script)
  destination=root/'python.tar.gz'
  def run(upstream='bundle.zip'):
   cmd=f'source {shlex.quote(str(file))}; download {shlex.quote(upstream)} {whole} {shlex.quote(str(destination))}'
   return subprocess.run(['/bin/bash','-c',cmd],capture_output=True,text=True,timeout=20)
  first=run();assert first.returncode!=0 and not destination.exists(),first
  goodpath=f'/chunks/{whole}/0000';before=counts[goodpath]
  assert (pathlib.Path(str(destination)+'.chunks')/whole/'0000').read_bytes()==parts[0]
  mode='healthy'
  second=run();assert second.returncode==0,second.stderr
  assert destination.read_bytes()==payload and counts[goodpath]==before
  beforeall=sum(counts.values());assert run().returncode==0 and sum(counts.values())==beforeall
  # A corrupted cached part must not be reused; upstream fallback remains pinned.
  destination.unlink();(pathlib.Path(str(destination)+'.chunks')/whole/'0000').write_bytes(b'bad cached part')
  mode='fallback'
  final=run(base+'/upstream');assert final.returncode==0,final.stderr
  assert destination.read_bytes()==payload and counts['/upstream']==1
  print('PASS: 520, truncated body, bad checksum, cross-run resume, cache reuse, corrupted cache and bounded upstream Range fallback')
finally:server.shutdown();server.server_close()
