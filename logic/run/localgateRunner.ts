import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { createServer as createSocketServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { LocalgateBanner } from "../cli/localgateBanner.ts";
import { LocalgateProxyClient } from "../client/localgateProxyClient.ts";
import { LocalgateMachineConfig, type LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import { LocalgateNames } from "../config/localgateNames.ts";
import { LocalgateProjectConfig, type LocalgateProjectSettings } from "../config/localgateProjectConfig.ts";
import type { LocalgateRoute } from "../proxy/localgateRegistry.ts";
import { LocalgateUrl } from "../proxy/localgateUrl.ts";
import { LocalgateEnvRewrite } from "./localgateEnvRewrite.ts";
import { LocalgateProcessTree } from "./localgateProcessTree.ts";

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

  private child: ChildProcess | null = null;
  private controlServer: Server | null = null;
  private route: LocalgateRoute | null = null;
  private runtime: LocalgateRunnerRuntime | null = null;
  private readonly logs: string[] = [];
  private stopping = false;
  private restarting = false;
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

    return [...command, "--", "-p", String(port)];
  }

  // Shown before the question, and instead of it when there is no terminal to ask in: whoever is about
  // to lose their dev server should be able to recognise it from this alone.
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

    const blocked = await this.clearPredecessor(runtime.project);
    if (blocked != 0) return blocked;

    const port = await LocalgateRunner.freePort();
    const controlUrl = await this.startControlServer();

    await LocalgateProxyClient.ensureRunning();
    const route = await LocalgateProxyClient.register({
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
  // Returns 0 to go ahead, or the exit code to leave with.
  private async clearPredecessor(project: LocalgateProjectSettings): Promise<number>
  {
    // By name, because that is what the registry would take away, and by directory, because that is
    // what a dev server's own lock is keyed on.
    const existing = await LocalgateProxyClient.resolve({ name: project.name })
      ?? await LocalgateProxyClient.resolve({ directory: project.packageDirectory });

    if (!existing) return 0;

    if (existing.kind == "alias")
    {
      process.stderr.write(`localgate: ${existing.names[0]} is an alias pointing at 127.0.0.1:${existing.port}, `
        + "so this project cannot claim that name.\n"
        + "Remove the alias, or give the project another name in package.json.\n");
      return 1;
    }

    if (!await LocalgateRunner.runnerAlive(existing))
    {
      await LocalgateRunner.reclaimAbandoned(existing);
      return 0;
    }

    if (!this.force)
    {
      process.stdout.write(LocalgateRunner.describeRunning(existing));

      // Asking without a terminal would block until somebody kills this process, so a non-interactive
      // caller gets the facts and a flag instead.
      if (process.stdin.isTTY !== true)
      {
        process.stderr.write("localgate: nothing to ask on, this is not a terminal. "
          + "Re-run with --force to take it over.\n");
        return 1;
      }

      if (!await LocalgateRunner.askTakeover())
      {
        process.stdout.write("localgate: left it running. Reach it at "
          + `${LocalgateUrl.forName(existing.names[0], LocalgateProxyClient.proxyPort())}\n`);
        return 1;
      }
    }

    await this.stopPredecessor(existing);
    return 0;
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

      if (!await LocalgateProcessTree.killPortHolder(route.port, LocalgateRunner.takeoverTimeoutMsConst))
        process.stderr.write(`localgate: 127.0.0.1:${route.port} is still held - `
          + "stop that process by hand, then run again\n");
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

  private static async askTakeover(): Promise<boolean>
  {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    reader.once("SIGINT", () =>
    {
      reader.close();
      process.exit(1);
    });

    try
    {
      const answer = await reader.question("Stop it and take over? [Y/n] ");
      return !/^n/i.test(answer.trim());
    }
    finally
    {
      reader.close();
    }
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

    await LocalgateProcessTree.killTree(pid, route.port, LocalgateRunner.takeoverTimeoutMsConst);
    await LocalgateProxyClient.deregister(route.id).catch(() => {});

    if (await LocalgateProcessTree.isPortListening(route.port))
      throw new Error(`${route.names[0]} still holds 127.0.0.1:${route.port} - stop it by hand`);
  }

  private spawnChild(port: number): Promise<void>
  {
    const runtime = this.runtime;
    if (!runtime) throw new Error("localgate runtime is not configured");

    const scripts = LocalgateRunner.readScripts(runtime.project.packageDirectory);
    const command = LocalgateRunner.withPortFlag(this.command, scripts, port);

    const env = LocalgateEnvRewrite.apply(process.env, runtime.project.mode, runtime.machine,
      LocalgateProxyClient.proxyPort());
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

        this.exitCode = code ?? 0;
        resolve();
      });
    });
  }

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
    await LocalgateProcessTree.killTree(child.pid, this.route.port);
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
    const server = createServer((request, response) =>
    {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const send = (status: number, payload: unknown) =>
      {
        const body = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        response.end(body);
      };

      if (url.pathname == "/ping") return send(200, { ok: true, id: this.route?.id ?? null });

      if (url.pathname == "/logs")
      {
        const lines = Number.parseInt(url.searchParams.get("lines") ?? "80", 10);
        return send(200, { lines: this.logs.slice(-Math.max(1, lines)) });
      }

      if (url.pathname == "/restart" && request.method == "POST")
      {
        void this.restartChild().then(
          () => send(200, { ok: true }),
          (error: unknown) => send(409, { error: String(error) })
        );
        return;
      }

      if (url.pathname == "/stop" && request.method == "POST")
      {
        send(200, { ok: true });
        void this.shutdown(0);
        return;
      }

      return send(404, { error: `unknown ${request.method} ${url.pathname}` });
    });

    this.controlServer = server;

    // Loopback only: the restart channel must not be reachable from the LAN.
    return new Promise<string>((resolve, reject) =>
    {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () =>
      {
        const address = server.address();
        if (!address || typeof address == "string")
        {
          reject(new Error("control server has no port"));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
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
          process.stdout.write("localgate: proxy restarted, route re-registered\n");
        }
        catch (error)
        {
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

  private async shutdown(code: number): Promise<void>
  {
    if (this.stopping) return;
    this.stopping = true;
    this.exitCode = code;

    const child = this.child;
    if (child?.pid && this.route) await LocalgateProcessTree.killTree(child.pid, this.route.port);

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

    if (this.controlServer)
    {
      this.controlServer.closeAllConnections();
      await new Promise<void>(resolve => this.controlServer!.close(() => resolve()));
      this.controlServer = null;
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
