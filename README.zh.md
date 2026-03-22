# RemoteLab

[English](README.md) | 中文

**面向超级个体的 AI 工作台。**

RemoteLab 的目标，是为那些已经熟练使用 AI、以及未来会越来越多出现的 AI-native 超级个体，提供最高效率的人机协作形态。

它并不执着于用户到底从手机、平板还是桌面端进入。端只是入口，真正重要的是：让人用最低认知负担去指挥 AI 工作，让 `codex`、`claude` 和兼容的本地工具在真实机器上把活做掉。

![RemoteLab 跨端演示](docs/readme-multisurface-demo.png)

> 当前基线：`v0.3` —— owner-first 的 session 编排、落盘的持久历史、可替换的 executor adapter、基于 App 的 workflow packaging，以及同时兼容手机和桌面的无构建 Web UI。

> 同一套系统可以从桌面、手机，以及飞书 / 邮件这类接入面进入。

## 快速安装

如果上面的 demo 已经说明白了，那就别往下看了。直接在部署机器上开一个新的终端，启动 Codex、Claude Code 或其他 coding agent，然后把下面这段 prompt 粘贴进去：

```text
我想在这台机器上配置 RemoteLab，这样我就能从不同设备控制 AI worker，并把长时间运行的 AI 工作组织起来。

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

如果说得更直接一点，RemoteLab 是面向未来超级个体的 AI IDE 工作台：服务于那群能熟练运用 AI，把个人杠杆放大到普通人数倍乃至数十倍的人。

它的目标很简单：找到人与越来越自主的 Agent 之间最高效的交互形式，再把这种交互形式产品化，真正提升人类运用 AI 的生产力。

### 基础判断

- 单轮任务的 scope 会持续放大：从分钟级，到小时级，再到天级，甚至周级。
- 并发会成为默认状态：想最大化 AI 生产效率，人就会同时跑越来越多 Agent。
- 人类记忆会成为瓶颈：几个小时后任务回来时，人需要的是上下文快速恢复，而不是原始日志堆砌。
- 项目编排会成为个人基础设施：并发线程一多，就必须有人机协同地处理优先级、阻塞点和跟进节奏。
- 超级个体一定会有分发需求：当某个 workflow 被验证有效后，他们会希望把它封装起来，让更多人也能直接使用。

### RemoteLab 是什么

- 一个架在强执行器之上的 AI 工作台
- 一个面向并发 Agent 工作的项目管理与编排层
- 一个帮助人类在长任务中恢复上下文的外置记忆系统
- 一个面向 Agentic Native 应用的工作流封装与分发层
- 一个不锁定具体端形态、而是让手机和桌面都能顺手工作的 Web 产品

### RemoteLab 不是什么

- 终端模拟器
- 传统的 editor-first IDE
- 通用多用户聊天 SaaS
- 一套试图在单任务执行层面正面超越 `codex` / `claude` 的闭环执行栈

### 两条核心产品线

1. **单任务执行器之上的任务编排与项目管理。** RemoteLab 帮用户管理自己正在推进的全量工作：开更多并发、看更清进度、更快恢复上下文、更合理分配注意力，并尽可能提高最终质量与效率。
2. **Agentic Native 应用的低成本搭建与分发。** RemoteLab 让超级个体可以把自己的 SOP 沉淀成可分发的 agentic-native workflow，无论最终承载它的是内置 Web UI、外部 Bot，还是其他前端入口。

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

- **不重造执行器这一层。** RemoteLab 不应该把主要精力花在优化单任务 Agent 内部实现细节上。
- **强调上下文恢复，不堆原始日志。** 比起终端连续性，durable session 更重要。
- **强调 workflow packaging，不只是分享 prompt。** `App` 不是一段复制粘贴文本，而是一种可复用的工作形态。
- **接入最强工具，并保持可替换。** 它更像一层稳定抽象，让更强执行器出现时可以被快速接入，而不是把自己做成重闭环 runtime。

### 你现在可以做什么

- 用手机或桌面端发消息，让 agent 在真实机器上执行
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
我想在这台机器上配置 RemoteLab，这样我就能从不同设备控制 AI worker，并把长时间运行的 AI 工作组织起来。

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
remotelab chat                 前台运行 chat server（调试用）
remotelab generate-token       生成新的访问 token
remotelab set-password         设置用户名和密码登录
remotelab --help               显示帮助
```

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
