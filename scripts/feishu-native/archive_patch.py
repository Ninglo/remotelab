import struct,json,hashlib

def patch_archive(original,loader):
 a,b,c,d=struct.unpack('<4I',original[:16]);header=json.loads(original[16:16+d]);body=bytearray(original[8+b:]);changes=[]
 assert a==4 and b>=8 and 16+d<=8+b<=len(original),'Invalid ASAR header'
 assert 'remotelab-native-v7.js' not in header['files'],'Archive already patched'
 def integrity(data,old):
  if 'integrity' not in old:return
  bs=old['integrity'].get('blockSize',4194304);old['integrity']={'algorithm':'SHA256','hash':hashlib.sha256(data).hexdigest(),'blockSize':bs,'blocks':[hashlib.sha256(data[i:i+bs]).hexdigest() for i in range(0,len(data),bs)]}
 for kind in ['messenger','messenger-chat']:
  count_before=len(changes)
  for locale,entry in header['files'][kind]['files'].items():
   if not locale.endswith('.html'):continue
   s=int(entry['offset']);raw=bytes(body[s:s+entry['size']]);assert b'remotelab-native-v7.js' not in raw,'Already patched: inspect instead of duplicating'
   assert b'</body>' in raw
   tag=b'<script defer src="native-resource://sandbox_fs/webcontent/messenger/remotelab-native-v7.js"></script>'
   data=raw.replace(b'</body>',tag+b'</body>');entry['offset']=str(len(body));entry['size']=len(data);integrity(data,entry);body.extend(data);changes.append(kind+'/'+locale)
  assert len(changes)>count_before,'Missing native HTML entry points: '+kind
 header['files']['remotelab-native-v7.js']={'size':len(loader),'offset':str(len(body))};body.extend(loader)
 h=json.dumps(header,ensure_ascii=False,separators=(',',':')).encode();hp=struct.pack('<I',len(h))+h;hp+=b'\0'*((-len(hp))%4);pick=struct.pack('<I',len(hp))+hp;packed=struct.pack('<II',4,len(pick))+pick+body
 # Check all unchanged entries still resolve to exactly the same bytes.
 changed=set(changes+['remotelab-native-v7.js']);verified=0
 oldHeader=json.loads(original[16:16+d]);newStart=8+len(pick)
 def check(tree,previous,pre=''):
  nonlocal verified
  for key,v in previous.get('files',{}).items():
   p=pre+key;n=tree['files'][key]
   if 'files' in v:check(n,v,p+'/')
   elif 'offset' in v and p not in changed:
    oldData=original[8+b+int(v['offset']):8+b+int(v['offset'])+v['size']];newData=packed[newStart+int(n['offset']):newStart+int(n['offset'])+n['size']];assert oldData==newData,p;verified+=1
 check(header,oldHeader)
 return packed,{"htmlsPatched":changes,"unchangedEntriesVerified":verified}
