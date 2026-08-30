# Feishu CLI

Use this skill for direct lark-cli access when the user asks to read or write
Feishu/Lark resources such as Docs, Wiki, Base/Bitable, Sheets, Drive, Tasks,
Calendar, or messages.

## Runtime contract

- The current Bot instance owns the lark-cli config and credentials.
- The CLI is pinned to Bot identity and uses the Feishu app's published scopes.
- Do not request, copy, or print the connector App Secret.
- Do not switch identity or weaken strict mode.
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
