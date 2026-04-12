# RemoteLab Instance Factory v1

This document locks the v1 contract for whole-host creation and project install.

## Command surface

The v1 entrypoints are:

```bash
node automation/instance-factory/scripts/inspect-remotelab-host.mjs
remotelab provision-host --manifest automation/instance-factory/contracts/host.manifest.example.jsonc --json
remotelab provision-host --manifest automation/instance-factory/contracts/host.manifest.example.jsonc --provider-env /root/.config/remotelab/providers/digitalocean.env --execute --wait --json
remotelab bootstrap-host --manifest automation/instance-factory/contracts/host.manifest.example.jsonc --json
remotelab bootstrap-host --manifest automation/instance-factory/contracts/host.manifest.example.jsonc --render-dir ./generated/bootstrap-host
remotelab bootstrap-host --manifest automation/instance-factory/manifests/miglab-sfo3-01.host.manifest.jsonc --ssh-host 164.92.123.246 --execute --json
remotelab install-profile --manifest automation/instance-factory/contracts/host.manifest.example.jsonc --env automation/instance-factory/contracts/install.env.example --json
remotelab install-profile --manifest automation/instance-factory/manifests/miglab-sfo3-01.host.manifest.jsonc --env automation/instance-factory/profiles/miglab-sfo3-01.install.env.example --ssh-host 164.92.123.246 --render-dir ./generated/install-profile --json
remotelab validate-profile --manifest automation/instance-factory/contracts/host.manifest.example.jsonc --env automation/instance-factory/contracts/install.env.example --json
```

`inspect-remotelab-host.mjs` is the current fact-pass entrypoint for deciding whether the next action is provider provisioning, host bootstrap, or same-host tenant expansion.

## Responsibility split

- `provision-host`
  - provider-only layer
  - reads `host.manifest.jsonc`
  - supports `digitalocean` in v1
  - always outputs a provider request body and bootstrap handoff
  - can create the Droplet directly with `--execute --provider-env <digitalocean.env>`
- `bootstrap-host`
  - machine convergence layer
  - verifies baseline commands, repo checkout path, and owner unit expectations
  - renders an executable `bootstrap-host.sh` plus derived env artifacts when `--render-dir` is used
  - can upload and execute the bootstrap payload remotely over SSH with `--ssh-host ... --execute`
- `install-profile`
  - private installer layer
  - reads `install.env`
  - resolves desired modes, dependencies, and derived states
  - decides which core services, connectors, and sidecars should be enabled
  - renders `install-profile.env`, owner systemd unit, Cloudflare config, and an `apply-install-profile.sh` converge script
  - can upload and apply the profile remotely over SSH with `--ssh-host ... --execute`
  - seeds owner `auth.json` on first install when the target host does not already have one
  - returns an owner access URL in `execution.ownerAccessUrl` during `--execute`
- `validate-profile`
  - post-install verification layer
  - re-runs the same feature map, but also checks service activity to report `ready`, `degraded`, or `blocked`

## Input contracts

### `host.manifest.jsonc`

Public or semi-public machine shape:

- provider, region, size, image
- hostname and repo checkout path
- optional provider extras like `tags`, `sshKeys`, `projectId`, and `vpcUuid`
- owner domain, listen port, ingress provider
- Cloudflare tunnel identity fields like `tunnelId`, `credentialsFile`, and optional `localCredentialsFile`
- systemd owner unit and log directory
- non-secret connector file paths

### `install.env`

Private bundle:

- desired modes: only `on`, `off`, `auto`
- capability inputs: tokens, secrets, endpoints, file paths
- no user-written derived states

## Feature map and module rules

Current v1 modules:

- `remotelab`
- `ingress.cloudflare`
- `ingress.cpolar`
- `connector.email`
- `worker.mailbox`
- `connector.feishu`
- `connector.calendar`

Derived states:

- `installed`
- `configured`
- `enabled`
- `runnable`
- `started`
- `healthy`

Rules:

- `on` + missing required inputs blocks the profile
- `auto` + missing required inputs skips the module with warnings
- `off` suppresses the module even if credentials exist
- if `remotelab` is runnable but an enabled connector or sidecar is not, overall status is `degraded`

## Startup orchestration

Default startup order:

1. `remotelab`
2. `connector.email`
3. `worker.mailbox`
4. `connector.feishu`
5. `connector.calendar`
6. `ingress.cloudflare` or `ingress.cpolar`

Why:

- connectors and sidecars depend on the owner control plane
- ingress should come last so public traffic is attached only after the owner service is up

## Repo-native landing zone

All shared contracts and templates live in `automation/instance-factory/`.

This keeps whole-host automation separate from:

- `setup.sh`, which remains the operator-oriented single-host setup path
- `remotelab guest-instance`, which remains the same-host multi-instance path

## Current happy path

1. Inspect the current source or target machine:

```bash
node automation/instance-factory/scripts/inspect-remotelab-host.mjs
```

2. Fill `host.manifest.jsonc` with the public machine shape.

3. Preview the DigitalOcean request and bootstrap handoff:

```bash
remotelab provision-host --manifest ./host.manifest.jsonc --render-dir ./generated/provision --json
```

4. Create the Droplet when ready:

```bash
remotelab provision-host --manifest ./host.manifest.jsonc --provider-env /root/.config/remotelab/providers/digitalocean.env --execute --wait --json
```

5. Render the bootstrap payload for SSH handoff:

```bash
remotelab bootstrap-host --manifest ./host.manifest.jsonc --render-dir ./generated/bootstrap --json
```

6. Or push and execute bootstrap directly on the target:

```bash
remotelab bootstrap-host --manifest ./host.manifest.jsonc --ssh-host <public-ip> --ssh-key ~/.ssh/remotelab_do_ed25519 --execute --json
```

7. Render or apply the private install profile:

```bash
remotelab install-profile --manifest ./host.manifest.jsonc --env ./install.env --render-dir ./generated/install-profile --json
remotelab install-profile --manifest ./host.manifest.jsonc --env ./install.env --ssh-host <public-ip> --ssh-key ~/.ssh/remotelab_do_ed25519 --execute --json
```

When the target host does not already have the Cloudflare tunnel credential JSON on disk, set `network.ingress.localCredentialsFile` in the manifest. `install-profile --execute` will copy that local credential file to `network.ingress.credentialsFile` on the target before restarting `cloudflared`.

8. Then run `validate-profile`.

### Optional one-shot orchestration

`automation/instance-factory/scripts/full-host-cycle.mjs` now covers the default single-track whole-host path:

- ensure Cloudflare tunnel identity and DNS route
- create the Droplet
- wait for SSH
- run `bootstrap-host --execute`
- run `install-profile --execute`
- run `validate-profile`
- wait for the public `/login` page and return both `publicLoginUrl` and `ownerAccessUrl`

Cloudflare DNS routing is forced by tunnel ID, not tunnel name, so repeated runs do not depend on ambiguous name lookup.

## Standardized MigLab baseline

The validated dedicated-host baseline now has repo-native templates:

- `automation/instance-factory/manifests/miglab-sfo3-01.host.manifest.jsonc`
- `automation/instance-factory/profiles/miglab-sfo3-01.install.env.example`

These files keep whole-host provisioning separate from the later same-host instance factory. The intent is:

- one dedicated machine per customer-sensitive owner surface when needed
- then standard `remotelab guest-instance ...` only for same-host follow-up tenants
