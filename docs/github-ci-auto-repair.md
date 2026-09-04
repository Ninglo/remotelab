# GitHub CI Auto Repair

`scripts/github-ci-auto-repair.mjs` watches the latest GitHub Actions runs for selected branches and starts a RemoteLab repair session when the newest matching branch CI run is red.

## Why this shape

For this machine, a **local poller** is the simplest reliable default:

- no extra public webhook surface needs to be exposed from GitHub into the laptop
- it reuses the existing local `gh` auth and RemoteLab owner auth
- it can enrich the repair prompt with local repo paths, workflow context, failed jobs, and log excerpts before the model starts working

The monitor is intentionally bounded and action-oriented:

- it looks only at the **latest** matching run per branch/workflow group
- it skips runs that are still in progress
- it waits through a configurable settle window so quick reruns do not create session noise
- it dedupes handled GitHub run ids in a local state file
- it tells the repair session to reproduce, retry, repair, and checkpoint every validated low-risk fix; if the cause is genuinely external or non-reproducible, it records an explicit terminal diagnosis and recovery condition instead of silently stopping or pushing an unverified guess

## Typical usage

For the RemoteLab repo itself:

```bash
npm run github:ci:repair -- \
  --repo Ninglo/remotelab \
  --branch main \
  --workflow CI \
  --session-folder ~/code/remotelab
```

To watch both `main` and `master`:

```bash
node scripts/github-ci-auto-repair.mjs \
  --repo Ninglo/remotelab \
  --branch main \
  --branch master \
  --workflow CI \
  --session-folder ~/code/remotelab
```

Useful options:

- `--dry-run` prints candidates without starting sessions
- `--settle-minutes 10` waits longer before reacting
- `--events push,workflow_dispatch` widens the event filter when needed
- `--model <id>` / `--effort <level>` / `--thinking` tune the spawned repair session
- `--state-file <path>` and `--snapshot-dir <path>` relocate persistent monitor data

## Resident mode on this machine

This repo now ships a small helper that installs a macOS `LaunchAgent` for scheduled polling:

- helper: `scripts/github-ci-auto-repair-instance.sh`
- runner: `scripts/github-ci-auto-repair-runner.mjs`
- config: `~/.config/remotelab/github-ci-auto-repair/config.json`
- launch agent: `~/Library/LaunchAgents/com.remotelab.github-ci-auto-repair.plist`

Install and start it:

```bash
./scripts/github-ci-auto-repair-instance.sh install
```

Useful operations:

```bash
./scripts/github-ci-auto-repair-instance.sh status
./scripts/github-ci-auto-repair-instance.sh run-now
./scripts/github-ci-auto-repair-instance.sh logs
./scripts/github-ci-auto-repair-instance.sh restart
./scripts/github-ci-auto-repair-instance.sh stop
```

Default behavior on this machine:

- polls every `300` seconds
- watches `Ninglo/remotelab`
- watches branches `main` and `master`
- watches workflow `CI`
- does **not** start model work during healthy polls
- only starts a RemoteLab repair session once the latest matching branch CI run is actually red

Edit `~/.config/remotelab/github-ci-auto-repair/config.json` if you want to change the poll interval, branches, workflows, or session runtime.

## Recommended operation pattern

For continuous monitoring, prefer the shipped `launchd` helper on macOS instead of keeping an always-open webhook path.

Recommended policy:

1. Watch only the default branch CI first.
2. Start a repair session only for the latest failed run.
3. Let the session reproduce locally and validate before checkpointing.
4. If the run appears flaky, infra-only, or provider-related, retry/reproduce with bounded evidence first. If no code fix is justified, finish with an explicit diagnosis, recovery condition, and visible blocked status instead of an unverified push.
5. Treat “repair started / repair fixed / repair blocked” delivery as part of the production workflow whenever a notification channel is configured; a hidden repair session is not sufficient operational visibility.

## Future extensions

Natural next steps if this works well:

- push a short owner notification when a repair session starts or finishes
- group repeated failures into a single long-lived incident session per branch/workflow
- auto-comment on the related GitHub issue/PR when the session concludes
- promote from polling to GitHub webhook delivery only if near-real-time response becomes worth the extra surface area
