import { execFile } from "node:child_process";
import { connect } from "node:net";
import { win32 } from "node:path";
import { promisify } from "node:util";

export type LocalgateKillSpec =
  | { via: "command"; file: string; args: string[] }
  | { via: "signal"; target: number };

// What a kill actually achieved. `released` is the fact a caller may act on - the port is free - and the
// errors are the reason it is not, which the platform prints once and nowhere else.
export type LocalgateKillOutcome =
{
  released: boolean;
  errors: string[];
};

// Killing a dev server is not one call on either platform, and for the same reason: `npm run dev` spawns
// a shell that spawns the real server, so the process that holds the port is not the one whose pid we
// recorded. Windows walks parent links with `taskkill /T`, POSIX signals the process group the child was
// made the leader of. Both miss an orphan whose parent already exited, so the port is checked afterwards
// and whoever still holds it is killed directly.
export class LocalgateProcessTree
{
  private static readonly pollIntervalMsConst = 100;
  private static readonly connectTimeoutMsConst = 500;
  private static readonly commandTimeoutMsConst = 5_000;

  // Pure so both branches are testable from either OS: what runs is a decision, and only the execution
  // below is platform-bound.
  static killSpec(pid: number, platform: NodeJS.Platform = process.platform,
    systemRoot = process.env.SystemRoot): LocalgateKillSpec
  {
    if (platform == "win32") return {
      via: "command", file: LocalgateProcessTree.windowsTool("taskkill.exe", systemRoot),
      args: ["/T", "/F", "/PID", String(pid)]
    };

    // The negative pid is the process group. The child is spawned detached precisely so that it leads
    // one, which is what reaches the shell's children instead of only the shell.
    return { via: "signal", target: -pid };
  }

  static portHolderCommand(port: number, platform: NodeJS.Platform = process.platform,
    systemRoot = process.env.SystemRoot): { file: string; args: string[] }
  {
    if (platform == "win32")
      return {
        file: LocalgateProcessTree.windowsTool("WindowsPowerShell\\v1.0\\powershell.exe", systemRoot),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop'; (Get-NetTCPConnection -ErrorAction Stop | `
            + `Where-Object { $_.LocalPort -eq ${port} -and $_.State -eq 'Listen' } | Select-Object -First 1).OwningProcess`
        ]
      };

    return { file: "lsof", args: ["-ti", `tcp:${port}`, "-sTCP:LISTEN"] };
  }

  static async killTree(pid: number, port: number, timeoutMs = 10_000): Promise<LocalgateKillOutcome>
  {
    const errors: string[] = [];
    const killed = await LocalgateProcessTree.killPid(pid, timeoutMs);
    if (killed !== null) errors.push(killed);

    if (await LocalgateProcessTree.waitForPortRelease(port, timeoutMs)) return { released: true, errors };

    const holder = await LocalgateProcessTree.findPortHolder(port, errors, timeoutMs);
    if (holder !== null && holder != pid)
    {
      const holderKilled = await LocalgateProcessTree.killPid(holder, timeoutMs);
      if (holderKilled !== null) errors.push(holderKilled);
      if (await LocalgateProcessTree.waitForPortRelease(port, timeoutMs)) return { released: true, errors };
    }

    // The wait ran out rather than the port being sampled once, so this last look only catches a release
    // that happened between the deadline and now. Everything else is a process that is still serving.
    return { released: !await LocalgateProcessTree.isPortListening(port), errors };
  }

  // For a process nobody owns any more. The recorded pid belongs to something that already exited and
  // both platforms reuse pid numbers, so killing it blind can take out an unrelated tree; whoever
  // actually holds the port is the only target that is still known to be the right one.
  static async killPortHolder(port: number, timeoutMs = 10_000): Promise<LocalgateKillOutcome>
  {
    const errors: string[] = [];
    const holder = await LocalgateProcessTree.findPortHolder(port, errors, timeoutMs);
    if (holder === null) return { released: !await LocalgateProcessTree.isPortListening(port), errors };

    const killed = await LocalgateProcessTree.killPid(holder, timeoutMs);
    if (killed !== null) errors.push(killed);
    return {
      released: await LocalgateProcessTree.waitForPortRelease(port, timeoutMs),
      errors
    };
  }

  // Appended to a caller's own "still held" line, which on its own cannot say which kill was refused or
  // what it printed. Empty when nothing failed, which is the case where the process outlived a kill that
  // the platform accepted.
  static describeErrors(outcome: LocalgateKillOutcome): string
  {
    return outcome.errors.length > 0 ? ` (${outcome.errors.join("; ")})` : "";
  }

  static async waitForPortRelease(port: number, timeoutMs: number): Promise<boolean>
  {
    const deadline = Date.now() + timeoutMs;
    for (;;)
    {
      if (!await LocalgateProcessTree.isPortListening(port)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, LocalgateProcessTree.pollIntervalMsConst));
    }
  }

  static isPortListening(port: number): Promise<boolean>
  {
    return new Promise<boolean>(resolve =>
    {
      const socket = connect({ host: "127.0.0.1", port });
      const settle = (listening: boolean) =>
      {
        socket.destroy();
        resolve(listening);
      };

      socket.setTimeout(LocalgateProcessTree.connectTimeoutMsConst);
      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      socket.once("error", () => settle(false));
    });
  }

  static async findPortHolder(port: number, errors: string[] = [],
    timeoutMs = LocalgateProcessTree.commandTimeoutMsConst): Promise<number | null>
  {
    try
    {
      const { file, args } = LocalgateProcessTree.portHolderCommand(port);
      const { stdout } = await LocalgateProcessTree.runCommand(file, args, timeoutMs);
      // lsof prints one pid per line and can name several; the listener is the first.
      const pid = Number.parseInt(stdout.trim().split(/\r?\n/)[0] ?? "", 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    catch (error)
    {
      errors.push(`port lookup ${port}: ${LocalgateProcessTree.describeFailure(error)}`);
      return null;
    }
  }

  // Returns what the kill said when it failed, and null when it was accepted. A process that was already
  // gone and a `taskkill` that was refused look the same from here, so the decision is left to the port:
  // this only makes sure the reason survives as far as the caller that has to report it.
  private static async killPid(pid: number, timeoutMs: number): Promise<string | null>
  {
    let spec: LocalgateKillSpec;
    try
    {
      spec = LocalgateProcessTree.killSpec(pid);
    }
    catch (error)
    {
      return `kill ${pid}: ${LocalgateProcessTree.describeFailure(error)}`;
    }

    if (spec.via == "command")
    {
      try
      {
        await LocalgateProcessTree.runCommand(spec.file, spec.args, timeoutMs);
        return null;
      }
      catch (error)
      {
        return LocalgateProcessTree.describeFailure(error);
      }
    }
    else if (spec.via == "signal")
    {
      try
      {
        process.kill(spec.target, "SIGKILL");
        return null;
      }
      catch
      {
        // A child that was never detached leads no group, so the group signal finds nothing. Falling
        // back to the pid itself still ends the process we were asked to end.
        try
        {
          process.kill(Math.abs(spec.target), "SIGKILL");
          return null;
        }
        catch (error)
        {
          return `kill ${Math.abs(spec.target)}: ${LocalgateProcessTree.describeFailure(error)}`;
        }
      }
    }
    else
      throw new Error(`Unknown kill spec: ${JSON.stringify(spec)}`);
  }

  // A runner can inherit a project-local PATH. Use the system tools without a shell, and include the
  // selected path in failures instead of dumping an environment that can contain credentials.
  private static windowsTool(relativePath: string, systemRoot: string | undefined): string
  {
    if (!systemRoot || !win32.isAbsolute(systemRoot))
      throw new Error("SystemRoot must be an absolute Windows directory to resolve process tools");
    return win32.join(systemRoot, "System32", relativePath);
  }

  private static async runCommand(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>
  {
    const timeout = Math.max(1, Math.min(timeoutMs, LocalgateProcessTree.commandTimeoutMsConst));
    try
    {
      return await promisify(execFile)(file, args, { timeout, killSignal: "SIGKILL", windowsHide: true, shell: false });
    }
    catch (error)
    {
      throw new Error(`${file} ${JSON.stringify(args)} [shell=false timeout=${timeout}ms]: `
        + LocalgateProcessTree.describeFailure(error));
    }
  }

  private static describeFailure(error: unknown): string
  {
    if (typeof error != "object" || error === null) return String(error);

    const detail: { stdout?: unknown; stderr?: unknown; message?: unknown;
      code?: unknown; signal?: unknown; killed?: unknown } = error;
    const stdout = typeof detail.stdout == "string" ? detail.stdout.trim() : "";
    const stderr = typeof detail.stderr == "string" ? detail.stderr.trim() : "";
    const message = typeof detail.message == "string" ? detail.message.trim() : "";
    const parts: string[] = [];
    if (detail.code !== undefined) parts.push(`code=${String(detail.code)}`);
    if (detail.signal !== undefined) parts.push(`signal=${String(detail.signal)}`);
    if (detail.killed !== undefined) parts.push(`killed=${String(detail.killed)}`);
    if (stdout) parts.push(`stdout=${stdout}`);
    if (stderr) parts.push(`stderr=${stderr}`);
    if (!stdout && !stderr) parts.push(message || String(error));
    return parts.join("; ").replace(/\s+/g, " ");
  }
}
