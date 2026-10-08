import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import { LocalgateControlApi } from "./localgateControlApi.ts";
import { LocalgateHealth } from "./localgateHealth.ts";
import { LocalgateProxy } from "./localgateProxy.ts";
import { LocalgateRegistry, type LocalgateRouteRegistration } from "./localgateRegistry.ts";
import { LocalgateStartPage } from "./localgateStartPage.ts";

type Harness = {
  proxy: LocalgateProxy;
  registry: LocalgateRegistry;
  port: number;
  // The second listener, when the harness asked for one. It is a loopback address like the first, so
  // the test binds no real network interface; what differs is the reach the proxy answers it with.
  lanPort: number | null;
  upstreamPort: number;
  // The routes the start page asked a runner to end, in order.
  stopped: string[];
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
          forwardedHost: request.headers["x-forwarded-host"],
          forwardedProto: request.headers["x-forwarded-proto"],
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

  const startProxy = async (options: { gracePeriodMs?: number; upstreamPort?: number; lanIp?: string;
    machine?: LocalgateMachineSettings; aliasStops?: Map<string, string> } = {}): Promise<Harness> =>
  {
    const upstream = options.upstreamPort ? null : await startUpstream();
    const upstreamPort = options.upstreamPort ?? upstream!.port;

    const registry = new LocalgateRegistry();
    let idleCount = 0;
    const health = new LocalgateHealth(registry, false, async () => {});
    // Port 80 for the start page, which prints addresses for a person rather than for this test's
    // ephemeral listener: what it must get right is the name, not the port the harness landed on.
    const stopped: string[] = [];
    const startPage = new LocalgateStartPage(registry, options.machine ?? null, 80, {
      aliasStopCommands: () => options.aliasStops ?? new Map(),
      stop: async route => { stopped.push(route.names[0]!); }
    });
    const proxy = new LocalgateProxy(registry, health, new LocalgateControlApi(registry, () => proxy.checkIdle()), startPage, {
      port: 0,
      lanIp: options.lanIp ?? null,
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
      stopped,
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

  // A real path for the platform the tests run on: `path` reads `C:\projects\web` on Linux as a single
  // segment with backslashes in its name, so the nested lookup below would find a sibling, not a child.
  const windows = process.platform == "win32";
  const projectDir = (...parts: string[]) => [windows ? "C:\\projects" : "/projects", ...parts]
    .join(windows ? "\\" : "/");

  const registration = (port: number, names: string[]): LocalgateRouteRegistration => ({
    names,
    port,
    kind: "app",
    mode: "lan",
    cwd: projectDir("web"),
    command: "npm run dev",
    controlUrl: null,
    runnerPid: null,
    childPid: null,
    debuggerAttached: false
  });

  const call = (port: number, path: string, headers: IncomingHttpHeaders, body?: string, method?: string) =>
    new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>((resolve, reject) =>
    {
      const request = httpRequest({ host: "127.0.0.1", port, path,
        method: method ?? (body ? "POST" : "GET"), headers: headers as never }, response =>
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
    const harness = await startProxy();
    harness.registry.register(registration(harness.upstreamPort, ["web.localhost", "web.dev.example.com"]),
      new Date().toISOString());

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

  it.each([
    ["myapp.localhost:8080", undefined, "http"],
    ["myapp.dev.example.com:8080", undefined, "http"],
    ["pub-myapp.example.com", "https", "https"],
    ["pub-myapp.example.com", "http", "http"],
    ["myapp.localhost", "https, http", "http"]
  ])("forwards the auth origin for %s with protocol %s", async (host, forwardedProto, expectedProtocol) =>
  {
    const harness = await startProxy({ lanIp: "127.0.0.1" });
    harness.registry.register({ ...registration(harness.upstreamPort,
      ["myapp.localhost", "myapp.dev.example.com", "pub-myapp.example.com"]), mode: "internet" },
    new Date().toISOString());
    const headers: Record<string, string> = { host: host!, "x-forwarded-host": "foreign.example.com" };
    if (forwardedProto) headers["x-forwarded-proto"] = forwardedProto;
    const result = await call(host!.includes(".localhost") ? harness.port : harness.lanPort!, "/api/auth/providers", headers);
    expect(result.status).toBe(201);
    expect(JSON.parse(result.text)).toMatchObject({ host, forwardedHost: host, forwardedProto: expectedProtocol });
  });

  it("answers an unknown hostname on loopback with the list of what is running", async () =>
  {
    const harness = await startProxy();
    harness.registry.register(registration(harness.upstreamPort, ["web.localhost"]), new Date().toISOString());

    const result = await call(harness.port, "/", { host: "nothing.localhost" });

    expect(result.status).toBe(404);
    expect(result.text).toContain("nothing is registered");
    expect(result.text).toContain("web.localhost");
    expect(result.text).toContain("start.localhost");
  });

  it("serves the start page on its own name, ahead of the route table", async () =>
  {
    const harness = await startProxy();
    harness.registry.register(registration(harness.upstreamPort, ["web.localhost", "web.dev.example.com"]),
      new Date().toISOString());

    const result = await call(harness.port, "/", { host: "start.localhost" });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.text).toContain("http://web.localhost");
    expect(result.text).toContain("http://web.dev.example.com");
  });

  // The page is the machine's inventory, so off the machine it is asked for by the machine's own name
  // and answers with the shared routes alone.
  it("serves the start page on the LAN only under the shared name", async () =>
  {
    const machine: LocalgateMachineSettings = {
      label: "dev", baseDomain: "example.com", lanIp: "127.0.0.1", publicPrefix: null,
      autoRestart: false, proxyPort: null
    };
    const harness = await startProxy({ lanIp: "127.0.0.1", machine });
    harness.registry.register({ ...registration(harness.upstreamPort, ["tool.localhost"]), mode: "local" },
      new Date().toISOString());

    expect((await call(harness.lanPort!, "/", { host: "start.localhost" })).status).toBe(404);

    const shared = await call(harness.lanPort!, "/", { host: "start.dev.example.com" });
    expect(shared.status).toBe(200);
    expect(shared.text).not.toContain("tool");

    expect((await call(harness.port, "/", { host: "start.dev.example.com" })).text).toContain("tool.localhost");
  });

  it("ends a dev server when the start page's own form asks it to", async () =>
  {
    const harness = await startProxy();
    harness.registry.register({ ...registration(harness.upstreamPort, ["web.localhost"]),
      controlUrl: "http://127.0.0.1:52000" }, new Date().toISOString());

    const result = await call(harness.port, "/stop?name=web",
      { host: "start.localhost", origin: "http://start.localhost" }, undefined, "POST");

    expect(result.status).toBe(303);
    expect(result.headers.location).toBe("/?stopped=web");
    expect(harness.stopped).toEqual(["web.localhost"]);
  });

  // A form POST needs no permission to leave the page it sits on, so without an origin check any site
  // the developer happens to open could end every dev server on the machine.
  it("refuses a stop that came from another site, or from the LAN listener", async () =>
  {
    const machine: LocalgateMachineSettings = {
      label: "dev", baseDomain: "example.com", lanIp: "127.0.0.1", publicPrefix: null,
      autoRestart: false, proxyPort: null
    };
    const harness = await startProxy({ lanIp: "127.0.0.1", machine });
    harness.registry.register({ ...registration(harness.upstreamPort, ["web.localhost", "web.dev.example.com"]),
      controlUrl: "http://127.0.0.1:52000" }, new Date().toISOString());

    const foreign = await call(harness.port, "/stop?name=web",
      { host: "start.localhost", origin: "http://anything.example" }, undefined, "POST");
    expect(foreign.status).toBe(403);

    const fromLan = await call(harness.lanPort!, "/stop?name=web",
      { host: "start.dev.example.com", origin: "http://start.dev.example.com" }, undefined, "POST");
    expect(fromLan.status).toBe(404);

    expect(harness.stopped).toEqual([]);
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
    const harness = await startProxy({ lanIp: "127.0.0.1" });
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

    const nested = encodeURIComponent(projectDir("web", "app"));
    const resolved = await call(harness.port, `/__localgate/resolve?cwd=${nested}`, { host: "127.0.0.1" });
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

  // A route aimed at the proxy's own port would come back in as loopback, which is how a LAN caller
  // reaches the loopback-only control API, and how any other path loops until the sockets run out.
  it("refuses to forward a route that points at its own port", async () =>
  {
    const harness = await startProxy({ lanIp: "127.0.0.1" });
    harness.registry.register(
      registration(harness.port, ["loop.localhost", "loop.dev.example.com"]),
      new Date().toISOString()
    );

    // From the LAN listener the control path is just a path. Forwarding it to the proxy's own port is
    // what used to re-enter as loopback and answer with the whole route table.
    const answer = await call(harness.lanPort!, "/__localgate/routes", { host: "loop.dev.example.com" });

    expect(answer.status).toBe(502);
    expect(answer.text).toContain("localgate's own port");
    expect(answer.text).not.toContain("\"routes\"");
  });

  it("refuses a registration whose port or kind the rest of the proxy cannot use", async () =>
  {
    const harness = await startProxy();
    const post = (body: unknown) => call(harness.port, "/__localgate/routes",
      { host: "127.0.0.1", "content-type": "application/json" }, JSON.stringify(body));

    expect((await post({ ...registration(70_000, ["web.localhost"]) })).status).toBe(400);
    expect((await post({ ...registration(harness.upstreamPort, ["web.localhost"]), kind: "gadget" })).status).toBe(400);
    expect((await post({ ...registration(harness.upstreamPort, []) })).status).toBe(400);
    expect(harness.registry.isEmpty()).toBe(true);
  });

  // `/ok` answers at once, `/sse` sends one event and stays open, `/hold` never answers. `closed` resolves
  // with the path of the first response the upstream saw end before it finished.
  const startHoldingUpstream = async () =>
  {
    let reportClosed: (path: string) => void = () => {};
    const closed = new Promise<string>(resolve => { reportClosed = resolve; });

    const server = createServer((request, response) =>
    {
      response.once("close", () =>
      {
        if (!response.writableFinished) reportClosed(request.url ?? "");
      });

      if (request.url == "/ok") response.end("ok");
      else if (request.url == "/sse")
      {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
      }
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address == "string") throw new Error("no upstream port");

    const close = async () =>
    {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    };

    return { port: address.port, closed, close };
  };

  // Well under the proxy's own first-byte timeout, so only the browser leaving can end the request in time.
  const promptly = <T>(promise: Promise<T>) => Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upstream request still open")), 2_000))
  ]);

  it("ends an open event stream on the dev server when the browser leaves", async () =>
  {
    const upstream = await startHoldingUpstream();
    try
    {
      const harness = await startProxy({ upstreamPort: upstream.port });
      harness.registry.register(registration(upstream.port, ["web.localhost"]), new Date().toISOString());

      const client = httpRequest({ host: "127.0.0.1", port: harness.port, path: "/sse",
        headers: { host: "web.localhost" } });
      client.once("error", () => {});
      client.once("response", response => response.once("data", () => client.destroy()));
      client.end();

      expect(await promptly(upstream.closed)).toBe("/sse");
    }
    finally
    {
      await upstream.close();
    }
  });

  it("ends a request still waiting for the dev server when the browser leaves, without blaming the route", async () =>
  {
    const upstream = await startHoldingUpstream();
    try
    {
      const harness = await startProxy({ upstreamPort: upstream.port });
      const route = harness.registry.register(registration(upstream.port, ["web.localhost"]), new Date().toISOString());
      await call(harness.port, "/ok", { host: "web.localhost" });
      expect(harness.registry.byId(route.id)?.state).toBe("healthy");

      const client = httpRequest({ host: "127.0.0.1", port: harness.port, path: "/hold",
        headers: { host: "web.localhost" } });
      client.once("error", () => {});
      client.end();
      setTimeout(() => client.destroy(), 100);

      expect(await promptly(upstream.closed)).toBe("/hold");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(harness.registry.byId(route.id)?.state).toBe("healthy");
    }
    finally
    {
      await upstream.close();
    }
  });

  it("proxies a websocket upgrade, which is what makes HMR work", async () =>
  {
    const harness = await startProxy();
    harness.registry.register(registration(harness.upstreamPort, ["web.localhost", "web.dev.example.com"]),
      new Date().toISOString());

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
