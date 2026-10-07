# Windows process termination diagnostics

## Decision

Keep `taskkill /T /F /PID` as the Windows tree termination operation. Resolve it and Windows
PowerShell under the inherited absolute `SystemRoot`, rather than through the runner's PATH.
Invoke both directly with an argument array, no shell, a hidden window and a five-second command
limit. A shorter caller timeout also shortens that limit. Missing or relative `SystemRoot` is a
reported failure, not a reason to search the current directory.

This implements the diagnostics option of Localgate issue #7. The original incident's taskkill
refusal has not been reproduced. Successful isolated pnpm runs do not establish its cause, and no
unverified Stop-Process fallback is introduced.

## Behavior

`LocalgateProcessTree` keeps the selected executable, argument array, timeout, exit or spawn code,
signal, killed flag, stdout and stderr in its failure message. Both output streams matter when a
tree operation partially succeeds. No complete environment or application command line is collected.
The absolute executable path records the effect of `SystemRoot`; PATH and ComSpec no longer select
these Windows tools.

A failed or timed-out port lookup now reaches `LocalgateKillOutcome.errors`. PowerShell queries
connections with terminating errors enabled and filters the requested listening port afterward:
an empty match is distinct from an unavailable networking cmdlet. The public lookup still returns
null when no usable holder is available; callers requesting diagnostics receive the error separately.

The port-release check remains authoritative. A nonzero helper exit may still accompany a released
port; an occupied port still produces HTTP 409 with the diagnostic. Existing restart and stop
behavior, including route retention after a refusal, is described in `restart-verification.md` and
`stop-verification.md`. Existing kill targets are unchanged.

## Bounds and limitations

The five-second limit applies to each command, not the complete control request. A tree kill can
execute two kill commands and one lookup, plus up to two existing ten-second port-release waits.
Socket probes and scheduling add small overhead. POSIX command lookups use the same bound; process
group signals remain unchanged. Runners already in memory acquire these changes when started again.

Entry points are `logic/run/localgateProcessTree.ts` and its co-located tests. Real child commands
test nonzero exits, both streams and command timeouts; an isolated pnpm script tests descendant
termination while a separate listener remains alive. Windows-specific coverage is skipped on POSIX.

The same change excludes `.aidocs/temp/` from ESLint. Disposable probe projects can contain generated
JavaScript, and previously those artifacts caused the normal verification command to lint unrelated
bundles. Application source remains in the lint scope.
