# Project and Session display module

The optional **项目与 Session** v21 work area reuses existing titles, status and
per-Person project groups. It introduces no model calls or provider polling.
Existing modes, drafts and applied device layouts remain unchanged until selected.

The authenticated display snapshot includes `metrics.projects`. Only the display
owner’s initiating identities and non-archived, non-internal Sessions with running,
waiting, queued or compacting status participate. All matching Sessions are retained.
Group names come from the owner’s stored `personViews`, never the service account’s
projected group; missing groups appear as 未归属项目. A cached, read-only metadata
reader refreshes on file changes. Failed metadata reads return `projects: null`,
distinct from an empty active set. Runtime status uses the existing summary reader.

Project overview shows counts; selecting a project exposes its Session titles.
Page capacity follows rendered row height and available space. Auto paging shares
15-second time slots between web and device rendering and uses existing refreshes;
manual web paging holds a page for 30 seconds. Selection and auto paging are saved
in the existing draft and exported payload. Rendering never generates summaries.

## Install into an existing v21 studio

Delegate: “Add the optional project module to this instance’s existing v21 studio.
Preserve applied layouts and other modes, test using isolated data, then publish the
existing editor and restart only the display services. Leave mode selection and
application to the user.”

The studio source is instance-local. `studio-projects-integration.patch` records
its precise v21 editor/renderer integration, including the isolated stream tests.
Check that patch against the current source, reconcile any drift, then apply it.
Copy `studio-projects.js` and `.css` from this directory into `concept-v21` and
publish the existing detailed editor slug. The renderer allowlist and work-mode
validation must include these assets and `projects`. Forward projects through
both status paths, include them in change fingerprints, and reject application
when project data is unavailable. No credentials or real Session data belong in
the static publication. Restart the instance’s display sidecar and studio renderer
through the registered service manager; do not restart chat or alter pairing.

Validation: `tests/test-display-project-sessions.mjs`, existing sidecar tests,
instance-local `concept-v14/test-preview-stream.mjs`, and browser checks of
project selection, complete pagination, old drafts, stale/empty/unavailable states,
settings export, mobile fit and absence of additional API requests. Compare the
applied-layout hash before/after deployment. User observation remains the final
physical-display check after they choose Apply.
