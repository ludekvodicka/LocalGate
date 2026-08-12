# Security Policy

localgate binds **port 80** and, in `lan` mode, also a LAN address, and it can **start, restart and
kill processes** on the machine. That is enough reach to take seriously, so please disclose problems
responsibly.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through **GitHub Private Vulnerability Reporting**: go to the repository's
**Security** tab → **Report a vulnerability**, and describe the issue, the impact and how to reproduce
it. We aim to acknowledge a report within a few days, and we're happy to credit you once a fix is out,
unless you prefer to stay anonymous.

## Scope

Especially interested in:

- Anything that reaches the **control API** (`/__localgate/*`) or a runner's restart endpoint from
  **off the loopback interface** — both are meant to be loopback-only, and reaching them means remote
  process control.
- `Host` header handling that resolves a request to the **wrong route**, or that lets a name escape the
  table it was registered in.
- Header or environment rewriting that leaks a value into a request it should not be in.
- A path where localgate exposes an app on the LAN that its `mode` did not ask for.

## What is not a vulnerability

- **A dev server in `lan` or `internet` mode is unauthenticated by design.** localgate routes to it; it
  does not put a login in front of it. Only enable those modes on networks you trust, and switch back
  from `internet` when you are done.
- **No TLS.** Plain http is deliberate; put a tunnel or a reverse proxy in front when a request must be
  encrypted.

## Supported versions

Pre-1.0 and actively developed. Fixes land on the latest `main`; please reproduce against current
`main` before reporting.
