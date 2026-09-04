# Auto-Promoted System Memory Review Queue

This file is a temporary review queue for automatically proposed cross-deployment learnings.

Before publishing the repository:

- promote only stable, deployment-agnostic lessons into `memory/system.md`
- move user-, machine-, customer-, project-, and incident-specific notes into local or project-scoped memory
- remove duplicates, dated case residue, credentials, private paths, hostnames, account identifiers, and raw investigation logs
- leave this queue empty after review

## Candidates

<!-- Automatically proposed candidates may be appended below. -->

- Static artifact delivery verification must check the final URL and expected artifact marker/title, not only an eventual HTTP 200 and `text/html`: an authentication redirect can end on a login page that returns 200. Treat a login redirect or unexpected page as an incomplete user handoff.

## Learnings

- RemoteLab 的邮箱连接必须由 WebUI 用户通过 SSO/OAuth 明确授权，查询只能使用与当前实例和用户绑定的令牌；未授权时应提示授权，不得回退到机器预置的 CLI 身份。
- 用户隔离边界是独立 RemoteLab 实例，不是 Session。每个用户实例拥有自己的配置、记忆、工作区、认证、Connector 与多个任务 Session；不要在单实例里用会话标签模拟多用户隔离。
- RemoteLab 新建会话采用前端空白草稿：只有首次发送消息或附件时才创建后端 Session，避免遗留空会话。
- RemoteLab 中 Codex/对话旧线程失效属于可恢复小故障，应由系统自动恢复：优先为同一条用户消息创建新线程重跑并保存新线程 ID，而不是让用户看到报错或要求重发。
