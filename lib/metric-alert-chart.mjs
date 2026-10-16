import { readFile } from 'node:fs/promises';

// Use the same renderer, CSS and already-collected numeric daily data as Monitor.
// No authenticated page fetch, extra scan, or screenshot of text disguised as a chart.
export async function renderMetricAlertChart(page, dashboard, metrics) {
  const css=await readFile(new URL('../static/chat/agent-monitor-dashboard.css',import.meta.url),'utf8');
  const js=await readFile(new URL('../static/chat/agent-monitor-dashboard.js',import.meta.url),'utf8');
  await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>${css}
    body{margin:0;background:white;font:16px sans-serif;--accent:#087f83;--text:#172b2c;--text-secondary:#536568;--text-muted:#536568;--border:#d7e4e4;--bg:#fff;--bg-secondary:#f4f9f9}
    main{padding:28px;width:840px;box-sizing:border-box}h1{font-size:24px;margin:0 0 12px}.agent-metrics{grid-template-columns:1fr}.agent-metric h4{font-size:19px}.agent-note{font-size:14px}.agent-metric svg{max-height:280px}.agent-metric details,.agent-stage-control{display:none}
    </style><main><h1>上下文与响应 · 近七日趋势</h1><div id="chart"></div><p class="agent-note" id="at"></p><p class="agent-note">图中为监管页面的总体均值；具体预警的首轮／后续轮、同类任务比较见卡片正文。今天尚未结束。</p></main></html>`);
  await page.addScriptTag({content:js});
  await page.evaluate(({dashboard,metrics})=>{
    const root=document.querySelector('#chart');
    window.RemoteLabAgentDashboard.render(root,dashboard);
    const keys=new Set(metrics.flatMap(m=>m==='injectionChars'?['meanInjectionChars','firstInjectionChars']:m==='firstResponseMs'?['meanFirstResponseMs']:['meanDeliveryMs']));
    root.querySelectorAll('[data-metric]').forEach(card=>{if(!keys.has(card.dataset.metric))card.remove();});
    [...root.children].forEach(child=>{if(!child.classList.contains('agent-metrics'))child.remove();});
    document.querySelector('#at').textContent=`数据截至 ${new Date(dashboard.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）`;
  },{dashboard,metrics});
}
