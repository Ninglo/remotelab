#!/usr/bin/env python3
"""Project-runtime projection into existing directory rows; preserve block IDs and elements."""
import argparse,json,subprocess,xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from collections import Counter

def main():
 p=argparse.ArgumentParser();p.add_argument('--runtime',required=True);p.add_argument('--doc',required=True);p.add_argument('--profile',required=True);p.add_argument('--route',default='bot-2');p.add_argument('--output',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
 out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
 def cli(args):
  r=subprocess.run(['lark-cli','--profile',a.profile]+args+['--as','bot','--format','json'],capture_output=True,text=True,timeout=90)
  try:d=json.loads(r.stdout)
  except:raise RuntimeError(r.stderr[:500])
  if r.returncode or not d.get('ok'):raise RuntimeError(json.dumps(d,ensure_ascii=False)[:1000])
  return d['data']
 def fetch():return cli(['docs','+fetch','--doc',a.doc,'--detail','full'])['document']
 def blocks():
  result=[];token='';seen=set()
  while True:
   params={'page_size':500}
   if token:params['page_token']=token
   d=cli(['api','GET',f'/open-apis/docx/v1/documents/{a.doc}/blocks','--params',json.dumps(params)])
   result+=d['items']
   if not d.get('has_more'):break
   token=d.get('page_token');assert token and token not in seen,'incomplete block pagination';seen.add(token)
  return result
 config=json.load(open(a.runtime));groups={g['chatId']:g for g in config['groups'] if g['sourceRouteId']==a.route};projects={p['id']:p for p in config['projects']}
 def trail(i):
  names=[];seen=set()
  while i and i not in seen:
   seen.add(i);v=projects[i];names.insert(0,v.get('name',i));i=v.get('parentId')
  return ' → '.join(names)
 labels={'focused':'重点观测','overview':'一般了解','paused':'暂停读取','excluded':'不纳入定时读取'}
 def level(g):return 'paused' if g['projectIds'] and all(projects[i].get('status')=='paused' for i in g['projectIds']) else g.get('readingLevel','focused')
 counts=Counter(level(g) for g in groups.values())
 prefix='群读取配置（统一数据）：'
 summary=prefix+f"重点观测{counts['focused']}群，一般了解{counts['overview']}群，暂停读取{counts['paused']}群，不纳入定时读取{counts['excluded']}条记录（含已解散群）。群卡、扫描计划与本目录共用项目登记数据；下表补充说明中的“读取配置”表示计划层级，实际读了什么、限量或失败情况由当轮日报披露。"
 doc=fetch();raw=blocks();byid={b['block_id']:b for b in raw};tree=ET.fromstring('<root>'+doc['content']+'</root>');updates=[];matched=set();expected={}
 (out/'directory-before.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2));(out/'blocks-before.json').write_text(json.dumps(raw,ensure_ascii=False,indent=2))
 def elements(block):return next((v['elements'] for v in block.values() if isinstance(v,dict) and 'elements' in v),None)
 def update(bid,els):updates.append({'block_id':bid,'update_text_elements':{'elements':els}});expected[bid]=els
 for tr in tree.iter('tr'):
  cells=tr.findall('td')
  if not cells:continue
  ids=[parse_qs(urlparse(link.get('href','')).query).get('openChatId',[''])[0] for link in cells[0].iter('a')]
  ids=[i for i in ids if i in groups]
  if len(ids)!=1:continue
  g=groups[ids[0]];ps=[p for p in cells[-1].iter('p') if p.get('id')]
  if not ps:continue
  bid=ps[-1].get('id');old=elements(byid[bid]);assert old is not None
  # Only our appended element is replaceable; original styles, links and comment_ids remain intact.
  from copy import deepcopy
  whole=''.join(e.get('text_run',{}).get('content','') for e in old)
  cut=whole.find('\n读取配置：');retained=[];remaining=cut if cut>=0 else len(whole)
  for e in old:
   text=e.get('text_run',{}).get('content','')
   if not text:
    retained.append(deepcopy(e));continue
   if remaining<=0:break
   part=deepcopy(e);part['text_run']['content']=text[:remaining];retained.append(part);remaining-=len(text)
  retained_comments={c for e in retained for c in e.get('text_run',{}).get('text_element_style',{}).get('comment_ids',[])}
  suffix_comments=[c for e in old for c in e.get('text_run',{}).get('text_element_style',{}).get('comment_ids',[]) if c not in retained_comments]
  suffix='\n读取配置：'+('；'.join(trail(i) for i in g['projectIds']) or '项目归属待明确')+'｜'+labels[level(g)]
  if level(g) in ('paused','excluded'):suffix+='（'+g.get('readingReason','保留原状态')+'）'
  els=retained+[{'text_run':{'content':suffix,'text_element_style':{'comment_ids':suffix_comments} if suffix_comments else {}}}]
  if whole!=''.join(e.get('text_run',{}).get('content','') for e in els):update(bid,els)
  matched.add(g['chatId'])
 marker=next((p for p in tree.iter('p') if ''.join(p.itertext()).startswith(prefix)),None)
 if marker is not None:
  bid=marker.get('id');old=elements(byid[bid]);text=''.join(e.get('text_run',{}).get('content','') for e in old)
  if text!=summary:
   comments=[c for e in old for c in e.get('text_run',{}).get('text_element_style',{}).get('comment_ids',[])]
   update(bid,[{'text_run':{'content':summary,'text_element_style':{'comment_ids':comments} if comments else {}}}])
 missing=[g['chatName'] for cid,g in groups.items() if cid not in matched and g.get('readingReason')!='已解散群']
 (out/'requests.json').write_text(json.dumps({'requests':updates},ensure_ascii=False,indent=2))
 receipt={'updates':len(updates),'matchedGroups':len(matched),'missingDirectoryRows':missing,'applied':False}
 if a.apply:
  latest=fetch();assert latest['revision_id']==doc['revision_id'],'document changed while preparing'
  if updates:
   body=json.dumps({'requests':updates},ensure_ascii=False)
   response=cli(['api','PATCH',f'/open-apis/docx/v1/documents/{a.doc}/blocks/batch_update','--params',json.dumps({'document_revision_id':doc['revision_id']}),'--data',body])
   (out/'batch-receipt.json').write_text(json.dumps(response,ensure_ascii=False,indent=2))
  if marker is None:
   from html import escape
   first=next(tree.iter('p')).get('id')
   content='<h2>项目层级与群读取范围</h2><p>'+escape(summary)+'</p><p>AI 板块是可以没有群的上层项目；Claude Tag、RemoteLab等沿现有项目索引归入上层。一个群可承载一个子项目，同一项目也可有多个协作群。归属证据不足时保持待明确，不凭群名新建项目。</p><p>重点观测：深入读取相关话题与资料，支撑项目认知和日报分析。一般了解：前24小时新增主线最多50条，不展开话题、附件或表情，不作其他分析信源；超出限额标限量读取。新发现适用群默认一般了解，升级重点观测需明确决定。暂停与排除保持。</p>'
   cli(['docs','+update','--doc',a.doc,'--command','block_insert_after','--block-id',first,'--content',content])
  after=blocks();afterids={b['block_id']:b for b in after}
  assert set(byid)<=set(afterids),'original blocks were removed'
  def semantic(els):
   return (''.join(e.get('text_run',{}).get('content','') for e in els),sorted(c for e in els for c in e.get('text_run',{}).get('text_element_style',{}).get('comment_ids',[])))
  for bid,els in expected.items():assert semantic(elements(afterids[bid]))==semantic(els),'readback differs '+bid
  for bid,b in byid.items():
   if bid not in expected and elements(b) is not None:assert elements(afterids[bid])==elements(b),'unrelated text changed '+bid
  final=fetch();(out/'directory-after.json').write_text(json.dumps(final,ensure_ascii=False,indent=2))
  assert prefix in final['content'];receipt.update(applied=True,verifiedBlocks=len(expected),revision=final['revision_id'])
 (out/'result.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2));print(json.dumps(receipt,ensure_ascii=False))
if __name__=='__main__':main()
