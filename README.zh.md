# RemoteLab

[English](README.md) | 中文

**让普通人也能把重复数字工作交给 AI 的跨端工作台。**

RemoteLab 的目标，不是只服务已经很会用 AI 的少数人，而是把 AI 的自动化能力带给更多普通用户，尤其是那些每天有大量重复数字工作、却没有研发自动化背景的人。

它并不执着于用户到底从手机、平板还是桌面端进入。端只是入口，真正重要的是：让用户能把一个模糊但反复出现的问题、样例文件或截图交给 AI，由 AI 先帮忙把问题想清楚，再让 `codex`、`claude` 和兼容的本地工具在真实机器上把活做掉。

![RemoteLab 跨端演示](docs/readme-multisurface-demo.png)

> 当前基线：`v0.3` —— owner-first 的 session 运行时、落盘的持久历史、可替换的 executor adapter、基于 App 的 workflow packaging，以及同时兼容手机和桌面的无构建 Web UI。

> 同一套系统可以从桌面、手机，以及飞书 / 邮件这类接入面进入。

## 快速安装

如果上面的 demo 已经说明白了，那就别往下看了。直接在部署机器上开一个新的终端，启动 Codex、Claude Code 或其他 coding agent，然后把下面这段 prompt 粘贴进去：

```text
我想在这台机器上配置 RemoteLab，这样我就能从不同设备把重复数字工作交给 AI，并让它在真实机器上完成自动化。

网络模式：[cloudflare | tailscale]

# Cloudflare 模式：
我的域名：[YOUR_DOMAIN]
我想用的子域名：[SUBDOMAIN]

# Tailscale 模式：
（无需额外配置——宿主机和我想使用的客户端设备都已安装 Tailscale，并在同一个 tailnet 中。）

请把 `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/setup.md` 当作配置契约和唯一真相来源。
不要假设这个仓库已经提前 clone 到本地。如果 `~/code/remotelab` 还不存在，请你先读取那份契约，再自行 clone `https://github.com/Ninglo/remotelab.git`，然后继续完成安装。
后续流程都留在这个对话里。
开始执行前，请先用一条消息把缺少的上下文一次性问全，让我集中回复一次。
能自动完成的步骤请直接做。
我回复后，请持续自主执行；只在真的遇到 [HUMAN] 步骤、授权确认或最终完成时停下来。
停下来时，请明确告诉我具体要做什么，以及我做完后你会怎么验证。
```

如果你想先看更完整的说明，可以跳到 [安装细节](#安装细节) 或直接打开 `docs/setup.md`。

---

## 给人类看的部分

### 愿景

如果说得更直接一点，RemoteLab 是一个面向普通人的 AI 自动化工作台：它优先服务那些有重复数字工作、却还没有把 AI 真正用进日常流程的人。

我们希望用户不需要先理解模型、密钥、部署、机器或运维这些细节；理想状态下，用户只要打开一个专属链接，就能直接进入一个已经可工作的 AI 环境。

它的第一阶段目标也很具体：让用户花很短时间，就能把一个原本每周都要做几小时的琐碎工作交给 AI，例如数据整理、简单分析、报表生成、文件批处理、导出导入、通知触发这类事情；从交付形态上看，它也应该尽量朝 hosted / 云服务 / 开箱即用的方向演进。

### 基础判断

- 最值得解决的问题，不是鼓励用户同时开无数个 session，而是先找到那些确实值得自动化的重复工作。
- 目标用户默认不是 AI-native，也不是天生会写 prompt 的产品经理；AI 需要先帮他们把问题澄清、把输入要齐、把方案设计出来。
- 首屏不能只是一个空的 session list。新用户需要一个默认的 `Welcome App`：先用很短的话说明 RemoteLab 能做什么，再收集用户的角色背景和重复工作痛点，把他们引导到第一个具体 automation 上。
- 模型接入、机器、权限、连接与运维复杂度应该尽量封装在服务内部；普通用户面对的应该是一个开箱即用的入口，而不是一套需要先理解和配置的技术栈。
- 最好的切入点是简单、明确、回报快的数字工作：数据整理、分析、文件处理、报表、通知、脚本化重复操作。
- 手机 + 桌面 + 真机执行是组合优势：用户可以随手发上下文，AI 在真实机器上做重活，结果和审批再回到最方便的设备上。
- `Session`、`App`、并发和分发仍然重要，但它们更像能力层或后续放大的方向，不应该压过首期价值验证。

### RemoteLab 是什么

- 一个运行在真实机器之上的 AI 自动化工作台
- 一个帮助用户把模糊问题澄清成可执行方案的 AI 协作入口
- 一个尽量把模型、机器、权限与运维复杂度封装在服务端的低门槛 AI 服务
- 一个让手机端发起、桌面端继续、AI 在本机执行的跨端控制面
- 一个帮助人类在长任务中恢复上下文、而不是反复重讲需求的持久化工作线程系统
- 一个可以把验证过的自动化 workflow 封装成可复用 `App` 的 packaging layer

### RemoteLab 不是什么

- 终端模拟器
- 传统的 editor-first IDE
- 只服务 AI 专家的“并发 session 驾驶舱”
- 一个默认假设用户已经把需求拆解得非常清楚的 prompt playground
- 通用多用户聊天 SaaS
- 一个默认假设远端用户能直接浏览宿主机、按本地路径取结果的产品
- 一套试图在单任务执行层面正面超越 `codex` / `claude` 的闭环执行栈

### 两条核心产品线

1. **先帮用户解决重复数字工作。** RemoteLab 要能接住一个模糊但反复出现的任务，帮用户澄清输入、输出和约束，然后尽快把它变成一个能稳定省时间的自动化流程。
2. **再把被验证的 workflow 包装和复用。** 当某个自动化真的帮用户省下时间后，再把它沉淀成 `App`、模板或其他可复用入口，逐步扩展到同一个人或相邻人群的类似问题。

### 产品语法

当前产品模型刻意保持简单：

- `Session` —— 持久化的工作线程
- `Run` —— 会话内部的一次执行尝试
- `App` —— 启动会话用的可复用 workflow / policy package
- `Share snapshot` —— 不可变的只读会话导出

这些模型背后的架构假设是：

- HTTP 是规范状态路径，WebSocket 只负责提示“有东西变了”
- 浏览器是控制面，不是系统事实来源
- 运行时进程可以丢，持久状态必须落在磁盘上
- 产品默认单 owner，visitor 访问通过 `Apps` 进行 scope 控制
- 前端保持轻量、无框架，并兼容不同端的使用方式

### 为什么这个边界重要

RemoteLab 在几个点上是刻意有立场的：

- **先帮用户把问题讲明白，再执行。** RemoteLab 不应假设用户本身已经会像 AI 产品经理一样派活；AI 需要承担一部分问题澄清与方案设计责任。
- **通过用户可达的界面交付，而不是甩本地路径。** AI 可以操作这台机器，但用户协作面应该是 RemoteLab 和显式暴露的产品界面；如果结果只存在于宿主机本地，还不算完成交付。
- **不重造执行器这一层。** RemoteLab 不应该把主要精力花在优化单任务 Agent 内部实现细节上。
- **强调上下文恢复，不堆原始日志。** 比起终端连续性，durable session 更重要。
- **强调 workflow packaging，不只是分享 prompt。** `App` 不是一段复制粘贴文本，而是一种可复用的工作形态。
- **接入最强工具，并保持可替换。** 它更像一层稳定抽象，让更强执行器出现时可以被快速接入，而不是把自己做成重闭环 runtime。

### 你现在可以做什么

- 用手机或桌面端发消息，让 agent 在真实机器上执行
- 在 workflow 产出结果文件时，直接在会话里下载它们，而不是去宿主机上找路径
- 浏览器断开后依然保留持久化历史
- 在控制面重启后恢复长时间运行的工作
- 让 agent 自动生成会话标题和侧边栏分组
- 直接往聊天里粘贴截图
- 界面自动跟随系统亮色 / 暗色外观
- 生成不可变的只读分享快照
- 用 App 链接做 visitor 范围内的入口流转

### Provider 说明

- RemoteLab 现在把 `Codex`（`codex`）作为默认内置工具，并放到选择器最前面。
- 这并不意味着“执行器选择本身就是产品”。恰恰相反：RemoteLab 应该保持 adapter-first，把当前最强的本地执行器接进来。
- 对这种自托管控制面来说，API key / 本地 CLI 风格的集成通常比基于消费级登录态的远程封装更稳妥。
- `Claude Code` 依然可以在 RemoteLab 里使用；其他兼容的本地工具也可以接入，前提是它们的认证方式和服务条款适合你的实际场景。
- 长期目标是 executor portability，而不是绑定某一个闭环 runtime。
- 实际风险通常来自底层提供商的认证方式和服务条款，而不只是某个 CLI 的名字本身。是否接入、是否继续用，请你自行判断。

### 安装细节

最快的方式仍然是：把一段 setup prompt 粘贴给部署机器上的 Codex、Claude Code 或其他靠谱的 coding agent。它可以自动完成绝大多数步骤，只会在 Cloudflare 登录这类真正需要人工参与的地方停下来（仅当你选择 Cloudflare 模式时）。

这个仓库里的配置类和功能接入类文档都按同一个原则来写：人只需要把 prompt 发给自己的 AI agent，Agent 会尽量在最开始一轮把需要的上下文都问清楚，然后后续流程都留在那段对话里，只有明确标记为 `[HUMAN]` 的步骤才需要人离开对话手工处理。

最优雅的模式就是一次性交接：Agent 先一轮收齐信息，人回一次；之后 Agent 自己连续完成剩余工作，除非真的需要人工授权、浏览器操作、校验确认或最终验收。

**粘贴前的前置条件：**
- **macOS**：已安装 Homebrew + Node.js 18+
- **Linux**：Node.js 18+
- 至少安装了一个 AI 工具（`codex`、`claude`、`cline` 或兼容的本地工具）
- **网络**（二选一）：
  - **Cloudflare Tunnel**：域名已接入 Cloudflare（[免费账号](https://cloudflare.com)，域名约 ¥10–90/年，可从 Namecheap 或 Porkbun 购买）
  - **Tailscale**：[个人使用免费](https://tailscale.com)——宿主机和你想使用的各个客户端设备都安装 Tailscale 并加入同一个 tailnet，无需域名

**在宿主机开一个新的终端，启动 Codex 或其他 coding agent，然后粘贴这段 prompt：**

```text
我想在这台机器上配置 RemoteLab，这样我就能从不同设备把重复数字工作交给 AI，并让它在真实机器上完成自动化。

网络模式：[cloudflare | tailscale]

# Cloudflare 模式：
我的域名：[YOUR_DOMAIN]
我想用的子域名：[SUBDOMAIN]

# Tailscale 模式：
（无需额外配置——宿主机和我想使用的客户端设备都已安装 Tailscale，并在同一个 tailnet 中。）

请把 `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/setup.md` 当作配置契约和唯一真相来源。
不要假设这个仓库已经提前 clone 到本地。如果 `~/code/remotelab` 还不存在，请你先读取那份契约，再自行 clone `https://github.com/Ninglo/remotelab.git`，然后继续完成安装。
后续流程都留在这个对话里。
开始执行前，请先用一条消息把缺少的上下文一次性问全，让我集中回复一次。
能自动完成的步骤请直接做。
我回复后，请持续自主执行；只在真的遇到 [HUMAN] 步骤、授权确认或最终完成时停下来。
停下来时，请明确告诉我具体要做什么，以及我做完后你会怎么验证。
```

如果你想看完整的配置契约和人工节点说明，请直接看 `docs/setup.md`。

### 配置完成后你会得到什么

在你想使用的设备上打开 RemoteLab 地址：
- **Cloudflare**：`https://[subdomain].[domain]/?token=YOUR_TOKEN`
- **Tailscale**：`http://[hostname].[tailnet].ts.net:7690/?token=YOUR_TOKEN`

![Dashboard](docs/new-dashboard.png)

- 新建一个本地 AI 工具会话，默认优先使用 Codex
- 默认从 `~` 开始，也可以让 agent 切到其他仓库路径
- 发送消息时，界面会在后台不断重新拉取规范 HTTP 状态
- 关掉浏览器后再回来，不会丢失会话线程
- 生成不可变的只读会话分享快照
- 按需配置基于 App 的 visitor 流程和推送通知

### 日常使用

配置完成后，服务可以在开机时自动启动（macOS LaunchAgent / Linux systemd）。你平时只需要在手机或桌面端打开网址。

```bash
remotelab start
remotelab stop
remotelab restart chat
```

## 文档地图

如果你是经历了很多轮架构迭代后重新回来看，现在推荐按这个顺序读：

1. `README.md` / `README.zh.md` —— 产品概览、安装路径、日常操作
2. `docs/project-architecture.md` —— 当前已落地架构和代码地图
3. `docs/README.md` —— 文档分层和同步规则
4. `notes/current/core-domain-contract.md` —— 当前领域模型 / 重构基线
5. `notes/README.md` —— 笔记分桶和清理规则
6. `docs/setup.md`、`docs/external-message-protocol.md`、`docs/creating-apps.md`、`docs/feishu-bot-setup.md` 这类专题文档

---

## 架构速览

RemoteLab 当前的落地架构已经稳定在：一个主 chat 控制面、detached runners，以及落盘的持久状态。

| 服务 | 端口 | 职责 |
|------|------|------|
| `chat-server.mjs` | `7690` | 生产可用的主 chat / 控制面 |

```
浏览器 / 客户端入口                    浏览器 / 客户端入口
   │                                      │
   ▼                                      ▼
Cloudflare Tunnel                    Tailscale (VPN)
   │                                      │
   ▼                                      ▼
chat-server.mjs (:7690)             chat-server.mjs (:7690)
   │
   ├── HTTP 控制面
   ├── 鉴权 + 策略
   ├── session/run 编排
   ├── 持久化历史 + run 存储
   ├── 很薄的 WS invalidation
   └── detached runners
```

当前最重要的架构规则：

- `Session` 是主持久对象，`Run` 是它下面的执行对象
- 浏览器状态始终要回收敛到 HTTP 读取结果
- WebSocket 是无效化通道，不是规范消息通道
- 之所以能在控制面重启后恢复活跃工作，是因为真正的状态在磁盘上
- 开发 RemoteLab 自身时，`7690` 就是唯一默认 chat/control plane；现在依赖干净重启后的恢复能力，而不是常驻第二个验证服务

完整代码地图和流程拆解请看 `docs/project-architecture.md`。

外部渠道接入的规范契约请看 `docs/external-message-protocol.md`。

---

## CLI 命令

```text
remotelab setup                运行交互式配置向导
remotelab start                启动所有服务
remotelab stop                 停止所有服务
remotelab restart [service]    重启：chat | tunnel | all
remotelab guest-instance       创建带独立 config + memory 的访客实例
remotelab chat                 前台运行 chat server（调试用）
remotelab generate-token       生成新的访问 token
remotelab set-password         设置用户名和密码登录
remotelab --help               显示帮助
```

如果要把试用用户开通流程固定下来，默认优先用 `remotelab guest-instance create-trial`。它会自动选择下一个标准的 `trialN` 名称、分配安全端口、写好 Cloudflare hostname / tunnel ingress，并在 mailbox worker 已配置时顺手同步这个实例的收件地址。只有在你明确想要自定义实例名时，再用 `remotelab guest-instance create <name>`。如果 agent mailbox 已初始化，`create`、`create-trial` 和 `show` 都会直接打印这个实例对应的默认收件地址，比如 `rowan+trial4@example.com` 或 `trial4@example.com`；具体格式取决于 mailbox identity 的 `instanceAddressMode`。当 Cloudflare mailbox worker 已配置好时，创建流程也会自动尝试同步 Email Routing，这样每个新实例默认都会得到一个可用的对外收件地址；只有你明确想跳过这一步时，才传 `--no-mailbox-sync`。

日常运维尽量只记这几条稳定命令，不要再靠临时翻实现：

```text
remotelab guest-instance create-trial      # 创建下一个标准 trial 实例
remotelab guest-instance links             # 打印所有 guest 实例的带 token 分享链接
remotelab guest-instance links trial24     # 打印单个实例的带 token 分享链接
remotelab guest-instance links --check     # 在链接之外顺手探测当前本地/公网可达性
remotelab guest-instance converge --all    # 把所有 guest 实例收敛到当前源码树
```

如果你还维护了一个按路径分流的大陆入口，比如 `https://jojotry.nat100.top/<instance>/`，可以把共享前缀写进 `~/.config/remotelab/guest-instance-defaults.json`：

```json
{
  "mainlandBaseUrl": "https://jojotry.nat100.top"
}
```

配置好之后，`remotelab guest-instance create`、`create-trial`、`show` 和 `links` 都会自动打印常规公网链接以及大陆入口链接。需要一次性看全量实例入口时，优先用 `links`，不用再一个个查。为了避免这条路径代理只存在于家目录里的临时脚本，仓库里现在也收编了 `scripts/natapp-dual-proxy.mjs`，可以直接把大陆桥接服务的 launch agent 指向它。

现在这条大陆桥的根路径默认也可以直接指向 owner 主服务（默认本机 `7690` 端口），而 guest instance 继续走 `https://<mainland-base>/<instance>/` 这种路径前缀分流；如果你需要临时把根路径改到别的实例，可以给代理脚本设置 `NATAPP_ROOT_UPSTREAM_PORT`。

如果机器上还留着早期那种按实例复制出来的 runtime（例如 `remotelab-trial-runtime`），可以运行 `remotelab guest-instance converge <name>` 或 `remotelab guest-instance converge --all`。它会保持原来的端口、域名、登录信息、config 和 memory 目录不变，只把 launch agent 的代码入口切回当前的 `~/code/remotelab`，这样以后代码更新就能统一落到所有实例上，而不用改用户手里的链接。

完成收敛后，这些共享代码树的 guest runtime 会在各自重启后直接吃到当前源码版本：外部链接保持不变，实例自己的状态、资源、config 和 memory 仍然继续隔离，但不再额外经过一层 release snapshot。

如果你希望每个 guest instance 都有一个对外可用的收件地址，优先做法应该是把 Cloudflare Email Routing 配成 catch-all -> Email Worker，而不是给每个实例单独建邮箱账号。`node scripts/agent-mail-cloudflare-routing.mjs status` 会打印期望的路由形态，`probe --address <email>` 可以直接验证像 `trial6@example.com` 这样的地址当前在 SMTP 层是否会被接受。

## 配置项

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHAT_PORT` | `7690` | Chat server 端口 |
| `CHAT_BIND_HOST` | `127.0.0.1` | Chat server 监听地址（`127.0.0.1` 用于 Cloudflare / 仅本机访问，`0.0.0.0` 用于 Tailscale 或局域网访问） |
| `SESSION_EXPIRY` | `86400000` | Cookie 有效期（毫秒，24h） |
| `SECURE_COOKIES` | `1` | Tailscale 或本地 HTTP 访问时设为 `0`（无 HTTPS） |
| `REMOTELAB_INSTANCE_ROOT` | 未设置 | 可选的额外实例数据根目录；设置后默认使用 `<root>/config` + `<root>/memory` |
| `REMOTELAB_CONFIG_DIR` | `~/.config/remotelab` | 可选的运行时数据/配置目录覆盖，包含 auth、sessions、runs、apps、push、provider runtime home |
| `REMOTELAB_MEMORY_DIR` | `~/.remotelab/memory` | 可选的用户 memory 目录覆盖，供 pointer-first 启动使用 |

## 常用文件位置

下面这些是未设置实例覆盖变量时的默认路径。

| 路径 | 内容 |
|------|------|
| `~/.config/remotelab/auth.json` | 访问 token + 密码哈希 |
| `~/.config/remotelab/auth-sessions.json` | Owner / visitor 登录会话 |
| `~/.config/remotelab/chat-sessions.json` | Chat 会话元数据 |
| `~/.config/remotelab/chat-history/` | 每个会话的事件存储（`meta.json`、`context.json`、`events/*.json`、`bodies/*.txt`） |
| `~/.config/remotelab/chat-runs/` | 持久化 run manifest、spool 输出和最终结果 |
| `~/.config/remotelab/apps.json` | App 模板定义 |
| `~/.config/remotelab/shared-snapshots/` | 不可变的只读会话分享快照 |
| `~/.remotelab/memory/` | pointer-first 启动时使用的机器私有 memory |
| `~/Library/Logs/chat-server.log` | Chat server 标准输出 **(macOS)** |
| `~/Library/Logs/cloudflared.log` | Tunnel 标准输出 **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server 标准输出 **(Linux)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel 标准输出 **(Linux)** |

## 安全

- **Cloudflare 模式**：通过 Cloudflare 提供 HTTPS（边缘 TLS，机器侧仍是本地 HTTP）；服务只绑定 `127.0.0.1`
- **Tailscale 模式**：流量由 Tailscale 的 WireGuard mesh 加密；服务绑定 `0.0.0.0`（所有接口），因此端口也可从局域网/公网访问——在不可信网络中，建议配置防火墙将 `7690` 端口限制为 Tailscale 子网（如 `100.64.0.0/10`）
- `256` 位随机访问 token，做时序安全比较
- 可选 scrypt 哈希密码登录
- `HttpOnly` + `Secure` + `SameSite=Strict` 的认证 cookie（Tailscale 模式下关闭 `Secure`）
- 登录失败按 IP 限流，并做指数退避
- 默认服务只绑定 `127.0.0.1`，不直接暴露到公网；如需局域网访问，设置 `CHAT_BIND_HOST=0.0.0.0`
- 分享快照是只读的，并与 owner 聊天面隔离
- CSP 头使用基于 nonce 的脚本白名单

## 手动起第二实例

- `scripts/chat-instance.sh` 现在除了旧的 `--home` 模式，也支持 `--instance-root`、`--config-dir`、`--memory-dir`。
- 如果你想让第二实例继续复用当前机器的 provider 登录状态、但把 RemoteLab 自己的数据和 memory 完全隔离，优先用 `--instance-root`。
- 示例：`scripts/chat-instance.sh start --port 7692 --name companion --instance-root ~/.remotelab/instances/companion --secure-cookies 1`

## 故障排查

**服务启动失败**

```bash
# macOS
tail -50 ~/Library/Logs/chat-server.error.log

# Linux
journalctl --user -u remotelab-chat -n 50
tail -50 ~/.local/share/remotelab/logs/chat-server.error.log
```

**DNS 还没解析出来**

配置完成后等待 `5–30` 分钟，再执行：

```bash
dig SUBDOMAIN.DOMAIN +short
```

**端口被占用**

```bash
lsof -i :7690
```

**重启单个服务**

```bash
remotelab restart chat
remotelab restart tunnel
```

---

## License

MIT
