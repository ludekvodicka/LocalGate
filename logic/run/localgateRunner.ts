import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createSocketServer } from "node:net";
import { join } from "node:path";
import { LocalgateBanner } from "../cli/localgateBanner.ts";
import { LocalgateProxyClient } from "../client/localgateProxyClient.ts";
import { LocalgateMachineConfig, type LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import { LocalgateNames } from "../config/localgateNames.ts";
import { LocalgateProjectConfig, type LocalgateProjectSettings } from "../config/localgateProjectConfig.ts";
import { LocalgateRouteConflictError } from "../proxy/localgateRegistry.ts";
import type { LocalgateRoute, LocalgateRouteRegistration } from "../proxy/localgateRegistry.ts";
import { LocalgateEnvRewrite } from "./localgateEnvRewrite.ts";
import { LocalgateNodeOptions } from "./localgateNodeOptions.ts";
import { LocalgateProcessTree, type LocalgateKillOutcome } from "./localgateProcessTree.ts";
import { LocalgateRunnerControl } from "./localgateRunnerControl.ts";

type LocalgateRunnerRuntime =
{
  project: LocalgateProjectSettings;
  machine: LocalgateMachineSettings | null;
  names: string[];
};

// Runs inside the editor's debug terminal and owns the dev process, which is the part an editor cannot
// give away: the terminal keeps the debugger attached, while `localgate restart` swaps the child
// underneath without touching the terminal, the route or the port.
export class LocalgateRunner
{
  private static readonly logLinesKeptConst = 400;
  private static readonly heartbeatMsConst = 10_000;
  private static readonly takeoverTimeoutMsConst = 10_000;
  private static readonly replacementTimeoutMsConst = 10_000;
  private static readonly replacementPollMsConst = 50;

  private child: ChildProcess | null = null;
  private control: LocalgateRunnerControl | null = null;
  private route: LocalgateRoute | null = null;
  private runtime: LocalgateRunnerRuntime | null = null;
  private readonly logs: string[] = [];
  private stopping = false;
  private restarting = false;
  private reportedLostRoute = false;
  private exitCode = 0;

  constructor(
    private readonly command: string[],
    private readonly directory: string,
    private readonly force = false
  ) {}

  // Only leading flags belong to localgate: from the first other word on, everything is the child's
  // command line, where a `--force` of its own must survive untouched.
  static parseOptions(args: string[]): { force: boolean; command: string[] }
  {
    let force = false;
    let index = 0;

    while (args[index] == "--force")
    {
      force = true;
      index++;
    }

    return { force, command: args.slice(index) };
  }

  static debuggerAttached(env: NodeJS.ProcessEnv = process.env): boolean
  {
    const options = env.NODE_OPTIONS ?? "";
    return options.includes("bootloader") || options.includes("js-debug");
  }

  // A dev server that ignores PORT still has to land on the port the route points at, so the framework's
  // own flag is appended as well when we can see that the script runs Next.
  static withPortFlag(command: string[], scripts: Record<string, string>, port: number): string[]
  {
    const [runner, verb, script] = command;
    if (!runner || verb != "run" || !script) return command;
    if (!["npm", "pnpm", "yarn", "npm.cmd", "pnpm.cmd"].includes(runner)) return command;

    const body = scripts[script] ?? "";
    if (!body.includes("next")) return command;

    // pnpm forwards a separator to the script, where Next treats the following flags as positional arguments.
    if (runner == "pnpm" || runner == "pnpm.cmd") return [...command, "-p", String(port)];

    return [...command, "--", "-p", String(port)];
  }

  // Shown before the takeover, and instead of it when there is no terminal: whoever is about to lose
  // their dev server should be able to recognise it from this alone.
  static describeRunning(route: LocalgateRoute): string
  {
    const lines = [
      "",
      `  localgate   ${route.names[0]} is already running`,
      "",
      `    command    ${route.command ?? "-"}`,
      `    upstream   127.0.0.1:${route.port}`,
      `    started    ${route.startedAt.replace("T", " ").slice(0, 19)}`,
      `    pids       runner ${route.runnerPid ?? "-"}, child ${route.childPid ?? "-"}`
    ];

    if (route.debuggerAttached) lines.push("    debugger   attached");
    lines.push("");

    return `${lines.join("\n")}\n`;
  }

  static shellCommand(command: string[]): string
  {
    return command.map(part => /[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part).join(" ");
  }

  static routeRegistrationMatches(route: LocalgateRoute, registered: LocalgateRoute | null, runnerPid: number): boolean
  {
    return registered?.runnerPid == runnerPid && registered.controlUrl == route.controlUrl;
  }

  // Whether the kill got far enough for a restart or a stop to be called done, and what to report when it
  // did not. The kill used to be fire-and-forget, so a taskkill the system refused left the old dev server
  // holding the port while `localgate restart` printed "restarted" and the browser went on being served
  // the old build. A port that came free is the fact this trusts; the errors only say why it did not.
  static killFailure(route: LocalgateRoute, pid: number, outcome: LocalgateKillOutcome,
    action: "restarted" | "stopped"): string | null
  {
    if (outcome.released) return null;

    return `${route.names[0]} still answers on 127.0.0.1:${route.port} after killing ${pid}`
      + `${LocalgateProcessTree.describeErrors(outcome)} - it was not ${action}`;
  }

  static async freePort(): Promise<number>
  {
    return new Promise<number>((resolve, reject) =>
    {
      const server = createSocketServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () =>
      {
        const address = server.address();
        if (!address || typeof address == "string")
        {
          server.close();
          reject(new Error("could not obtain a free port"));
          return;
        }
        const { port } = address;
        server.close(() => resolve(port));
      });
    });
  }

  async run(): Promise<number>
  {
    if (this.command.length == 0) throw new Error("localgate run needs a command, for example: localgate run npm run dev");

    const runtime = this.loadRuntime();

    // Refused before the proxy is even asked for: the name belongs to localgate's own start page, so the
    // registration would fail anyway, and here the message can name the file that decides it.
    if (LocalgateNames.isReserved(runtime.project.name))
    {
      process.stderr.write(`localgate: "${LocalgateNames.startNameConst}" is reserved for localgate's start `
        + `page, so this project cannot use it as a name. Set "localgate": { "name": "..." } in `
        + `${runtime.project.packageDirectory}/package.json.\n`);
      return 1;
    }

    // Before the check and not after it: the route table lives in the proxy, so asking what already
    // runs while the proxy is down answers "nothing" about a machine full of dev servers.
    await LocalgateProxyClient.ensureRunning();

    if (!await this.clearPredecessor(runtime.project)) return 1;

    const port = await LocalgateRunner.freePort();
    const controlUrl = await this.startControlServer();

    const route = await this.claim({
      names: runtime.names,
      port,
      kind: "app",
      mode: runtime.project.mode,
      cwd: runtime.project.packageDirectory,
      command: this.command.join(" "),
      controlUrl,
      runnerPid: process.pid,
      childPid: null,
      debuggerAttached: LocalgateRunner.debuggerAttached()
    });

    if (!route)
    {
      await this.cleanup();
      return 1;
    }

    this.route = route;
    this.runtime = runtime;

    process.stdout.write(LocalgateBanner.render(route, LocalgateProxyClient.proxyPort()));

    this.installSignalHandlers();
    const heartbeat = this.startHeartbeat();

    const finished = this.spawnChild(port);
    await finished;

    clearInterval(heartbeat);
    await this.cleanup();
    return this.exitCode;
  }

  // Starting a second dev server for one project used to fail twice over: the registry handed this
  // runner the name and left the old one holding its port unreachable, and the dev server itself then
  // refused because of its own lock. So the collision is settled here, before anything is claimed.
  // Returns whether the run may go ahead.
  private async clearPredecessor(project: LocalgateProjectSettings): Promise<boolean>
  {
    // By name, because that is what the registry would take away, and by directory, because that is
    // what a dev server's own lock is keyed on.
    const existing = await LocalgateProxyClient.resolve({ name: project.name })
      ?? await LocalgateProxyClient.resolve({ directory: project.packageDirectory });

    if (!existing) return true;
    return this.settle(existing);
  }

  // The registration is the second place a collision shows up, and the one no check can prevent: the
  // route table lives in the proxy, so between the check above and this claim another runner can take
  // the name. A proxy that has just started is that race in practice - its table is empty, and the live
  // runners refill it from their own heartbeats up to ten seconds later, so the check sees a free name
  // that is not free. This used to end the process with a stack trace. It is now settled exactly like
  // the collision the check finds, and the claim is made once more.
  private async claim(registration: LocalgateRouteRegistration): Promise<LocalgateRoute | null>
  {
    try
    {
      return await LocalgateProxyClient.register(registration);
    }
    catch (error)
    {
      if (!(error instanceof LocalgateRouteConflictError)) throw error;
      if (!await this.settle(error.existing)) return null;
    }

    try
    {
      return await LocalgateProxyClient.register(registration);
    }
    catch (error)
    {
      if (!(error instanceof LocalgateRouteConflictError)) throw error;
      process.stderr.write(`localgate: ${error.existing.names[0]} was claimed by runner `
        + `${error.existing.runnerPid ?? "?"} while this one was taking it over - run again\n`);
      return null;
    }
  }

  // What happens to whoever holds the name: an alias is not ours to take, a route whose runner is gone
  // is cleared, and a live runner is stopped when this run has a terminal. That used to be a question,
  // but starting the project again from a terminal is the editor's restart button, and in a compound
  // launch the question waited in a terminal nobody looked at, leaving that project on its old build.
  // Without a terminal the caller is an agent or a CI job, which must not end the developer's session
  // by accident, so it gets the facts and needs --force.
  private async settle(existing: LocalgateRoute): Promise<boolean>
  {
    if (existing.kind == "alias")
    {
      process.stderr.write(`localgate: ${existing.names[0]} is an alias pointing at 127.0.0.1:${existing.port}, `
        + "so this project cannot claim that name.\n"
        + "Remove the alias, or give the project another name in package.json.\n");
      return false;
    }

    if (!await LocalgateRunner.runnerAlive(existing))
    {
      await LocalgateRunner.reclaimAbandoned(existing);
      return true;
    }

    process.stdout.write(LocalgateRunner.describeRunning(existing));

    if (!this.force && process.stdin.isTTY !== true)
    {
      process.stderr.write("localgate: left it running, this is not a terminal. "
        + "Re-run with --force to take it over.\n");
      return false;
    }

    await this.stopPredecessor(existing);
    return true;
  }

  // A runner that died without cleaning up leaves a row behind, and usually its dev server too: the
  // child outlives it and keeps the port, which is the orphan the framework's own lock then trips over.
  // Nobody owns it any more, so there is nothing to ask about - it just goes.
  // The pids on the row are not usable here: they were recorded by a runner that has since exited, and
  // a pid number gets reused. So the port is the only handle we trust, and killPortHolder kills
  // whoever answers on it right now rather than whoever used to.
  private static async reclaimAbandoned(route: LocalgateRoute): Promise<void>
  {
    if (await LocalgateProcessTree.isPortListening(route.port))
    {
      process.stdout.write(`localgate: ${route.names[0]} was left behind by a runner that is gone, `
        + `clearing 127.0.0.1:${route.port}\n`);

      const outcome = await LocalgateProcessTree.killPortHolder(route.port, LocalgateRunner.takeoverTimeoutMsConst);
      if (!outcome.released)
        process.stderr.write(`localgate: 127.0.0.1:${route.port} is still held`
          + `${LocalgateProcessTree.describeErrors(outcome)} - stop that process by hand, then run again\n`);
    }

    await LocalgateProxyClient.deregister(route.id).catch(() => {});
  }

  private static async runnerAlive(route: LocalgateRoute): Promise<boolean>
  {
    if (!route.controlUrl) return false;

    return fetch(`${route.controlUrl}/ping`, { signal: AbortSignal.timeout(1_000) })
      .then(response => response.ok)
      .catch(() => false);
  }

  // The old runner's own stop endpoint is the good path: it kills its child tree, releases the port and
  // deregisters itself, so its terminal ends cleanly. Killing by pid is the fallback for a runner that
  // no longer answers, and the port has to actually come free either way.
  private async stopPredecessor(route: LocalgateRoute): Promise<void>
  {
    process.stdout.write(`localgate: stopping ${route.names[0]} (runner ${route.runnerPid ?? "?"})\n`);

    const asked = route.controlUrl !== null && await fetch(`${route.controlUrl}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(2_000)
    }).then(response => response.ok).catch(() => false);

    if (asked && await LocalgateProcessTree.waitForPortRelease(route.port, LocalgateRunner.takeoverTimeoutMsConst))
    {
      await LocalgateProxyClient.deregister(route.id).catch(() => {});
      return;
    }

    const pid = route.childPid ?? route.runnerPid;
    if (pid === null)
      throw new Error(`${route.names[0]} did not stop and has no pid to kill - stop it by hand`);

    const outcome = await LocalgateProcessTree.killTree(pid, route.port, LocalgateRunner.takeoverTimeoutMsConst);
    await LocalgateProxyClient.deregister(route.id).catch(() => {});

    if (!outcome.released)
      throw new Error(`${route.names[0]} still holds 127.0.0.1:${route.port}`
        + `${LocalgateProcessTree.describeErrors(outcome)} - stop it by hand`);
  }

  private spawnChild(port: number): Promise<void>
  {
    const runtime = this.runtime;
    if (!runtime) throw new Error("localgate runtime is not configured");

    const scripts = LocalgateRunner.readScripts(runtime.project.packageDirectory);
    const command = LocalgateRunner.withPortFlag(this.command, scripts, port);

    const env = LocalgateNodeOptions.apply(LocalgateEnvRewrite.apply(
      process.env,
      runtime.project.mode,
      runtime.machine,
      LocalgateProxyClient.proxyPort()
    ));
    env.PORT = String(port);

    // One command string rather than a command plus an args array: `npm run dev` on Windows is a .cmd,
    // which node refuses to spawn without a shell, and passing an args array alongside `shell: true`
    // triggers DEP0190 because the shell concatenates them anyway. Quoting here makes that explicit.
    //
    // `detached` off Windows makes the child lead its own process group, which is the only way to reach
    // the dev server the shell spawns underneath it: signalling the shell alone leaves the server
    // running and holding the port. On Windows the same flag would hand the child its own console
    // instead, and `taskkill /T` already walks the tree, so it stays off there.
    const child = spawn(LocalgateRunner.shellCommand(command), {
      cwd: this.directory,
      env,
      shell: true,
      detached: process.platform != "win32",
      stdio: ["inherit", "pipe", "pipe"]
    });

    this.child = child;
    if (this.route)
      void LocalgateProxyClient.patch(this.route.id, { childPid: child.pid ?? null })
        .then(route => { this.route = route; })
        .catch(() => {});

    child.stdout?.on("data", chunk => this.absorb(chunk as Buffer, process.stdout));
    child.stderr?.on("data", chunk => this.absorb(chunk as Buffer, process.stderr));

    return new Promise<void>(resolve =>
    {
      child.once("exit", code =>
      {
        this.child = null;
        // A restart kills the child on purpose; only an exit we did not ask for ends the runner.
        if (this.restarting)
        {
          this.restarting = false;
          resolve(this.spawnChild(port));
          return;
        }

        // A stop kills it on purpose too, and there the result of the run is the stop's, not the code a
        // dev server leaves behind when it is killed.
        if (!this.stopping) this.exitCode = code ?? 0;
        resolve();
      });
    });
  }

  // A restart is two facts, and answering before both are in is how a route came to report "restarted"
  // while the old process went on serving: the old tree is gone with its port free, and a replacement
  // child is running. Either one missing is a failed restart, and the caller is told which.
  private async restartChild(): Promise<void>
  {
    const child = this.child;
    if (!child?.pid || !this.route) throw new Error("nothing to restart");

    const runtime = this.loadRuntime();
    this.route = await LocalgateProxyClient.patch(this.route.id, {
      names: runtime.names,
      mode: runtime.project.mode
    });
    this.runtime = runtime;
    this.restarting = true;

    const outcome = await LocalgateProcessTree.killTree(child.pid, this.route.port);
    const failure = LocalgateRunner.killFailure(this.route, child.pid, outcome, "restarted");
    if (failure !== null)
    {
      // Nothing died, so nothing will exit and nothing will respawn. The flag has to go back, or an exit
      // this restart never caused would be taken for its replacement.
      this.restarting = false;
      throw new Error(failure);
    }

    if (!await this.waitForReplacement(child, LocalgateRunner.replacementTimeoutMsConst))
      throw new Error(`${this.route.names[0]} released 127.0.0.1:${this.route.port} but started no `
        + `replacement process within ${LocalgateRunner.replacementTimeoutMsConst / 1_000}s`);
  }

  // A stop is a request that can be refused, and that is the whole difference from the signal path: the
  // kill runs first and what it achieved is the answer. Answering before it left a stop the system had
  // turned down looking exactly like one that worked - the route gone, this runner gone, the old dev
  // server still on its port, and `localgate stop` printing "stopped".
  private async stopChild(): Promise<void>
  {
    const child = this.child;
    if (!child?.pid || !this.route) return;

    this.stopping = true;
    const outcome = await LocalgateProcessTree.killTree(child.pid, this.route.port);
    const failure = LocalgateRunner.killFailure(this.route, child.pid, outcome, "stopped");
    if (failure === null) return;

    // Nothing died, so this runner stays with what it could not kill: its route still points at the
    // process that is serving, and that process still has an owner the next stop can ask. Exiting here
    // would leave it holding the port with no route and nobody to end it but the operator, by hand.
    this.stopping = false;
    throw new Error(failure);
  }

  // The replacement is spawned by the old child's own exit handler, so the kill returning is not yet a
  // restart. The flag is left alone here: a child still on its way out respawns after this gave up, and
  // reporting a restart that did not finish in time is better than ending the runner on its next exit.
  private async waitForReplacement(previous: ChildProcess, timeoutMs: number): Promise<boolean>
  {
    const deadline = Date.now() + timeoutMs;
    for (;;)
    {
      const current = this.child;
      if (current !== null && current !== previous) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, LocalgateRunner.replacementPollMsConst));
    }
  }

  private absorb(chunk: Buffer, sink: NodeJS.WriteStream): void
  {
    sink.write(chunk);

    for (const line of String(chunk).split(/\r?\n/))
      if (line.length > 0) this.logs.push(line);

    if (this.logs.length > LocalgateRunner.logLinesKeptConst)
      this.logs.splice(0, this.logs.length - LocalgateRunner.logLinesKeptConst);
  }

  private startControlServer(): Promise<string>
  {
    const control = new LocalgateRunnerControl({
      routeId: () => this.route?.id ?? null,
      logs: lines => this.logs.slice(-lines),
      restart: () => this.restartChild(),
      stop: () => this.stopChild(),
      // The child is gone and its port is free, so what is left of the stop is this runner's own exit.
      stopped: () => void this.end(0)
    });

    this.control = control;
    return control.start();
  }

  // The proxy holds the route table in memory, so if it dies the route dies with it. Another runner may
  // start the proxy before this heartbeat, so a successful ping is not enough: this runner verifies that
  // its own route is present and re-registers when it is missing.
  private startHeartbeat(): NodeJS.Timeout
  {
    const timer = setInterval(() =>
    {
      void (async () =>
      {
        if (this.stopping || !this.route) return;

        const registered = await LocalgateProxyClient.resolve({ name: this.route.names[0] }).catch(() => null);
        if (LocalgateRunner.routeRegistrationMatches(this.route, registered, process.pid))
        {
          this.route = registered;
          return;
        }

        try
        {
          await LocalgateProxyClient.ensureRunning();
          this.route = await LocalgateProxyClient.register({
            names: this.route.names,
            port: this.route.port,
            kind: "app",
            mode: this.route.mode,
            cwd: this.route.cwd,
            command: this.route.command,
            controlUrl: this.route.controlUrl,
            runnerPid: process.pid,
            childPid: this.child?.pid ?? null,
            debuggerAttached: this.route.debuggerAttached
          });
          this.reportedLostRoute = false;
          process.stdout.write("localgate: proxy restarted, route re-registered\n");
        }
        catch (error)
        {
          // Another runner serves this name now, so every following heartbeat fails the same way. Said
          // once, because this prints into a terminal somebody is working in.
          if (error instanceof LocalgateRouteConflictError)
          {
            if (this.reportedLostRoute) return;
            this.reportedLostRoute = true;
            process.stderr.write(`localgate: ${error.existing.names[0]} is served by runner `
              + `${error.existing.runnerPid ?? "?"} now, so this runner has no route left. `
              + "Stop it with Ctrl+C.\n");
            return;
          }

          process.stderr.write(`localgate: could not re-register the route: ${String(error)}\n`);
        }
      })();
    }, LocalgateRunner.heartbeatMsConst);

    timer.unref();
    return timer;
  }

  private installSignalHandlers(): void
  {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => void this.shutdown(0));
  }

  // Ctrl+C and the terminal going away, which is the operator leaving: the runner ends whatever the kill
  // achieved, and a port that outlived the child is a line on the way out. `/stop` is the other way in,
  // and it is the opposite - there somebody is waiting for the answer, so a refused kill is refused.
  private async shutdown(code: number): Promise<void>
  {
    if (this.stopping) return;
    this.stopping = true;

    const child = this.child;
    if (child?.pid && this.route)
    {
      const outcome = await LocalgateProcessTree.killTree(child.pid, this.route.port);
      if (!outcome.released)
        process.stderr.write(`localgate: 127.0.0.1:${this.route.port} is still held after stopping `
          + `${child.pid}${LocalgateProcessTree.describeErrors(outcome)}\n`);
    }

    await this.end(code);
  }

  // Everything left once the child is dealt with: the route, the control server and this process.
  private async end(code: number): Promise<void>
  {
    this.exitCode = code;
    await this.cleanup();
    process.exit(code);
  }

  private async cleanup(): Promise<void>
  {
    if (this.route)
    {
      await LocalgateProxyClient.deregister(this.route.id).catch(() => {});
      this.route = null;
      this.runtime = null;
    }

    if (this.control)
    {
      await this.control.close();
      this.control = null;
    }
  }

  private static readScripts(packageDirectory: string): Record<string, string>
  {
    try
    {
      const parsed = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      return parsed.scripts ?? {};
    }
    catch
    {
      return {};
    }
  }

  private loadRuntime(): LocalgateRunnerRuntime
  {
    const project = LocalgateProjectConfig.load(this.directory);
    const machine = LocalgateMachineConfig.load();
    return { project, machine, names: LocalgateNames.routeNames(project.name, project.mode, machine) };
  }
}
