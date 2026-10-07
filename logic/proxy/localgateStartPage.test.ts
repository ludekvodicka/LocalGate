import { beforeEach, describe, expect, it } from "vitest";
import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import { LocalgateRegistry, type LocalgateRouteRegistration } from "./localgateRegistry.ts";
import { LocalgateStartPage, type LocalgateRouteStopper } from "./localgateStartPage.ts";

describe("LocalgateStartPage", () =>
{
  const machine: LocalgateMachineSettings = {
    label: "dev",
    baseDomain: "example.com",
    lanIp: "192.0.2.10",
    publicPrefix: "pub",
    autoRestart: false,
    proxyPort: null
  };

  const registration = (names: string[], patch: Partial<LocalgateRouteRegistration> = {}): LocalgateRouteRegistration => ({
    names,
    port: 41_000,
    kind: "app",
    mode: "lan",
    cwd: "C:\\projects\\myapp",
    command: "npm run dev",
    controlUrl: "http://127.0.0.1:52000",
    runnerPid: 100,
    childPid: 200,
    debuggerAttached: false,
    ...patch
  });

  // What the page asked to end, in the order it asked. The page itself dials nothing and runs nothing.
  const stopped: string[] = [];
  // What this machine knows how to stop besides its own dev servers, as the alias file would say.
  const aliasStops = new Map<string, string>();

  const stopper: LocalgateRouteStopper = {
    aliasStopCommands: () => aliasStops,
    stop: async route => { stopped.push(route.names[0]!); }
  };

  beforeEach(() => { stopped.length = 0; aliasStops.clear(); });

  const registryWith = (...registrations: LocalgateRouteRegistration[]): LocalgateRegistry =>
  {
    const registry = new LocalgateRegistry();
    for (const entry of registrations) registry.register(entry, "2026-09-15T08:00:00.000Z");
    return registry;
  };

  const pageWith = (...registrations: LocalgateRouteRegistration[]): LocalgateStartPage =>
    new LocalgateStartPage(registryWith(...registrations), machine, 80, stopper);

  it("answers on its own name from this machine, and on no other name", () =>
  {
    const page = pageWith();

    expect(page.handles("start.localhost", "loopback")).toBe(true);
    expect(page.handles("start.localhost:8080", "loopback")).toBe(true);
    expect(page.handles("START.localhost", "loopback")).toBe(true);
    expect(page.handles("myapp.localhost", "loopback")).toBe(false);
    expect(page.handles("", "loopback")).toBe(false);
  });

  // `.localhost` means the machine that resolved it, so off this machine the page has to be asked for by
  // the machine's own name - and that name must not be answered with the local one's contents either.
  it("answers the shared name on both listeners and the local name only on loopback", () =>
  {
    const page = pageWith();

    expect(page.handles("start.dev.example.com", "lan")).toBe(true);
    expect(page.handles("start.dev.example.com", "loopback")).toBe(true);
    expect(page.handles("start.localhost", "lan")).toBe(false);
  });

  it("has no shared name on a machine with no config", () =>
  {
    const page = new LocalgateStartPage(new LocalgateRegistry(), null, 80, stopper);

    expect(page.handles("start.localhost", "loopback")).toBe(true);
    expect(page.handles("start.dev.example.com", "lan")).toBe(false);
  });

  it("lists every route with both addresses, and where it runs, on loopback", () =>
  {
    const html = pageWith(registration(["myapp.localhost", "myapp.dev.example.com"])).render("loopback");

    expect(html).toContain("http://myapp.localhost");
    expect(html).toContain("http://myapp.dev.example.com");
    expect(html).toContain("127.0.0.1:41000");
    expect(html).toContain("npm run dev");
    expect(html).toContain("C:\\projects\\myapp");
  });

  // The whole point of mode `local` is that the app never leaves the machine. Naming it on the LAN page
  // would hand out the inventory the mode exists to keep back, so the route is absent, not just unlinked.
  it("hides a local-mode route from the LAN, with its name and its paths", () =>
  {
    const page = pageWith(
      registration(["tool.localhost"], { mode: "local", cwd: "C:\\projects\\tool", command: "npm run tool" }),
      registration(["myapp.localhost", "myapp.dev.example.com"], { port: 41_001 })
    );

    const html = page.render("lan");

    expect(html).not.toContain("tool");
    expect(html).not.toContain("myapp.localhost");
    expect(html).toContain("http://myapp.dev.example.com");
    expect(html).not.toContain("127.0.0.1:41001");
    expect(html).not.toContain("C:\\projects\\myapp");
  });

  // On Linux and macOS the proxy is on 8080, which every local address has to carry - while the public
  // one arrives through a tunnel on 443 and must never be written with the proxy's internal port.
  it("writes the public address with https and without the proxy's port", () =>
  {
    const registry = registryWith(registration(["shop.localhost", "shop.dev.example.com", "pub-shop.example.com"],
      { mode: "internet" }));

    const html = new LocalgateStartPage(registry, machine, 8_080, stopper).render("loopback");

    expect(html).toContain("http://shop.localhost:8080");
    expect(html).toContain("http://shop.dev.example.com:8080");
    expect(html).toContain("https://pub-shop.example.com");
    expect(html).not.toContain("pub-shop.example.com:8080");
  });

  // The card is one click target, and the address behind it has to be the one the reader can open from
  // where they are: the local name on this machine, the shared name off it.
  it("puts the address this listener can reach behind the card itself", () =>
  {
    const page = pageWith(registration(["myapp.localhost", "myapp.dev.example.com"]));

    expect(page.render("loopback")).toContain("class=\"name\" href=\"http://myapp.localhost\"");
    expect(page.render("lan")).toContain("class=\"name\" href=\"http://myapp.dev.example.com\"");
  });

  // Stopping is process control: it belongs to the machine's own listener, and an alias points at a
  // process localgate never started, so on its own there is nothing it can ask.
  it("offers the stop button only for an app, and only on this machine", () =>
  {
    const page = pageWith(
      registration(["myapp.localhost", "myapp.dev.example.com"]),
      registration(["database.localhost", "database.dev.example.com"],
        { kind: "alias", controlUrl: null, cwd: null, command: null, port: 8_001 })
    );

    const loopback = page.render("loopback");
    expect(loopback).toContain("href=\"/?confirm=myapp\"");
    expect(loopback).not.toContain("href=\"/?confirm=database\"");
    expect(page.render("lan")).not.toContain("confirm=");
  });

  // Unless the machine's owner wrote down how. Then the alias gets the same two steps, and the question
  // names the command, because a click that runs a shell line should say which one.
  it("gives an alias a stop button once the machine says how to stop it", () =>
  {
    const alias = registration(["database.localhost", "database.dev.example.com"],
      { kind: "alias", controlUrl: null, cwd: null, command: null, port: 8_001 });
    aliasStops.set("database", "docker stop database");

    const page = pageWith(alias);

    expect(page.render("loopback")).toContain("href=\"/?confirm=database\"");
    expect(page.render("loopback", { confirming: "database" }))
      .toContain("localgate runs: docker stop database");
    // Still nothing off this machine: the file says how, not who may.
    expect(page.render("lan")).not.toContain("confirm=");
  });

  it("asks before it stops, and stops being one big link while it asks", () =>
  {
    const page = pageWith(
      registration(["myapp.localhost", "myapp.dev.example.com"]),
      registration(["other.localhost"], { port: 41_001 })
    );

    const html = page.render("loopback", { confirming: "myapp" });

    expect(html).toContain("action=\"/stop?name=myapp\"");
    expect(html).toContain("yes, stop it");
    expect(html).not.toContain("class=\"name\" href=\"http://myapp.localhost\"");
    // The question is about one card; everything else on the page still works as it did.
    expect(html).toContain("class=\"name\" href=\"http://other.localhost\"");
    // A list that reloads under an unanswered question would answer it for the reader.
    expect(html).not.toContain("http-equiv=\"refresh\"");
  });

  // The state the proxy keeps is learned from forwarded traffic, so a route nobody has opened since it
  // registered sits at "starting" whatever is true of it. The page asks the port instead.
  it("says what is actually on the port, not what the untouched route still claims", () =>
  {
    const registry = registryWith(
      registration(["up.localhost"]),
      registration(["down.localhost"], { port: 41_001 })
    );
    const [up, down] = registry.all();
    const page = new LocalgateStartPage(registry, machine, 80, stopper);

    const html = page.render("loopback", { listening: new Map([[up!.id, true], [down!.id, false]]) });

    expect(html).toContain(">running<");
    expect(html).toContain(">not running<");
    expect(html).toContain("class=\"card down\"");
  });

  // A dev server binds its port a moment after launch, and saying "not running" in that moment would
  // send the reader looking for a fault that is not there.
  it("keeps calling a just-launched app starting while its port is still silent", () =>
  {
    const registry = new LocalgateRegistry();
    const fresh = registry.register(registration(["myapp.localhost"]), new Date().toISOString());
    const old = registry.register(registration(["stale.localhost"], { port: 41_001 }), "2020-01-01T00:00:00.000Z");
    const page = new LocalgateStartPage(registry, machine, 80, stopper);

    const html = page.render("loopback", { listening: new Map([[fresh.id, false], [old.id, false]]) });

    expect(html).toContain(">starting<");
    expect(html).toContain(">not running<");
  });

  // An alias points at a container somebody else starts, so there is no launch to wait for, and the way
  // to be rid of the row belongs on the row.
  it("calls a silent alias not running at once, and says how to forget it", () =>
  {
    const registry = new LocalgateRegistry();
    const alias = registry.register(registration(["database.localhost"],
      { kind: "alias", controlUrl: null, cwd: null, command: null, port: 8_001 }), new Date().toISOString());
    const page = new LocalgateStartPage(registry, machine, 80, stopper);

    const html = page.render("loopback", { listening: new Map([[alias.id, false]]) });

    expect(html).toContain(">not running<");
    expect(html).not.toContain(">starting<");
    expect(html).toContain("localgate alias --remove database");
  });

  // A port that accepts connections while every request times out is wedged, and the probe cannot see
  // that - only the forwarded traffic can.
  it("keeps the wedged verdict the forwarded traffic reached", () =>
  {
    const registry = registryWith(registration(["myapp.localhost"]));
    const route = registry.all()[0]!;
    registry.update(route.id, { state: "unresponsive" });
    const page = new LocalgateStartPage(registry, machine, 80, stopper);

    expect(page.render("loopback", { listening: new Map([[route.id, true]]) })).toContain(">not responding<");
  });

  it("orders the routes by name, so a restarted app keeps its place", () =>
  {
    const html = pageWith(
      registration(["zeta.localhost"]),
      registration(["alpha.localhost"], { port: 41_001 })
    ).render("loopback");

    expect(html.indexOf("alpha")).toBeLessThan(html.indexOf("zeta"));
  });

  it("says what to type when nothing is running", () =>
  {
    expect(pageWith().render("loopback")).toContain("localgate run npm run dev");
  });

  // A command line is whatever was typed to start the dev server, and it is printed into a page.
  it("escapes what a route carries into the page", () =>
  {
    const html = pageWith(registration(["myapp.localhost"], { command: "npm run dev <script>alert(1)</script>" }))
      .render("loopback");

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("writes its own address with the port the proxy answers on", () =>
  {
    expect(LocalgateStartPage.localUrl(80)).toBe("http://start.localhost");
    expect(LocalgateStartPage.localUrl(8_080)).toBe("http://start.localhost:8080");
  });
});
