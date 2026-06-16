# RemoteLab Update Strategy

This document proposes the update model for two different RemoteLab operating shapes:

- same-host multi-instance development / control machines
- separately deployed dedicated RemoteLab hosts

Status: proposed from repo and live-host inspection on 2026-04-13 UTC.

## 0. Surface Split

RemoteLab now needs three distinct control layers instead of one overloaded "instance admin" idea.

### 0.1 Admin Plane

`/admin` and the future `remotelab admin ...` surface should be the fleet plane.

It should own:

- the private registry of dedicated hosts
- the private registry of same-host guest instances
- cross-host rollout, validation, and incident views
- sharing-oriented allocation flows such as "prepare 5 fresh trial instances"

It should not own the detailed bootstrap steps for creating a whole host, and it should not replace the same-host tenant lifecycle commands.

Current minimum shipped surface:

- `remotelab admin summary`
- `remotelab admin hosts list`
- `remotelab admin hosts add <name> ...`
- `remotelab admin hosts show <name>`
- `remotelab admin hosts remove <name>`
- `remotelab admin hosts sync-local <name>`
- `remotelab admin hosts import-snapshot <name> --file <guest-list.json>`

Current boundary:

- local hosts can read live instance state from this machine's `guest-instances.json`
- remote hosts are represented by registry metadata plus imported snapshots for now
- cross-host execution and rollout actions should attach later onto the same host registry model

### 0.2 Same-Host Tenant Plane

`remotelab guest-instance ...` remains the current-machine tenant layer.

It should own:

- create, batch-create, inspect, link, report, and converge for guest instances on this host
- host-local port, hostname, mailbox, and runtime wiring
- fast sharing workflows on the control host, such as `remotelab guest-instance create-trial --count 5`

It should not become the cross-host fleet coordinator.

### 0.3 Whole-Host Factory Plane

`remotelab provision-host`, `bootstrap-host`, `install-profile`, and `validate-profile` remain the whole-host lifecycle layer.

It should own:

- provider provisioning
- host bootstrap
- private profile installation
- host-level validation

It should not be used for same-host guest fan-out.

## 1. Observed Current State

Observed on the current Linux control host `remotelab-sfo3-01`:

- owner chat runs as `remotelab.service`
- 28 guest chat instances currently run as `remotelab-guest@*.service`
- owner / host-global long-running services include:
  - `remotelab-instance-admin.service`
  - `remotelab-agent-mail-bridge.service`
  - `remotelab-agent-mail-worker.service`
  - `remotelab-feishu-connector.service`
  - `cloudflared-thelab.service`
  - `cpolar.service`
  - `remotelab-hk-host-router.service`
- per-instance auxiliary services already exist for some instances, for example `remotelab-trial23-wechat-poller.service`
- detached per-run services exist as `remotelab-runner-run_*.service`
- `remotelab guest-instance check` and `/api/build-info` already provide useful owner-vs-guest build drift checks
- `automation/instance-factory/` already provides `provision-host`, `bootstrap-host`, `install-profile`, and `validate-profile` for whole-host creation / convergence

Current gaps:

- `restart.sh` is only a partial restart helper; it does not represent the full update surface of a real host
- the instance-factory feature map covers only part of the live service graph
- some live unit names already drift from the current template assumptions
  - example: instance-factory currently expects `remotelab-agent-mail-http-bridge`
  - the current host runs `remotelab-agent-mail-bridge`
- there is no single generated host inventory that says which services are:
  - code-bound and must restart on source changes
  - config-bound and should restart only when config changes
  - transient and should be excluded from normal updates

## 2. Design Goals

- After code changes on the development / control host, all code-bound instances on that host should converge to one build identity.
- Dedicated hosts should converge to an explicit git ref and have a defined rollback path.
- Optional connectors and sidecars should be updated through the same host plan, not through ad-hoc manual restart lists.
- Ingress should restart only when ingress config changed, not on every code change.
- Active detached runs should be handled intentionally instead of being killed accidentally.
- Validation should report `ready`, `degraded`, or `blocked` from one host-level update transaction.

## 3. Non-Goals

- container or Kubernetes deployment
- a permanent blue/green second chat plane
- one tunnel per guest instance
- per-instance code releases on same-host guests

RemoteLab should continue to run the current source tree in `/opt/remotelab` after restart. The update system should converge that tree and the host runtime around it, not introduce a parallel permanent release layout.

## 4. Core Model

### 4.1 Build Identity

RemoteLab already exposes a useful build signal via `/api/build-info`.

Use two modes:

- `source` mode
  - for the active development / control host
  - desired build identity is the current `/opt/remotelab` working tree
  - dirty working trees are allowed
- `git_ref` mode
  - for dedicated deployed hosts
  - desired build identity is an explicit git ref, tag, or commit
  - dirty working trees are not allowed

Validation rules:

- owner and guest chat surfaces validate via `/api/build-info`
- non-HTTP sidecars validate via:
  - successful restart after update start time
  - service `active` state
  - optional module-specific self-check

### 4.2 Runtime Inventory

Add one generated host inventory file:

- path: `/etc/remotelab/runtime-inventory.json`

This inventory becomes the single source of truth for host updates.

It should be generated from:

- `host.manifest.jsonc`
- `install.env`
- `~/.config/remotelab/guest-instances.json`
- `/etc/remotelab/guest-instances/*.env`
- connector / poller registries when present
- a repo-owned unit alias map for historical compatibility

Suggested shape:

```json
{
  "schemaVersion": 1,
  "hostName": "remotelab-sfo3-01",
  "repoCheckoutPath": "/opt/remotelab",
  "buildMode": "source",
  "updateGroups": [
    { "id": "owner-core", "units": ["remotelab"], "policy": "blocking" },
    { "id": "owner-sidecars", "units": ["remotelab-instance-admin", "remotelab-agent-mail-bridge", "remotelab-agent-mail-worker", "remotelab-feishu-connector"], "policy": "degraded" },
    { "id": "guest-chat", "template": "remotelab-guest@", "policy": "rolling" },
    { "id": "guest-aux", "selectors": ["remotelab-*-wechat-poller", "remotelab-*-voice-*"], "policy": "rolling" },
    { "id": "ingress", "units": ["cloudflared-thelab", "cpolar", "remotelab-hk-host-router"], "policy": "config-change-only" }
  ],
  "unitAliases": {
    "remotelab-agent-mail-http-bridge": ["remotelab-agent-mail-bridge"]
  },
  "excludedUnits": ["remotelab-runner-run_*"]
}
```

Why this matters:

- update orchestration stops depending on ad-hoc `systemctl list-units` guesses
- same-host multi-instance updates and dedicated-host updates can share the same restart engine
- historical unit drift can be handled through explicit aliases instead of silent breakage

### 4.3 Update Transaction

Every update should be treated as one host-level transaction with these phases:

1. `preflight`
2. `source_converge`
3. `runtime_converge`
4. `restart`
5. `validate`
6. `record`
7. `rollback` when required

Persist each update run under a host-local ledger such as:

- `/root/.config/remotelab/update-runs/<timestamp>.json`

The record should include:

- target build identity
- previous build identity
- update mode (`source` or `git_ref`)
- restarted units
- skipped units
- validation results
- rollback target when available

## 5. Update Flows

### 5.1 Same-Host Development / Control Machine

This host is not a normal deployment target. It is the live source tree and the source of truth for many same-host guests.

Update rules:

- treat the host as one update domain
- do not try to version guests independently from the owner
- converge all code-bound units around the current worktree

Recommended flow:

1. `preflight`
   - load runtime inventory
   - capture current owner `/api/build-info`
   - capture current guest fleet summary via `remotelab guest-instance check --json`
   - detect active `remotelab-runner-run_*` units
2. `source_converge`
   - do not change git ref
   - if `package.json` or `package-lock.json` changed, run `npm install`
3. `runtime_converge`
   - regenerate any rendered env / unit files that are derived from the repo
   - regenerate guest runtime defaults and platform skills when needed
4. `restart`
   - restart `owner-core`
   - restart `owner-sidecars`
   - restart `guest-chat` in batches
   - restart `guest-aux` by instance grouping
   - restart `ingress` only if ingress config actually changed
5. `validate`
   - owner `/api/build-info` reachable
   - `remotelab guest-instance check --json` shows no owner-vs-guest build drift
   - enabled connector / sidecar self-checks pass
6. `record`

Detached runner policy:

- default dev mode should be `fast`
- do not restart active `remotelab-runner-run_*`
- let in-flight runs finish on the old code
- new runs after the owner restart use the new code

This means dev mode may temporarily allow mixed code only for already-running detached jobs. That tradeoff is acceptable for the control host.

### 5.2 Dedicated Host Update

Dedicated hosts should use a pinned git ref and a clean repo.

Inputs:

- `host.manifest.jsonc`
- private `install.env`
- desired git ref / tag / commit
- SSH target

Recommended flow:

1. `preflight`
   - run `validate-profile`
   - capture current git ref
   - capture current owner `/api/build-info`
   - write a rollback record
2. `source_converge`
   - `git fetch --all --tags --prune`
   - `git checkout <target-ref>`
   - `npm ci`
3. `runtime_converge`
   - run `remotelab install-profile --manifest ... --env ... --ssh-host ... --execute`
   - rewrite env / unit files from the declarative profile
4. `restart`
   - owner core first
   - enabled sidecars / connectors next
   - ingress last, and only if its rendered config changed
5. `validate`
   - `remotelab validate-profile`
   - local `/login`
   - public `/login`
   - owner `/api/build-info`
6. `record`
7. `rollback` on failure
   - checkout previous ref
   - `npm ci`
   - reapply previous rendered profile
   - rerun validation

Unlike the control host, dedicated hosts should use `safe` mode by default:

- either wait for detached runner units to drain
- or declare a bounded maintenance window and stop scheduling new work before restart

### 5.3 Fleet Rollout Across Multiple Dedicated Hosts

Use the control host as the rollout coordinator, but keep per-host secrets private and off-repo.

Add a private fleet registry on the control host, for example:

- `/root/.config/remotelab/fleet/hosts/<name>.json`

Each entry should contain:

- host name
- SSH target
- manifest path
- private env path
- update ring
- deployment mode (`source` or `git_ref`, though dedicated hosts should normally be `git_ref`)

Recommended rings:

1. `dev`
   - current development / control host
2. `canary`
   - one dedicated host with representative connectors
3. `stable`
   - all remaining dedicated hosts

Proposed orchestration commands:

- `remotelab update-local`
- `remotelab update-host --manifest ... --env ... --ssh-host ... --ref <git-ref>`
- `remotelab fleet-update --ring <dev|canary|stable> --ref <git-ref>`

Rollout policy:

- one host at a time per ring by default
- do not advance to the next ring until validation passes on the previous ring
- store a fleet update ledger with per-host results

## 6. Criticality and Restart Policy

| Class | Examples | Restart On Code Change | Failure Class |
| --- | --- | --- | --- |
| owner core | `remotelab.service` | always | blocking |
| guest chat | `remotelab-guest@*.service` | always | blocking |
| owner sidecars / connectors | mail bridge, mailbox worker, Feishu connector, instance-admin | always when enabled | degraded by default, blocking if explicitly required by profile |
| guest auxiliary services | per-instance WeChat / voice / connector workers | restart with their owning instance group | degraded by default |
| ingress | `cloudflared-*`, `cpolar`, host routers | only if rendered config changed | blocking for public access, but not a code-update trigger by itself |
| maintenance automations | review jobs, monitors, GitHub triage | optional; can restart after core path is healthy | degraded / informational |
| detached runners | `remotelab-runner-run_*` | excluded from normal restart set | excluded, but must be tracked |

Important rule:

- not every systemd unit belongs in the normal code-update restart set

In particular, `cloudflared` and `cpolar` do not need a restart for ordinary repo code changes, and detached runner units should not be swept up accidentally.

## 7. Validation Contract

Validation should combine existing probes with a few new module checks.

Already available:

- owner / guest `/api/build-info`
- `remotelab guest-instance check`
- `validate-profile`

Needed next:

- a host update validator that merges:
  - build drift
  - service activity
  - module-specific self-checks
  - public route reachability

Module-specific checks should be lightweight and deterministic:

- email bridge: local authenticated webhook self-check
- mailbox worker: queue scan or mailbox self-check
- Feishu: config load + minimal connectivity / token sanity check
- WeChat / voice / other instance-bound connectors: process alive + instance ownership check

The update result should return:

- `ready`
- `degraded`
- `blocked`

with explicit module reasons.

## 8. Required Repo Changes

### Phase 1: Fix Same-Host Update Correctness

- add runtime inventory generation
- add unit alias support
- add `remotelab update-local`
- make `restart.sh` explicitly low-level / partial, not the full update story
- extend current validation so guest build drift and enabled sidecars are checked together
- make guest restart batching explicit

### Phase 2: Make Dedicated Host Updates First-Class

- add `remotelab update-host`
- add rollback metadata and previous-profile snapshots
- require explicit git ref for dedicated hosts
- converge `install-profile` and live service naming

### Phase 3: Fleet Rollouts

- add a private fleet registry on the control host
- add `remotelab fleet-update`
- add ring-based rollout and fleet history

### Phase 4: Clean Up Historical Drift

- migrate historical unit names to canonical names
- extend feature-map coverage to current long-running services
- decide which optional automations belong in the managed update surface and which stay best-effort

## 9. Immediate Baseline Before New Commands Exist

Until the new update commands land, use the following operational baseline.

### Same-Host Control Machine

1. Converge source and dependencies in `/opt/remotelab`.
2. Restart code-bound owner services:
   - `remotelab.service`
   - `remotelab-instance-admin.service`
   - enabled mail / connector / poller services
3. Restart `remotelab-guest@*.service` in batches.
4. Restart per-instance auxiliary services that execute repo code.
5. Do not restart `remotelab-runner-run_*`.
6. Restart ingress only if ingress config changed.
7. Run `remotelab guest-instance check --json`.

### Dedicated Host

1. Pin a git ref.
2. `git fetch --all --tags --prune`
3. `git checkout <target-ref>`
4. `npm ci`
5. `remotelab install-profile --manifest ... --env ... --ssh-host ... --execute`
6. `remotelab validate-profile --manifest ... --env ...`
7. Roll back to the previous ref if validation fails.

## 10. Recommended Decision

The right long-term shape is:

- one host-level update transaction
- one generated runtime inventory per host
- one dev-mode update path for the current source tree
- one git-ref-based update path for dedicated hosts
- one optional fleet rollout layer above those two

That gives RemoteLab a coherent model across:

- same-host guest fleets
- owner-side connectors and sidecars
- dedicated machines on other hosts

without abandoning the current source-tree runtime model.
