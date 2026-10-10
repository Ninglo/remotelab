# Feishu monthly API quota failures

When replies stop arriving, compare inbound admission, Run execution and
provider delivery receipts first. A completed Run is not a delivered reply.

Feishu code `99991403` means the monthly API quota has been exhausted. It can
arrive with HTTP 429 or as a structured business response. Unlike `99991400`
short-term throttling, retrying it every few seconds cannot restore the quota.
See the [official platform notice](https://open.feishu.cn/document/platform-notices/platform-updates-/custom-app-api-call-limit).

The card worker pauses its Bot route on that rejection, clears retry timers,
and saves `quotaBlocked` in its existing private state. New Session events
remain in durable history; card IDs, task evidence and disclosure choices
remain intact. A definitely rejected card create is eligible for recovery
with the same deterministic UUID. An uncertain create remains fenced.
Read/reconciliation and ordinary delivery policies also avoid short automatic
retries of this monthly failure. Failed deliveries remain visible in Web.

Ask the enterprise administrator to verify and restore quota in Feishu before
resuming publication. Do not silently change the Bot or tenant. Preserve live
work and use the registered service manager to stop a faulty card writer when
needed. After quota restoration, verify an affected interface, clean source
and the existing card state, then restart that route worker. A restart alone
does not restore quota. Review saved failed deliveries individually before
retrying them; never replay unknown sends or backfill obsolete progress cards.

Isolated tests cover quota versus short throttling, definite delivery rejection,
route blocking and card creation recovery. Production quota restoration and
actual Feishu delivery require separate live evidence.
