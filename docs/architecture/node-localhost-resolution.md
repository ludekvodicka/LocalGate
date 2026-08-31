# Node localhost resolution

## Decision

Every Node process started below `localgate run` resolves a hostname ending in `.localhost` to
`127.0.0.1`. Localgate injects a small bootstrap through `NODE_OPTIONS`; repositories continue to use
stable URLs such as `http://api.localhost` and never learn another app's ephemeral upstream port.

The override is limited to the reserved `.localhost` suffix. Every other lookup keeps Node's original
resolver behavior.

## Runtime behavior

`LocalgateRunner` preserves existing `NODE_OPTIONS` and appends one `--import` for
`localgateNodeBootstrap.mjs`. The option propagates through package managers to the Node dev server and
its workers. The bootstrap replaces `dns.lookup` for nested `.localhost` names, which covers Node's
HTTP, HTTPS and Fetch clients while preserving the URL hostname and therefore the proxy's `Host`
header.

On platforms where the Localgate proxy uses a port other than 80, `LocalgateEnvRewrite` adds that port
to server-only `.localhost` URL values. Browser-facing values continue to follow the project's
exposure mode.

## Entry points

- `logic/run/localgateNodeOptions.ts`: composes `NODE_OPTIONS`
- `logic/run/localgateNodeBootstrap.mjs`: installs the lookup override
- `logic/run/localgateEnvRewrite.ts`: supplies the proxy port to server-only URLs
- `logic/run/localgateRunner.ts`: passes the resulting environment to the child process

## Constraints

- The lookup hook applies only to Node descendants of `localgate run`. Other command-line clients use
  their operating system resolver.
- Localgate binds its local proxy to IPv4 loopback, so the reserved names resolve to `127.0.0.1` even
  when a caller would otherwise prefer IPv6.
- Localgate remains a plain HTTP proxy. The lookup hook does not add TLS.
