import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalgateProcessTree } from "./localgateProcessTree.ts";

describe("LocalgateProcessTree", () =>
{
  const listen = async (): Promise<{ port: number; close: () => Promise<void> }> =>
  {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address == "string") throw new Error("no port assigned");

    return {
      port: address.port,
      close: () => new Promise<void>(resolve => server.close(() => resolve()))
    };
  };

  // A pid nobody holds, so the kill command below really fails. ESRCH rather than merely "it throws":
  // EPERM would mean a live process belonging to somebody else, and no test may aim a kill at one.
  const absentPid = (): number =>
  {
    const candidate = 999_999;
    try
    {
      process.kill(candidate, 0);
    }
    catch (error)
    {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code == "ESRCH") return candidate;
    }

    throw new Error(`pid ${candidate} is not free on this machine, pick another one for this test`);
  };

  // The platform branches decide what runs; only one of them can execute on any given machine, so what
  // is asserted here is the decision. Getting it wrong is how the POSIX side came to kill a single pid
  // and look up nothing at all.
  it("kills the process tree on Windows and the process group elsewhere", () =>
  {
    expect(LocalgateProcessTree.killSpec(4_544, "win32", "C:\\Windows"))
      .toEqual({ via: "command", file: "C:\\Windows\\System32\\taskkill.exe", args: ["/T", "/F", "/PID", "4544"] });

    expect(LocalgateProcessTree.killSpec(4_544, "linux")).toEqual({ via: "signal", target: -4_544 });
    expect(LocalgateProcessTree.killSpec(4_544, "darwin")).toEqual({ via: "signal", target: -4_544 });
  });

  it("asks the right tool which process holds a port", () =>
  {
    expect(LocalgateProcessTree.portHolderCommand(41_000, "win32", "C:\\Windows").file)
      .toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(LocalgateProcessTree.portHolderCommand(41_000, "win32", "C:\\Windows").args.join(" ")).toContain("$_.LocalPort -eq 41000");

    expect(LocalgateProcessTree.portHolderCommand(41_000, "linux"))
      .toEqual({ file: "lsof", args: ["-ti", "tcp:41000", "-sTCP:LISTEN"] });
  });

  it("refuses Windows tool resolution without an absolute SystemRoot", () =>
  {
    expect(() => LocalgateProcessTree.killSpec(4_544, "win32", "")).toThrow("SystemRoot");
    expect(() => LocalgateProcessTree.portHolderCommand(41_000, "win32", "Windows")).toThrow("SystemRoot");
  });

  it("preserves exit code and both output streams when a kill command refuses", async () =>
  {
    const server = await listen();
    const spec = vi.spyOn(LocalgateProcessTree, "killSpec").mockReturnValue({
      via: "command", file: process.execPath,
      args: ["-e", "process.stdout.write('partial termination');process.stderr.write('fixture denied');process.exit(7)"]
    });
    const holder = vi.spyOn(LocalgateProcessTree, "findPortHolder").mockResolvedValue(null);
    try
    {
      const outcome = await LocalgateProcessTree.killTree(absentPid(), server.port, 500);
      expect(outcome.released).toBe(false);
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]).toContain("code=7");
      expect(outcome.errors[0]).toContain("stdout=partial termination");
      expect(outcome.errors[0]).toContain("stderr=fixture denied");
      expect(outcome.errors[0]).toContain(process.execPath);
      expect(await LocalgateProcessTree.isPortListening(server.port)).toBe(true);
    }
    finally
    {
      spec.mockRestore();
      holder.mockRestore();
      await server.close();
    }
  });

  it("bounds a stalled kill command and reports that it was killed", async () =>
  {
    const server = await listen();
    const spec = vi.spyOn(LocalgateProcessTree, "killSpec").mockReturnValue({
      via: "command", file: process.execPath,
      args: ["-e", "console.log('helperPid='+process.pid);setTimeout(()=>{},3000)"]
    });
    const holder = vi.spyOn(LocalgateProcessTree, "findPortHolder").mockResolvedValue(null);
    try
    {
      const started = Date.now();
      const outcome = await LocalgateProcessTree.killTree(absentPid(), server.port, 500);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(outcome.released).toBe(false);
      expect(outcome.errors.join(" ")).toContain("killed=true");
      expect(outcome.errors.join(" ")).toContain("timeout=500ms");
      const helperPid = Number(/stdout=helperPid=(\d+)/.exec(outcome.errors.join(" "))?.[1]);
      expect(helperPid).toBeGreaterThan(0);
      expect(() => process.kill(helperPid, 0)).toThrow();
    }
    finally
    {
      spec.mockRestore();
      holder.mockRestore();
      await server.close();
    }
  }, 10_000);

  it("preserves a failed port lookup instead of reporting it as no listener", async () =>
  {
    const server = await listen();
    const command = vi.spyOn(LocalgateProcessTree, "portHolderCommand").mockReturnValue({
      file: process.execPath,
      args: ["-e", "process.stderr.write('fixture lookup denied');process.exit(8)"]
    });
    try
    {
      const outcome = await LocalgateProcessTree.killPortHolder(server.port, 500);
      expect(outcome.released).toBe(false);
      expect(outcome.errors.join(" ")).toContain("code=8");
      expect(outcome.errors.join(" ")).toContain("stderr=fixture lookup denied");
      expect(await LocalgateProcessTree.isPortListening(server.port)).toBe(true);
    }
    finally
    {
      command.mockRestore();
      await server.close();
    }
  });

  it("bounds a stalled port lookup and leaves the listener alone", async () =>
  {
    const server = await listen();
    const command = vi.spyOn(LocalgateProcessTree, "portHolderCommand").mockReturnValue({
      file: process.execPath, args: ["-e", "console.log('helperPid='+process.pid);setTimeout(()=>{},3000)"]
    });
    try
    {
      const started = Date.now();
      const outcome = await LocalgateProcessTree.killPortHolder(server.port, 500);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(outcome.released).toBe(false);
      expect(outcome.errors.join(" ")).toContain("killed=true");
      const helperPid = Number(/stdout=helperPid=(\d+)/.exec(outcome.errors.join(" "))?.[1]);
      expect(helperPid).toBeGreaterThan(0);
      expect(() => process.kill(helperPid, 0)).toThrow();
      expect(await LocalgateProcessTree.isPortListening(server.port)).toBe(true);
    }
    finally
    {
      command.mockRestore();
      await server.close();
    }
  }, 10_000);

  it.runIf(process.platform == "win32")("terminates a pnpm run child tree without touching another listener", async () =>
  {
    const directory = mkdtempSync(join(tmpdir(), "localgate-process-tree-"));
    const unrelated = await listen();
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "myapp", private: true, scripts: { dev: "node server.cjs" }
    }));
    writeFileSync(join(directory, "server.cjs"), "const s=require('node:http').createServer(()=>{});"
      + "s.listen(0,'127.0.0.1',()=>console.log('LISTENER='+JSON.stringify({pid:process.pid,port:s.address().port})));\n");
    const child = spawn("pnpm run dev", { cwd: directory, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let listener: { pid: number; port: number } | null = null;
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    try
    {
      await vi.waitFor(() => expect(output).toContain("LISTENER="), { timeout: 15_000, interval: 50 });
      const match = /LISTENER=(\{[^\r\n]+\})/.exec(output);
      expect(match).not.toBeNull();
      listener = JSON.parse(match![1]!) as { pid: number; port: number };
      expect(listener.pid).not.toBe(child.pid);
      expect(await LocalgateProcessTree.findPortHolder(listener.port)).toBe(listener.pid);

      const outcome = await LocalgateProcessTree.killTree(child.pid!, listener.port);
      expect(outcome).toEqual({ released: true, errors: [] });
      expect(() => process.kill(listener!.pid, 0)).toThrow();
      expect(await LocalgateProcessTree.isPortListening(listener.port)).toBe(false);
      expect(await LocalgateProcessTree.isPortListening(unrelated.port)).toBe(true);
    }
    finally
    {
      if (child.exitCode === null && child.signalCode === null)
      {
        const spec = LocalgateProcessTree.killSpec(child.pid!);
        if (spec.via == "command")
          await promisify(execFile)(spec.file, spec.args, { timeout: 5000, windowsHide: true }).catch(() => {});
        else throw new Error("Expected Windows kill command");
      }
      if (listener && await LocalgateProcessTree.isPortListening(listener.port)
        && await LocalgateProcessTree.findPortHolder(listener.port) === listener.pid)
        try { process.kill(listener.pid, "SIGKILL"); } catch { /* Already terminated. */ }
      await unrelated.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("sees a listening port and sees it go", async () =>
  {
    const server = await listen();
    expect(await LocalgateProcessTree.isPortListening(server.port)).toBe(true);

    await server.close();
    expect(await LocalgateProcessTree.isPortListening(server.port)).toBe(false);
  });

  it("waits for a port to come free and reports the timeout when it does not", async () =>
  {
    const server = await listen();
    setTimeout(() => void server.close(), 150);

    expect(await LocalgateProcessTree.waitForPortRelease(server.port, 5_000)).toBe(true);

    const held = await listen();
    expect(await LocalgateProcessTree.waitForPortRelease(held.port, 300)).toBe(false);
    await held.close();
  });

  it("kills a spawned child and leaves the port free", async () =>
  {
    // A child that holds a port of its own, which is the shape that matters: the port must be free
    // afterwards, not merely the pid gone.
    const child = spawn(process.execPath, [
      "-e",
      "const s=require('node:http').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1000);"
    ], { stdio: ["ignore", "pipe", "ignore"] });

    const port = await new Promise<number>((resolve, reject) =>
    {
      child.stdout.once("data", data => resolve(Number.parseInt(String(data).trim(), 10)));
      child.once("error", reject);
    });

    expect(await LocalgateProcessTree.isPortListening(port)).toBe(true);

    const outcome = await LocalgateProcessTree.killTree(child.pid!, port, 10_000);

    expect(outcome).toEqual({ released: true, errors: [] });
    expect(await LocalgateProcessTree.isPortListening(port)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }, 20_000);

  // The regression: a kill the platform refused and a port that stayed bound used to leave exactly the
  // same trace as a kill that worked - none - and `localgate restart` answered success on top of it.
  it("reports a refused kill and a port that is still bound, with what the kill said", async () =>
  {
    const server = await listen();
    const pid = absentPid();

    // Whoever holds this port is the test runner itself, so the second kill has to be kept away from it.
    // What is under test is the first one, and it fails for real.
    const holder = vi.spyOn(LocalgateProcessTree, "findPortHolder").mockResolvedValue(null);

    try
    {
      const outcome = await LocalgateProcessTree.killTree(pid, server.port, 300);

      expect(outcome.released).toBe(false);
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]).toContain(String(pid));
    }
    finally
    {
      holder.mockRestore();
      await server.close();
    }
  }, 20_000);
});
