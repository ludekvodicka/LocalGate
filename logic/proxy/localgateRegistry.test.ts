import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { LocalgateRegistry, LocalgateRouteConflictError, type LocalgateRouteRegistration } from "./localgateRegistry.ts";

describe("LocalgateRegistry", () =>
{
  const now = "2026-08-11T10:00:00.000Z";

  // Only the tests below that actually resolve a directory need a real one: `path` reads `C:\projects`
  // on Linux as a relative segment with a colon in it, not as a root. Everywhere else the cwd is opaque
  // data and stays as written.
  const windows = process.platform == "win32";
  const projectDir = (...parts: string[]) => [windows ? "C:\\projects" : "/projects", ...parts]
    .join(windows ? "\\" : "/");

  const app = (names: string[], cwd: string | null, port = 41000): LocalgateRouteRegistration => ({
    names,
    port,
    kind: "app",
    mode: "lan",
    cwd,
    command: "npm run dev",
    controlUrl: "http://127.0.0.1:52000",
    runnerPid: 100,
    childPid: 200,
    debuggerAttached: false
  });

  const alias = (names: string[], port: number): LocalgateRouteRegistration => ({
    names,
    port,
    kind: "alias",
    mode: "local",
    cwd: null,
    command: null,
    controlUrl: null,
    runnerPid: null,
    childPid: null,
    debuggerAttached: false
  });

  it("registers a route as starting", () =>
  {
    const registry = new LocalgateRegistry();
    const route = registry.register(app(["web.localhost", "web.dev.example.com"], "C:\\projects\\web"), now);

    expect(route.id).toBe("r1");
    expect(route.state).toBe("starting");
    expect(route.startedAt).toBe(now);
    expect(registry.all()).toHaveLength(1);
  });

  it("refuses a route with no name", () =>
  {
    const registry = new LocalgateRegistry();
    expect(() => registry.register(app([], null), now)).toThrow(/at least one name/);
  });

  it("lets a runner re-register its own name, which is how the heartbeat survives a proxy restart", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["web.localhost"], "C:\\projects\\web", 41000), now);
    const second = registry.register(app(["web.localhost"], "C:\\projects\\web", 41001), now);

    expect(registry.all()).toHaveLength(1);
    expect(registry.byHostname("web.localhost", "loopback")?.port).toBe(41001);
    expect(registry.byId(second.id)?.port).toBe(41001);
  });

  // Silently handing the name over left the old runner holding its port with nothing pointing at it:
  // unreachable by name, and invisible to stop, restart and status.
  it("refuses to take a name away from another live runner", () =>
  {
    const registry = new LocalgateRegistry();
    const first = registry.register(app(["web.localhost"], "C:\\projects\\web", 41000), now);

    expect(() => registry.register({ ...app(["web.localhost"], "C:\\projects\\web", 41001), runnerPid: 999 }, now))
      .toThrow(LocalgateRouteConflictError);

    expect(registry.all()).toHaveLength(1);
    expect(registry.byId(first.id)?.port).toBe(41000);
  });

  it("carries the route it collided with, so the caller can name the process that holds it", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["web.localhost"], "C:\\projects\\web", 41000), now);

    try
    {
      registry.register({ ...app(["web.localhost"], "C:\\projects\\web", 41001), runnerPid: 999 }, now);
      expect.fail("expected a conflict");
    }
    catch (error)
    {
      expect(error).toBeInstanceOf(LocalgateRouteConflictError);
      expect((error as LocalgateRouteConflictError).existing.port).toBe(41000);
    }
  });

  it("replaces an alias freely, since an alias owns no process to orphan", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(alias(["wagtail.localhost"], 8002), now);
    registry.register(alias(["wagtail.localhost"], 8003), now);

    expect(registry.all()).toHaveLength(1);
    expect(registry.byHostname("wagtail.localhost", "loopback")?.port).toBe(8003);
  });

  it("refuses an alias that would shadow a running dev server", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["web.localhost"], "C:\\projects\\web", 41000), now);

    expect(() => registry.register(alias(["web.localhost"], 8002), now))
      .toThrow(LocalgateRouteConflictError);
  });

  it("matches a hostname exactly, ignoring the port and the case", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["web.localhost", "web.dev.example.com"], "C:\\projects\\web"), now);

    expect(registry.byHostname("WEB.localhost:80", "loopback")?.names[0]).toBe("web.localhost");
    expect(registry.byHostname("web.dev.example.com", "loopback")?.names[0]).toBe("web.localhost");
    expect(registry.byHostname("other.localhost", "loopback")).toBe(null);
  });

  it("falls back to a parent-domain match", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["web.localhost"], "C:\\projects\\web"), now);

    expect(registry.byHostname("preview.web.localhost", "loopback")?.names[0]).toBe("web.localhost");
  });

  it("never answers a .localhost name off this machine, parent-domain matches included", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["web.localhost", "web.dev.example.com"], "C:\\projects\\web"), now);

    expect(registry.byHostname("web.localhost", "lan")).toBe(null);
    expect(registry.byHostname("preview.web.localhost", "lan")).toBe(null);
    expect(registry.byHostname("web.dev.example.com", "lan")?.names[0]).toBe("web.localhost");
  });

  it("keeps a local-mode route off the LAN even though it is in the same table", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register({ ...app(["web.localhost"], "C:\\projects\\web"), mode: "local" }, now);

    expect(registry.byHostname("web.localhost", "lan")).toBe(null);
    expect(registry.byHostname("web.localhost", "loopback")?.port).toBe(41000);
  });

  it("finds a route by the short app name a person types", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["myapp.localhost"], "C:\\projects\\web"), now);

    expect(registry.byName("myapp")?.port).toBe(41000);
    expect(registry.byName("web")).toBe(null);
  });

  it("resolves the route owning a directory, including from a nested path", () =>
  {
    const registry = new LocalgateRegistry();
    const route = registry.register(app(["web.localhost"], projectDir("web")), now);

    expect(registry.byDirectory(projectDir("web"))?.id).toBe(route.id);
    expect(registry.byDirectory(join(projectDir("web"), "app", "blog"))?.id).toBe(route.id);
    expect(registry.byDirectory(projectDir("other"))).toBe(null);
  });

  // `relative` between two drives has no relative form and returns the target unchanged, so the
  // "does not start with .." test alone said yes: every route on one drive owned every directory on
  // the other, and `run` there offered to take over an unrelated app.
  // Drives are a Windows idea, and so is the bug: elsewhere there is no second root for a path to be
  // wrongly resolved into.
  it.runIf(windows)("never resolves a directory on another drive", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["web.localhost"], "Q:\\projects\\web"), now);

    expect(registry.byDirectory("C:\\projects\\other")).toBe(null);
    expect(registry.byDirectory("C:\\")).toBe(null);
    expect(registry.byDirectory("Q:\\projects\\web\\app")?.names[0]).toBe("web.localhost");
  });

  it("prefers the deepest owner when projects are nested", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(app(["outer.localhost"], projectDir(), 41000), now);
    const inner = registry.register(app(["inner.localhost"], projectDir("web"), 41001), now);

    expect(registry.byDirectory(projectDir("web", "app"))?.id).toBe(inner.id);
  });

  it("never resolves an alias by directory, because an alias owns no working copy", () =>
  {
    const registry = new LocalgateRegistry();
    registry.register(alias(["wagtail.localhost"], 8002), now);

    expect(registry.byHostname("wagtail.localhost", "loopback")?.port).toBe(8002);
    expect(registry.byDirectory("C:\\projects\\web")).toBe(null);
  });

  it("patches mutable state and reports emptiness for the proxy's self-exit", () =>
  {
    const registry = new LocalgateRegistry();
    const route = registry.register(app(["web.localhost"], "C:\\projects\\web"), now);

    registry.update(route.id, { state: "healthy", lastResponseAt: now });
    expect(registry.byId(route.id)?.state).toBe("healthy");
    expect(registry.isEmpty()).toBe(false);

    registry.remove(route.id);
    expect(registry.isEmpty()).toBe(true);
    expect(() => registry.update(route.id, { state: "dead" })).toThrow(/unknown route/);
  });
});
