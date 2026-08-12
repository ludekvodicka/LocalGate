import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";

// Killing a dev server on Windows is not one call. `taskkill /T` walks parent links, so when the
// intermediate shell npm spawned has already exited, the real server is an orphan the tree walk cannot
// see - it survives and keeps the port. That is the failure `portless prune` exists to clean up after.
// So: kill the tree, wait for the port to actually come free, and if it does not, find whoever still
// holds it and kill that process directly.
export class LocalgateProcessTree
{
  private static readonly pollIntervalMsConst = 100;
  private static readonly connectTimeoutMsConst = 500;

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
  // Windows reuses pid numbers, so killing it blind can take out an unrelated tree; whoever actually
  // holds the port is the only target that is still known to be the right one.
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
    if (process.platform != "win32") return null;

    try
    {
      const { stdout } = await promisify(execFile)("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
      ]);

      const pid = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    catch
    {
      return null;
    }
  }

  private static async killPid(pid: number): Promise<void>
  {
    if (process.platform == "win32")
    {
      try
      {
        await promisify(execFile)("taskkill", ["/T", "/F", "/PID", String(pid)]);
      }
      catch
      {
        // Already gone, or gone between the check and the call: both mean there is nothing to kill.
      }
      return;
    }

    try
    {
      process.kill(pid, "SIGKILL");
    }
    catch
    {
      // Same as above.
    }
  }
}
