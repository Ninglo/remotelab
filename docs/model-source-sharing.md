# Model source sharing: personal, group and public

In **Settings → Model sources** (`/?tab=settings#settings-model-sources`), the
binding owner selects the scope and confirms the member list. Groups are fixed
lists of verified RemoteLab People, not Feishu chats. Web and linked Feishu
identities refer to the same People. An invite gives invocation rights, never
ownership or the ability to delegate. Administrator status is not a grant.

| Scope | Codex subscription | Managed API source |
| --- | --- | --- |
| Personal | Existing My Codex device authorization, owner only | Default on operator registration, owner only |
| Group | Change your existing My Codex binding to Group and select People | Owner plus selected People |
| Public | Existing admin-managed public Codex pool, unchanged | Explicit Public scope, then available to this instance |

A Person can have one My Codex binding (Personal or Group) and receive access
to other people's Group bindings. Codex/Pi on `openai-codex` prefers a personal
binding, then an available granted group account, then the existing public pool
if there is no eligible group membership. Group selection does not update public
pool preferences or affinity. A request already assigned to the group does not
silently fall back to the public pool if its group credentials are unavailable or
revoked. Personal confirmed-exhaustion behavior remains unchanged. Group owners
use the same device login and unbind controls as personal owners. Reauthorization
preserves the sharing list; successful unbind clears it. Other Pi providers do
not start using Codex credentials.

An owner can edit the list and switch scopes without uploading credentials again.
New requests, queued starts and new live inputs are checked. Revocation does not
cancel an already-running provider subprocess or revoke a provider-side token.
An old Session selection is not a grant: if denied, choose an eligible source
and resend. A Feishu shortcut may not overwrite a topic's saved source unless
the current sender can use it.

## Provision a new API source

Copyable operator handoff: “Register this supported runtime and approved provider
endpoint as an independently named managed model source. Use the private credential
channel and its existing credential adapter; do not put the key in chat, tool
arguments, model metadata or logs. Verify the employee who controls the credential
and register their verified Person ID as owner. Read back the initial Personal
scope and let the owner choose sharing in Settings. Confirm an unrelated Person
cannot list or start the source.”

1. Use an existing supported runtime/credential adapter and a distinct `tools.json`
   entry with `managedProviderSource: true`. Do not embed secrets in the entry.
2. On the instance as its operator, run
   `node scripts/register-model-source.mjs <tool-id> <verified-owner-person-id>`.
   This registers ownership and enables the default Personal scope, not a token.
   The owner can then edit scope, members or enablement in Settings. Raw key upload
   through the browser or Feishu is intentionally not enabled. An adapter is still
   needed for provider protocols not supported by this instance.
3. Access metadata lives separately from credentials, in keyed private files
   under `model-source-sharing/`. Disable the source there through Settings or
   operator maintenance; don't remove `managedProviderSource` to disable a source.
   Missing/invalid authorization on a managed source denies execution.

The legacy `claude-topic-pilot` tool used by `/claude` and `/claude-x` is always
managed even without the tool flag. Stage its scoped instance record **before**
starting the new server. An existing credential whose owner is not yet registered
can have an operator-maintained Group policy (`ownerPersonId: null`, verified
`memberPersonIds`, `enabled: true`, `revision: 1`). Only the instance operator can
assign the verified credential owner for that migrated record. An existing token
and its runtime configuration need not move.

The policy controls the RemoteLab product surface, not arbitrary shell access
on the trusted runtime host. Operators must separately protect the credential
adapter and its environment; do not treat this feature as OS-level containment
for agents or people sharing the host UID. Do not publish a Key by embedding it
in a prompt, uploaded artifact, custom launcher argument or client response.

## Verification and rollback

Run `tests/test-http-personal-codex.mjs`, `tests/test-feishu-runtime-commands.mjs`,
`tests/test-native-request-dispatch.mjs` and the public Codex allocation tests in
clean instance environments. The HTTP fixture exercises owner/member/outsider,
settings revisions, group versus public allocation, old Session revocation, and
Feishu sender identity using synthetic credentials.

Codex group bindings retain the on-disk `personal` ownership and add sharing
metadata; old allocation code will not leak them into the public pool. A rollback
below API admission support must first disable restricted custom provider tools
and retire their shortcut aliases, so that an older server never exposes a
scoped key through a saved tool or Feishu route. Do not rollback by marking a
private or group source Public. Preserve account records, provider sessions,
and audit metadata for reactivation.
