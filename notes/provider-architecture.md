# Open Provider / Model Architecture

> 2026-03-06 架构设计草案。
> 目标：让 RemoteLab 的 model 选择和 agent/provider 接入更开放，既方便本地配置，也方便外部贡献者通过 PR 接入新 provider。

---

## 1. 现状问题

当前 chat 侧的 provider 抽象是分裂的：

| 关注点 | 现在在哪 | 当前问题 |
|---|---|---|
| 可用工具列表 | `lib/tools.mjs` | 只知道 `id/name/command`，不知道模型、thinking、runtime |
| 模型列表 | `chat/models.mjs` | 只对 `claude` / `codex` 特判，其他 tool 默认没有模型能力 |
| 启动与输出解析 | `chat/process-runner.mjs` + `chat/adapters/*.mjs` | 通过 `if (toolId === 'claude' / 'codex')` 硬编码；未知 tool 还会 fallback 到 Claude 语义 |
| 前端 thinking UI | `static/chat.js` | 用 `effortLevels === null` 这种隐式协议判断“显示 toggle 还是下拉框” |

这导致一个核心问题：

**现在的 `tools.json` 只是“把命令放进下拉框”，不是完整 provider 接入。**

别人即使加了一个 tool：
- 也不一定能拿到 model list
- 也不一定知道 thinking / effort 应该怎么渲染
- 也不一定知道 spawn args / parser 应该怎么走
- 还可能被错误地套用 Claude runtime

所以要开放的不是单独的 “tool list”，而是完整的 **provider contract**。

---

## 2. 设计目标

这次重构要满足五个目标：

1. **Provider 成为单一抽象**
   - command、model list、thinking schema、runtime adapter、resume key 都挂在同一个 provider 上。

2. **既支持 PR，也支持本地扩展**
   - 通用 provider 走 repo 内置模块，适合 PR。
   - 本地实验/私有 provider 走本机配置目录，不要求 fork 项目。

3. **支持两种 model catalog 模式**
   - **code mode**：写 JS 代码动态探测 model / thinking list。
   - **hardcode mode**：直接在 JSON 里写死 model / thinking list。

4. **渐进迁移，不打断现有会话结构**
   - 现有 session / app 里的 `tool` 字段先保留，把它解释成 provider id。
   - `/api/tools`、`/api/models` 在第一阶段保持兼容。

5. **不要再有“未知 provider 回退到 Claude”这种假兼容**
   - provider 没声明 runtime，就不能执行。
   - 少一点“看起来接上了，实际是错的”的伪抽象。

6. **让 provider 创建有低门槛入口**
   - 高阶用户可以写代码。
   - 普通用户也应该能在 GUI 里通过表单完成一个“简单 provider”的配置。
   - UI 本身要传达一个信号：RemoteLab 不只支持 Claude/Codex，provider 是可以扩展的。

---

## 3. 核心决策

### 3.1 Provider 是唯一的一等公民

后续 chat 侧所有与 agent/tool 相关的能力都挂在 provider 上：

- 可用性检查（command 是否存在）
- 模型列表
- thinking / reasoning 配置方式
- prompt/build args 逻辑
- stdout parser
- resume id 类型
- 能否支持图片、能否支持 app、能否支持恢复

一句话：

**不再是 “tool + models + adapter” 三块拼起来，而是一个 provider 自带这些定义。**

### 3.2 Provider 有三种来源

#### A. Builtin provider（适合 PR）

放在 repo 内，例如：

```text
chat/providers/builtin/claude.mjs
chat/providers/builtin/codex.mjs
```

特点：
- 适合沉淀成官方支持
- 可以写探测逻辑
- 可以定义自定义 runtime

#### B. Local JS provider（适合本地 code mode）

放在本机配置目录，例如：

```text
~/.config/remotelab/providers/my-provider.mjs
```

特点：
- 不需要改 repo
- 可以直接写代码去探测本机 CLI 的 model / thinking list
- 适合作为 PR 前的本地验证形态

#### C. Local JSON provider（适合本地 hardcode mode）

放在本机配置目录，例如：

```text
~/.config/remotelab/providers/my-provider.json
```

特点：
- 零代码
- 适合本地覆盖 model label、thinking levels、默认 model
- 只能复用已有 runtime family，不能自定义 parser / buildArgs

这三种来源刚好对应用户需求：

- **想提 PR** → repo 内置 `.mjs`
- **想自己本地写代码探测** → 本地 `.mjs`
- **只想本地写死几个 model** → 本地 `.json`

---

## 4. Provider Contract

建议引入统一的 `defineProvider()` 规范。JS provider 的完整形态大致如下：

```js
export default defineProvider({
  id: 'codex',
  name: 'OpenAI Codex',
  command: 'codex',

  availability: {
    type: 'command',
    value: 'codex',
  },

  modelCatalog: {
    mode: 'probe',
    timeoutMs: 1500,
    cacheTtlMs: 5 * 60 * 1000,
    async resolve(ctx) {
      return {
        models: [
          { id: 'gpt-5-codex', label: 'GPT-5 Codex', defaultReasoning: 'medium' },
        ],
        reasoning: {
          kind: 'enum',
          label: 'Thinking',
          levels: ['low', 'medium', 'high', 'xhigh'],
          default: 'medium',
        },
      };
    },
    fallback: {
      models: [],
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: ['low', 'medium', 'high', 'xhigh'],
        default: 'medium',
      },
    },
  },

  runtime: {
    family: 'codex-json',
    resumeField: 'codexThreadId',
    createAdapter: createCodexAdapter,
    buildArgs: buildCodexArgs,
  },

  capabilities: {
    images: true,
    resumable: true,
    appSelectable: true,
  },
});
```

### 4.1 统一返回的 catalog shape

无论是 code mode 还是 hardcode mode，最终都统一返回：

```js
{
  models: [
    { id: 'sonnet', label: 'Sonnet 4.6' },
    { id: 'opus', label: 'Opus 4.6' },
  ],
  reasoning: {
    kind: 'none' | 'toggle' | 'enum',
    label: 'Thinking',
    levels: ['low', 'medium', 'high'],
    default: 'medium',
  },
  source: 'static' | 'probe' | 'cache',
  stale: false,
}
```

这里最重要的是：

- Claude 现在的 `thinking` toggle，统一映射成 `reasoning.kind = 'toggle'`
- Codex 现在的 `effort` 下拉框，统一映射成 `reasoning.kind = 'enum'`
- 没有 thinking 概念的 provider，明确写 `reasoning.kind = 'none'`

前端不应该再用 `effortLevels === null` 猜协议。

### 4.2 JSON provider 的约束

本地 JSON provider 只做静态声明，不允许自定义函数：

```json
{
  "id": "codex-local",
  "name": "Codex Local",
  "command": "codex",
  "runtime": {
    "family": "codex-json"
  },
  "modelCatalog": {
    "mode": "static",
    "models": [
      { "id": "gpt-5-codex", "label": "GPT-5 Codex" }
    ],
    "reasoning": {
      "kind": "enum",
      "label": "Thinking",
      "levels": ["low", "medium", "high", "xhigh"],
      "default": "medium"
    }
  }
}
```

也就是说：

- **JS provider** 可以定义 runtime + 动态探测逻辑
- **JSON provider** 只能引用已知 runtime family + 静态 models

这能把“可扩展”与“可控”平衡起来。

---

## 5. Provider Loader 与覆盖规则

建议新增 chat-only registry，而不是直接把 `lib/tools.mjs` 继续做大。

原因：
- `lib/router.mjs` 属于 frozen terminal service，不能牵连进去
- chat provider 的抽象已经明显比 terminal tool list 更丰富

建议目录结构：

```text
chat/providers/
  registry.mjs
  contract.mjs
  catalog.mjs
  local-loader.mjs
  builtin/
    claude.mjs
    codex.mjs
```

### 5.1 加载顺序

1. 先加载 repo 内置 provider
2. 再加载本地 JSON patch / provider
3. 最后加载本地 JS provider

优先级：

```text
builtin < local json < local js
```

### 5.2 覆盖语义

- **同 id**：视为 override / patch
- **新 id + `extends`**：视为一个 provider variant

例子：

- `id = codex`：本地覆盖官方 Codex provider
- `id = codex-nightly`, `extends = codex`：基于 Codex 派生一个 nightly 版本

### 5.3 失败隔离

单个 provider 加载失败时：
- 记录日志
- 在 `/api/tools` 里不返回这个 provider
- 不能把整个 chat server 拖死

---

## 6. Runtime 抽象

当前最大的结构性问题不是 model list，而是 runtime 也写死在 `process-runner.mjs` 里。

正确的依赖关系应该是：

```text
session.tool(providerId)
  → provider registry
    → runtime family / adapter / buildArgs
    → model catalog
```

而不是：

```text
toolId === 'claude' ? Claude :
toolId === 'codex'  ? Codex  :
fallback to Claude
```

### 6.1 运行时建议拆成两层

#### A. Runtime family

这是可复用的运行时模板，例如：

- `claude-stream-json`
- `codex-json`
- 未来可加 `generic-jsonl`, `plain-stdio`, `openai-compatible`

#### B. Provider instance

这是具体 provider，对应具体 command、models、defaults。

例如：
- `claude` provider 使用 `claude-stream-json`
- `codex` provider 使用 `codex-json`
- `my-codex-wrapper` 也可以复用 `codex-json`

这样 hardcode mode 的 JSON provider 也能成立：

**它不需要自己写 parser，只要声明“我复用哪个 runtime family”。**

### 6.2 Resume key 也归 provider 管

现在 resume id 分成 `claudeSessionId` / `codexThreadId`。

建议 provider contract 显式声明：

```js
runtime: {
  resumeField: 'claudeSessionId'
}
```

这样 process runner 和 session manager 不需要再散落着 provider-specific 判断。

---

## 7. API / 前端抽象

### 7.1 第一阶段：保持现有 API，不破坏前端

- `/api/tools` 继续保留
- `/api/models?tool=...` 继续保留
- session / app 里的 `tool` 字段继续保留

但实现改成走 provider registry。

### 7.2 `/api/tools` 返回 richer metadata

建议返回：

```json
{
  "tools": [
    {
      "id": "codex",
      "name": "OpenAI Codex",
      "command": "codex",
      "available": true,
      "source": "builtin",
      "runtimeFamily": "codex-json",
      "reasoningKind": "enum",
      "supportsModelSelection": true
    }
  ]
}
```

### 7.3 WebSocket send payload 内部要标准化

现状：
- Claude 走 `thinking: boolean`
- Codex 走 `effort: string`

建议内部统一成：

```js
{
  tool: 'codex',
  model: 'gpt-5-codex',
  reasoning: {
    kind: 'enum',
    value: 'high'
  }
}
```

兼容策略：
- 前端第一阶段仍可继续发 `thinking` / `effort`
- server 先做 normalize，再交给 provider runtime

这样第二阶段前端再改 UI 时，不会牵动后端协议。

### 7.4 Provider 管理 UI 要分三层

如果只提供 code mode，会让“可扩展”停留在工程师视角。

RemoteLab 更合适的产品形态是 **三层 authoring path**：

#### A. Preset / One-click enable

面向：绝大多数用户。

形态：
- 在 setup 或 settings 的 `Providers` 页面里直接显示内置 provider 卡片
- 用户只需要点击启用/禁用、设默认 provider、设默认 model
- 也可以从 builtin provider 派生一个 variant（例如 `codex-nightly`）

价值：
- 成本最低
- 最能直观表达“这里不止两个 agent，可以继续加”

#### B. Simple custom provider（GUI 表单）

面向：会折腾命令行，但不想写 JS 的用户。

形态：
- 点击 `Add Provider`
- 选择一个 runtime family / 模板
- 在表单里填写：
  - `id`
  - `name`
  - `command`
  - `runtime family`
  - model 来源（静态填写 / 从缓存文件读取 / 复用 builtin）
  - reasoning 方式（none / toggle / enum）
  - 默认 model / 默认 thinking
  - 能力开关（images、resume、app-selectable）
- 保存后写入：

```text
~/.config/remotelab/providers/<id>.json
```

本质上这就是 **GUI 驱动的 hardcode mode**。

#### C. Advanced provider（代码模式）

面向：要做动态探测、自定义 parser、特殊 buildArgs 的人。

形态：
- `Add Provider` 时选择 `Advanced`
- 生成一个 provider 模板文件：

```text
~/.config/remotelab/providers/<id>.mjs
```

- 用户可以在本地编辑，验证后再 PR 到 repo builtin provider

这就是 **GUI 入口 + code escape hatch**。

### 7.5 GUI 不能写死 Claude/Codex 逻辑，要吃 runtime family schema

如果 GUI 是手写页面：
- Claude 一套表单
- Codex 一套表单
- 新增 provider 再写一套

那最后又会回到硬编码泥潭。

所以 GUI 的底层也必须抽象：

**runtime family 不只定义运行时，还要定义 authoring schema。**

例如：

```js
{
  family: 'codex-json',
  label: 'Codex JSON CLI',
  authoringSchema: {
    fields: [
      { key: 'command', type: 'command', label: 'Command' },
      { key: 'modelCatalog.mode', type: 'select', options: ['static', 'cache-file'] },
      { key: 'reasoning.kind', type: 'select', options: ['none', 'enum'] },
      { key: 'reasoning.levels', type: 'string-list' },
      { key: 'runtime.resumeField', type: 'readonly', value: 'codexThreadId' }
    ]
  }
}
```

这样前端的 provider 表单就是一个通用 renderer：

- family 负责暴露字段
- UI 负责把字段渲染出来
- 保存时输出 JSON provider

这样做的好处是：

1. **GUI 本身是 extensible 的**，不是又一层硬编码
2. **用户能明显看到系统支持多个 runtime family**
3. **新增 provider family 时，不一定要同时改前端页面代码**

### 7.6 推荐的产品流

#### Setup 流程

在 `remotelab setup` 或首次打开的 owner setup 页面里：

1. 扫描常见命令是否存在（`claude`、`codex`、`cline` 等）
2. 自动推荐对应 builtin provider
3. 如果命令存在但没有现成 builtin，可以提示：
   - `Create simple provider`
   - `Use advanced template`
4. 设置默认 provider / 默认 model

这一步负责告诉用户：

**RemoteLab 是一个 provider-based 系统，不是只内置两个 agent。**

#### Settings → Providers 页面

owner 侧增加一个轻量管理页：

- 已启用 providers
- builtin providers
- local custom providers
- `Add Provider`
- `Import JSON`
- `Export JSON`
- `Duplicate from builtin`

其中 `Import/Export JSON` 很重要，因为它能让“分享 provider”比“分享代码 PR”更轻量。

#### Chat UI

Chat UI 继续保持轻量：

- 展示当前 provider / model / reasoning
- 允许轻量切换
- 不承担复杂 provider onboarding

这和 RemoteLab 一贯的原则一致：

- setup / settings 负责配置
- chat 负责执行

### 7.7 近期开口：tool picker 里的 `+ Add more...`

如果现在就做完整的 settings / providers 页面，还是偏重。

一个更合适的近期落点是：

- 在现有 agent/tool 选择框里追加一项 `+ Add more...`
- 这不是一个 provider 选项，而是一个 action
- 点击后弹出轻量 modal
- modal 里同时提供：
  - **quick config**：产品直接写入简单配置，不要求用户手动粘贴 JSON
  - **advanced path**：给出一段 base prompt，让用户开新 session 去实现 provider 代码

这条路径的好处是：

1. 改动极小，能马上落地
2. UI 会自然暗示“agent 是可扩展的”
3. 不需要等完整 provider 管理系统 ready 才开始教育用户心智

### 7.8 Quick add 的产品原则

`Quick add` 不是教程入口，而是一个 **完成任务的入口**。

也就是说：

- 用户填完表单后，产品应该直接保存配置
- 不要求用户再去复制/粘贴 JSON
- 保存后应该立刻刷新当前 tool picker
- 简单配置路径不应该要求重启服务

这背后的原则是：

**只要是配置型能力，就优先做成动态加载，而不是 restart-driven workflow。**

在当前 RemoteLab 里，这件事本来就具备基础条件：

- tool 列表来自配置文件
- `/api/tools` 是运行时读取
- 前端 picker 可以主动重新拉取

所以 quick add 的正确形态是：

```text
fill form
→ save simple provider config
→ refetch /api/tools
→ update picker immediately
→ optionally preselect the new tool
```

### 7.9 `id` 在 simple mode 应该隐藏或自动派生

对于 simple mode 用户来说，显式填写 `id` 往往是多余负担。

更好的规则是：

- 默认以 `command` 作为主要身份
- 内部如果需要稳定 key，可以从 `command` 自动派生 slug
- 只有 advanced mode 或冲突场景才暴露 override id

也就是说：

- `command = codex` → auto id = `codex`
- `command = my-agent` → auto id = `my-agent`

simple mode 不应该把内部实现字段直接甩给用户。

### 7.10 简单 provider 要支持 model / reasoning 配置，但只在已知 runtime family 内运行

simple mode 不应该只支持 `name + command`。

至少还要允许配置：

- model list
- reasoning / thinking 方式（none / toggle / enum）
- 默认 model
- 默认 reasoning

但这里不能走“任意命令 + 任意解析”的幻想路线。

更稳的边界是：

**simple provider 只能绑定到一个已知 runtime family。**

例如：

- `claude-stream-json`
- `codex-json`

这样 simple mode 只需要额外配置“如何把 model / reasoning 选择映射成命令参数”，而不需要用户定义 parser。

当前这一版 quick add 的落地边界可以更保守一点：

- 先假设 command 与所选 runtime family 的核心 CLI flags 兼容
- 这样 GUI 可以直接保存并即时刷新，不把表单做重
- 如果 command 的参数风格不兼容，再走 advanced path 做 provider 代码或参数映射

### 7.11 模板变量可以做，但应该只做 argv 模板，不做 shell 模板

把用户选择映射进 CLI，确实需要模板变量。

建议支持的变量类似：

```text
${model}
${reasoning}
${prompt}
${resumeId}
```

但这层模板应该作用在 **argv 片段** 上，而不是整段 shell command 字符串上。

原因：

- RemoteLab 当前是 `spawn(command, args)`，不是 shell eval
- shell 模板会把 quoting / escaping / 注入问题重新引进来
- argv 模板更安全，也更容易做 runtime family 复用

所以推荐形态是：

```json
{
  "command": "my-agent",
  "runtimeFamily": "codex-json",
  "argTemplates": {
    "model": ["-m", "${model}"],
    "reasoning": ["-c", "model_reasoning_effort=${reasoning}"]
  }
}
```

而不是：

```text
my-agent --model ${model} --effort ${reasoning} "${prompt}"
```

### 7.12 高级路径保持 copy-only，不主动打断当前工作流

advanced path 的正确克制是：

- 只提供 base prompt 的复制能力
- 不自动创建 session
- 不自动切换当前 session
- 不假设用户现在愿意中断当前任务

因为用户可能：

- 正在赶当前任务
- 只是想先记住怎么扩展 provider
- 想稍后再开一个新会话做集成

所以 advanced path 负责“降低下一步成本”，不负责“替用户决定现在就切流程”。

---

## 8. 推荐迁移路径

### Phase 1 — 建立 registry，但不改外部 API

- 新增 `chat/providers/registry.mjs`
- 新增 provider contract / local loader
- 把 `chat/models.mjs` 改成 provider registry 的 thin wrapper
- 把 `process-runner.mjs` 改成通过 provider 查 runtime
- 去掉“未知 tool fallback 到 Claude”

### Phase 2 — 迁移 Claude / Codex 成 provider modules

- `chat/adapters/claude.mjs` / `chat/adapters/codex.mjs` 保留
- 但由 `chat/providers/builtin/*.mjs` 引用，而不是在 runner 里硬编码

### Phase 3 — 前端改为显式 reasoning schema

- `/api/models` 返回 `reasoning` 对象，而不是 `effortLevels` null hack
- `static/chat.js` 根据 `reasoning.kind` 渲染 toggle / select / none

### Phase 4 — 打开本地扩展与贡献流程

- 文档化 `~/.config/remotelab/providers/*.mjs`
- 文档化 `~/.config/remotelab/providers/*.json`
- 提供一个 builtin provider 模板，方便别人 PR

---

## 9. 为什么这个设计最适合 RemoteLab

### 9.1 它和当前产品阶段匹配

RemoteLab 还处于少量 provider、快速试错阶段。

所以最合适的不是引入复杂插件系统，而是：

- **repo 内置 JS module**：承载正式支持
- **本地 JS module**：承载实验与私人 provider
- **本地 JSON**：承载轻量 hardcode 覆盖

复杂度足够低，但扩展面已经打开。

### 9.2 它同时服务两种人

#### 想 upstream 的人

可以先在本地 `.mjs` provider 验证：

```text
~/.config/remotelab/providers/foo.mjs
```

验证稳定后，几乎原样搬到：

```text
chat/providers/builtin/foo.mjs
```

这让“本地试验”和“提交 PR”变成同一套接口。

#### 只想自己机器改一下的人

直接放一个 JSON：

```text
~/.config/remotelab/providers/foo.json
```

不需要 fork，不需要改源码。

---

## 10. 明确不做的事

这版架构设计里先不做：

- 不做远程下载 provider marketplace
- 不做 visitor 可上传 provider
- 不做复杂权限沙箱
- 不把 frozen terminal service 一起改掉

这是 chat provider abstraction，不是通用插件平台。

---

## 11. 最终结论

这次模型选择开放化，真正要开放的是 **provider contract**，不是单独的 model list。

最终建议是：

1. **引入 chat-only provider registry**，不要继续把逻辑堆在 `lib/tools.mjs`
2. **统一 provider contract**：command、modelCatalog、reasoning、runtime、resumeField 放在一起
3. **同时支持两种 catalog 模式**：
   - JS code mode（动态探测）
   - JSON hardcode mode（静态声明）
4. **provider authoring 走三层入口**：
   - preset / one-click enable
   - GUI 表单直接保存 simple provider 配置
   - advanced code mode (`.mjs`)
5. **repo 内置 `.mjs` + 本地 `.mjs` + 本地 `.json` 三层来源**
6. **前端改为消费显式 `reasoning.kind`**，而不是继续猜 `effortLevels`
7. **GUI 也要基于 runtime family schema 生成**，不要再写死某几个 provider 的页面逻辑
8. **移除未知 provider → Claude fallback**，避免假抽象
9. **区分 setup 默认值 和 chat 运行时选择**：
   - setup 负责通过 AI 对话向用户确认“我有哪些 provider / model 可用、默认用哪个”
   - chat UI 负责展示当前选择并允许轻量切换，不承担复杂 onboarding
   - 真正执行时（包括后台一次性调用，如 session 命名 / sidebar summarization）必须以当前 turn 的 provider/model/reasoning 选择为准
10. **simple mode 不暴露多余内部字段**：`id` 默认从 `command` 自动派生，仅在 advanced 场景才需要 override
11. **simple mode 的模板变量只作用于 argv 片段**，不引入 shell-template 机制
12. **配置路径优先动态加载**：保存 simple provider 后立刻刷新 picker，不以服务重启作为正常流程的一部分

如果后面真开始落地，第一刀应该切在：

- `chat/providers/registry.mjs`
- `chat/models.mjs`
- `chat/process-runner.mjs`

因为这三处是当前 provider 抽象最断裂的地方。
