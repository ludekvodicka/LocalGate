# Terminal loss

## Decision

A runner belongs to the terminal it was started from. When that terminal goes, the runner ends the way
Ctrl+C ends it: it kills the dev tree, releases the port, deregisters the route and exits. There are
three ways a terminal goes, and the runner now notices all of them:

| How the terminal goes | What the runner receives | Handled by |
|---|---|---|
| Ctrl+C, `kill` | `SIGINT`, `SIGTERM` | the signal handlers |
| The terminal window is closed | `SIGHUP` (on Windows the console close event) | the signal handlers |
| The console host disappears without an event (Windows) | nothing | the heartbeat, every 10 s |

The dev server is not given a console of its own so that it could outlive its terminal. That would turn
a server an agent starts into a background service nobody owns, which is the orphan the takeover already
has to clean up.

## The failure this prevents

On Windows the runner starts the dev command without `windowsHide` and without `detached`, so the whole
dev tree is attached to the console of whoever ran `localgate run`. A coding agent runs it from its own
shell. When that command ends, its console host can go without any event reaching the processes attached
to it. The runner and the dev server keep running, but every child they then start without a console of
its own (`npm` scripts, `cmd`, a framework's worker processes) fails at once with `0xC0000142`
(`STATUS_DLL_INIT_FAILED`).

A Next.js dev server shows what that costs. Its bundled worker pool restarts a worker that exits with a
non-zero code at once, with no delay and no limit (the retry limit only fails the pending request), so it
spawned about a hundred workers a second for as long as it ran: one core busy, `write EPIPE` in the log
and HTTP 500 on every page that needed a worker. The runner saw nothing wrong; its route still answered.

The cause was reproduced without localgate or Next: process A owns a console, process B is attached to
it, A's console host is killed, and from then on B's plain children exit with `0xC0000142` while a child
started with `windowsHide` works. `LocalgateConsole.test.ts` runs that reproduction on Windows.

## How the loss is detected

`LocalgateConsole` opens the console device `\\.\CONOUT$` and closes it again:

| State | Open of `\\.\CONOUT$` |
|---|---|
| Console alive | succeeds, about 0.1 ms |
| Console host gone | `EPIPE` |
| No console at all | `EBADF` |

No process is started, so the check costs about 0.1 ms per runner and beat. The path must be the device
path; a bare `CONOUT$` is resolved against the working directory and answers `ENOENT`.

- **Only a console that was there:** a runner started without any console, or on one the check cannot
  read at start, is not watched, and keeps working as it did before.
- **Unknown errors:** an error other than `EPIPE` or `EBADF` is reported once and the runner keeps
  working; it is not taken as a loss.
- **Other platforms:** off Windows the loss of a terminal arrives as `SIGHUP`, so the check always
  answers "attached".

Watching the parent process would not catch this case: in the observed failure the runner's parent shell
was still alive; the process above it had ended and taken the console with it.

## Output on a lost terminal

A terminal that is gone answers every write with `EPIPE`. The runner ignores errors on its own
`stdout` and `stderr`, because an unhandled stream error would end it in the middle of its shutdown,
before the route is released. The output is lost either way.

## Verified

With a real runner and proxy: `localgate run --force` was started from a process with its own console,
and the console host of that process was killed.

| Runner | After the console host was killed |
|---|---|
| Before this change | still running after 20 s; route kept; the dev server still running |
| With this change | exited after 2.4 s (the next beat); route gone; no dev server process left |
