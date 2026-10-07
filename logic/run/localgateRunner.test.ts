import { describe, expect, it } from "vitest";
import type { LocalgateRoute } from "../proxy/localgateRegistry.ts";
import { LocalgateRunner } from "./localgateRunner.ts";

describe("LocalgateRunner", () =>
{
  describe("withPortFlag", () =>
  {
    const scripts = { dev: "next dev", start: "node app.js" };

    it.each(["npm", "npm.cmd"])("appends the framework flag after the %s separator", runner =>
    {
      expect(LocalgateRunner.withPortFlag([runner, "run", "dev"], scripts, 41277))
        .toEqual([runner, "run", "dev", "--", "-p", "41277"]);
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

    it.each(["pnpm", "pnpm.cmd"])("passes the framework flag directly through %s", runner =>
    {
      expect(LocalgateRunner.withPortFlag([runner, "run", "dev"], scripts, 41277))
        .toEqual([runner, "run", "dev", "-p", "41277"]);
    });

    it.each(["pnpm", "pnpm.cmd"])("passes the port through a dotenv-wrapped Next script with %s", runner =>
    {
      const wrapped = { dev: "dotenv -e .env-development -- next dev" };
      expect(LocalgateRunner.withPortFlag([runner, "run", "dev", "--hostname", "127.0.0.1"], wrapped, 41277))
        .toEqual([runner, "run", "dev", "--hostname", "127.0.0.1", "-p", "41277"]);
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

  describe("parseOptions", () =>
  {
    it("takes a leading --force and leaves the command alone", () =>
    {
      expect(LocalgateRunner.parseOptions(["--force", "npm", "run", "dev"]))
        .toEqual({ force: true, command: ["npm", "run", "dev"] });
    });

    it("defaults to no force", () =>
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

  describe("routeRegistrationMatches", () =>
  {
    const route: LocalgateRoute = {
      id: "r1",
      names: ["myapp.localhost"],
      port: 41_000,
      kind: "app",
      mode: "local",
      cwd: "C:\\projects\\myapp",
      command: "npm run dev",
      controlUrl: "http://127.0.0.1:51000",
      runnerPid: 100,
      childPid: 200,
      debuggerAttached: false,
      startedAt: "2026-08-21T15:00:00.000Z",
      state: "healthy",
      lastResponseAt: null
    };

    it("requires this runner's route, not merely a live proxy", () =>
    {
      expect(LocalgateRunner.routeRegistrationMatches(route, null, 100)).toBe(false);
      expect(LocalgateRunner.routeRegistrationMatches(route, { ...route, runnerPid: 999 }, 100)).toBe(false);
      expect(LocalgateRunner.routeRegistrationMatches(route, { ...route, controlUrl: "http://127.0.0.1:52000" }, 100))
        .toBe(false);
      expect(LocalgateRunner.routeRegistrationMatches(route, route, 100)).toBe(true);
    });
  });

  describe("killFailure", () =>
  {
    const route: LocalgateRoute = {
      id: "r1",
      names: ["myapp.localhost"],
      port: 61_346,
      kind: "app",
      mode: "local",
      cwd: "C:\\projects\\myapp",
      command: "npm run dev",
      controlUrl: "http://127.0.0.1:52000",
      runnerPid: 87_016,
      childPid: 41_188,
      debuggerAttached: false,
      startedAt: "2026-09-10T06:00:00.000Z",
      state: "healthy",
      lastResponseAt: null
    };

    // The regression this guards: the kill was fire-and-forget, so a refused taskkill and a port that
    // stayed bound produced the same silence as a restart that worked, and the route answered success.
    it("refuses the restart and names the port, the pid and what the kill said", () =>
    {
      const failure = LocalgateRunner.killFailure(route, 41_188, {
        released: false,
        errors: ['taskkill /T /F /PID 41188: ERROR: The process "41188" could not be terminated.']
      }, "restarted");

      expect(failure).toContain("myapp.localhost still answers on 127.0.0.1:61346");
      expect(failure).toContain("after killing 41188");
      expect(failure).toContain("could not be terminated");
      expect(failure).toContain("it was not restarted");
    });

    // The same rule decides a stop, and it is the only thing a runner can honestly answer `localgate
    // stop` with: the port is still held, so the dev server was not stopped.
    it("refuses the stop on the same fact, and says so in its own words", () =>
    {
      const failure = LocalgateRunner.killFailure(route, 41_188, {
        released: false,
        errors: ["taskkill /T /F /PID 41188: ERROR: Access is denied."]
      }, "stopped");

      expect(failure).toContain("myapp.localhost still answers on 127.0.0.1:61346");
      expect(failure).toContain("Access is denied");
      expect(failure).toContain("it was not stopped");
    });

    it("passes a released port, which is the only half of a restart this can see", () =>
    {
      expect(LocalgateRunner.killFailure(route, 41_188, { released: true, errors: [] }, "restarted")).toBeNull();
      expect(LocalgateRunner.killFailure(route, 41_188, { released: true, errors: [] }, "stopped")).toBeNull();
    });

    // A first kill that failed and a second that freed the port is still a restart: the port decides.
    it("passes a port that came free despite a kill that failed", () =>
    {
      expect(LocalgateRunner.killFailure(route, 41_188, {
        released: true,
        errors: ["taskkill /T /F /PID 41188: ERROR: The process \"41188\" not found."]
      }, "restarted")).toBeNull();
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
