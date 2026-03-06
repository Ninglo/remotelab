# RemoteLab

[English](README.md) | 中文

用手机浏览器远程控制 Mac 或 Linux 服务器上的 AI 编程工具（Claude Code、Codex、Cline）——无需 SSH，无需 VPN，只要一个浏览器。

![Chat UI](docs/demo.gif)

---

## 给人类看的部分

### 它能做什么

RemoteLab 在你的 Mac 或 Linux 服务器上运行一个轻量级 Web 服务器。配合 Cloudflare Tunnel 得到一个 HTTPS 地址，之后在任意浏览器（手机、平板、随便什么设备）打开，就能和运行在服务器上的 Claude Code 对话。

会话断开后依然保活。历史记录存到磁盘。多个文件夹、多个会话可以并行运行。

### 5 分钟配置完成——直接交给 AI

最快的方式：把下面的 prompt 粘贴到 Mac 或 Linux 上的 Claude Code，让 AI 全程自动完成配置。唯一需要你手动操作的是 Cloudflare 的浏览器登录（没法绕过，他们要确认你拥有这个域名）。

**粘贴前的前置条件：**
- macOS（已安装 Homebrew）或 Linux
- Node.js 18+
- 至少安装了一个 AI 工具（`claude`、`codex`）
- 域名已接入 Cloudflare（[免费注册](https://cloudflare.com)，域名约 ¥10–90/年，可从 Namecheap 或 Porkbun 购买）

---

**把这段 prompt 粘贴到 Claude Code：**

```
我想在这台 Mac/Linux 服务器上配置 RemoteLab，这样我就能用手机远程控制 AI 编程工具了。

我的域名：[YOUR_DOMAIN]（例如 example.com）
我想用的子域名：[SUBDOMAIN]（例如 chat，会创建 chat.example.com）

请按照本仓库 docs/setup.md 中的完整安装指南一步步来。
能自动完成的步骤请直接做。遇到 [HUMAN] 步骤时，停下来告诉我具体需要做什么。
我确认每个手动步骤后，继续下一个阶段。
```

填入你的域名和子域名，粘贴进去，按照 AI 的指引操作就行。你只需要点一次 Cloudflare 的浏览器登录，其余全部自动化。

---

### 配置完成后你会得到什么

在手机上打开 `https://[subdomain].[domain]/?token=YOUR_TOKEN`：

![Dashboard](docs/new-dashboard.png)

- 新建会话：选择一个文件夹 + AI 工具
- 发送消息——响应实时流式返回
- 关闭浏览器，过段时间回来——会话依然活着
- 可以直接粘贴截图到对话框

### 日常使用

配置完成后，服务会在开机时自动启动（macOS LaunchAgent / Linux systemd），直接在手机上打开网址就能用。

```
remotelab start          # 启动所有服务
remotelab stop           # 停止所有服务
remotelab restart chat   # 只重启 chat server
```

---

## 架构

两个服务在你的 Mac 或 Linux 服务器上运行，隐藏在 Cloudflare Tunnel 后面：

| 服务 | 端口 | 职责 |
|------|------|------|
| `chat-server.mjs` | 7690 | **主服务**。Chat UI，启动 CLI 工具，WebSocket 流式传输 |
| `auth-proxy.mjs` | 7681 | **备用**。通过 ttyd 提供原始终端——仅用于应急 |

Cloudflare Tunnel 将你的域名路由到 chat server（7690）。auth-proxy 仅监听 localhost——如果 chat 崩得很惨，SSH 进去直接访问它。

```
手机 ──HTTPS──→ Cloudflare Tunnel ──→ chat-server :7690
                                              │
                                        启动子进程
                                        (claude / codex / cline)
                                              │
                                        流式事件 → WebSocket → 浏览器
```

### 会话持久化

每个 chat 会话是一个子进程。断开连接后，进程继续运行。重新连接时，服务器会重放历史记录并重新接入实时流。

如果在活跃运行期间 `chat-server` 本身被重启，这个子进程仍然会被中断。RemoteLab 现在会把该会话标记为 `interrupted`，并在 Claude/Codex 的 resume 元数据已捕获时提供 `Resume` 操作，把“可恢复”显式化，而不是默默丢掉这次 turn。

做自举开发时，不要在你准备频繁重启的同一个实例上完成开发操作。应该用稳定的 operator plane（例如 `7690`）去改代码、重启目标测试实例（`7692`）。自定义端口的开发实例请使用 `scripts/chat-instance.sh`。

---

## CLI 命令

```
remotelab setup                运行交互式配置向导
remotelab start                启动所有服务
remotelab stop                 停止所有服务
remotelab restart [service]    重启：chat | proxy | tunnel | all
remotelab chat                 前台运行 chat server（调试用）
remotelab server               前台运行 auth proxy（调试用）
remotelab generate-token       生成新的访问 token
remotelab set-password         设置用户名和密码（token 的替代方案）
remotelab --help               显示帮助
```

## 配置项

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHAT_PORT` | `7690` | Chat server 端口 |
| `LISTEN_PORT` | `7681` | Auth proxy 端口 |
| `SESSION_EXPIRY` | `86400000` | Cookie 有效期（毫秒，24h） |
| `SECURE_COOKIES` | `1` | 本地不走 HTTPS 时设为 `0` |

## 文件位置

| 路径 | 内容 |
|------|------|
| `~/.config/remotelab/auth.json` | 访问 token + 密码哈希 |
| `~/.config/remotelab/chat-sessions.json` | Chat 会话元数据 |
| `~/.config/remotelab/chat-history/` | 每个会话的事件日志（JSONL） |
| `~/Library/Logs/chat-server.log` | Chat server 标准输出 **(macOS)** |
| `~/Library/Logs/auth-proxy.log` | Auth proxy 标准输出 **(macOS)** |
| `~/Library/Logs/cloudflared.log` | Tunnel 标准输出 **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server 标准输出 **(Linux)** |
| `~/.local/share/remotelab/logs/auth-proxy.log` | Auth proxy 标准输出 **(Linux)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel 标准输出 **(Linux)** |

## 安全

- 通过 Cloudflare 提供 HTTPS（边缘 TLS，服务器侧是本地 HTTP）
- 256 位随机访问 token，时序安全比较
- 可选 scrypt 哈希密码登录
- HttpOnly + Secure + SameSite=Strict session cookie，24h 过期
- 登录失败按 IP 限流，指数退避
- 服务只绑定 127.0.0.1，不直接对外暴露
- CSP 头 + nonce-based script 白名单

## 故障排查

**服务启动失败：**
```bash
# macOS
tail -50 ~/Library/Logs/chat-server.error.log
tail -50 ~/Library/Logs/auth-proxy.error.log
# Linux
journalctl --user -u remotelab-chat -n 50
tail -50 ~/.local/share/remotelab/logs/chat-server.error.log
```

**DNS 解析不了：** 配置完成后等 5–30 分钟。验证：`dig SUBDOMAIN.DOMAIN +short`

**端口被占用：**
```bash
lsof -i :7690   # chat server
lsof -i :7681   # auth proxy
```

**重启单个服务：**
```bash
remotelab restart chat
remotelab restart proxy
remotelab restart tunnel
```

**管理自定义开发 chat 实例：**
```bash
scripts/chat-instance.sh restart --port 7692 --name test
scripts/chat-instance.sh status --port 7692 --name test
scripts/chat-instance.sh logs --port 7692 --name test
```

---

## License

MIT
