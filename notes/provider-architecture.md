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
4. **repo 内置 `.mjs` + 本地 `.mjs` + 本地 `.json` 三层来源**
5. **前端改为消费显式 `reasoning.kind`**，而不是继续猜 `effortLevels`
6. **移除未知 provider → Claude fallback**，避免假抽象
7. **区分 setup 默认值 和 chat 运行时选择**：
   - setup 负责通过 AI 对话向用户确认“我有哪些 provider / model 可用、默认用哪个”
   - chat UI 负责展示当前选择并允许轻量切换，不承担复杂 onboarding
   - 真正执行时（包括后台一次性调用，如 session 命名 / sidebar summarization）必须以当前 turn 的 provider/model/reasoning 选择为准

如果后面真开始落地，第一刀应该切在：

- `chat/providers/registry.mjs`
- `chat/models.mjs`
- `chat/process-runner.mjs`

因为这三处是当前 provider 抽象最断裂的地方。
