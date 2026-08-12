# Contributing to localgate

Thanks for your interest. localgate started as a tool for one developer's machine and turned out to be
worth sharing, so bug reports, ideas and patches are all welcome.

## Ways to help

- **Report a bug** — open an issue with steps to reproduce, your OS and Node version, and what you
  expected. Output from `localgate status --json` and `localgate list` is usually the fastest context.
- **Suggest a feature** — open an issue describing the problem first, then the idea.
- **Send a PR** — for anything non-trivial, please open an issue to discuss the approach before writing
  a lot of code, so we don't both spend effort on something that won't merge.
- **Security issues** — do **not** open a public issue; see [SECURITY.md](SECURITY.md).

Windows, Linux and macOS are all supported, but the two POSIX platforms are far less travelled than
Windows, where this tool is used daily. Reports that something behaves differently there are the most
useful thing you can send right now. See *Status* in the README for the known rough edge on macOS.

## How your changes land

localgate is developed in a separate primary working tree, and this GitHub repo is kept in sync from it.
Your PRs are very welcome — a merged PR is integrated back into that tree by hand and shows up in a
later sync commit here, so it may be squashed or re-authored rather than preserved verbatim. None of
this changes how you contribute: open an issue, send a PR, and it will be picked up.

## Development setup

**Prerequisites:** Node.js 24+ and pnpm.

```bash
pnpm install
pnpm run verify      # type-check + lint + tests — the same gate CI runs
```

There is no build step: `bin/localgate.mjs` runs the TypeScript sources through tsx, so a working copy
is always runnable.

```bash
node bin/localgate.mjs list          # run it without installing
pnpm link --global                   # or put `localgate` on your PATH
```

Tests are vitest, co-located as `logic/**/*.test.ts`, and they do not need a proxy on port 80: the ones
that exercise the proxy start it on an ephemeral port instead.

## House style

Match the surrounding code. In short:

- One class per file, named after the file (`localgateProxy.ts` → `LocalgateProxy`); no loose top-level
  functions or constants next to a class.
- Constants are `camelCase` with a `Const` suffix (`private static readonly heartbeatMsConst`), never
  `SCREAMING_SNAKE_CASE`.
- A comment explains a non-obvious **why** — a constraint, a race, a platform quirk. It never restates
  what the code says.
- No braces around single-statement bodies.

## Before you open a PR

```bash
pnpm run verify
```

- No secrets, machine-specific paths, hostnames or personal data. Examples in code, tests and docs use
  the reserved documentation values: `example.com` and `192.0.2.x`.
- New behaviour comes with a test.
