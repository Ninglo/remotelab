// Reader-facing facts are pinned to the audited source, not to a moving branch.
export const audit = {
  version: 'v3 · 2026-10-03',
  commit: '2e300793188aeabddba720df872c3ac4f1c0a5f2',
  scope: '主线源码；7696 的现有个人任务卡试验；已启用 Jev / ambient / groupFeed 的飞书群。其他部署实例需要单独核对。',
};

export const sources = {
  inbox: ['lib/connector-inbox.mjs', 'scripts/feishu-connector.mjs#L1778'],
  observation: ['chat/session-observations.mjs#L50', 'scripts/feishu-connector.mjs#L1079'],
  jev: ['scripts/feishu-connector.mjs#L1188', 'connectors/feishu/quick-participation.mjs#L68'],
  quick: ['scripts/feishu-connector.mjs#L1740', 'connectors/feishu/quick-participation.mjs#L286'],
  handoff: ['scripts/feishu-connector.mjs#L984', 'connectors/feishu/session-flow.mjs'],
  admission: ['chat/session-manager.mjs#L3159', 'chat/requests.mjs'],
  auto: ['chat/session-runtime-selection.mjs#L17', 'lib/jev-auto-router.mjs'],
  native: ['chat/native-request-dispatch.mjs', 'chat/native-input-transport.mjs', 'docs/native-harness-input.md'],
  run: ['chat/run-launcher.mjs', 'chat/runner-sidecar.mjs', 'chat/run-projection.mjs'],
  opening: ['chat/session-entry-notification.mjs', 'chat/native-final-publication.mjs#L35'],
  card: ['chat/session-manager.mjs#L1417', 'lib/workboard-state.mjs', 'connectors/feishu/workboard-pilot.mjs'],
  delivery: ['chat/native-final-publication.mjs', 'lib/reply-deliveries.mjs', 'scripts/feishu-connector.mjs#L1400'],
  question: ['chat/session-manager.mjs#L3183', 'chat/native-user-questions.mjs#L133'],
  after: ['chat/session-turn-completion.mjs#L212', 'chat/session-state-classifier.mjs'],
};

export const actors = [
  {id:'user',label:'用户 / 飞书',owner:'发消息、看输出'},
  {id:'connector',label:'Connector',owner:'收录、路由、投递'},
  {id:'session',label:'Session / Request',owner:'持久记录与接纳'},
  {id:'jev',label:'Jev',owner:'条件启用的快判'},
  {id:'harness',label:'Harness / Run',owner:'理解、执行、验收'},
  {id:'delivery',label:'输出 Worker',owner:'文本 outbox / 卡片'},
  {id:'background',label:'后置后台',owner:'状态整理 / 记忆'},
];

const step = (title, from, to, kind, owner, action, handoff, wait, visible, ref) =>
  ({title,from,to,kind,owner,action,handoff,wait,visible,ref});

const execution = [
  step('接纳可执行请求','connector','session','sync','RemoteLab 接纳层',
    'Connector 提交带稳定 requestId、文本、附件和本条回复位置的请求。结构校验与去重通过后，保存 Request。只有选择 Auto 时，运行档位解析才可能再等待一次 Jev。',
    '输入：sessionId + requestId + sourceContext + sourceDelivery。输出：requestId / runId / queued / duplicate。',
    '调用方等待 HTTP 接纳回执，不等待完整答案。后续运行与 Connector 的这次调用脱离。',
    '接纳成功说明工作进入系统；还不能证明已经开始，更不能证明完成。','admission'),
  step('启动、续接或排队','session','harness','async','RemoteLab 调度器 + 原生 Harness',
    '空闲时启动脱离前台的 Run。同一原生 Harness 正在运行且输入兼容时，把追加文字送入当前执行；不能加入当前执行的输入按队列处理。切换正在运行的模型等配置会被拒绝。',
    '输入：已接纳 Request 和执行快照。输出：原生输入回执、Run 事件与状态。',
    '浏览器断开或 Connector 结束本次请求不会停止 Run。追加输入回执与模型如何采用输入是两回事。',
    '此时才是模型真正承接执行。Session 是持久工作间，Run 是一次运行。','native'),
  step('形成有信息量的开场','harness','session','sync','执行 Harness 写内容；RemoteLab 保存事件',
    '模型说明自己理解到的具体问题、首个待判分叉和要核查什么。开场内容不是固定程序代写的“已创建会话”。快速完整答案可直接交付。',
    '输入：模型输出事件。输出：规范化 opening；新飞书 Session 的入口合入首个有效开场，若没有开场则合入首个最终答复。',
    '内容先形成并保存，投递另走 outbox。首个有效开场不等待完整任务清单。',
    '飞书显示【开始处理】和会话入口；这里首次让人知道模型准备怎样解决问题。','opening'),
  step('按工作量建立任务快照','harness','session','sync','执行 Harness 决定并验收；平台校验结构',
    '可建卡的工作 Session 中，已启用试验的复杂或长任务，由 Harness 提交目标、2–5 个交付项及验收条件。groupFeed 旁听 Session 被明确排除；短问题若留在该 Session，即使后来调查变长，也不能据此保证会建卡。简单任务不需要卡。',
    '输入：目标、taskId、revision、交付项、证据引用。输出：持久 workboard 快照；续作沿用原 taskId。',
    '提交快照要等待保存；不等待飞书卡片创建成功，工具工作可以继续。Jev 清单 gate 已取消，但它建议的工作位置仍可能影响可建卡范围。',
    '网页可直接投影快照；飞书卡片 Worker 稍后创建一张卡。','card'),
  step('投递开场、创建或更新卡','session','delivery','async','两条独立输出程序',
    '开场、问题、最终答复走 source-delivery outbox，由 Connector 调飞书 API。已启用的任务卡由另一 Worker 读 Session 快照，首次 create，后续 patch 同一 messageId。',
    '输入：输出事件或任务快照。输出：飞书 messageId、卡片锚点、内容版本与提供方回执。',
    '两条 Worker 可并行追赶事件，并不共享一个发送队列；事件顺序不等于客户端严格到达顺序。目前跨 Worker 的“开场必定先于卡片到达”没有统一屏障。',
    '这说明为何“模型已经开工”与“卡片刚弹出来”可能有间隔。','delivery'),
  step('进度更新原卡','harness','session','sync','Harness 输出实际发现；卡片 Worker 更新表面',
    '有用进展被标为 progress 并保存。有任务卡时，投影把它合入原卡的进度区，不再为每句话新增群消息。交付项只有验收证据充分时才能打勾。',
    '输入：新的进度事件、同一 taskId 的更高 revision。输出：原卡最新进度与验收状态。',
    '卡片刷新独立于后续模型工作；没有卡时，有用进度仍可能单独显示。',
    '保留一张推进卡，目标在上、交付项居中、实际进度在下。','card'),
  step('保存并投递最终答复','harness','session','sync','Harness 写结果；RemoteLab 保存；Connector 发送',
    'Harness 给出本轮结果、已完成部分及真实剩余阻塞。平台标记最终答复，并由 outbox 投递文本和附件。Run 结束、任务验收完成、飞书送达分别记录。',
    '输入：最终事件和已保存资产。输出：独立【最终答复】与分片 / 附件回执。',
    '无需等后置标题整理或记忆归集。投递失败从已保存结果恢复发送，不自动重跑工具动作。',
    '【最终答复】表示这轮回答结束；任务卡仍可以是部分完成、等待或失败。','delivery'),
  step('后台整理与归集','session','background','async','独立 Session 状态分类器与记忆流程',
    '满足条件时，运行后的状态分类器整理标题、分组和工作摘要，记忆流程另行归集可复用信息。这是后置支路，不是回答前的第二个审查员。',
    '输入：已结束运行的历史与结果。输出：Session 元数据、摘要或记忆记录。',
    '答案投递不等这条支路；它也不能把未验收交付项自动判为完成。',
    '标题或摘要可能稍后刷新；不应再发一遍最终答复。','after'),
];

export const scenarios = {
  pilot: {
    label:'飞书 · Jev 试验路径', status:'当前源码与已配置路径',
    intro:'以“群里发一条没有 @ 的复杂问题”为例。这里只描述已配置接入范围内的真人消息；命令、自发机器人消息及访问策略有自己的前置处理。',
    steps:[
      step('收到事件并写入 inbox','user','connector','sync','飞书 Connector + 耐久 inbox',
        '长连接拿到消息后，先把可重放的事件写入本地 inbox。同一来源标识去重；记录成功后唤醒处理器。重启后可恢复尚未处理的输入。',
        '输入：来源消息 ID、内容、发送者、群 / 话题。输出：耐久 inbox 记录。',
        '等待落盘，不等 Jev 或 Harness。此时只是平台可靠收录，尚未启动任务。',
        '本路径目前没有从 inbox 落盘立即触发表情的统一实现。','inbox'),
      step('先写入 Session 观察记录','connector','session','sync','Connector 路由 + Session observations API',
        '检查接入策略，找到已绑定 Session 或创建相应 Session。把本条消息写入观察历史，取回近期消息供快判使用。这里只收录，不创建执行 Run。',
        '输入：sourceMessageId + requestId + text + sourceContext。输出：sessionId + eventSeq + recent。',
        'Connector 等待 observations 回执。Session 已有消息，不等于模型已经接单。',
        '第一次交给 Session：交的是记录和上下文。','observation'),
      step('等待 Jev 判断并保存决定','connector','jev','sync','Jev 判断；固定程序保存和执行决定',
        'Connector 收集有限的最近上下文，必要时读取已配置的项目记忆，再调用 Jev。它建议表情与工作位置、短答或复杂工作；判断会被保存。',
        '输入：最近消息、是否 @、最新正文、可用记忆摘录。输出：participation / emojiType / workMode / reason。',
        '这一步当前确实 await Jev，是执行请求提交前的串行等待。快判失败有回退路径，但平台错误仍可能阻塞。',
        '当前临时 fail-open：即便 Jev 建议静默或只回表情，也把已观察消息交给 Session 模型决定是否答复。','jev'),
      step('决定工作位置并提交任务','connector','session','sync','Connector 选路由；Session 接纳可执行请求',
        'Jev 建议 complex 时，Connector 选择话题工作路径，并携带近期群上下文；其他情况通常续接原 Session。准备附件、上下文和本条 sourceDelivery，提交执行请求。',
        '输入：判断结果 + sessionId + 正文 + sourceDelivery。输出：可执行 Request、Run 身份与回复目标。',
        '等待请求接纳，随后独立执行。创建了 Session、准备了话题目标，都不等于已发出一条飞书话题消息。',
        '第二次交给 Session：这次交的是可以执行的工作。话题首条 Bot 回复送出后，才取得真实 threadId 并绑定。','handoff'),
      step('再把表情放进投递队列','connector','delivery','async','固定程序入 outbox；Connector 调飞书 API',
        '若已保存的 Jev 决定有 emojiType，在执行请求提交之后排入 reaction delivery。独立投递器真正发送，保存 reactionId / 回执。Jev 自己不调用飞书发送接口。',
        '输入：原消息位置 + 表情决定。输出：reaction delivery；发送后才有提供方回执。',
        '这里只排队，不等待完整模型答案；表情仍可能晚于模型开工甚至开场。',
        '“表情必须最快确认收到”是目标要求；此路径尚未前置到 inbox 接收点。','delivery'),
      ...execution.slice(1),
    ],
  },
  standard: {
    label:'飞书 · 常规接入分支', status:'未启用 Jev observation；Quick 可另用 Jev',
    intro:'常规群不是统一的开关组合。这一分支未启用 jevReactions，但 Quick participation 仍可另调 Jev；等待位置与新的观察快判路径不同。',
    steps:[
      step('事件落盘与接入检查','user','connector','sync','Connector + inbox',
        '可靠保存并去重消息，再检查访问范围、群触发策略、命令以及主线 / 话题路由。ambient 与必须 @ 的群，接入行为不同。',
        '输入：飞书来源事件。输出：可处理消息及其路由。','等待本地保存和结构处理，不等待最终答案。','只有被接入策略接纳的消息进入后续工作。','inbox'),
      step('按该分支尝试收到表情','connector','user','conditional','quickParticipation 或固定 processing reaction',
        'quickReactions 分支启动已读表情，并发启动 Quick Jev 快判；Connector 只等待已读表情回执，再继续提交工作。另一些配置只把 processing reaction 异步发出。这不是 Jev observation 路径。',
        '输入：消息与分支开关。输出：表情尝试 / 回执。','Quick 分支等表情回执，不等其 Jev 判断；另一些 processing reaction 配置异步发送。','表情与后续任务答复仍是不同证据。','quick'),
      step('并行的 Quick Jev 快判','connector','jev','async','旧 Quick participation 的 Jev 调用',
        '启用 Quick participation 时，它与已读表情同一轮并发启动，记录参与方式和可能的工作交接建议；建议由 discussionHandoff 接口承接。',
        '输入：有限的群消息上下文。输出：Quick 判定日志和条件发生的交接建议。','Connector 不 await 本次判定完成才提交执行请求；不能把它画成 observation 快判那样的前置串行门槛。','这里也使用 Jev，但当前主模型工作不以该判断结束为启动条件。','quick'),
      ...execution,
    ],
  },
  web: {
    label:'网页 · 试验 / 常规', status:'同一运行底座，展示按开关',
    intro:'浏览器直接把输入交给当前 Session，绕过飞书 inbox 和群快判。个人任务卡试验是否开启决定展示规则；端口本身不能证明所有人都用了同一规则。',
    steps:[
      step('浏览器提交本条输入','user','session','sync','网页 HTTP 客户端 + Session 接纳层',
        '把文本、附件和稳定 requestId 发给当前 Session。这里描述 HTTP 输入到达；还要经过结构校验和运行设置解析。',
        '输入：sessionId + requestId + 文本 / 附件。输出：进入接纳处理的输入。','浏览器等待接纳回执，不等完整答案。','输入到达还不是接纳完成。','admission'),
      step('条件启用 Auto 路由','session','jev','conditional','Session 运行设置解析 + Jev Auto',
        '固定档位跳过这次 Jev 路由。选 Auto 时，在 Request 接纳前等待它解析运行档位；待答问题的答案沿用当前执行设置。',
        '输入：Session 设置和本条输入。输出：本次运行设置快照。','Auto 网络调用是异步写法，但业务接纳仍等其结果；固定配置不等它。','此处没有飞书群 Jev、群表情或话题判断。','auto'),
      step('返回 Request 接纳回执','session','user','sync','RemoteLab HTTP 接纳层',
        '保存可执行 Request，返回稳定身份、是否重复及是否排队。',
        '输出：requestId / runId / queued / duplicate。','从这里开始，后续运行与网页这次 HTTP 调用脱离。WS 只提示变化，事实从 HTTP 读取。','已接纳运行可在用户离开网页后继续。','admission'),
      ...execution.slice(1,4),
      step('网页直接读取输出投影','session','user','async','网页读取历史 + workboard 投影',
        '网页读持久事件，显示开场、原任务卡及当前进度。这里不需要飞书文本 outbox，也不等待飞书卡片 Worker。未启用任务卡时按普通会话展示。',
        '输入：Session 事件与任务快照。输出：当前聊天表面。','WS 断开后重读持久事实；浏览器连接不承担执行生命期。','网页与飞书共享事实来源，但用不同投影和投递程序。','card'),
      execution[5],
      step('显示本轮最终答复','harness','user','async','Harness 写结果；网页读取持久事件',
        '保存本轮结果和附件引用，网页投影最终答复。任务是否完成仍以原卡的验收事实为准。',
        '输入：最终事件、资产、任务快照。输出：网页结果与明确的本轮结束状态。','不需要飞书投递器；也不等待后置标题整理。','Run 结束不把剩余交付项自动打勾。','delivery'),
      execution[7],
    ],
  },
  goal: {
    label:'目标 · 收到确认前置', status:'规划，尚未实现',
    intro:'这条路径表达用户要求，不冒充现状。保留可靠接入、原生执行和持久事件；把即时确认前置，并补齐跨投递顺序和必要问题契约。',
    steps:[
      step('可靠收录消息','user','connector','sync','Connector + inbox','先校验接入范围并可靠写入消息。','输出：可靠接收身份。','不等模型判断。','系统已可靠接收。','inbox'),
      step('立即确认收到','connector','user','async','固定接收确认程序','从可靠接收点发送统一含义的收到表情；后台判断和启动与确认并行。表情确认收到，不承诺任务成功。','输出：原消息表情及回执。','必须从 Jev 和模型开工的等待条件中移出；这是待实施改动。','用户尽快知道这条消息有没有被看到。','delivery'),
      step('按配置决定工作位置','connector','session','conditional','Connector 路由 + 可选的快判','若保留 Jev，用于表情选择、位置建议或 Auto；不得替代执行模型判断任务是否需要卡。','输出：工作 Session 与不可变回复位置。','即刻确认不等待这一步；是否等待其他判断要在契约中写清。','不开无信息量的创建通知。','jev'),
      ...execution.slice(0,4),
      step('保证开场先到，再创建卡','session','delivery','async','输出程序与持久交接状态','将开场回执与首张卡创建关联，避免两条 Worker 各自发送造成逆序；后续只更新原卡。','输出：一次开场、一张主卡及实际送达证据。','这是待补的跨 Worker 顺序保证；不能从事件序号推断客户端已按序看到。','有意义的开场 → 主卡 → 主卡进度。','delivery'),
      step('按问题等级等待或继续','harness','user','conditional','Harness 定义等级；平台持久保存待答状态','可选偏好可按已声明默认继续；缺关键输入与未获授权必须等待，完成独立部分后可释放本次 Run。稍后回答续接原 taskId。','输出：单独交互卡、等待范围、questionId 与版本。','必要输入和授权不得由超时默认首项替代；这些分级卡片和跨轮待答语义仍待实施。','普通进度留原卡，需要回答的问题单独弹出。','question'),
      ...execution.slice(6),
    ],
  },
};

// Surface sends are separate from saving output. Keeping them explicit avoids
// treating a normalized event as proof that the user has received anything.
for (const key of ['pilot','standard']) {
  scenarios[key].steps = scenarios[key].steps.flatMap(s => {
    if (s.title === '投递开场、创建或更新卡') return [s,
      step('飞书显示开场与首卡','delivery','user','async','文本 Connector 与卡片 Worker 各自发送',
        '文本发送和卡片创建从各自持久记录推进。有用开场与首卡可在这里被用户看到；当前没有统一屏障保证二者在客户端严格先后。',
        '输出：开场 messageId、首卡 messageId 与绑定。','不等待后续工具任务完成；发送结果由各提供方 API 回执确认。','这里才是表面交付，保存开场事件或快照本身还不算送达。','delivery')];
    if (s.title === '进度更新原卡') return [s,
      step('卡片 Worker 编辑原卡','delivery','user','async','个人试验卡片 Worker',
        '读取新的任务版本和实际进度，对原卡的 messageId 做 patch，并核对提供方响应；创建结果未知时不能盲目再建卡。',
        '输入：已有卡片身份、最新快照和进度。输出：同一张卡的新内容及回执。','模型执行不等这个 patch；卡片可以稍后追赶最新事件。','群里不新增另一条进度消息，也不另发一张全部完成清单。','card')];
    if (s.title === '保存并投递最终答复') return [s,
      step('最终结果进入 outbox','session','delivery','async','RemoteLab 输出投影',
        '从已保存的最终事件建立幂等的文本 / 附件投递记录，供 Connector 领取。',
        '输入：最终事件、资产和原 Request 的回复位置。输出：待投递记录。','任务结果已有，飞书仍可能待发送。后置整理不在等待条件中。','还不能仅凭 outbox 记录声称群里已收到。','delivery'),
      step('飞书显示最终答复','delivery','user','async','Connector 调提供方 API',
        '发送文本及附件，沿原话题或原消息位置交付；各部分使用稳定投递身份。',
        '输出：【最终答复】文本、附件和提供方发送回执。','投递失败恢复本轮既有结果；不自动重做工具任务。','用户获得这轮结果；它可以说明任务仍是部分完成。','delivery'),
      step('保存各部分送达回执','delivery','session','sync','Connector + 持久交付记录',
        '保存各文本分片、附件的外部身份和发送状态；卡片 Worker 独立保存自己的卡片回执。',
        '输出：可恢复、可核对的交付状态。','记录全部必要部分的确认，不能用一个成功分片代替整轮交付。','提供方接受不证明真人已读；完整体验仍需要真实入口验收。','delivery')];
    return [s];
  });
}

// Numbering after admission is a reading order, not a total clock ordering.
// In particular the Run may start before reaction enqueue, and post-turn
// metadata may finish before the final message's delivery receipt.
scenarios.pilot.parallelStart = 4;
scenarios.standard.parallelStart = 4;
scenarios.web.parallelStart = 3;
scenarios.goal.parallelStart = 4;

export const feedback = [
  ['按停止按钮','RemoteLab 收到控制请求，向原生执行发送 interrupt / cancellation；已做的外部动作不会因此自动撤销。','停止是控制事件，不与问题答案混用；主卡写清取消或暂停及保留结果。','native'],
  ['文字说“停一下”','目前仍属于普通输入，由 Harness 理解；若正在等原生问题，新文字可能先进入问题答案分支。','在必要的明确停止控制下优先处理；暂停与取消分别持久记录，不自行恢复。','question'],
  ['插问、补充或纠正','同一运行的兼容输入可送给当前原生 Harness；它判断是否继续、改计划或重新验收。接纳不证明已经采用。','回答插问并说明原任务去向；采用补充后在原卡说明具体变化，改验收标准时重新核验。','native'],
  ['正在等选择题时又说一句','当前没有附件的普通新文字会自动绑定到 pending native question；并未先可靠区分“回答、插问、停止、补充”。','带 questionId 的答案与普通追加输入分别处理，过期答案不应用；停止不能被吞成自定义答案。','question'],
  ['问题没有回复','当前统一五分钟：有选项取首项，无选项返回未答；模型收到的是系统超时回退，不能视为用户选择或授权。','可选偏好允许声明默认；必要输入与授权保持待答，无自动默认。','question'],
  ['原 Run 已结束后再补充','新输入可以在同一 Session 启动新 Run；Harness 判断是否续作，并按规则沿用原 taskId。','问题跨轮持久保留并校验版本，续作编辑原卡，不新建一张“全部完成”卡。','card'],
];

export const testCases = [
  ['复杂任务、无 @','接入范围内发一个需要调查的问题。核对消息先被观察收录，之后有执行请求；有用开场带会话入口，出现一张主卡，后续进度编辑原卡。','真实新任务的完整收发仍待验收'],
  ['快速问题','发一个能直接完整回答的问题。应直接得到结果，不补发迟到清单，不为了凑流程拆多条。','有代码回归；仍需真人入口核验'],
  ['插问与补充','在任务运行中插问，再补充一个改变方案的事实。核对是否回答、是否采用及原任务是否继续，不能只看 HTTP accepted。','原生追加底座已实现；体验待验'],
  ['等待问题时打断','出现选择题时发“先停下”或一个新问题。观察它是否被当成题目答案。停止按钮与普通文字分别测试。','已发现当前分支风险，尚未修复'],
  ['不回答选择题','观察五分钟超时回退是否清楚标为系统行为；必要输入与授权不能据此通过验收。','当前统一超时策略；分级待改'],
  ['最终结果与完成状态','构造只有部分交付项验收通过的任务。最终答复必须清楚说明剩余部分，主卡不能仅因 Run 结束全部打勾。','输出标签与状态分离已实现；真实样本待验'],
];
