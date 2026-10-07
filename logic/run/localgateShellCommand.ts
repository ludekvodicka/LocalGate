import { spawn } from "node:child_process";

// Runs one line from the machine's own alias file and waits for it to finish.
//
// It is a shell line on purpose - `docker stop wagtail`, `systemctl --user stop thing` - because what
// stops a service localgate did not start is the service owner's business, not something localgate can
// derive. Only the owner of `~/.localgate/aliases.json` can put a line here, and nothing that arrives
// over a socket ever reaches this.
export class LocalgateShellCommand
{
  private static readonly timeoutMsConst = 25_000;
  private static readonly outputKeptConst = 400;

  // Waited on rather than fired off, so the page can say what happened. `docker stop` takes seconds,
  // which is the wait the reader is expecting after clicking; a command that hangs past the timeout is
  // killed and reported rather than holding the request open.
  static run(command: string, timeoutMs: number = LocalgateShellCommand.timeoutMsConst): Promise<void>
  {
    return new Promise<void>((resolve, reject) =>
    {
      const child = spawn(command, { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer) =>
      {
        output = `${output}${String(chunk)}`.slice(-LocalgateShellCommand.outputKeptConst);
      };

      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);

      const timer = setTimeout(() =>
      {
        child.kill();
        reject(new Error(`${command} did not finish within ${timeoutMs / 1000} s`));
      }, timeoutMs);

      child.once("error", (error: Error) =>
      {
        clearTimeout(timer);
        reject(new Error(`${command} could not be started: ${error.message}`));
      });

      child.once("close", code =>
      {
        clearTimeout(timer);
        if (code == 0) return resolve();
        reject(new Error(`${command} exited with ${code}${output.trim() ? `: ${output.trim()}` : ""}`));
      });
    });
  }
}
