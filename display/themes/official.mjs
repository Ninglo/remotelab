import { selectOfficialScene } from '../status-state.mjs';

const COLORS = {
  attention: '#ffcb68', incident: '#ff7d7d', upcoming: '#a9b8ff',
  result: '#79dbb1', progress: '#8cc5ff', note: '#b4bdc8',
  quiet: '#79dbb1', stale: '#8f9aa5', unconfigured: '#8f9aa5',
};

function xml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function clipped(value, max) {
  const chars = Array.from(String(value ?? ''));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function lines(value, width = 31) {
  const chars = Array.from(String(value ?? ''));
  const first = chars.slice(0, width).join('');
  const second = chars.length > width ? clipped(chars.slice(width).join(''), width) : '';
  return [first, second].filter(Boolean);
}

function sceneCopy(scene) {
  const signal = scene.signal;
  if (signal) {
    const reported = signal.evidence === 'source_reported';
    const labels = {
      attention: reported ? '来源称需要处理 · 待核对' : '需要你处理',
      incident: reported ? '异常待核对' : '异常提醒',
      upcoming: '即将发生', result: reported ? '结果待核对' : '已有结果',
      progress: '正在进行', note: '状态消息',
    };
    return {
      label: labels[scene.kind], title: signal.title, summary: signal.summary,
      destination: signal.destination, source: signal.sourceLabel,
      evidence: reported ? '来源报告' : '已核实',
    };
  }
  if (scene.kind === 'stale') return {
    label: '状态未更新', title: '暂时无法确认当前状态',
    summary: '数据源已过有效期，请到原应用查看。', destination: '请检查来源连接', source: '系统', evidence: '已过期',
  };
  if (scene.kind === 'unconfigured') return {
    label: '等待接入', title: '还没有状态来源',
    summary: '连接一个来源后，这里会展示最值得留意的一件事。', destination: '在 RemoteLab 配置', source: '系统', evidence: '未配置',
  };
  return {
    label: '一切平稳', title: '目前无需处理',
    summary: '暂时没有需要占据这块屏幕的消息。', destination: '需要时去 RemoteLab 查看详情', source: '系统', evidence: '当前',
  };
}

export function renderTheme(snapshot, { metrics = {}, nowMs = Date.now() } = {}) {
  const scene = selectOfficialScene(snapshot, nowMs);
  const copy = sceneCopy(scene);
  const accent = COLORS[scene.kind];
  const summary = lines(copy.summary);
  const time = new Date(nowMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const freshCount = snapshot.sources.filter((source) => source.fresh).length;
  const totalCount = snapshot.sources.length;
  const running = Number.isSafeInteger(metrics?.running) ? metrics.running : '—';
  const pendingReview = Number.isSafeInteger(metrics?.pendingReview) ? metrics.pendingReview : '—';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="480" viewBox="0 0 1920 480">
    <style>
      text { font-family: "Noto Sans CJK SC", "PingFang SC", sans-serif; fill: #f2f6f8; }
      .muted { fill: #9caab6; } .micro { font-size: 19px; letter-spacing: 2px; }
      .label { font-size: 25px; font-weight: 700; } .title { font-size: 67px; font-weight: 700; }
      .summary { font-size: 28px; } .number { font-size: 69px; font-weight: 700; }
    </style>
    <rect width="1920" height="480" fill="#0b1118"/>
    <rect x="0" y="0" width="13" height="480" fill="${accent}"/>
    <text x="49" y="49" class="micro muted">REMOTELAB  /  SIGNAL</text>
    <text x="1455" y="49" class="micro muted">${xml(`${freshCount}/${totalCount} 个来源在线`)}</text>
    <text x="1808" y="51" text-anchor="end" font-size="31" font-weight="700">${xml(time)}</text>
    <path d="M49 71H1871" stroke="#2c3741" stroke-width="2"/>
    <circle cx="61" cy="122" r="10" fill="${accent}"/>
    <text x="89" y="132" class="label" fill="${accent}">${xml(copy.label)}</text>
    ${scene.otherCount ? `<text x="1150" y="129" text-anchor="end" class="micro muted">另有 ${scene.otherCount} 条</text>` : ''}
    <text x="49" y="225" class="title">${xml(clipped(copy.title, 17))}</text>
    ${summary.map((line, index) => `<text x="52" y="${285 + index * 39}" class="summary muted">${xml(line)}</text>`).join('')}
    <path d="M49 372H1195" stroke="#2c3741" stroke-width="2"/>
    <text x="52" y="416" font-size="23" fill="${accent}">${xml(clipped(copy.destination, 32))}</text>
    <text x="52" y="453" font-size="18" class="muted">${xml(clipped(copy.source, 30))}  ·  ${xml(copy.evidence)}</text>
    <path d="M1228 94V448" stroke="#2c3741" stroke-width="2"/>
    <text x="1272" y="139" class="micro muted">REMOTELAB 运行概况</text>
    <text x="1272" y="246" class="number">${running}</text>
    <text x="1276" y="278" font-size="22" class="muted">正在运行</text>
    <text x="1580" y="246" class="number">${pendingReview}</text>
    <text x="1584" y="278" font-size="22" class="muted">结果待浏览</text>
    <path d="M1272 313H1852" stroke="#2c3741" stroke-width="2"/>
    <text x="1272" y="361" font-size="21" class="muted">这不是操作入口；详情请到来源应用查看</text>
    <text x="1272" y="421" class="micro muted">状态优先  ·  少即是多</text>
  </svg>`;
}
