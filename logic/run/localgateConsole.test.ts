import { describe, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { LocalgateConsole } from "./localgateConsole.ts";

describe("LocalgateConsole", () =>
{
  const failing = (code: string) => () =>
  {
    throw Object.assign(new Error(code), { code });
  };

  it("reports a console that was there and went, and nothing else", () =>
  {
    let answer: () => void = () => {};
    const terminal = new LocalgateConsole("win32", () => answer());
    expect(terminal.lost()).toBe(false);

    answer = failing("EPIPE");
    expect(terminal.lost()).toBe(true);
    answer = failing("EBADF");
    expect(terminal.lost()).toBe(true);
  });

  it("opens the console device, not a file named CONOUT$ in the working directory", () =>
  {
    const opened: string[] = [];
    new LocalgateConsole("win32", path => void opened.push(path));
    expect(opened).toEqual(["\\\\.\\CONOUT$"]);
  });

  it("never reports a loss for a runner that started without a console", () =>
  {
    expect(new LocalgateConsole("win32", failing("EBADF")).lost()).toBe(false);
    expect(new LocalgateConsole("win32", failing("EACCES")).lost()).toBe(false);
  });

  it("passes an error it does not know to the caller", () =>
  {
    let answer: () => void = () => {};
    const terminal = new LocalgateConsole("win32", () => answer());
    answer = failing("EACCES");
    expect(() => terminal.lost()).toThrow("EACCES");
  });

  it("leaves terminal loss off Windows to SIGHUP", () =>
  {
    expect(new LocalgateConsole("linux", failing("EPIPE")).lost()).toBe(false);
    expect(new LocalgateConsole("darwin", failing("EPIPE")).attached()).toBe(true);
  });

  // The failure itself, without localgate or a dev server: B shares A's console, the console host of A
  // is killed, and B must see the loss while its plain children start no more.
  it.runIf(process.platform == "win32")("sees the loss after the console host is killed", async () =>
  {
    const directory = mkdtempSync(join(tmpdir(), "localgate-console-"));
    const result = join(directory, "result.json");
    const go = join(directory, "go");
    const consoleModule = pathToFileURL(join(import.meta.dirname, "localgateConsole.ts")).href;
    writeFileSync(join(directory, "b.mjs"), `
      import { spawn } from "node:child_process";
      import { existsSync, writeFileSync } from "node:fs";
      const { LocalgateConsole } = await import(${JSON.stringify(consoleModule)});
      const terminal = new LocalgateConsole();
      const child = () => new Promise(r => spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }).on("exit", r));
      const before = { lost: terminal.lost(), child: await child() };
      while (!existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 100));
      writeFileSync(${JSON.stringify(result)}, JSON.stringify({ before, after: { lost: terminal.lost(), child: await child() } }));
    `);
    writeFileSync(join(directory, "a.mjs"), `
      import { spawn } from "node:child_process";
      spawn(process.execPath, [...process.execArgv, ${JSON.stringify(join(directory, "b.mjs"))}], { stdio: "ignore" });
      setTimeout(() => {}, 60_000);
    `);

    // windowsHide gives A a console of its own, so its console host is A's child and B is attached to it.
    const a = spawn(process.execPath, ["--import", "tsx", join(directory, "a.mjs")], { stdio: "ignore", windowsHide: true });
    try
    {
      let host = "";
      for (let attempt = 0; attempt < 50 && !host; attempt++)
      {
        await new Promise(r => setTimeout(r, 100));
        const query = `(Get-CimInstance Win32_Process -Filter "Name='conhost.exe' and ParentProcessId=${a.pid}").ProcessId`;
        host = (await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", query], { windowsHide: true })).stdout.trim();
      }
      expect(host).toMatch(/^\d+$/);
      // B answers `before` while the console still exists; give it the time to start and spawn.
      await new Promise(r => setTimeout(r, 3_000));
      await promisify(execFile)("taskkill.exe", ["/F", "/PID", host], { windowsHide: true });
      writeFileSync(go, "");

      for (let attempt = 0; attempt < 100 && !existsSync(result); attempt++)
        await new Promise(r => setTimeout(r, 100));
      expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({
        before: { lost: false, child: 0 },
        after: { lost: true, child: 0xC0000142 }
      });
    }
    finally
    {
      a.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
