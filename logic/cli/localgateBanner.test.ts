import { describe, expect, it } from "vitest";
import type { LocalgateRoute } from "../proxy/localgateRegistry.ts";
import { LocalgateBanner } from "./localgateBanner.ts";

describe("LocalgateBanner", () =>
{
  const route = (patch: Partial<LocalgateRoute>): LocalgateRoute => ({
    id: "r1",
    names: ["myapp.localhost", "myapp.dev.example.com"],
    port: 54_624,
    kind: "app",
    mode: "lan",
    cwd: "C:\\projects\\myapp",
    command: "npm run dev",
    controlUrl: "http://127.0.0.1:52000",
    runnerPid: 100,
    childPid: 200,
    debuggerAttached: false,
    startedAt: "2026-08-12T09:04:11.000Z",
    state: "healthy",
    lastResponseAt: null,
    ...patch
  });

  it("stacks the shared name above the local one and closes with the command to type next", () =>
  {
    const text = LocalgateBanner.render(route({}), 80);
    const lines = text.split("\n");
    const shared = lines.findIndex(line => line.includes("shared"));
    const local = lines.findIndex(line => line.includes("local "));

    expect(shared).toBeGreaterThan(0);
    expect(local).toBeGreaterThan(shared);
    expect(text).toContain("localgate   myapp   ·   mode lan");
    expect(text).toContain("http://myapp.dev.example.com");
    expect(text).toContain("upstream   127.0.0.1:54624");
    expect(text).toContain("restart    localgate restart");
  });

  // On Linux and macOS the proxy cannot have 80, so every address it prints has to carry the port it
  // actually answers on - a banner that says otherwise sends the reader somewhere empty.
  it("writes the port into both addresses when the proxy is not on 80", () =>
  {
    const text = LocalgateBanner.render(route({}), 8_080);

    expect(text).toContain("http://myapp.dev.example.com:8080");
    expect(text).toContain("http://myapp.localhost:8080");
  });

  it("shows one address in mode local, where no shared name exists", () =>
  {
    const text = LocalgateBanner.render(route({ names: ["tool.localhost"], mode: "local", port: 41_000 }), 80);

    expect(text).not.toContain("shared");
    expect(text).toContain("http://tool.localhost");
    expect(text).toContain("mode local");
  });

  // An alias used to announce itself in one line, which is why the scripts that register one printed their
  // own `.localhost` block and never mentioned the shared name at all.
  it("gives an alias the same shape, and the command that puts it back rather than a restart", () =>
  {
    const text = LocalgateBanner.render(route({
      names: ["cms.localhost", "cms.dev.example.com"],
      port: 8_002,
      kind: "alias",
      controlUrl: null,
      runnerPid: null,
      childPid: null
    }), 80);

    expect(text).toContain("localgate   cms   ·   alias   ·   mode lan");
    expect(text).toContain("http://cms.dev.example.com");
    expect(text).toContain("upstream   127.0.0.1:8002");
    expect(text).toContain("re-add     localgate alias cms 8002");
    expect(text).not.toContain("localgate restart");
  });

  // The alignment is the whole reason this lives in one place: a caller that hand-pads its own line is a
  // caller that can drift.
  it("aligns every value into the same column, whatever the label length", () =>
  {
    const columns = LocalgateBanner.render(route({}), 80)
      .split("\n")
      .filter(line => /^ {4}\S/.test(line))
      .map(line => line.indexOf(line.trim().split(/\s{2,}/)[1]));

    expect(new Set(columns).size).toBe(1);
  });
});
