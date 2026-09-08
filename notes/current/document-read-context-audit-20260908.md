# Document-read context audit — 2026-09-08

## Verified failure chain (sanitized)

- The executor loaded lark-doc and lark-shared, then docs +fetch --as user returned config/not_configured. It treated a missing effective CLI configuration as a setup task for the user rather than locating the existing source-bound configuration.
- The Skills said login was required before first document use and categorically claimed bots cannot read user documents. These are misleading: existing authorization should be reused, and document access depends on scopes and resource ACLs. Local installed Skills were corrected (outside this repository; CLI updates may replace them).
- The source runtime prompt named an HTTP endpoint without explaining authentication. The executor used bare curl and got 401. The documented path now uses remotelab api with the instance base URL.
- Once the correct source's existing CLI directory was selected, both user and bot identities were verified ready, and a bot document fetch succeeded. No new authorization was needed. A fresh bot outline fetch reproduced success during this audit.
- The post-turn classifier summary remained at an earlier blocked state even after successful document reading and a later runtime-default update. Earlier blocked summaries were repeatedly injected as current conclusions and user dependencies. Remove automatic classifier-summary injection from the turn hook; retain stored summaries for UI/explicit inspection. Native history and other continuation paths are not deleted. Tradeoff: cross-Harness prompts no longer automatically include this derived summary either.
- The connector catalog claimed completeness without distinguishing independent CLI/Skill capabilities. Narrow that statement to the catalog itself.

## Not established

No tool evidence shows that the failed reading turns loaded old global/user-memory files. Do not delete unrelated historical memory or blame reasoning effort alone. The configuration was not automatically supplied to the executor; this patch improves discovery instructions but does not implement source-bound environment projection.

## Verification

- test-turn-context-hook
- test-session-manager-build-prompt
- Live source-context read with remotelab api
- Live document outline fetch using the matching existing bot profile: ok=true, identity=bot

Existing historical prompts and stale UI summaries are preserved as evidence; removing injection does not rewrite native thread history.
