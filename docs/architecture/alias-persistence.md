# Alias persistence

## Decision

An alias registered with `localgate alias <name> <port>` is remembered in
`~/.localgate/aliases.json` and served again by the next proxy that starts.

Every other route has a process that re-asserts it: a runner heartbeat verifies its own route every
ten seconds and re-registers it when a fresh proxy comes up with an empty table. An alias points at
something localgate does not own - a docker container, a server somebody else started - so there is no
process to put it back. Without a file, a proxy restart drops the alias for good, and since any runner
heartbeat can recycle a dead proxy, that stopped being an exceptional event.

The alternative was to keep the route table entirely ephemeral and only report the loss. It was
rejected on mechanics: to say *which* aliases went missing, the proxy has to remember them across its
own death, which is the same file. What is left without one is a disclaimer, not a fix.

The consequence is deliberate and stated in the README: "nothing is persisted" is now "nothing is
persisted except alias intent".

## What is stored

```json
{ "aliases": [ { "name": "myapp", "port": 8001 } ] }
```

The short name and the port, nothing else. The full name list and the mode are re-derived at restore
time by `LocalgateAliasRoute.registration` from the current `~/.localgate/config.json`, so changing the
machine label or base domain moves the alias with it instead of resurrecting hostnames that no longer
resolve. An alias is always registered in `local` or `lan` mode, so `publicPrefix` never applies to it.

Re-deriving the mode has a consequence worth knowing: an alias created on a machine with no
`~/.localgate/config.json` is local-only, and the day that file appears the same entry comes back as a
LAN route, served to the network with no authentication. An alias cannot currently say "keep me local"
the way a project can.

The file is written `0600` inside a `0700` directory: it lists this machine's internal service names
and ports, which is nobody else's business on a shared host. Windows ignores both modes.

## Who writes it

The `alias` command, and nothing else. It adds an entry only after the proxy accepted the
registration, so a name refused with a 409 leaves no entry behind, and `alias --remove` drops one. The
proxy reads the file once, at boot, and never writes it.

A proxy-owned snapshot of the route table was rejected: `LocalgateRegistry.register` evicts an alias
when an app legitimately claims its name, and a snapshot taken at that moment would un-persist the
alias forever.

There is no lock. Two `alias` commands running at the same instant on one machine is not a real
scenario, and the write is atomic anyway - the file is written as `aliases.json.tmp`, flushed, and
renamed over the target, because losing every alias to a crash halfway through a write is the failure
this file exists to prevent.

A port equal to localgate's own proxy port is refused, by the `alias` command and again by the proxy
before it dials anything. Such a route would send every request back into the proxy: from the LAN
listener that re-enters as loopback, which is where the control API answers, and any other path loops
until the machine runs out of sockets.

## Restore

`LocalgateProxyHost.run` loads the store and registers each entry **before** `proxy.start()`. The last
step of `start()` is the idle check, so routes that exist by then keep the fresh proxy from scheduling
its own exit. Each restored route is field-for-field what a fresh `localgate alias` registers, down to
`state: "starting"`, because both callers build it through the same `LocalgateAliasRoute.registration`.

The table is empty at that point, so a restore cannot collide with anything; a name repeated in a
hand-edited file simply replaces the earlier row, the same as re-running the command.

## Consequences

- **The proxy stays resident while an alias exists.** That is not new - a live alias has always kept
  `registry.isEmpty()` false - but persistence makes it reachable on every boot, so a forgotten alias
  pins the proxy until `localgate alias --remove <name>`. `localgate list` shows it, the banner prints
  the removal line, and `localgate config` reports the file and the entry count. Nothing auto-starts
  the proxy at machine boot: after a reboot the aliases come back with the first `run` or `alias`.
- **A restored alias is not probed.** An alias for a container the user starts five minutes later has
  to exist before its target does. If nothing answers, the health machine reports it like any other
  route: `starting` through the grace window, then `dead` with a page that names the port and offers
  the removal command.
- **`prune` still ignores aliases.** It drops routes whose runner is gone, and a dead upstream is not
  a dead intent.
- **Eviction keeps the intent.** When an app claims an alias's name, the registry drops the alias
  route but the file keeps the entry, so the alias returns at the next proxy boot. `alias --remove`
  works in that state too: it leaves the running app's route alone and removes the persisted alias,
  and says which of the two it did.
- **A restored alias can hold a live app's name for up to ten seconds.** The restore runs before the
  proxy listens, while a running app re-registers only on its next heartbeat. If the proxy is recycled
  while an alias and an app share a short name, requests reach the alias's port until that heartbeat.
  It heals itself, and the window did not exist before aliases were persisted: it used to answer 404.

## Failure handling

`load` never throws. A missing file reads as no aliases. Unparseable JSON is reported on stderr,
read as no aliases, and left on disk untouched - the next add or remove rewrites it. An entry whose
name is not a DNS label or whose port is not a port is skipped with its own stderr line while the
valid entries still load. A broken alias file must never take down a proxy boot that every dev server
on the machine depends on.

`add` and `remove` do throw, on a disk failure. The `alias` command catches that after the route is
already live and says the alias will not survive a restart, rather than dying over its own banner.

The warnings reach a terminal only from a CLI process. The proxy is spawned with its output discarded,
so its own copy of them is lost - which is why `localgate alias` refuses a name or port the loader
would reject, instead of writing it and letting the boot drop it silently.

## Files

| File | Role |
|---|---|
| `logic/config/localgateAliasStore.ts` | the file: load, upsert, remove, atomic write |
| `logic/proxy/localgateAliasRoute.ts` | the one registration builder shared by the CLI and the restore |
| `logic/proxy/localgateProxyHost.ts` | replays the store before the proxy starts listening |
| `logic/cli/localgateCli.ts` | `alias` writes the store, `alias --remove` drops from it |
| `logic/proxy/localgateProxy.ts` | refuses to forward a route aimed at the proxy's own port |
