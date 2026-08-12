import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { LocalgateControlApi } from "./localgateControlApi.ts";
import { LocalgateHealth } from "./localgateHealth.ts";
import { LocalgateProxy } from "./localgateProxy.ts";
import { LocalgateRegistry, type LocalgateRouteRegistration } from "./localgateRegistry.ts";

type Harness = {
  proxy: LocalgateProxy;
  registry: LocalgateRegistry;
  port: number;
  // The second listener, when the harness asked for one. It is a loopback address like the first, so
  // the test binds no real network interface; what differs is the reach the proxy answers it with.
  lanPort: number | null;
  upstreamPort: number;
  idle: () => number;
  stop: () => Promise<void>;
};

describe("LocalgateProxy", () =>
{
  const openHarnesses: Harness[] = [];

  const startUpstream = async (): Promise<{ server: Server; port: number }> =>
  {
    const server = createServer((request, response) =>
    {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () =>
      {
        const body = JSON.stringify({
          url: request.url,
          method: request.method,
          host: request.headers.host,
          origin: request.headers.origin ?? null,
          referer: request.headers.referer ?? null,
          body: Buffer.concat(chunks).toString("utf8")
        });
        response.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
        response.end(body);
      });
    });

    server.on("upgrade", (request, socket) =>
    {
      // Echo once and close from the server side: the assertion only needs the handshake and the payload
      // to survive the hop, and a lingering socket would blur what the teardown is waiting for.
      socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
      socket.end(`origin=${request.headers.origin ?? "none"}`);
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address == "string") throw new Error("no upstream port");
    return { server, port: address.port };
  };

  const startProxy = async (options: { externalSuffix?: string | null; gracePeriodMs?: number; upstreamPort?: number;
    lanIp?: string } = {}): Promise<Harness> =>
  {
    const upstream = options.upstreamPort ? null : await startUpstream();
    const upstreamPort = options.upstreamPort ?? upstream!.port;

    const registry = new LocalgateRegistry();
    let idleCount = 0;
    const health = new LocalgateHealth(registry, false, async () => {});
    const proxy = new LocalgateProxy(registry, health, new LocalgateControlApi(registry, () => proxy.checkIdle()), {
      port: 0,
      lanIp: options.lanIp ?? null,
      externalSuffix: options.externalSuffix ?? null,
      gracePeriodMs: options.gracePeriodMs ?? 50,
      onIdle: () => { idleCount++; }
    });

    await proxy.start();

    const ports = proxy.boundPorts();
    const harness: Harness = {
      proxy,
      registry,
      port: ports[0]!,
      lanPort: ports[1] ?? null,
      upstreamPort,
      idle: () => idleCount,
      stop: async () =>
      {
        await proxy.stop();
        if (upstream)
        {
          upstream.server.closeAllConnections();
          await new Promise<void>(resolve => upstream.server.close(() => resolve()));
        }
      }
    };

    openHarnesses.push(harness);
    return harness;
  };

  const registration = (port: number, names: string[]): LocalgateRouteRegistration => ({
    names,
    port,
    kind: "app",
    mode: "lan",
    cwd: "C:\\projects\\web",
    command: "npm run dev",
    controlUrl: null,
    runnerPid: null,
    childPid: null,
    debuggerAttached: false
  });

  const call = (port: number, path: string, headers: IncomingHttpHeaders, body?: string) =>
    new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>((resolve, reject) =>
    {
      const request = httpRequest({ host: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers: headers as never }, response =>
      {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk as Buffer));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }));
      });
      request.once("error", reject);
      request.end(body);
    });

  // Resolves with everything the proxy answered before the socket closed. A refused upgrade is a close
  // with nothing written, so the empty string is a meaningful result here, not a timeout.
  const upgrade = (port: number, host: string) =>
    new Promise<string>((resolve, reject) =>
    {
      const socket = connect({ host: "127.0.0.1", port }, () =>
      {
        socket.write(
          "GET /_next/webpack-hmr HTTP/1.1\r\n" +
          `Host: ${host}\r\n` +
          `Origin: http://${host}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n"
        );
      });

      let buffer = "";
      const settle = (value: string) =>
      {
        clearTimeout(timer);
        socket.destroy();
        resolve(value);
      };

      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer, got: ${buffer}`)); }, 4_000);
      socket.on("data", chunk =>
      {
        buffer += String(chunk);
        if (buffer.includes("origin=")) settle(buffer);
      });
      socket.once("close", () => settle(buffer));
      socket.once("error", () => settle(buffer));
    });

  afterEach(async () =>
  {
    while (openHarnesses.length > 0) await openHarnesses.pop()!.stop();
  });

  it("routes by Host and forwards method, path, body, status and headers", async () =>
  {
    const harness = await startProxy();
    harness.registry.register(registration(harness.upstreamPort, ["web.localhost"]), new Date().toISOString());

    const result = await call(harness.port, "/api/thing?x=1", { host: "web.localhost" }, "payload");

    expect(result.status).toBe(201);
    expect(result.headers["x-upstream"]).toBe("yes");
    const echoed = JSON.parse(result.text) as Record<string, unknown>;
    expect(echoed.url).toBe("/api/thing?x=1");
    expect(echoed.method).toBe("POST");
    expect(echoed.host).toBe("web.localhost");
    expect(echoed.body).toBe("payload");
  });

  it("maps Origin back to .localhost for Next dev endpoints only", async () =>
  {
    const harness = await startProxy({ externalSuffix: ".dev.example.com" });
    harness.registry.register(registration(harness.upstreamPort, ["web.dev.example.com"]), new Date().toISOString());

    const internal = await call(harness.port, "/_next/static/chunk.js", {
      host: "web.dev.example.com",
      origin: "http://web.dev.example.com"
    });
    expect((JSON.parse(internal.text) as Record<string, unknown>).origin).toBe("http://web.localhost");

    const application = await call(harness.port, "/blog", {
      host: "web.dev.example.com",
      origin: "http://web.dev.example.com"
    });
    expect((JSON.parse(application.text) as Record<string, unknown>).origin).toBe("http://web.dev.example.com");
  });

  it("answers an unknown hostname on loopback with the list of what is running", async () =>
  {
    const harness = await startProxy();
    harness.registry.register(registration(harness.upstreamPort, ["web.localhost"]), new Date().toISOString());

    const result = await call(harness.port, "/", { host: "nothing.localhost" });

    expect(result.status).toBe(404);
    expect(result.text).toContain("nothing is registered");
    expect(result.text).toContain("web.localhost");
  });

  it("reports a refused upstream as still starting rather than as a crash", async () =>
  {
    const harness = await startProxy({ upstreamPort: 1 });
    harness.registry.register(registration(59_999, ["web.localhost"]), new Date().toISOString());

    const result = await call(harness.port, "/", { host: "web.localhost" });

    expect(result.status).toBe(503);
    expect(result.text).toContain("still starting");
    expect(harness.registry.byHostname("web.localhost", "loopback")?.state).toBe("starting");
  });

  it("refuses a .localhost name on the LAN listener and serves the shared one", async () =>
  {
    const harness = await startProxy({ lanIp: "127.0.0.1", externalSuffix: ".dev.example.com" });
    harness.registry.register(registration(harness.upstreamPort, ["web.localhost", "web.dev.example.com"]),
      new Date().toISOString());

    expect((await call(harness.port, "/", { host: "web.localhost" })).status).toBe(201);

    const refused = await call(harness.lanPort!, "/", { host: "web.localhost" });
    expect(refused.status).toBe(404);
    expect(refused.text).toContain("only ever mean the machine asking");
    expect(refused.text).not.toContain("web.dev.example.com");

    expect((await call(harness.lanPort!, "/", { host: "web.dev.example.com" })).status).toBe(201);
  });

  it("keeps a local-mode app off the LAN listener, upgrades included", async () =>
  {
    const harness = await startProxy({ lanIp: "127.0.0.1" });
    harness.registry.register({ ...registration(harness.upstreamPort, ["web.localhost"]), mode: "local" },
      new Date().toISOString());

    expect((await call(harness.lanPort!, "/", { host: "web.localhost" })).status).toBe(404);
    expect((await call(harness.lanPort!, "/", { host: "preview.web.localhost" })).status).toBe(404);
    expect(await upgrade(harness.lanPort!, "web.localhost")).toBe("");

    expect((await call(harness.port, "/", { host: "web.localhost" })).status).toBe(201);
    expect(await upgrade(harness.port, "web.localhost")).toContain("101 Switching Protocols");
  });

  it("registers, lists and removes routes over the loopback control API", async () =>
  {
    const harness = await startProxy();

    const created = await call(
      harness.port,
      "/__localgate/routes",
      { host: "127.0.0.1", "content-type": "application/json" },
      JSON.stringify(registration(harness.upstreamPort, ["web.localhost"]))
    );
    expect(created.status).toBe(201);
    const id = ((JSON.parse(created.text) as { route: { id: string } }).route).id;

    const listed = await call(harness.port, "/__localgate/routes", { host: "127.0.0.1" });
    expect((JSON.parse(listed.text) as { routes: unknown[] }).routes).toHaveLength(1);

    const resolved = await call(harness.port, "/__localgate/resolve?cwd=C:\\projects\\web\\app", { host: "127.0.0.1" });
    expect(resolved.status).toBe(200);

    const removed = await call(harness.port, `/__localgate/routes/${id}`, { host: "127.0.0.1", "x-method": "delete" });
    expect(removed.status).toBe(404); // GET on a route id is not a control route

    await new Promise<void>((resolve, reject) =>
    {
      const request = httpRequest({ host: "127.0.0.1", port: harness.port, path: `/__localgate/routes/${id}`, method: "DELETE" }, response =>
      {
        expect(response.statusCode).toBe(200);
        response.resume();
        response.on("end", resolve);
      });
      request.once("error", reject);
      request.end();
    });

    expect(harness.registry.isEmpty()).toBe(true);
  });

  it("proxies a websocket upgrade, which is what makes HMR work", async () =>
  {
    const harness = await startProxy({ externalSuffix: ".dev.example.com" });
    harness.registry.register(registration(harness.upstreamPort, ["web.dev.example.com"]), new Date().toISOString());

    const received = await upgrade(harness.port, "web.dev.example.com");

    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("origin=http://web.localhost");
  });

  it("signals idle once the last route is gone, which is how it stops being resident", async () =>
  {
    const harness = await startProxy({ gracePeriodMs: 30 });
    const route = harness.registry.register(registration(harness.upstreamPort, ["web.localhost"]), new Date().toISOString());
    harness.proxy.checkIdle();

    await new Promise(resolve => setTimeout(resolve, 80));
    expect(harness.idle()).toBe(0);

    harness.registry.remove(route.id);
    harness.proxy.checkIdle();

    await new Promise(resolve => setTimeout(resolve, 80));
    expect(harness.idle()).toBeGreaterThan(0);
  });
});
