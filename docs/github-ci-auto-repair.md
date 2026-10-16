# GitHub CI and auto repair retirement

On 2026-10-16, the project requested removal of GitHub CI because its waiting and automatic repair loop were slowing delivery. The repository no longer ships `.github/workflows/ci.yml`, the CI repair monitor, its resident runner, installer, or npm entry points. Existing local test suites remain available.

## Delivery

Run the checks relevant to the change locally, with isolated state for runtime tests. Check documentation impact before committing, then push the reviewed change directly to `main`. Documentation builds and instance-local publishing hooks remain available; see [documentation delivery](documentation-delivery.md). Native macOS changes need compilation and relevant tests on a macOS host.

## Repository setting and completion

On 2026-10-16, the user confirmed the repository setting was changed and future work should push directly to `main`. Readback verified `protected: false`, no required status checks, and PR #76 merged as `99139162`. The GitHub Actions workflow list is empty. The former required `test` check no longer blocks delivery.

Existing run history is retained. Local validation and a normal fast-forward push to `main` are the delivery path; no integration branch or pull request is required for routine work.

## Existing macOS monitor installations

The retired installer used `~/Library/LaunchAgents/com.remotelab.github-ci-auto-repair.plist`. On a host where this monitor was installed for RemoteLab, unload it before removing the plist:

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.remotelab.github-ci-auto-repair.plist"
rm "$HOME/Library/LaunchAgents/com.remotelab.github-ci-auto-repair.plist"
```

Keep `~/.config/remotelab/github-ci-auto-repair/` snapshots and repair Session history as evidence. Source deletion does not prove a remote machine's LaunchAgent has been stopped; check only the actual registered installations in the authorized scope.
