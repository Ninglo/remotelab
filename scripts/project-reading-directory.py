#!/usr/bin/env python3
"""Project-runtime projection into existing directory rows; preserve block IDs and elements."""
import argparse,json,subprocess,xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from collections import Counter

def coverage(config, boards, native_groups):
 configured=set();ready=set()
 for board in boards.get('pairs',[]):
  members=[g['chatId'] for g in board['groups']] if isinstance(board.get('groups'),list) else [board.get('workChatId'),board.get('discussionChatId')]
  members=[m for m in members if m];configured.update(members)
  if 'groups' in board or all(native_groups.get(m) for m in members):ready.update(m for m in members if native_groups.get(m))
 projects={p['id']:p for p in config['projects']};briefs=set()
 for pid,p in projects.items():
  try:
   if p.get('briefUrl') and Path(p.get('briefPath','')).is_file() and Path(p['briefPath']).read_text().strip():briefs.add(pid)
  except (OSError,UnicodeError):pass
 result={}
 for g in config['groups']:
  ids=g.get('projectIds',[]);cid=g['chatId'];brief=any(p in briefs for p in ids)
  enabled=config.get('enabled',False) and config.get('contextEnabled',False)
  scoped=any(d.get('sourceRouteId')==g.get('sourceRouteId') and cid in d.get('chatIds',[]) for d in config.get('directoryGroups',[]))
  directory=(bool(ids) or scoped) and enabled and config.get('directoryEnabled') is True
  injected=brief and enabled
  result[cid]=['已接入' if directory else '不纳入' if g.get('readingLevel')=='excluded' else '未接入',
   '有' if brief else '缺正文' if ids else '未绑定',
   '认知＋目录' if injected and directory else '仅认知' if injected else '仅目录' if directory else '无']
 return result,configured,ready,briefs

def main():
 p=argparse.ArgumentParser();p.add_argument('--runtime',required=True);p.add_argument('--doc',required=True);p.add_argument('--profile',required=True);p.add_argument('--route',default='bot-2');p.add_argument('--output',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--coverage',action='store_true',help='Update directory injection coverage without client mappings');p.add_argument('--boards');p.add_argument('--native-groups');a=p.parse_args()
 assert bool(a.boards)==bool(a.native_groups),'boards and native-groups must be supplied together'
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
 covered=coverage(config,json.load(open(a.boards)) if a.boards else {},json.load(open(a.native_groups)) if a.native_groups else {}) if a.coverage or a.boards else None
 def trail(i):
  names=[];seen=set()
  while i and i not in seen:
   seen.add(i);v=projects[i];names.insert(0,v.get('name',i));i=v.get('parentId')
  return ' → '.join(names)
 labels={'focused':'重点观测','overview':'一般了解','paused':'暂停读取','excluded':'不纳入定时读取'}
 def level(g):return 'paused' if g['projectIds'] and all(projects[i].get('status')=='paused' for i in g['projectIds']) else g.get('readingLevel','focused')
 counts=Counter(level(g) for g in groups.values())
 prefix='群读取配置（统一数据）：'
 summary=prefix+f"重点观测{counts['focused']}群，一般了解{counts['overview']}群，暂停读取{counts['paused']}群，不纳入定时读取{counts['excluded']}条记录（含已解散群）。实际覆盖与失败情况见当日日报。"
 doc=fetch();raw=blocks();byid={b['block_id']:b for b in raw};tree=ET.fromstring('<root>'+doc['content']+'</root>');updates=[];matched=set();expected={}
 (out/'directory-before.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2));(out/'blocks-before.json').write_text(json.dumps(raw,ensure_ascii=False,indent=2))
 def elements(block):return next((v['elements'] for v in block.values() if isinstance(v,dict) and 'elements' in v),None)
 def update(bid,els):updates.append({'block_id':bid,'update_text_elements':{'elements':els}});expected[bid]=els
 def set_text(bid,text):
  old=elements(byid[bid]);assert old is not None
  whole=''.join(e.get('text_run',{}).get('content','') for e in old)
  if whole==text:return
  # Managed status cells contain plain text. Refuse to erase a new human link
  # or non-text element; carry comment anchors across status changes.
  assert all('text_run' in e and not e['text_run'].get('text_element_style',{}).get('link') for e in old),'linked status needs review: '+bid
  comments=[c for e in old for c in e.get('text_run',{}).get('text_element_style',{}).get('comment_ids',[])]
  style=dict(old[0]['text_run'].get('text_element_style',{})) if old else {}
  if comments:style['comment_ids']=comments
  update(bid,[{'text_run':{'content':text,'text_element_style':style}}])
 headers={}
 for table in tree.iter('table'):
  title=next(table.iter('tr'),None)
  if title is not None:
   names=[''.join(c.itertext()).strip() for c in title]
   if covered and '实时看板' in names:
    index=names.index('实时看板');ps=list(title[index].iter('p'))
    assert len(ps)==1 and ps[0].get('id'),'ambiguous legacy coverage header'
    set_text(ps[0].get('id'),'话题目录');names[index]='话题目录'
   for tr in table.iter('tr'):headers[id(tr)]={name:i for i,name in enumerate(names)}
 for tr in tree.iter('tr'):
  cells=tr.findall('td')
  if not cells:continue
  ids=[parse_qs(urlparse(link.get('href','')).query).get('openChatId',[''])[0] for link in cells[0].iter('a')]
  ids=[i for i in ids if i in groups]
  if len(ids)!=1:continue
  g=groups[ids[0]];cols=headers.get(id(tr),{});note_index=cols.get('补充说明')
  assert note_index is not None,'missing notes column'
  if covered:
   for label,value in zip(['话题目录','项目认知','新话题注入'],covered[0][g['chatId']]):
    assert label in cols,'missing coverage column: '+label
    ps=list(cells[cols[label]].iter('p'));assert len(ps)==1 and ps[0].get('id'),'ambiguous status cell'
    set_text(ps[0].get('id'),value)
  ps=[p for p in cells[note_index].iter('p') if p.get('id')]
  if not ps:continue
  bid=ps[-1].get('id');old=elements(byid[bid]);assert old is not None
  # Only our appended element is replaceable; original styles, links and comment_ids remain intact.
  from copy import deepcopy
  whole=''.join(e.get('text_run',{}).get('content','') for e in old)
  if '实时看板' in cols or '话题目录' in cols:
   # The compact table owns a short reading-level prefix, not a repeated
   # hierarchy paragraph. Never append to the last (injection) column.
   old_label=next((v for v in labels.values() if whole.startswith(v)),None)
   if old_label and old_label!=labels[level(g)]:set_text(bid,labels[level(g)]+whole[len(old_label):])
   matched.add(g['chatId']);continue
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
 if covered:
  values,configured,ready,briefs=covered
  summary_marker=next((p for p in tree.iter('p') if ''.join(p.itertext()).startswith('汇总：') and any(term in ''.join(p.itertext()) for term in ('看板','目录注入'))),None)
  if summary_marker is not None:
   scoped=set(groups);configured&=scoped;ready&=scoped
   brief_count=sum(values[cid][1]=='有' for cid in scoped);directory_count=sum('目录' in values[cid][2] for cid in scoped)
   set_text(summary_marker.get('id'),f'汇总：工作目录注入{directory_count}群，项目认知正文覆盖{brief_count}群；按服务端实际接入范围维护，无需客户端群映射。每天04:00核对，有变化原位更新。')
 if covered:
  legend=next((p for p in tree.iter('p') if ''.join(p.itertext()).startswith(('“实时看板”为','“话题目录”为'))),None)
  if legend is not None:
   set_text(legend.get('id'),'“话题目录”为模型可读取并注入的服务端话题记录；“已接入”表示注入通道已启用，不保证已有记录，也不代表覆盖群内全部人工讨论。“项目认知”为已登记正文，“新话题注入”为两者的实际组合。普通成员展示另议。')
 if marker is not None:
  bid=marker.get('id');old=elements(byid[bid]);text=''.join(e.get('text_run',{}).get('content','') for e in old)
  if text!=summary:
   comments=[c for e in old for c in e.get('text_run',{}).get('text_element_style',{}).get('comment_ids',[])]
   update(bid,[{'text_run':{'content':summary,'text_element_style':{'comment_ids':comments} if comments else {}}}])
 missing=[g['chatName'] for cid,g in groups.items() if cid not in matched and g.get('readingReason')!='已解散群']
 (out/'requests.json').write_text(json.dumps({'requests':updates},ensure_ascii=False,indent=2))
 receipt={'updates':len(updates),'matchedGroups':len(matched),'missingDirectoryRows':missing,'applied':False}
 if covered:
  receipt['directoryCoverage']={'enabled':sum(covered[0][c][0]=='已接入' for c in groups),'briefs':sum(covered[0][c][1]=='有' for c in groups)}
  if a.boards:receipt['nativeDisplayEvidence']={'configured':len(covered[1]&set(groups)),'nativeLinked':len(covered[2]&set(groups)),'pending':[groups[c]['chatName'] for c in covered[1]-covered[2] if c in groups]}
 if a.apply:
  latest=fetch();assert latest['revision_id']==doc['revision_id'],'document changed while preparing'
  if updates:
   revision=doc['revision_id']
   for start in range(0,len(updates),200):
    body=json.dumps({'requests':updates[start:start+200]},ensure_ascii=False)
    response=cli(['api','PATCH',f'/open-apis/docx/v1/documents/{a.doc}/blocks/batch_update','--params',json.dumps({'document_revision_id':revision}),'--data',body])
    (out/f'batch-receipt-{start//200}.json').write_text(json.dumps(response,ensure_ascii=False,indent=2))
    revision=response['document_revision_id']
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
