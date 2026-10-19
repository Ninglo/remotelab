#!/usr/bin/env python3
"""On-demand read-only evidence for registered local SSH accounts. Never accepts paths."""
import os,sys,pwd,pathlib,json,hashlib,sqlite3,stat

def evidence(account,selected=None):
 u=pwd.getpwnam(account)
 if not u.pw_dir.startswith('/data/home/') or pathlib.Path(u.pw_dir).name!=account:raise ValueError('not a registered employee account')
 base=pathlib.Path(u.pw_dir)/'.codex/memories';files=[]
 if base.exists() and base.resolve()!=base:raise ValueError('aliased memory root')
 if base.is_dir() and not base.is_symlink():
  for root,dirs,names in os.walk(base,followlinks=False):
   dirs[:]=[d for d in dirs if d!='.git' and not pathlib.Path(root,d).is_symlink()]
   for name in names:
    p=pathlib.Path(root,name)
    if p.suffix!='.md' or p.is_symlink():continue
    if len(files)>=2000:raise ValueError('inventory exceeds limit')
    files.append({'id':hashlib.sha256(str(p).encode()).hexdigest()[:16],'name':str(p.relative_to(base)),'_path':p})
 if selected:
  f=next((f for f in files if f['id']==selected),None)
  if not f:raise ValueError('file outside registered memory scope')
  p=f['_path'];resolved=p.resolve(strict=True)
  if not resolved.is_relative_to(base.resolve(strict=True)):raise ValueError('path changed')
  parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
  try:
   for part in p.parts[1:-1]:
    nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);os.close(parent);parent=nxt
   fd=os.open(p.name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
  finally:os.close(parent)
  with os.fdopen(fd,'rb') as h:
   s=os.fstat(h.fileno())
   if not stat.S_ISREG(s.st_mode) or s.st_size>2*1024*1024:raise ValueError('file exceeds preview limit')
   body=h.read(2*1024*1024+1).decode('utf-8')
   if '\0' in body:raise ValueError('not text')
  return {'name':f['name'],'body':body,'mode':oct(stat.S_IMODE(s.st_mode))}
 return {'account':account,'files':[{k:v for k,v in f.items() if k!='_path'} for f in files]}
if __name__=='__main__':
 try:print(json.dumps(evidence(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None),ensure_ascii=False))
 except (OSError,ValueError,KeyError,IndexError):print(json.dumps({'error':'该账号或文件当前不可读'}));sys.exit(1)
