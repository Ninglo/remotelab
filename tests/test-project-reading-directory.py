"""Exercise real sync entry against a fake provider, including a reordered table."""
import json,os,pathlib,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
 p=pathlib.Path(temp);state=p/'state.json'
 headers=['群与入口','用途','实时看板','项目认知','新话题注入','机器人状态','补充说明']
 values=['A','讨论','未配置','未绑定','无','主动参与','重点观测；人的说明保留']
 blocks=[{'block_id':'s','text':{'elements':[{'text_run':{'content':'群读取配置（统一数据）：旧'}}]}}]
 for i,v in enumerate(values):blocks.append({'block_id':str(i),'text':{'elements':[{'text_run':{'content':v,'text_element_style':{'comment_ids':['comment']} if i==2 else {}}}]}})
 state.write_text(json.dumps({'revision':1,'blocks':blocks,'writes':0}))
 fake='''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['FAKE_STATE']);s=json.loads(p.read_text());args=sys.argv
if '+fetch' in args:
 h=json.loads(os.environ['FAKE_HEADERS']);byid={b['block_id']:b for b in s['blocks']};txt=lambda i: ''.join(e['text_run']['content'] for e in byid[str(i)]['text']['elements'])
 cells=[]
 for i in range(7):
  content=txt(i)
  if i==0:content='<a href="https://applink.feishu.cn/client/chat/open?openChatId=a">A</a>'
  cells.append('<td><p id="'+str(i)+'">'+content+'</p></td>')
 content='<p id="s">'+txt('s')+'</p><table><tr>'+''.join('<th>'+v+'</th>' for v in h)+'</tr><tr>'+''.join(cells)+'</tr></table>'
 data={'document':{'content':content,'revision_id':s['revision']}}
elif 'PATCH' in args:
 body=json.loads(args[args.index('--data')+1]);params=json.loads(args[args.index('--params')+1]);assert params['document_revision_id']==s['revision']
 for req in body['requests']:
  next(b for b in s['blocks'] if b['block_id']==req['block_id'])['text']['elements']=req['update_text_elements']['elements']
 s['revision']+=1;s['writes']+=1;p.write_text(json.dumps(s));data={'document_revision_id':s['revision']}
else:data={'items':s['blocks'],'has_more':False}
print(json.dumps({'ok':True,'data':data}))
'''
 (p/'lark-cli').write_text(fake);(p/'lark-cli').chmod(0o700)
 brief=p/'brief.md';brief.write_text('Real brief')
 config={'enabled':True,'contextEnabled':True,'projects':[{'id':'p','name':'P','briefPath':str(brief),'briefUrl':'https://example.com/doc'}],'groups':[{'chatId':'a','chatName':'A','sourceRouteId':'bot-2','projectIds':['p'],'readingLevel':'focused'}]}
 for name,value in [('runtime',config),('boards',{'pairs':[{'id':'p','groups':[{'chatId':'a'}]}]}),('native',{'a':'native-a'})]: (p/(name+'.json')).write_text(json.dumps(value))
 env={**os.environ,'PATH':str(p)+os.pathsep+os.environ['PATH'],'FAKE_STATE':str(state),'FAKE_HEADERS':json.dumps(headers)}
 command=['python',str(ROOT/'scripts/project-reading-directory.py'),'--runtime',str(p/'runtime.json'),'--boards',str(p/'boards.json'),'--native-groups',str(p/'native.json'),'--doc','fixture','--profile','bot-2','--output',str(p/'out'),'--apply']
 subprocess.run(command,env=env,check=True,capture_output=True)
 first=json.loads(state.read_text());assert first['writes']==1
 byid={b['block_id']:b for b in first['blocks']};text=lambda i:''.join(e['text_run']['content'] for e in byid[str(i)]['text']['elements'])
 assert text(2)=='已配置' and text(3)=='有' and text(4)=='认知＋目录'
 assert text(6)==values[6] and text(5)==values[5]
 assert byid['2']['text']['elements'][0]['text_run']['text_element_style']['comment_ids']==['comment']
 subprocess.run(command,env=env,check=True,capture_output=True)
 assert json.loads(state.read_text())==first,'second run must produce no writes'
 print('Directory reordered columns, notes/comments preservation, readback and no-change run passed.')
