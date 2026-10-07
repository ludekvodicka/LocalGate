import { afterEach, describe, expect, it } from "vitest";
import { LocalgateRunnerControl } from "../run/localgateRunnerControl.ts";
import { LocalgateProxyHost } from "./localgateProxyHost.ts";
import type { LocalgateRoute } from "./localgateRegistry.ts";

describe("LocalgateProxyHost", () =>
{
  const opened: LocalgateRunnerControl[] = [];

  // A real runner endpoint rather than a stubbed fetch, because the body this is about is written on
  // one side of that socket and read on the other: a test that wrote it itself would prove nothing.
  const runnerRefusing = async (reason: string | null): Promise<LocalgateRoute> =>
  {
    const control = new LocalgateRunnerControl({
      routeId: () => "r1",
      logs: () => [],
      restart: () => Promise.reject(new Error(reason ?? "")),
      stop: () => reason === null ? Promise.resolve() : Promise.reject(new Error(reason)),
      stopped: () => {}
    });

    const url = await control.start();
    opened.push(control);

    return {
      id: "r1",
      names: ["myapp.localhost"],
      port: 41_000,
      kind: "app",
      mode: "lan",
      cwd: null,
      command: "npm run dev",
      controlUrl: url,
      runnerPid: 100,
      childPid: 200,
      debuggerAttached: false,
      startedAt: "2026-09-15T08:00:00.000Z",
      state: "healthy",
      lastResponseAt: null
    };
  };

  afterEach(async () =>
  {
    for (const control of opened.splice(0)) await control.close();
  });

  // The regression this guards: the status code arrived on its own, so the start page said "could not be
  // stopped: control endpoint answered 409" and the reader had to open a terminal to learn why.
  it("reports a refused stop with the reason the runner gave, not the status alone", async () =>
  {
    const failure = "myapp.localhost still answers on 127.0.0.1:41000 after killing 41188"
      + " (taskkill /T /F /PID 41188: Access is denied.) - it was not stopped";

    await expect(LocalgateProxyHost.stop(await runnerRefusing(failure)))
      .rejects.toThrow(`control endpoint answered 409: Error: ${failure}`);
  });

  it("asks the runner and reports nothing when the stop worked", async () =>
  {
    await expect(LocalgateProxyHost.stop(await runnerRefusing(null))).resolves.toBeUndefined();
  });
});
