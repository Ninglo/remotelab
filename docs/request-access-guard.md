# Request admission guard

Enable a local, deterministic guard when a deployment needs to reject known
restricted requests before model execution. Set `REMOTELAB_REQUEST_ACCESS_GUARD`
to an explicitly managed JSON policy on the Core and its Feishu connector.
Without this setting the existing admission behavior is unchanged. An enabled
but unreadable or malformed policy refuses admission. Keep identities and real
deployment rules outside the source repository.

The version 1 policy has `policyId`, exact `allowPairs` of Person and identity,
optional `allowFeishu` entries (`route`, `tenant`, `openId`), `contextSeconds`,
and `rules`. Each rule has `category` (`protected`, `indirect`, `bypass`) and an
`all` array of JavaScript regular expressions. `continuation: true` limits a
rule to the same sender and Session after a prior match. Rule expressions are
trusted operator configuration, never supplied by the requester. Authenticated
Feishu identities use the validated connector route and tenant; body text,
display names and Session ownership never grant access. Internal operations
retain existing scopes; a guard is not an automation authorization system.

The guard runs in `submitHttpMessage` before routing, attachment processing and
native in-flight forwarding. A denial commits a completed, released Request,
uses the existing reply outbox and records a fixed answer in history. No Run is
created. Retries retain that result, and restart recovery cannot execute it.
The restricted interview query path runs the same check before loading API
credentials or querying its backend, and checks again before publication.

An optional `interview` setting routes limited candidate questions into a signed
business API instead of a general model. `actors` binds authenticated source
route/tenant/open ID to the verified target-app open ID; the backend must still
enforce current role and candidate assignment. Missing bindings refuse lookup.
Mixed requests receive only the closed safe-field response plus a refusal and
denial event for the protected part. Backend text, feedback and extra fields are
never forwarded. Protocol v1 reports the absence of a separate question record;
it does not infer historical questions from interview evaluations. Five-person
confidential-data exceptions retain their existing access and business workflows.

Every denial also commits a metadata-only outbox file under
`CONFIG_DIR/request-access-guard/denials/pending`. It contains the decision,
original request/message identity and authenticated attribution, not the input
text, attachments, credentials or conversation history. An independent local
observer must consume this outbox and preserve per-recipient receipts; merely
enabling this guard does not install notifications. The observer archives
acknowledged decisions. Actor/Session continuation records under `scopes/`
hold only a timestamp and policy ID; they are read by key, never scanned at
startup. Their logical lifetime is `contextSeconds` (default 24 hours).

This is an admission filter, not a complete semantic classifier. It does not
isolate files, privileged shell commands, read-only history/attachment APIs,
existing model context or external copies. Policy and program owners remain
trusted. Preserve the native resource ACL and model-side confidentiality rules.

Validation: run `node scripts/run-with-clean-instance-env.mjs node
tests/test-request-access-guard.mjs`, then the durable-request, request-runtime
and Feishu restricted-access/role-delivery/interview-conversation suites. These
use synthetic temporary state and never send real alerts or invoke a model.
