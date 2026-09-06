# Feishu CLI

Use this skill for direct lark-cli access when the user asks to read or write
Feishu/Lark resources such as Docs, Wiki, Base/Bitable, Sheets, Drive, Tasks,
Calendar, or messages.

## Runtime contract

- The current instance owns the lark-cli config, profiles, and credentials.
- Use the CLI's available authorized identities and profiles. Inspect
  `profile list` and `auth status --json --verify`; use `--as user` for authorized
  user access or `--as bot` for application access as the task requires.
- Do not request, copy, or print the connector App Secret.
- RemoteLab does not impose Bot-only mode or reset the CLI's default identity.
  Respect an owner's explicit CLI policy; user login still requires their OAuth
  consent. Never borrow another instance's credentials.
- Do not use connector-private HTTP wrappers for general Feishu API work.

## Workflow

Read the version-matched CLI skill before acting:

```bash
lark-cli skills read lark-shared
lark-cli skills read lark-doc
lark-cli skills read lark-base
```

Then use the corresponding direct CLI command. For a capability not covered by
an existing skill, read `lark-openapi-explorer` and invoke the native OpenAPI
through lark-cli rather than adding a RemoteLab wrapper.

Before a destructive or high-risk action, follow the CLI's own confirmation and
risk policy. Feishu still enforces the app's published scopes and resource-level
permissions.

For a read denied to Bot, check whether a user identity is already authorized
for the requested resource before asking someone to change resource permissions.
An absent user login is an authorization checkpoint, not a reason to disable
the CLI's user capabilities. Identity fallback for reads does not authorize
sending or modifying data as the user without the corresponding task intent.
