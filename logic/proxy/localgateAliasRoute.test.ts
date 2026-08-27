import { describe, expect, it } from "vitest";
import { LocalgateAliasRoute } from "./localgateAliasRoute.ts";
import { LocalgateRegistry } from "./localgateRegistry.ts";
import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";

describe("LocalgateAliasRoute", () =>
{
  const machine: LocalgateMachineSettings = {
    label: "dev",
    baseDomain: "example.com",
    lanIp: "192.0.2.10",
    publicPrefix: null,
    autoRestart: false,
    proxyPort: null
  };

  it("registers a local-only name when the machine has no config", () =>
  {
    expect(LocalgateAliasRoute.registration("myapp", 8_001, null)).toEqual({
      names: ["myapp.localhost"],
      port: 8_001,
      kind: "alias",
      mode: "local",
      cwd: null,
      command: null,
      controlUrl: null,
      runnerPid: null,
      childPid: null,
      debuggerAttached: false
    });
  });

  it("adds the LAN name when the machine has a config", () =>
  {
    const registration = LocalgateAliasRoute.registration("cms", 8_002, machine);

    expect(registration.names).toEqual(["cms.localhost", "cms.dev.example.com"]);
    expect(registration.mode).toBe("lan");
  });

  it("registers into a table as a route the proxy can answer from", () =>
  {
    const registry = new LocalgateRegistry();
    const route = registry.register(LocalgateAliasRoute.registration("myapp", 8_001, null), "2026-08-27T10:00:00.000Z");

    expect(route.kind).toBe("alias");
    expect(route.state).toBe("starting");
    expect(registry.byHostname("myapp.localhost", "loopback")).toBe(route);
  });

  // This is the step that fixes a lost alias, so it is the step that must not be able to rot quietly.
  it("replays persisted intent into an empty table and reports each name", () =>
  {
    const registry = new LocalgateRegistry();

    const restored = LocalgateAliasRoute.restore(
      registry,
      [{ name: "myapp", port: 8_001 }, { name: "cms", port: 8_002 }],
      machine,
      "2026-08-27T10:00:00.000Z"
    );

    expect(registry.all()).toHaveLength(2);
    expect(registry.byHostname("cms.dev.example.com", "lan")?.port).toBe(8_002);
    // A non-empty table is what stops the fresh proxy exiting as idle before anything asks for a name.
    expect(registry.isEmpty()).toBe(false);
    expect(restored).toEqual([
      "localgate: restored alias myapp -> 127.0.0.1:8001",
      "localgate: restored alias cms -> 127.0.0.1:8002"
    ]);
  });

  it("keeps the last row when a hand-edited file repeats a name, and does nothing with no aliases", () =>
  {
    const registry = new LocalgateRegistry();

    LocalgateAliasRoute.restore(registry,
      [{ name: "myapp", port: 8_001 }, { name: "myapp", port: 8_003 }], null, "2026-08-27T10:00:00.000Z");

    expect(registry.all()).toHaveLength(1);
    expect(registry.byName("myapp")?.port).toBe(8_003);

    const empty = new LocalgateRegistry();
    expect(LocalgateAliasRoute.restore(empty, [], null, "2026-08-27T10:00:00.000Z")).toEqual([]);
    expect(empty.isEmpty()).toBe(true);
  });
});
