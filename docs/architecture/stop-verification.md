# Stop verification

## Decision

`localgate stop` reports success only once the runner has killed the process tree and seen its port come
free. A stop it could not achieve is answered `409` with the reason, the CLI prints that and exits `1`,
and the runner keeps its route and itself.

The endpoint used to answer first. `/stop` wrote `200 {ok:true}` and only then started the kill, and the
shutdown that followed deregistered the route and ended the runner whatever the kill achieved. A
`taskkill` the system refused therefore ended with the route gone, the runner gone, the old dev server
still holding its port, and the operator told that it stopped. It is the same untruth `restart` used to
tell, and the port decides it the same way: `LocalgateRunner.killFailure` is one rule for both, and
`restart-verification.md` records why a kill result on its own proves nothing.

## What a refused stop does

The runner stays alive with the process it could not end, and its route stays pointing at it. That is
the choice this ticket turned on, and it is the same one a failed restart already makes. The alternative
is to exit anyway, which leaves the dev server holding its port with no route, no owner and no control
endpoint, so the only way to end it is by hand and the only way to find it is the port. Staying costs a
terminal that still belongs to a process it no longer controls, and it keeps both the route table
truthful and somebody to ask again: `localgate stop` can be run once more, and Ctrl+C is still there.

`stopping` goes back to `false` when the kill is refused, exactly as `restarting` does. Nothing died, so
the next stop and the signal handlers must not find a runner that thinks it is already on its way out.

## The reason belongs to whoever reports the refusal

The `409` carries the reason in `{error}`, and that field is the only place it exists. The start page
used to drop it and print `control endpoint answered 409` alone, which is the bare status code
`restart-verification.md` already calls useless, and worse there than in a terminal: the page is read by
somebody who did not open one. `LocalgateRunnerControl.refusalDetail` is the reading half of that body,
in the class that writes it, and `LocalgateCli.control`, `LocalgateProxyHost.request` and the automatic
restart behind it all report through it. A body that is not that shape is reported as it stands, and an
empty one adds nothing to the status code.

## Signals are the other way round

Ctrl+C and `SIGTERM` end the runner whatever the kill achieved. There the operator is leaving rather than
asking a question, so a port that outlived the child is a line on the terminal and not a refusal. That
asymmetry is deliberate: a `/stop` has a caller waiting for an answer it will act on, and a signal has
nobody left to tell.

## The answer has to leave before the runner does

The kill usually ends the child, and the child's exit is also what ends a `localgate run`. Both paths run
through `cleanup`, which closes the control server, and closing it destroys the socket the stop's answer
is still on. `LocalgateRunnerControl` holds that answer from the request until the response is closed,
and `close()` waits for it, so a stop that worked cannot reach its caller as a broken connection. The
runner's own exit is then `stopped()`, which the control server calls once the answer is out.

## Already-running runners

A runner loaded `logic/` when it started, so a runner that predates this change still answers `200` for a
stop it did not complete, until it is started again. Nothing in the control protocol changed shape: an
old CLI reports the new `409` as `stop failed, the runner answered 409`, without the reason.

Entry points are `logic/run/localgateRunnerControl.ts`, `logic/run/localgateRunner.ts` and the `control`
command in `logic/cli/localgateCli.ts`.
