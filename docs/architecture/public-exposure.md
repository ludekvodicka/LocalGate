# Public exposure names

## Decision

Localgate models project reachability with three modes:

| Mode | Registered names |
|---|---|
| `local` | `<app>.localhost` |
| `lan` | local plus `<app>.<label>.<baseDomain>` |
| `internet` | local and LAN plus `<publicPrefix>-<app>.<baseDomain>` |

The public prefix belongs to the computer, not the project. It lives in
`~/.localgate/config.json`. This lets two developers expose the same package without sharing a DNS
name. Localgate does not call a DNS or tunnel API. A separate controller owns those external changes;
Atomix projects use `axtoolsv2 expose` from AtomixToolsV2.

## Runtime behavior

`LocalgateNames` is the single name builder used by route registration and browser-facing environment
rewrites. A runner reloads the project and machine files during `localgate restart`, patches its live
route, then restarts the child on the same port. Changing `localgate.mode` therefore takes effect without
replacing the runner or its editor terminal.

Each runner heartbeat also verifies that the proxy still contains that runner's own route. If another
runner recreates a stopped proxy first, every remaining runner registers itself again without restarting
its child process. Static alias routes have no runner to do that, so the starting proxy replays them
from `~/.localgate/aliases.json` instead (see `alias-persistence.md`).

For Next.js internal requests, the proxy rewrites `Origin` and `Referer` to the route's first name,
which is always the canonical `.localhost` name. It only rewrites a header whose hostname exactly
matches the incoming request `Host`. This supports both LAN and prefixed public names without trusting
a suffix wildcard.

Browser-facing environment values use the selected mode:

- `local`: `.localhost` and the Localgate proxy port
- `lan`: the LAN name and the Localgate proxy port
- `internet`: the public HTTPS name without the proxy's internal LAN port

Server-only environment values keep their canonical `.localhost` name. The runner adds a non-default
proxy port when needed and gives Node children a lookup hook that maps nested `.localhost` names to
`127.0.0.1`.

## Entry points

- `logic/config/localgateMachineConfig.ts`: loads `publicPrefix` with the other per-computer settings
- `logic/config/localgateNames.ts`: builds local, LAN and public names
- `logic/run/localgateRunner.ts`: reloads settings and patches the live route on restart
- `logic/run/localgateEnvRewrite.ts`: selects browser-facing names by mode
- `logic/run/localgateNodeOptions.ts`: installs the Node lookup bootstrap in child processes
- `logic/run/localgateNodeBootstrap.mjs`: maps nested `.localhost` names to loopback for Node clients
- `logic/proxy/localgateHeaderRewrite.ts`: exact-host Next.js header rewrite
- `logic/proxy/localgateRegistry.ts`: conflict-checked live name and mode updates

## Constraints

- The public DNS label is `<publicPrefix>-<app>` and must fit the 63 character DNS label limit.
- A missing machine config keeps every mode local-only. A missing public prefix keeps `internet` at
  local plus LAN. The external controller must reject public exposure until setup is complete.
- Public tunnel ingress rules are exact hostnames. Prefix globs are not supported by cloudflared.
- A public endpoint has no Localgate proxy port in browser-facing URLs. That port is only the tunnel's
  origin port on the LAN.
