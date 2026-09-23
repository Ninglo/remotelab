# GitHub accounts on a shared RemoteLab host

## Copyable rollout prompt

> Set up a short trial for one person on this RemoteLab host. First identify that person's Unix user or create an isolated RemoteLab guest instance. Run `remotelab github-workspace prepare` as that Unix user. Ask the person to complete `gh auth login` in their own account and add the generated public SSH key to that GitHub account. Then run `activate` for the repository and `check`. Record the Unix user, GitHub account, checkout path, read/push permission result, and RemoteLab instance name. Do not copy GitHub tokens or SSH private keys between users, and do not replace a shared checkout.

## Target state

One person has one Unix user, one RemoteLab runtime running as that user, one GitHub CLI login and SSH key in that user's home, and a separate checkout. The checkout records that person's Git author and uses only their SSH key for Git network operations. GitHub grants read and write rights to that person's account as usual. Several people can use the same physical host and the same remote repository.

RemoteLab's `Person` record identifies who used its UI or connector. It does not select a Unix user for the current shared instance. Putting several people's GitHub tokens or private SSH keys under the same Unix user does not preserve different permission levels: tasks running as that user can use all of them. Use separate runtimes for this trial. On Linux, the host administrator can use `remotelab guest-instance create NAME --isolated` to create a dedicated service user. Existing personal Unix users are also suitable when each has a separate RemoteLab service.

## One person's setup

The operator supplies the Unix username, its active RemoteLab systemd service name, that instance's `auth.json` path, GitHub username, repository, Git display name and a verified commit email (or the account's GitHub `noreply` email). The following commands all run **as that Unix user**, with its own `HOME`. For a guest service user without a login shell, the host administrator can use `runuser` to launch each command with that user's home. Do not run them as root. The helper refuses services running under another Unix user and instances with multiple People.

```bash
remotelab github-workspace prepare --unix-user PERSON_UNIX_USER --service REMOTELAB_SERVICE --auth-file INSTANCE_AUTH_JSON --account GITHUB_USER
gh auth login --git-protocol ssh --skip-ssh-key
gh ssh-key add PATH_FROM_PREPARE_OUTPUT --type authentication
ssh -T -i PRIVATE_KEY_PATH_FROM_PREPARE_OUTPUT -o IdentitiesOnly=yes git@github.com
remotelab github-workspace activate --unix-user PERSON_UNIX_USER --service REMOTELAB_SERVICE --auth-file INSTANCE_AUTH_JSON --account GITHUB_USER --repo OWNER/REPO --name "Git display name" --email VERIFIED_EMAIL
remotelab github-workspace check --unix-user PERSON_UNIX_USER --service REMOTELAB_SERVICE --auth-file INSTANCE_AUTH_JSON --account GITHUB_USER --repo OWNER/REPO
```

The SSH command lets the person inspect and accept GitHub's host key before `activate`, which requires a known host key. Confirm the fingerprint against [GitHub's published fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints). `prepare` creates a private Ed25519 key with mode 600 and reports the public key path; it does not log in or upload the key. `activate` refuses a mismatched `gh` login, mismatched SSH account, or an existing checkout. It clones to `~/code/OWNER-REPO` by default and writes Git identity and the selected SSH command only to that checkout. `check` reads the active account, SSH identity, Git settings, repository reachability, and GitHub's reported read/push/admin permissions. It does not push a commit.

The account owner completes the browser login and SSH key upload. Their repository access must already be granted on GitHub. A successful `check` with `push: true` shows account-level write permission; branch protection can still restrict individual branches.

## Trial acceptance and rollback

For each participant, save only the non-secret `check` result and the matching RemoteLab instance name. Make a normal, reviewed change from that person's checkout and confirm the GitHub commit author and push actor match the intended account. Keep existing shared checkouts and credentials untouched during the trial. To stop the trial, stop using the new instance and checkout, revoke that person's trial SSH key in GitHub, then remove the trial checkout and local key after preserving any unmerged work.

The rollout does not rewrite old Git commits. Git author text alone can be changed locally; use per-person commit signing later if cryptographic proof is needed.
