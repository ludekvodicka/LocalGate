# Authentication origins

## Decision, 2026-10-08

An app in LAN or internet mode has several browser origins. One fixed `AUTH_URL` or `NEXTAUTH_URL`
cannot represent all of them. A login can set a host-only cookie on one origin and then redirect to
another, where that cookie is absent.

The application owns its authentication configuration. For request-derived origins, remove both URL
settings from development env files and launcher overrides, and configure `trustHost: true` or
`AUTH_TRUST_HOST=true`. Localgate forwards the routed host and browser protocol. It no longer
classifies auth URLs as browser-facing values to rewrite to a LAN or public hostname.

Localgate neither removes auth variables nor injects trust or internal-URL settings. Its existing
server-URL rule still adjusts the proxy port on explicitly configured `.localhost` URLs. Other URLs
retain their values. Local mode keeps this existing port behavior.

The attempted alternative, suppressing auth settings after application dotenv loads, was rejected:
intercepting `process.env` assignments makes the effective configuration diverge from its source.
Deleting inherited values alone is insufficient because dotenv can restore them. Keeping the setting
absent in the owning application's configuration avoids both mechanisms.

## Forwarded headers

After routing has accepted `Host`, the proxy sets `X-Forwarded-Host` to that exact authority, including
the port, replacing any unrelated forwarded host. It preserves `Host` itself. This applies to HTTP
requests and WebSocket upgrades.

`X-Forwarded-Proto` defaults to `http`. A single upstream `http` or `https` value is retained, while
invalid or comma-separated values fall back to `http`. A TLS-terminating tunnel must set this header
and preserve the browser's `Host`. The loopback/LAN listeners trust that protocol information;
Localgate does not authenticate a tunnel or add TLS. The tunnel must replace client-supplied headers.
Existing Next.js dev-endpoint Origin/Referer rewriting remains separate.

## Application compatibility

- Auth.js v5 derives action and redirect URLs from the request once both fixed URLs are absent.
  Set trust explicitly in the application. Do not use empty URL values as a substitute for absence.
- NextAuth v4.24.15 also supports request origin detection through `AUTH_TRUST_HOST`. Older releases
  require verification before adopting that configuration; Localgate does not retrofit support.
- V4 server-side `getSession()` needs an explicitly configured `NEXTAUTH_URL_INTERNAL` when there is
  no fixed auth URL. That helper uses one destination and cannot infer both HTTP and HTTPS default
  cookie names. For mixed-protocol access, use `getServerSession()` with the original request headers.
- Preserve custom auth base paths through the library's server and client configuration before
  removing an env URL that supplied the path. Apps intentionally using a fixed auth origin can retain it.
- If a cookie prefix previously came from `NEXTAUTH_URL`, configure a stable prefix or verify its
  fallback. Changing the prefix can require signing in again. Sessions remain separate per origin.
- OAuth providers must permit each callback URL. Fixed application redirect callbacks and explicit
  secure-cookie policies remain application choices.

## Entry points and validation

- `logic/run/localgateEnvRewrite.ts`: rewrites public URL fields and server proxy ports, with no auth
  variable names or auth-specific policy.
- `logic/proxy/localgateHeaderRewrite.ts`: supplies the request host and protocol to the upstream.
- Env and proxy tests cover preserved auth configuration, absent settings, ports, local/LAN/public
  names and forwarded HTTPS. Existing Node bootstrap tests cover nested localhost DNS resolution.
- `logic/run/localgateNodeOptions.ts` continues to add the original single DNS preload. No auth
  preload or `process.env` interception is installed.

## Applying a source or env update

The runner and resident proxy load modules at process startup. `localgate restart` replaces the dev
child but retains its runner and inherited environment. Restart the original editor launch to load a
runner change or remove an auth value inherited from the editor's env file. The resident proxy must
also be restarted to load forwarded-header changes; runners re-register and aliases are replayed.
Keep unrelated editor terminals and dev processes running.

## Sources

- [Auth.js environment defaults and action URL construction](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/lib/utils/env.ts).
- [NextAuth v4 origin detection](https://github.com/nextauthjs/next-auth/blob/v4/packages/next-auth/src/utils/detect-origin.ts).
- [NextAuth v4 React internal URL settings](https://github.com/nextauthjs/next-auth/blob/v4/packages/next-auth/src/react/index.tsx).
