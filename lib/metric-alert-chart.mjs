import { readFile } from 'node:fs/promises';

// Use the same renderer, CSS and already-collected numeric daily data as Monitor.
// No authenticated page fetch, extra scan, or screenshot of text disguised as a chart.
export const METRIC_CHART_VERSION = 2;

export async function renderMetricAlertChart(page, dashboard, metrics) {
  const css=await readFile(new URL('../static/chat/agent-monitor-dashboard.css',import.meta.url),'utf8');
  const js=await readFile(new URL('../static/chat/agent-monitor-dashboard.js',import.meta.url),'utf8');
  await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>${css}
    body{margin:0;background:white;font:16px sans-serif;--accent:#087f83;--text:#172b2c;--text-secondary:#536568;--text-muted:#536568;--border:#d7e4e4;--bg:#fff;--bg-secondary:#f4f9f9}
    main{padding:20px;width:600px;box-sizing:border-box}h1{font-size:24px;margin:0 0 12px}.agent-metrics{grid-template-columns:1fr}.agent-metric h4{font-size:19px}.agent-note{font-size:14px}.agent-metric svg{max-height:175px}.agent-metric details,.agent-stage-control,.agent-metric .agent-value{display:none}.agent-metric{padding:14px}.agent-metric h4{margin:0 0 6px}.agent-metric p{margin:5px 0}
    </style><main><h1>上下文与响应 · 近五日总览</h1><div id="chart"></div><p class="agent-note" id="at"></p><p class="agent-note">沿用监管页面的全量均值；后续轮及同类任务预警见正文。此图聚焦近五日，完整历史可打开监管页面。今天尚未结束。</p></main></html>`);
  await page.addScriptTag({content:js});
  await page.evaluate(({dashboard,metrics})=>{
    const root=document.querySelector('#chart');
    window.RemoteLabAgentDashboard.render(root,{...dashboard,days:dashboard.days.slice(-5)});
    const keys=new Set(metrics.flatMap(m=>m==='injectionChars'?['firstInjectionChars']:m==='firstResponseMs'?['meanFirstResponseMs']:['meanDeliveryMs']));
    root.querySelectorAll('[data-metric]').forEach(card=>{if(!keys.has(card.dataset.metric))card.remove();});
    [...root.children].forEach(child=>{if(!child.classList.contains('agent-metrics'))child.remove();});
    root.querySelectorAll('.agent-metric').forEach(card => {
      card.querySelectorAll(':scope > p')[1]?.remove();
      const key=card.dataset.metric;
      const values=dashboard.days.slice(-5).filter(d=>Number.isFinite(d[key]));
      const last=values.at(-1);
      if(last){const label=document.createElement('p');label.className='agent-note';label.textContent=`最新：${last.day} · ${key.endsWith('Ms') ? (last[key]/1000).toFixed(1)+' 秒' : Math.round(last[key]).toLocaleString('zh-CN')+' 字符'}`;card.querySelector('svg').after(label);}
    });
    document.querySelector('#at').textContent=`数据截至 ${new Date(dashboard.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）`;
  },{dashboard,metrics});
}
