# Automatic takeover

## Decision

`localgate run` started from a terminal, for a project whose name or directory a live runner already
holds, stops that runner and takes its name without asking. Without a terminal it refuses and exits `1`
unless `--force` is given. Both print the predecessor's command, upstream port, start time and pids
first, so the terminal records what was stopped or left running.

The run used to ask `Stop it and take over? [Y/n]` in a terminal. In practice the second run is the
editor's restart button on a debug configuration, and the answer was always yes. In a compound launch
(F5 on several projects) the question waited in a terminal nobody had focused, so that project silently
stayed on its old build while the others restarted.

## Why the terminal decides

An editor debug terminal (`node-terminal`) is a TTY, as is any terminal a developer types in, and there
the takeover is what the person wants. A coding agent's shell tool and a CI job have no TTY. Their
`localgate run` would end the developer's dev server and the debug session attached to it, so they keep
the old refusal and need `--force` to take over on purpose. An agent picks up a change with
`localgate restart`, which keeps the runner and the debugger.

Rejected alternatives:

- **Deciding by an attached debugger** (`NODE_OPTIONS` naming `js-debug`): depends on the editor's
  internals, and a plain terminal run would still need a question.
- **A question with a timeout defaulting to yes:** every project in a compound launch waits the full
  timeout.

## What is still refused

An alias is not a runner and has no owner to stop, so a project still cannot take an alias's name; `run`
says so and exits `1`. A route whose runner is gone is cleared as before, by killing whoever holds its
port, with or without a terminal. The second takeover after a registration conflict, described in the
README, follows the same terminal rule.

A takeover that cannot free the port still ends the run with `1`, and that project then stays on its old
build; the reason is printed in its terminal.

Entry points are `LocalgateRunner.settle` in `logic/run/localgateRunner.ts` and the `run` command in
`logic/cli/localgateCli.ts`.
