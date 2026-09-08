# Consistent Request state upgrade

Requirement: other machines must run the same migration, rather than repeat the
manual fixes used during the first production cutover.

The new `upgrade-state apply --plan ...` command owns rehearsal, final conversion,
file/record validation, backup and directory replacement, lifecycle command
receipts, HTTP version checks, resume and rollback. Per-host service and source
switch commands are explicit plan inputs. The tool never stops running business
Runs, starts a second message consumer for testing, or sends old replies.

## Failing reproduction

The multi-attempt fixture failed in the original converter:
`Multiple attempts share request identity s/req; reconcile explicitly before conversion`.
The transaction scenario initially failed because the upgrade entry point did not
exist. Logs are in `~/.remotelab/workspace/request-state-upgrader-20260908/`.

## Verified behavior

- Three historical attempts with shared request/response IDs all survive. Repeated
  conversions produce the same mappings and preserve the original source.
- Imported handled receipts deduplicate redelivery with additional event fields.
  Unmatched inbound events are retained for review and never executed by import.
- External connector storage, files, whitelist contents and failed-delivery
  terminal state survive; the instance directory remains private.
- Independent verification detects altered copied files. The old schema and
  original conversion regressions still pass.
- The transaction fixture uses subprocess lifecycle commands and an HTTP server:
  full upgrade, repeated apply, code+data rollback, rejected active lock, refused
  unfinished work before service stop, failed rollback reporting, later rollback
  recovery, real SIGKILL during activation and resumed completion all pass.
- After new data is written, rollback preserves it and reports recovery-required;
  it cannot claim success by restoring an obsolete snapshot.
- Full npm test passed in an isolated checkout containing this change. Final
  targeted tests, CLI help, documentation links and git diff --check passed.

The fixture substitutes the service/model and external transport. It is not a
claim of live Feishu acceptance or completed upgrades on other machines. Plans
must include every writer and preserve runnable old/new sources and dependencies;
health commands must check current connector startup evidence. Ambiguous batches,
unreconciled completion targets, unowned child processes and unsafe filesystem
layouts stop with retained evidence instead of being silently discarded.
