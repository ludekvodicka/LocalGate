import { closeSync, openSync } from "node:fs";

// Whether the Windows console this process is attached to still exists. The runner and its dev tree
// share the console of whoever started `localgate run`. When an agent's command ends, its console host
// can go without any event reaching the processes attached to it, and from then on every child spawned
// without its own console fails to start with 0xC0000142 - Next's worker pool restarts such a child
// forever. Opening the console device is the cheapest question that tells: about 0.1 ms, no process.
export class LocalgateConsole
{
  // `CONOUT$` alone resolves against the working directory; only the device path reaches the console.
  static readonly devicePathConst = "\\\\.\\CONOUT$";

  private readonly platform: NodeJS.Platform;
  private readonly open: (path: string) => void;
  private readonly watched: boolean;

  constructor(platform: NodeJS.Platform = process.platform, open: (path: string) => void = LocalgateConsole.openDevice)
  {
    this.platform = platform;
    this.open = open;
    // A runner started without a console, or on a console this probe cannot read, keeps working the way
    // it always did; only a console that was there and went is the loss this class reports.
    try { this.watched = this.attached(); }
    catch { this.watched = false; }
  }

  // POSIX reports a lost terminal as SIGHUP, which the runner handles, so only Windows needs the probe.
  attached(): boolean
  {
    if (this.platform != "win32") return true;

    try
    {
      this.open(LocalgateConsole.devicePathConst);
      return true;
    }
    catch (error)
    {
      const code = (error as NodeJS.ErrnoException).code;
      // EPIPE: the console host is gone. EBADF: this process has no console at all.
      if (code == "EPIPE" || code == "EBADF") return false;
      throw error;
    }
  }

  lost(): boolean
  {
    return this.watched && !this.attached();
  }

  private static openDevice(path: string): void
  {
    closeSync(openSync(path, "r+"));
  }
}
