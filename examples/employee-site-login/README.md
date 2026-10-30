# Employee login sample

Publish this same directory under `employee-login-demo-a` and
`employee-login-demo-b` with `--access employee`. The page labels its business
content as a sample and reads the actual browser identity from
`/api/site-login/me`. It does not implement authentication, issue credentials or
log the employee out. Publishing inside an accepted human Request records that
human as owner; outside one, supply `--owner` as described in
[the login contract](../../docs/employee-site-login.md).

The first-login simulator lives in the existing explanation site at
`docs/architecture-atlas/employee-login-demo.html`. That simulator never contacts
the login API or changes browser cookies. Verify desktop/mobile rendering and
anonymous rejection of these real sample sites separately from a human's
completion of Feishu authorization.
