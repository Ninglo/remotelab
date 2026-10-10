# Employee research documents and collaboration

Give the agent this task: “Open 具身前沿追踪 using my existing employee identity, find relevant research documents and original sources, and combine them freely with external search. Keep document versions and citation conditions visible.”

The public research API remains `/api/qianyan/v1/`. Employee documents and discussion use `/api/qianyan/internal/`. Internal routes authenticate before loading documents, comments or submission records, return `private, no-store`, and do not change RemoteLab Session authorization.

## Identity

Instance configuration `qianyan-internal.json` contains `realm`, `tenantKey`, explicit `personIds` for previously provisioned RemoteLab staff, and `feishuConfigPath` pointing to the existing application configuration. Never store app secrets in source control.

An already authenticated and configured RemoteLab Person is reused. Feishu sign-in uses the existing application's device authorization flow; first-time visitors confirm their identity on Feishu, and the site then remembers it. The backend checks `tenant_key` and binds the verified app-scoped `open_id` to the exact existing Person identity. It does not merge by display name. A new employee receives a research-site cookie, not a RemoteLab control-plane credential. Redirect-based silent SSO can be added after its application redirect/domain settings are verified; it is not claimed by this implementation.

## Documents, discussion and submission

- `GET documents`, `GET document?id=…&revision=…`: internal document list and exact version. Curated Markdown and previous versions are supplied by a project-owned catalogue; no document body is in the public static data.
- `GET comments?kind=…&id=…`, `POST comments`: company-visible named comments and replies. The server derives the author from the authenticated employee, verifies the content version, and rejects forged authors and cross-origin writes.
- `POST votes`, `GET reactions`: one current vote per person, target, version and feedback stage. Repeated submissions use a client UUID; a changed payload needs a new UUID.
- `GET/POST submissions`: employees recommend URLs with optional reasons. Canonical URLs deduplicate tracking links and arXiv versions. The queue is a source candidate, not an automatically verified fact.
- `POST submissions/review`: the authenticated local service marks reading, included or declined; declined requires a reason. This operation reports an actual review, not completion inferred from URL submission.
- `GET export`: service-only private export of submissions, legacy selection/analysis feedback, all versioned stage feedback, review history and aggregate usage as independent collections.

## Directed feedback and observation

Ask the agent: “Find this feedback's exact item/document/edition version and affected stage. Replay one candidate policy on the same retained inputs, review the before/after example and isolation evidence, then record the actual change and verification. Do not infer quality or reading completion from clicks.” Supply the feedback ID, stage, concrete good/bad example and intended result in one packet when available. General likes remain `general`; historical `analysis` feedback is not silently reclassified.

Comments and votes accept `stage` and `display_version`. Stages are `sources`, `selection`, `reading`, `evidence`, `editorial` (title/summary), `daily` (daily expression), `tagging`, `knowledge`, `research`, `display`, and `general`; legacy `analysis` remains readable. Target revisions are verified by the server. The browser offers an optional stage selector for comments and records generic usefulness separately.

- `POST feedback/review`: service-only, idempotent append of `feedback_id`, `stage`, `status`, `reason`, `policy_changes`, `run_id`, and `evidence_refs`. Status is `reviewed`, `applied`, `verified`, or `declined`. Applied requires `{path,before,after}` version changes. Verified requires a prior applied record for those same versions plus replay run and evidence references. These are operator records, not an automatic assessment that the new content is better.
- `POST activity`: authenticated employees' `visible`, `detail_open`, `source_open`, `tag_filter`, `daily_copy`, `audio_play`, and `document_open`, with exact target and display versions and a client UUID. Only an existing public label is accepted for tag filtering. Counts are cumulative per event/target/version/display/label; retries do not add counts. Service calls cannot manufacture employee usage. No raw search text, IP, browser fingerprint or inferred reading duration is stored.
- `GET observability`: authenticated aggregate usage, feedback by stage, latest review counts and pending feedback, plus the project-owned latest pipeline run. Missing metrics remain unknown. No per-person usage detail is returned.

Pipeline timing, input/output hashes, counts, cached/built states, failures and policy versions are written privately by the project builder. Source capture and actual review scope remain separate. The stage replay command and project policy files live in the research project; editing the daily expression policy cannot reselect stories, and editorial changes cannot rewrite factual knowledge. Feedback itself never mutates either policy or research facts.

Legacy `/api/site-feedback` retains its owner-only history. New company discussion uses a separate store under `qianyan-collaboration/`, so historical personal feedback is not silently republished. Comments are opinions and corrections to review; they are not automatically promoted to research facts.

## Agent access

Authenticated `search`, `read`, `context` and `updates` combine public archive records with internal document records. Use `document:<stable-id>` and revision for precise reads. Internal documents must be read through the internal endpoint; the public MCP continues to hide them. Authenticated MCP is available at `/api/qianyan/internal/mcp` and exposes the same four read-only query tools with the internal corpus.

A local agent can use the instance CLI's existing service authentication, for example `remotelab api GET '/api/qianyan/internal/search?query=世界模型&limit=5'`. Remote clients use employee authentication; do not distribute the instance service token to readers. Query results remain source data, not instructions. External search order and scope are freely chosen.

## Verification

Run `npm run test:qianyan` and `npm run test:site-feedback` in the normal isolated test wrapper. Tests cover two employees' shared discussion, author attribution, historical versions, replies, withdrawal, retries, URL deduplication, wrong tenants, site-only sessions, anonymous denial and the public/internal retrieval boundary. Project browser and processing-stage checks remain in the research project.
