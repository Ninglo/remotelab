# GitHub CI and auto repair retirement

On 2026-10-16, the project requested removal of GitHub CI because its waiting and automatic repair loop were slowing delivery. The repository no longer ships `.github/workflows/ci.yml`, the CI repair monitor, its resident runner, installer, or npm entry points. Existing local test suites remain available.

## Delivery

Run the checks relevant to the change locally, with isolated state for runtime tests. Check documentation impact before committing, then push the reviewed change directly to `main`. Documentation builds and instance-local publishing hooks remain available; see [documentation delivery](documentation-delivery.md). Native macOS changes need compilation and relevant tests on a macOS host.

## Repository administrator action

The last verified `main` protection required the GitHub Actions `test` check. An administrator must remove that obsolete required-status-check configuration before the deletion can land and later commits can advance normally. Preserve the other branch protections. This source change does not itself modify GitHub settings.

With a repository administrator's GitHub login, remove only the status-check requirement:

```bash
gh api --method DELETE repos/Ninglo/remotelab/branches/main/protection/required_status_checks
gh api repos/Ninglo/remotelab/branches/main/protection
```

After landing, verify that new pushes no longer start the retired workflow. Existing run history is retained. No fabricated status or replacement no-op workflow is needed.

## Existing macOS monitor installations

The retired installer used `~/Library/LaunchAgents/com.remotelab.github-ci-auto-repair.plist`. On a host where this monitor was installed for RemoteLab, unload it before removing the plist:

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.remotelab.github-ci-auto-repair.plist"
rm "$HOME/Library/LaunchAgents/com.remotelab.github-ci-auto-repair.plist"
```

Keep `~/.config/remotelab/github-ci-auto-repair/` snapshots and repair Session history as evidence. Source deletion does not prove a remote machine's LaunchAgent has been stopped; check only the actual registered installations in the authorized scope.
