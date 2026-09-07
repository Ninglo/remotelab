# Preserve running tasks while loading the Feishu reply fix

## Observed failure

The owner service had already completed the request-record conversion and loaded
schema 1. Both Feishu connectors were connected and accepted inbound messages.
Generated replies nevertheless had no Delivery children because HTTP admission
had discarded their explicit sourceDelivery field. Commit 27bcf1a4 preserves this
field for JSON and multipart input; its remote CI and isolated HTTP regression
passed, but the old controller process still preceded that commit.

Restart preparation exposed a second problem. The controller ran as an ordinary
user in a system service. Runner launch selected the system manager, which denied
transient-unit creation. Fallback runners remained in the controller cgroup, whose
KillMode=control-group would terminate them on restart. The installed drop-in
requested REMOTELAB_RUNNER_SYSTEMD_SCOPE=user, but the launcher ignored it.

## Reproduction and change

The new scope test initially failed with `'system' !== 'user'` despite an explicit
user-manager setting. The launcher now honors that setting and resolves its async
default scope before constructing launch and PID-query arguments. Invalid explicit
settings fail clearly. The generated owner service uses KillMode=process so that
existing fallback runners retain execution ownership during a controller restart.
The same policy was installed on this host before restarting it.

## Validation

- The JSON/multipart HTTP sourceDelivery regression passed.
- The new runner-scope test passed after the failing reproduction.
- Full npm test passed, including merge-safety, shared-tools and recovery tests.
- A real transient fixture was launched through the changed launcher under the
  user systemd manager. Its PID belonged to its own user-service cgroup, outside
  the owner controller cgroup. The fixture was then stopped and collected.
- The live controller was restarted once to load both changes. Its PID changed;
  both already-running sessions retained the same runner and tool process birth
  identities. Their Run APIs still returned running, and authenticated HTTP
  service access returned 200 after restart.
- JavaScript syntax, bash -n setup.sh and git diff --check passed.

Logs, original/updated process identities and the real-manager probe output are
saved under ~/.remotelab/workspace/connector-live-repair-20260907/ on the test host.
This verification does not claim that a newly submitted human Feishu message has
completed: that final check requires a new inbound message after the restart.
No historical reply was replayed by this repair.
