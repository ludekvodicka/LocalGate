# Restart verification

## Decision

`localgate restart` reports success only when the runner has confirmed both halves of a restart: the
old process tree is gone and its port is free, and a replacement child is running. Anything else is a
failed restart, answered `409` with the reason.

The kill used to be fire-and-forget. `LocalgateProcessTree.killTree` returned nothing, swallowed every
`taskkill` failure in a bare `catch`, and discarded the result of its own port-release wait;
`restartChild` awaited it and let the control endpoint answer `200`. A kill the system refused was
therefore indistinguishable from one that worked, and the CLI printed `restarted` while the old dev
server went on serving on the same port behind the same route. The way that surfaced was an upgraded
application: the route kept answering from the pre-upgrade build, and the browser failed on modules
that the running process did not have.

## What decides it

The port, not the kill. A process that was already gone and a `taskkill` that was turned down look the
same to the caller of a kill command, and on Windows they are reported the same way, so no kill result
can be read as proof on its own. A port that is free is proof: whatever was serving there is not
serving any more.

Kill errors are kept all the same, because they are the only place the reason exists - `Access is
denied`, a pid that no longer resolves, a missing tool. `LocalgateKillOutcome` carries both: `released`
is what the caller acts on, `errors` is what it says when it reports the failure.

`LocalgateRunner.killFailure` is the pure decision and the message, so the rule is asserted directly
rather than through a spawned dev server. The second half, the replacement child, is observed rather
than assumed: the new child is spawned by the old child's own `exit` handler, so `waitForReplacement`
waits for the runner's child to be a different object before the restart is called one.

`localgate stop` decides on the same rule and reports it the same way. What a refused stop does with the
route and the runner it could not end is in `stop-verification.md`.

## What a failed restart does

The runner throws, the control endpoint answers `409` with the message, and the CLI prints it after the
status code and exits `1`:

```text
localgate: restart failed, the runner answered 409: Error: myapp.localhost still answers on
127.0.0.1:61346 after killing 41188 (taskkill /T /F /PID 41188: ERROR: The process "41188" could not be
terminated. Access is denied.) - it was not restarted
```

The route is left alone. The old process is still serving it, and that is a truthful table: pointing
the route elsewhere or dropping it would replace a stale application with a broken one, and the
operator still has to end that process by hand.

When the kill is refused, `restarting` goes back to `false`. Nothing died, so nothing will exit and
nothing will respawn, and a later exit the restart never caused must not be taken for its replacement.
When the port came free but the replacement did not arrive in time, the flag is left set: a child still
on its way out respawns after the wait gave up, and a late restart is better than a runner that ends on
the next exit.

The same outcome is now reported by the two other places that kill a tree: taking over a route from a
predecessor and reclaiming one whose runner is gone both name what the kill said instead of `is still
held` alone, and shutdown writes a line when the port outlives the child.

## Already-running runners

A runner is a separate process that loaded `logic/` when it started, so updating localgate's source
does not reach it: a runner started before this change keeps answering `200` for a restart it did not
complete until it is started again. Both directions of the mismatch are safe. An old runner with the
new CLI answers `200`, and the CLI prints `restarted` exactly as it did before. A new runner with an
old CLI answers `409`, which the old CLI already reports as `restart failed, the runner answered 409`,
without the reason. Nothing in the control protocol changed shape.

Entry points are `logic/run/localgateProcessTree.ts`, `logic/run/localgateRunner.ts`,
`logic/run/localgateRunnerControl.ts` and the `control` command in `logic/cli/localgateCli.ts`.
