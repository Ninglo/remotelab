# Service management access

Use this workflow when a task needs a service restart or deployment, or a
service-manager command reports missing permission. Keep the task's existing
authorization and source/deployment requirements; discovering a management
capability does not authorize unrelated work.

Copyable handoff: “Check this instance's services, current source, concurrent
work and management routes. Use an existing authorized route to finish the
restart, verify every affected process and report the loaded version. Ask me
only for a human-only step after checking the registered alternatives.”

## Check all registered routes before declaring a blocker

Run `remotelab service-access check --json` (or
`node "$REMOTELAB_PROJECT_ROOT/cli.js" service-access check --json`). It reads
the current instance's `service-access.json`, checks each exact systemd unit,
tests the noninteractive sudo permission without restarting, and probes any
explicitly registered loopback root SSH route. SSH uses the existing key and
strict host-key verification; it verifies root UID and the same machine ID.
The result gives a concrete `restartArgv` for each available service route.
No keys, permissions, services or other instances are changed by the check.

A sudo failure proves only that sudo route failed. A missing configuration
does not prove the host has no alternative: read the bootstrap Host Access
pointer and the task's recorded successful operations. Preserve actual error
text, check registered alternatives once with fresh evidence, and only then
report the minimum human-only step. Historical blocked reports, CI success
and automatically learned methods are not current permission evidence.

## Execute within the current task

Confirm the exact affected services, their `WorkingDirectory`, current
`/api/build-info`, clean source and required CI. Preserve concurrent edits
and inactive services. A coupled update must cover each necessary connector
as well as the core; restarting the core alone does not update separately
managed connectors. Do not use `kill` or launch a second consumer as a
permission workaround.

Execute the chosen command through the existing service manager only when
the current task authorizes those targets. Loopback SSH is an alternate
transport to the same manager, not a reason to broaden the task to other
instances. Use the exact returned argv; it is capability evidence, not an
automatic restart plan. Keep an independent maintenance entry outside the
service being stopped. For state upgrades, first read
`docs/request-state-upgrade.md`.

Verify new process IDs/start times, active state, loaded source/version and
connector readiness from real logs. Service-command success alone is not
deployment acceptance. Do not send real-group test messages without scope
authorization. If permission was misreported in a visible reply, correct it
in the original conversation with the old message's location and evidence.

## Instance registration

The file lives in `REMOTELAB_CONFIG_DIR`, or the instance's `config` directory,
or `~/.config/remotelab`. Register only known services for this instance.
Local SSH is optional and must already exist; this workflow installs no keys
and grants no privileges. An example, with values supplied by the operator:

```json
{
  "version": 1,
  "units": ["remotelab-example.service", "remotelab-example-feishu.service"],
  "localRootSsh": {
    "host": "127.0.0.1",
    "identityFile": "/home/example/.ssh/existing-key"
  }
}
```

Never copy another instance's registration. Keep host-specific names and
key paths out of shared platform docs. When configuration or SSH is absent,
report it as unconfigured rather than inventing a root route. On macOS use
the registered launchd workflow; this probe supports Linux systemd.
