# RemoteLab Instance Factory v1

This directory is the repo-native home for whole-host automation.

It intentionally does **not** replace `remotelab guest-instance`, which remains the same-host multi-instance layer.

## Scope split

- `provision-host`: provider-side host creation contract
- `bootstrap-host`: converge a Linux machine into a RemoteLab-capable host baseline
- `install-profile`: read `install.env`, resolve the feature map, render runtime plan, and decide what should start
- `validate-profile`: check the host and enabled modules, then report `ready`, `degraded`, or `blocked`

## Layout

- `contracts/host.manifest.example.jsonc`: public or semi-public host shape
- `contracts/host.manifest.schema.json`: JSON schema for the host manifest
- `contracts/install.env.example`: private install bundle example
- `contracts/install.env.schema.json`: documented env contract
- `feature-map.json`: module catalog, dependencies, startup order, and required inputs
- `manifests/miglab-sfo3-01.host.manifest.jsonc`: concrete whole-host baseline for the validated MigLab shape
- `profiles/miglab-sfo3-01.install.env.example`: sanitized install-profile baseline for MigLab
- `scripts/inspect-remotelab-host.mjs`: current-machine fact pass for routing whole-host work
- `templates/systemd/`: unit templates and drop-ins that installers can render later

## Current executable path

- `provision-host`
  - dry-run request render by default
  - direct DigitalOcean create with `--provider-env ... --execute --wait`
- `bootstrap-host`
  - renders `bootstrap-host.sh`
  - can push and run it remotely with `--ssh-host ... --execute`
- `install-profile`
  - renders `install-profile.env`, owner unit, Cloudflare config, and `apply-install-profile.sh`
  - can push and run the converge payload remotely with `--ssh-host ... --execute`
  - can seed a target host's Cloudflare tunnel credentials from `network.ingress.localCredentialsFile`
  - seeds owner `auth.json` automatically on first install and reports `execution.ownerAccessUrl`
- `scripts/full-host-cycle.mjs`
  - end-to-end create -> SSH bootstrap -> install -> validate -> public login wait
  - routes Cloudflare DNS by tunnel ID and returns both the public login URL and owner access URL

## v1 rules

- Provider scope is `digitalocean` only.
- Ingress scope is `cloudflare` first, `cpolar` optional.
- Feature modes are always `on`, `off`, or `auto`.
- Users never declare derived module states directly.
- The installer computes `installed`, `configured`, `enabled`, `runnable`, `started`, and `healthy`.
- If `remotelab` is runnable but an enabled sidecar or connector is not, the profile is `degraded`.
