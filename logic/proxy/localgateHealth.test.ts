import { describe, expect, it } from "vitest";
import { LocalgateAliasRoute } from "./localgateAliasRoute.ts";
import { LocalgateHealth } from "./localgateHealth.ts";
import { LocalgateRegistry, type LocalgateRoute } from "./localgateRegistry.ts";

describe("LocalgateHealth", () =>
{
  const setup = (options: { autoRestart?: boolean; debuggerAttached?: boolean } = {}) =>
  {
    const registry = new LocalgateRegistry();
    const route = registry.register({
      names: ["web.localhost", "web.dev.example.com"],
      port: 41000,
      kind: "app",
      mode: "lan",
      cwd: "C:\\projects\\web",
      command: "npm run dev",
      controlUrl: "http://127.0.0.1:52000",
      runnerPid: 100,
      childPid: 200,
      debuggerAttached: options.debuggerAttached === true
    }, new Date(0).toISOString());

    const restarted: string[] = [];
    let clock = 1_000;
    const health = new LocalgateHealth(
      registry,
      options.autoRestart === true,
      async (target: LocalgateRoute) => { restarted.push(target.id); },
      () => clock
    );

    const alias = registry.register(LocalgateAliasRoute.registration("cms", 8_002, {
      label: "dev",
      baseDomain: "example.com",
      lanIp: "192.0.2.10",
      publicPrefix: null,
      autoRestart: false,
      proxyPort: null
    }), new Date(0).toISOString());

    return { registry, route, alias, health, restarted, advance: (ms: number) => { clock += ms; }, state: () => registry.byId(route.id)!.state };
  };

  it("marks a route healthy on a response and records when", () =>
  {
    const { health, route, registry, state } = setup();
    health.noteSuccess(route);

    expect(state()).toBe("healthy");
    expect(registry.byId(route.id)?.lastResponseAt).toBe(new Date(1_000).toISOString());
  });

  it("needs three consecutive timeouts before calling a route unresponsive", () =>
  {
    const { health, route, state } = setup();

    health.noteTimeout(route);
    expect(state()).toBe("starting");
    health.noteTimeout(route);
    expect(state()).toBe("starting");
    health.noteTimeout(route);
    expect(state()).toBe("unresponsive");
  });

  it("forgets earlier timeouts once a request succeeds, so a slow first compile is not a wedge", () =>
  {
    const { health, route, state } = setup();

    health.noteTimeout(route);
    health.noteTimeout(route);
    health.noteSuccess(route);
    health.noteTimeout(route);

    expect(state()).toBe("healthy");
  });

  it("treats a refused connection as starting inside the grace window and dead after it", () =>
  {
    const { health, route, state, advance } = setup();

    health.noteConnectionRefused(route);
    expect(state()).toBe("starting");

    advance(120_000);
    health.noteConnectionRefused(route);
    expect(state()).toBe("dead");
  });

  it("never restarts automatically when the machine has not asked for it", () =>
  {
    const { health, route, restarted, state } = setup({ autoRestart: false });

    for (let attempt = 0; attempt < 3; attempt++) health.noteTimeout(route);

    expect(state()).toBe("unresponsive");
    expect(restarted).toEqual([]);
  });

  it("never restarts automatically while a debugger is attached, even when enabled", () =>
  {
    const { health, route, restarted, state } = setup({ autoRestart: true, debuggerAttached: true });

    for (let attempt = 0; attempt < 3; attempt++) health.noteTimeout(route);

    expect(state()).toBe("unresponsive");
    expect(restarted).toEqual([]);
  });

  it("restarts once when enabled, then holds off for the cooldown", () =>
  {
    const { health, route, restarted, advance } = setup({ autoRestart: true });

    for (let attempt = 0; attempt < 3; attempt++) health.noteTimeout(route);
    expect(restarted).toHaveLength(1);

    advance(60_000);
    for (let attempt = 0; attempt < 3; attempt++) health.noteTimeout(route);
    expect(restarted).toHaveLength(1);
  });

  it("stops trying after the attempt cap, so a broken app cannot become a restart loop", () =>
  {
    const { health, route, restarted, advance } = setup({ autoRestart: true });

    for (let round = 0; round < 5; round++)
    {
      advance(10 * 60_000);
      for (let attempt = 0; attempt < 3; attempt++) health.noteTimeout(route);
    }

    expect(restarted).toHaveLength(2);
  });

  it("tells the reader which command fixes it", () =>
  {
    const { health, route } = setup();

    expect(health.unresponsiveMessage(route)).toContain("localgate restart web");
    expect(health.unresponsiveMessage(route)).toContain("C:\\projects\\web");
    expect(health.deadMessage(route)).toContain("nothing is listening");
    expect(health.deadMessage(route)).toContain("localgate prune");
    expect(health.startingMessage(route)).toContain("still starting");
  });

  it("sends a dead alias to the port it points at, not to an editor or prune", () =>
  {
    const { health, alias } = setup();

    const message = health.deadMessage(alias);

    expect(message).toContain("127.0.0.1:8002");
    expect(message).toContain("localgate alias --remove cms");
    expect(message).not.toContain("prune");
    expect(message).not.toContain("from your editor");
  });

  // `localgate restart` refuses an alias outright, so the wedged page must not send anyone there.
  it("does not offer a restart for a wedged alias", () =>
  {
    const { health, alias } = setup();

    const message = health.unresponsiveMessage(alias);

    expect(message).toContain("127.0.0.1:8002");
    expect(message).toContain("localgate alias --remove cms");
    expect(message).not.toContain("localgate restart");
  });
});
