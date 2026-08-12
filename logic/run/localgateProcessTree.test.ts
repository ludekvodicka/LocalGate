import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
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

  // The platform branches decide what runs; only one of them can execute on any given machine, so what
  // is asserted here is the decision. Getting it wrong is how the POSIX side came to kill a single pid
  // and look up nothing at all.
  it("kills the process tree on Windows and the process group elsewhere", () =>
  {
    expect(LocalgateProcessTree.killSpec(4_544, "win32"))
      .toEqual({ via: "command", file: "taskkill", args: ["/T", "/F", "/PID", "4544"] });

    expect(LocalgateProcessTree.killSpec(4_544, "linux")).toEqual({ via: "signal", target: -4_544 });
    expect(LocalgateProcessTree.killSpec(4_544, "darwin")).toEqual({ via: "signal", target: -4_544 });
  });

  it("asks the right tool which process holds a port", () =>
  {
    expect(LocalgateProcessTree.portHolderCommand(41_000, "win32").file).toBe("powershell");
    expect(LocalgateProcessTree.portHolderCommand(41_000, "win32").args.join(" ")).toContain("-LocalPort 41000");

    expect(LocalgateProcessTree.portHolderCommand(41_000, "linux"))
      .toEqual({ file: "lsof", args: ["-ti", "tcp:41000", "-sTCP:LISTEN"] });
  });

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

    await LocalgateProcessTree.killTree(child.pid!, port, 10_000);

    expect(await LocalgateProcessTree.isPortListening(port)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }, 20_000);
});
