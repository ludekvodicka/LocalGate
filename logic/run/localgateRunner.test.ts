import { describe, expect, it } from "vitest";
import type { LocalgateRoute } from "../proxy/localgateRegistry.ts";
import { LocalgateRunner } from "./localgateRunner.ts";

describe("LocalgateRunner", () =>
{
  describe("withPortFlag", () =>
  {
    const scripts = { dev: "next dev", start: "node app.js" };

    it("appends the framework flag for a Next dev script", () =>
    {
      expect(LocalgateRunner.withPortFlag(["npm", "run", "dev"], scripts, 41277))
        .toEqual(["npm", "run", "dev", "--", "-p", "41277"]);
    });

    it("leaves a non-Next script alone, where PORT is the whole mechanism", () =>
    {
      expect(LocalgateRunner.withPortFlag(["npm", "run", "start"], scripts, 41277))
        .toEqual(["npm", "run", "start"]);
    });

    it("leaves a direct command alone", () =>
    {
      expect(LocalgateRunner.withPortFlag(["node", "app.js"], scripts, 41277))
        .toEqual(["node", "app.js"]);
    });

    it("leaves an unknown script name alone", () =>
    {
      expect(LocalgateRunner.withPortFlag(["npm", "run", "nope"], scripts, 41277))
        .toEqual(["npm", "run", "nope"]);
    });

    it("works for pnpm too", () =>
    {
      expect(LocalgateRunner.withPortFlag(["pnpm", "run", "dev"], scripts, 41277))
        .toEqual(["pnpm", "run", "dev", "--", "-p", "41277"]);
    });
  });

  describe("debuggerAttached", () =>
  {
    it("sees the editor's auto-attach bootloader, which is why the automatic restart holds off", () =>
    {
      expect(LocalgateRunner.debuggerAttached({
        NODE_OPTIONS: '--require "c:\\Users\\x\\.vscode\\extensions\\ms-vscode.js-debug\\src\\bootloader.js"'
      })).toBe(true);
    });

    it("reports no debugger for a plain terminal run", () =>
    {
      expect(LocalgateRunner.debuggerAttached({})).toBe(false);
      expect(LocalgateRunner.debuggerAttached({ NODE_OPTIONS: "--max-old-space-size=4096" })).toBe(false);
    });
  });

  describe("banner", () =>
  {
    it("stacks the shared name above the local one and names the restart command", () =>
    {
      const text = LocalgateRunner.banner("myapp", "lan", [
        "myapp.localhost",
        "myapp.dev.example.com"
      ], 54_624);

      const lines = text.split("\n");
      const shared = lines.findIndex(line => line.includes("shared"));
      const local = lines.findIndex(line => line.includes("local "));

      expect(shared).toBeGreaterThan(0);
      expect(local).toBeGreaterThan(shared);
      expect(text).toContain("http://myapp.dev.example.com");
      expect(text).toContain("upstream   127.0.0.1:54624");
      expect(text).toContain("localgate restart");
      expect(text).toContain("mode lan");
    });

    it("shows one address in mode local, where no shared name exists", () =>
    {
      const text = LocalgateRunner.banner("tool", "local", ["tool.localhost"], 41_000);

      expect(text).not.toContain("shared");
      expect(text).toContain("http://tool.localhost");
    });
  });

  describe("parseOptions", () =>
  {
    it("takes a leading --force and leaves the command alone", () =>
    {
      expect(LocalgateRunner.parseOptions(["--force", "npm", "run", "dev"]))
        .toEqual({ force: true, command: ["npm", "run", "dev"] });
    });

    it("defaults to asking", () =>
    {
      expect(LocalgateRunner.parseOptions(["npm", "run", "dev"]))
        .toEqual({ force: false, command: ["npm", "run", "dev"] });
    });

    it("leaves a --force meant for the child where it belongs", () =>
    {
      expect(LocalgateRunner.parseOptions(["npm", "run", "dev", "--", "--force"]))
        .toEqual({ force: false, command: ["npm", "run", "dev", "--", "--force"] });
    });

    it("handles an empty command, which run() reports on its own", () =>
    {
      expect(LocalgateRunner.parseOptions([])).toEqual({ force: false, command: [] });
    });
  });

  describe("describeRunning", () =>
  {
    const route: LocalgateRoute = {
      id: "r1",
      names: ["myapp.localhost", "myapp.dev.example.com"],
      port: 54_382,
      kind: "app",
      mode: "lan",
      cwd: "C:\\projects\\myapp",
      command: "npm run dev",
      controlUrl: "http://127.0.0.1:52000",
      runnerPid: 45_568,
      childPid: 4_544,
      debuggerAttached: false,
      startedAt: "2026-08-12T09:04:11.000Z",
      state: "healthy",
      lastResponseAt: null
    };

    it("names the app, its command and both pids, so the owner recognises what is about to die", () =>
    {
      const text = LocalgateRunner.describeRunning(route);

      expect(text).toContain("myapp.localhost is already running");
      expect(text).toContain("command    npm run dev");
      expect(text).toContain("upstream   127.0.0.1:54382");
      expect(text).toContain("started    2026-08-12 09:04:11");
      expect(text).toContain("runner 45568, child 4544");
      expect(text).not.toContain("debugger");
    });

    it("calls out an attached debugger, which is a session and not just a process", () =>
    {
      expect(LocalgateRunner.describeRunning({ ...route, debuggerAttached: true }))
        .toContain("debugger   attached");
    });
  });

  describe("shellCommand", () =>
  {
    it("joins the command into one string and quotes only what needs it", () =>
    {
      expect(LocalgateRunner.shellCommand(["npm", "run", "dev", "--", "-p", "54624"]))
        .toBe("npm run dev -- -p 54624");
      expect(LocalgateRunner.shellCommand(["node", "my script.js"]))
        .toBe('node "my script.js"');
    });
  });

  it("hands out a port that is actually free", async () =>
  {
    const port = await LocalgateRunner.freePort();
    expect(port).toBeGreaterThan(1_023);

    const second = await LocalgateRunner.freePort();
    expect(second).toBeGreaterThan(1_023);
  });
});
