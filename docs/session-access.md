# Session ownership and administrator access

Ordinary workbench accounts can read and operate only Sessions they created. Administrators can access all Sessions. This is enforced on the server for lists (including archived counts and summary references), search, direct URLs, events and bodies, Runs, mutations, shares, file assets, legacy media, WebSocket hints and completion push notifications. Display filters and personal Space/group organization do not grant access.

## Operator handoff

> Inspect this instance's auth document and existing identities. Set `administratorPersonIds` to the verified administrator Person IDs, retaining all accounts, credentials and history. Validate two ordinary accounts and an administrator through HTTP and separate browser contexts; check direct URLs, search, assets, identity spoofing and notifications. Preserve connector service authentication and detached execution. Commit, deploy the authorized instance, verify its loaded commit, then update its existing user guide. Ask only for missing human identity evidence or an actual human browser check.

`auth.json` stores an explicit `administratorPersonIds` array. Old installations without the field retain their primary operator as administrator on migration; configure the intended administrators before restarting an existing shared instance. An explicit empty array grants no human administrator rights. Service authentication remains a separate machine capability for already authorized connectors, runners and maintenance; it is not a human administrator account. Browser account/identity management for other People, cross-Session monitoring, source deliveries, global work discovery and shared desktop access require administrator access. New unscoped browser APIs default to administrator-only until their ownership checks are implemented.

## Creation and historical records

- New Web Sessions use the authenticated account's identity. Browser-supplied owner/Person fields cannot select a creator, and connector source/binding metadata requires service authentication.
- `creatorIdentityId` is recorded at creation and retained when later speakers or attribution fields change. At the legacy metadata boundary, the existing recorded initiator is frozen; absent attribution and existing group feeds become system/unknown. No display name, last speaker, participant list or client claim is used to infer an owner.
- Identity IDs resolve through the server's established Person directory, including historical identity aliases. New external subjects do not merge into accounts merely because a name or handle matches. Exceptional binding uses the administrator's existing identity-management operation. Feishu console sign-in still requires an already provisioned account and established identity mapping; this change does not enable automatic account creation.
- Group mainlines created by the system remain administrator-only on the Web. Connector message reception and group replies continue under their existing source authentication. Being a group member or replying does not confer ownership of its Web Session.
- Scheduled tasks retain their recorded creator identity. New execution Sessions use that identity; ordinary browser task lists and controls are restricted to that creator. Unknown task ownership remains administrator-only. Existing scheduler and runner authentication is unchanged.
- Web forks use the authenticated forker; service-created forks/delegations use the accepted request identity when available, otherwise the recorded parent initiator. Independent routed work and execution plans retain the accepted human request's identity. Unknown ownership is not made public.

Legacy media ownership is indexed by filename at upload or from trusted persisted event attachments when their Session is read. Unindexed legacy media fail closed until the owning event is read or an administrator handles it. File assets use their recorded Session. Private event bodies and media are no longer issued with public/immutable cache directives.

## Sharing and boundaries

A normal Session URL does not grant access. Explicit immutable ShareSnapshot publications and already published sites retain their separate publication rules. Previously downloaded material and existing externally signed asset URLs cannot be recalled by changing Session visibility. The workbench still executes agents on its configured machine; these HTTP rules do not provide operating-system or agent filesystem isolation. Separate instances and OS permissions remain necessary across machine trust boundaries.

## Verification and recovery

`node scripts/run-with-clean-instance-env.mjs node tests/test-session-access.mjs` exercises real HTTP login, ordinary/admin/service accounts, lists and refs, direct links, event/body APIs, media/assets, search, forged identities, forks, task controls, role revocation and WebSocket hints. Optional `REMOTELAB_TEST_PLAYWRIGHT_MODULE` and `REMOTELAB_TEST_CHROMIUM_PATH` run three isolated headless browser logins. These are test fixtures, not evidence that human users have completed browser acceptance. Scheduler lifecycle and connector tests retain their own isolated fixtures.

Before rollout, retain the current auth configuration privately and record the previous commit. On a policy/configuration issue, use the existing service credential or verified administrator to inspect ownership and repair the exact mapping/configuration; restart/reload the authorized service and recheck both positive and negative paths. A code rollback is a new revert commit of this change followed by deployment, retaining all new Session/history/auth state and concurrent commits. Reverting the policy restores broad authenticated access; do not restore an old data backup over newly accepted work.
