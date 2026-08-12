import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";

export type LocalgateKillSpec =
  | { via: "command"; file: string; args: string[] }
  | { via: "signal"; target: number };

// Killing a dev server is not one call on either platform, and for the same reason: `npm run dev` spawns
// a shell that spawns the real server, so the process that holds the port is not the one whose pid we
// recorded. Windows walks parent links with `taskkill /T`, POSIX signals the process group the child was
// made the leader of. Both miss an orphan whose parent already exited, so the port is checked afterwards
// and whoever still holds it is killed directly.
export class LocalgateProcessTree
{
  private static readonly pollIntervalMsConst = 100;
  private static readonly connectTimeoutMsConst = 500;

  // Pure so both branches are testable from either OS: what runs is a decision, and only the execution
  // below is platform-bound.
  static killSpec(pid: number, platform: NodeJS.Platform = process.platform): LocalgateKillSpec
  {
    if (platform == "win32") return { via: "command", file: "taskkill", args: ["/T", "/F", "/PID", String(pid)] };

    // The negative pid is the process group. The child is spawned detached precisely so that it leads
    // one, which is what reaches the shell's children instead of only the shell.
    return { via: "signal", target: -pid };
  }

  static portHolderCommand(port: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] }
  {
    if (platform == "win32")
      return {
        file: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
        ]
      };

    return { file: "lsof", args: ["-ti", `tcp:${port}`, "-sTCP:LISTEN"] };
  }

  static async killTree(pid: number, port: number, timeoutMs = 10_000): Promise<void>
  {
    await LocalgateProcessTree.killPid(pid);

    if (await LocalgateProcessTree.waitForPortRelease(port, timeoutMs)) return;

    const holder = await LocalgateProcessTree.findPortHolder(port);
    if (holder !== null && holder != pid)
    {
      await LocalgateProcessTree.killPid(holder);
      await LocalgateProcessTree.waitForPortRelease(port, timeoutMs);
    }
  }

  // For a process nobody owns any more. The recorded pid belongs to something that already exited and
  // both platforms reuse pid numbers, so killing it blind can take out an unrelated tree; whoever
  // actually holds the port is the only target that is still known to be the right one.
  static async killPortHolder(port: number, timeoutMs = 10_000): Promise<boolean>
  {
    const holder = await LocalgateProcessTree.findPortHolder(port);
    if (holder === null) return !await LocalgateProcessTree.isPortListening(port);

    await LocalgateProcessTree.killPid(holder);
    return LocalgateProcessTree.waitForPortRelease(port, timeoutMs);
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

  static async findPortHolder(port: number): Promise<number | null>
  {
    const { file, args } = LocalgateProcessTree.portHolderCommand(port);

    try
    {
      const { stdout } = await promisify(execFile)(file, args);
      // lsof prints one pid per line and can name several; the listener is the first.
      const pid = Number.parseInt(stdout.trim().split(/\r?\n/)[0] ?? "", 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    catch
    {
      // No holder, or no lsof on this machine. Both mean the same to every caller: nothing to kill here.
      return null;
    }
  }

  private static async killPid(pid: number): Promise<void>
  {
    const spec = LocalgateProcessTree.killSpec(pid);

    if (spec.via == "command")
    {
      try
      {
        await promisify(execFile)(spec.file, spec.args);
      }
      catch
      {
        // Already gone, or gone between the check and the call: both mean there is nothing to kill.
      }
      return;
    }
    else if (spec.via == "signal")
    {
      try
      {
        process.kill(spec.target, "SIGKILL");
      }
      catch
      {
        // A child that was never detached leads no group, so the group signal finds nothing. Falling
        // back to the pid itself still ends the process we were asked to end.
        try
        {
          process.kill(Math.abs(spec.target), "SIGKILL");
        }
        catch
        {
          // Same as above.
        }
      }
      return;
    }
    else
      throw new Error(`Unknown kill spec: ${JSON.stringify(spec)}`);
  }
}
