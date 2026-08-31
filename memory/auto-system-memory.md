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
- Space、Group、排序及自动命名必须按账号隔离；所有整理操作只能读取和修改同一账号的 Sessions，管理员全账号视图仅用于查看，不得跨账号重排。
- RemoteLab 新建会话采用前端空白草稿：只有首次发送消息或附件时才创建后端 Session，避免遗留空会话。
- RemoteLab 中 Codex/对话旧线程失效属于可恢复小故障，应由系统自动恢复：优先为同一条用户消息创建新线程重跑并保存新线程 ID，而不是让用户看到报错或要求重发。
