// MAIN world, before Feishu loads. Adapt only the native FeedList module;
// never replace rows, mutate its store, or write its read/completion state.
(() => {
  if (globalThis.__RLFE_NATIVE_SORT__) return;
  const listeners = new Set(), wrapped = new WeakSet(), modes = new Set(['native','group','status','topic']);
  let mode='native', entries=new Map(), revision=0, alive=true, reportKey='';
  const read=(o,k)=>typeof o?.get==='function'?o.get(k):o?.[k];
  const emit=state=>{const detail=JSON.stringify(state);if(detail!==reportKey){reportKey=detail;document.documentElement?.setAttribute('data-rlfe-native-sort',detail);}};
  function notify(){revision++;for(const listener of listeners)listener();}
  function receive(event){try{const p=JSON.parse(event.detail);if(modes.has(p.mode))mode=p.mode;
    if(Array.isArray(p.entries))entries=new Map(p.entries.filter(e=>/^\d{10,30}$/.test(e.id)).map(e=>[e.id,{status:String(e.status||''),stale:e.stale===true}]));notify();
  }catch{}}
  window.addEventListener('rlfe:native-sort-input',receive);
  function pageState(props){
    const state=globalThis.__feedStore?.getState?.();
    const module=state&&Object.values(state).find(m=>m&&String(m.type)===String(props.filterId)&&m.list?.feedCursor);
    const cursor=module?.list?.feedCursor;
    return {complete:!!module?.inited&&String(cursor?.id)==='0'&&String(cursor?.rankTime)==='0',cursor:cursor?JSON.stringify(cursor):null};
  }
  function ordered(props){
    if(mode==='native')return props.list;
    const rows=props.list.map((row,index)=>{const p=props.getPreviewById(row.id),e=entries.get(String(row.id));
      const type=read(p,'type'),entity=read(p,'entityType'),topic=(entity===1&&type===4)||(entity===3&&type===11);
      return {row,index,topic,group:String(topic?read(p,'chatId')||'':type===1&&read(p,'chatType')===2?row.id:''),recent:Number(read(p,'displayTime')||0),status:e&&!e.stale?e.status:'',
        fixed:!p||!row.isPreviewKind||row.disableAutoActivation===true||row.bizParentId!=null||row.parentId!=null||row.tempTopPos!=null||Number(read(p,'onTopRankTime')||0)>0};
    });
    const rank={waiting:0,blocked:0,error:0,review:1,running:2,idle:3,done:4};
    const result=[];let run=[];
    function flush(){
      const groupTimes=new Map();for(const r of run)if(r.group)groupTimes.set(r.group,Math.max(groupTimes.get(r.group)||0,r.recent));
      run.sort((a,b)=>{
        let delta=0;
        if(mode==='status')delta=(rank[a.status]??5)-(rank[b.status]??5);
        if(mode==='topic')delta=Number(b.topic)-Number(a.topic);
        if(mode==='group'&&a.group!==b.group)delta=(Number(!!b.group)-Number(!!a.group))||(groupTimes.get(b.group)||0)-(groupTimes.get(a.group)||0)||a.group.localeCompare(b.group);
        return delta||b.recent-a.recent||a.index-b.index;
      });result.push(...run.map(r=>r.row));run=[];
    }
    for(const r of rows){if(r.fixed){flush();result.push(r.row);}else run.push(r);}flush();
    return result.every((r,i)=>r===props.list[i])?props.list:result;
  }
  function enhance(React,render,getComponent){
    return function(props,ref){
      // Checked at first mount, before any hooks. displayName is fixed by Feishu.
      if(getComponent()?.displayName!=='[Render] FeedList')return render(props,ref);
      const [,refresh]=React.useReducer(n=>n+1,0);
      const loading=React.useRef({key:'',seen:new Set(),started:0,error:''});
      React.useEffect(()=>{listeners.add(refresh);refresh();return()=>listeners.delete(refresh);},[]);
      const valid=Array.isArray(props.list)&&typeof props.getPreviewById==='function';
      const page=valid?pageState(props):{complete:false,cursor:null};
      const key=String(props.filterId)+':'+mode;
      if(loading.current.key!==key)loading.current={key,seen:new Set(),started:0,error:''};
      const pending=loading.current;
      React.useEffect(()=>{
        if(!alive||mode==='native'||!valid||page.complete||pending.error)return;
        if(!page.cursor||typeof props.loadmore!=='function'){pending.error='当前分组暂不支持排序';refresh();return;}
        if(pending.seen.has(page.cursor))return;
        if(pending.seen.size>=50){pending.error='列表尚未载完，保留飞书顺序';refresh();return;}
        pending.seen.add(page.cursor);pending.started||=Date.now();
        try{Promise.resolve(props.loadmore()).catch(()=>{pending.error='列表加载失败，保留飞书顺序';refresh();});}catch{pending.error='列表加载失败，保留飞书顺序';refresh();}
      },[key,page.cursor,page.complete,valid]);
      React.useEffect(()=>{
        if(!alive||mode==='native'||!valid||page.complete||pending.error)return;
        const timer=setTimeout(()=>{pending.error='列表加载未完成，保留飞书顺序';refresh();},Math.max(0,30000-(Date.now()-(pending.started||Date.now()))));
        return()=>clearTimeout(timer);
      },[key,page.complete,pending.error]);
      const sorted=React.useMemo(()=>alive&&valid&&page.complete&&!pending.error?ordered(props):props.list,[props.list,props.getPreviewById,key,revision,page.complete,pending.error]);
      React.useEffect(()=>{emit({hooked:true,filter:String(props.filterId),mode,complete:page.complete,total:props.list?.length||0,applied:mode!=='native'&&page.complete&&!pending.error,error:pending.error,topicsOnly:valid&&props.list.length>0&&props.list.every(r=>{const p=props.getPreviewById(r.id);return read(p,'type')===4||read(p,'type')===11;})});});
      return render(sorted===props.list?props:{...props,list:sorted},ref);
    };
  }
  function instrument(chunk){
    const modules=chunk?.[1];if(!modules||typeof modules!=='object')return;
    for(const id of Object.keys(modules)){
      const factory=modules[id];if(typeof factory!=='function'||wrapped.has(factory)||!Function.prototype.toString.call(factory).includes('[Render] FeedList'))continue;
      const replacements=new WeakMap();
      const replacement=function(module,exports,require){
        const scoped=new Proxy(require,{apply(target,that,args){
          const value=Reflect.apply(target,that,args);
          if(!value||typeof value.forwardRef!=='function'||typeof value.useReducer!=='function')return value;
          if(!replacements.has(value)){
            const local=Object.create(value);
            Object.defineProperty(local,'forwardRef',{value(fn){let component;const adapted=enhance(value,fn,()=>component);component=value.forwardRef(adapted);return component;}});
            replacements.set(value,local);
          }return replacements.get(value);
        }});
        return factory.call(this,module,exports,scoped);
      };
      wrapped.add(replacement);modules[id]=replacement;
    }
  }
  const queue=globalThis.webpackChunkLarkletMessenger=globalThis.webpackChunkLarkletMessenger||[];
  // Webpack replaces push when its runtime arrives. Preserve that setter and
  // instrument future chunks regardless of runtime/chunk arrival order.
  let push=queue.push;
  Object.defineProperty(queue,'push',{configurable:true,get(){const current=push;return function(...chunks){for(const chunk of chunks)instrument(chunk);return current.apply(this,chunks);};},set(value){push=value;}});
  for(const chunk of queue)instrument(chunk);
  globalThis.__RLFE_NATIVE_SORT__={cleanup(){mode='native';alive=false;notify();window.removeEventListener('rlfe:native-sort-input',receive);},status:()=>({mode,subscribers:listeners.size})};
  emit({hooked:false,mode:'native',error:'刷新飞书页面后启用排序'});
})();
