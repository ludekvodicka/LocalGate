import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { LocalgateControlApi } from "./localgateControlApi.ts";
import { LocalgateHeaderRewrite } from "./localgateHeaderRewrite.ts";
import { LocalgateHealth } from "./localgateHealth.ts";
import type { LocalgateReach, LocalgateRegistry, LocalgateRoute } from "./localgateRegistry.ts";

export type LocalgateProxyOptions =
{
  port: number;
  // null keeps the proxy on loopback only, which is what a machine with no localgate config gets.
  lanIp: string | null;
  gracePeriodMs: number;
  onIdle: () => void;
};

export class LocalgateProxy
{
  private readonly servers: Server[] = [];
  // An upgraded socket is handed to us and stops being tracked by the http server, so
  // closeAllConnections cannot reach it. The proxy keeps its own set, or a single open browser tab
  // holding an HMR websocket would keep it alive forever and defeat the self-exit.
  private readonly upgraded = new Set<Duplex>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: LocalgateRegistry,
    private readonly health: LocalgateHealth,
    private readonly controlApi: LocalgateControlApi,
    private readonly options: LocalgateProxyOptions
  ) {}

  async start(): Promise<void>
  {
    await this.listen("127.0.0.1", true);
    if (this.options.lanIp) await this.listen(this.options.lanIp, false);
    this.checkIdle();
  }

  // The ports actually bound, in listen order: loopback first, the LAN address second when there is
  // one. They differ from the requested port only when 0 was asked for (tests).
  boundPorts(): number[]
  {
    if (this.servers.length == 0) throw new Error("proxy is not listening");

    return this.servers.map(server =>
    {
      const address = server.address();
      if (!address || typeof address == "string") throw new Error("proxy is not listening");
      return address.port;
    });
  }

  async stop(): Promise<void>
  {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    // Without dropping live sockets the proxy would never finish closing: a browser tab holding an HMR
    // websocket keeps the server open forever, and the self-exit in `checkIdle` would never complete.
    for (const socket of this.upgraded) socket.destroy();
    this.upgraded.clear();
    for (const server of this.servers) server.closeAllConnections();

    await Promise.all(this.servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    this.servers.length = 0;
  }

  // Called after every control-API mutation: the proxy exists to serve routes, so when the last one goes
  // it has no reason to stay resident. The grace period is what keeps it alive across a restart, between
  // the child being killed and the new one registering.
  checkIdle(): void
  {
    if (this.idleTimer)
    {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.registry.isEmpty()) return;

    this.idleTimer = setTimeout(() =>
    {
      this.idleTimer = null;
      if (this.registry.isEmpty()) this.options.onIdle();
    }, this.options.gracePeriodMs);
    this.idleTimer.unref();
  }

  private listen(address: string, loopback: boolean): Promise<void>
  {
    const reachedFrom: LocalgateReach = loopback ? "loopback" : "lan";
    const server = createServer((request, response) => void this.handleRequest(request, response, loopback, reachedFrom));
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket as Duplex, head, reachedFrom));

    return new Promise<void>((resolve, reject) =>
    {
      server.once("error", reject);
      server.listen(this.options.port, address, () =>
      {
        server.removeListener("error", reject);
        this.servers.push(server);
        resolve();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, loopback: boolean,
    reachedFrom: LocalgateReach): Promise<void>
  {
    const requestUrl = request.url ?? "/";

    // The control API is loopback-only. On the LAN listener the path is just a path, and since no route
    // claims it the request falls through to the not-found answer below.
    if (loopback && LocalgateControlApi.handles(requestUrl))
      return this.controlApi.handle(request, response);

    const route = this.registry.byHostname(request.headers.host ?? "", reachedFrom);
    if (!route)
    {
      if (loopback) return LocalgateProxy.sendText(response, 404, this.indexPage(request.headers.host ?? ""));
      return LocalgateProxy.sendText(response, 404, LocalgateProxy.offMachineMessage(request.headers.host ?? ""));
    }

    this.forward(route, request, response);
  }

  private forward(route: LocalgateRoute, request: IncomingMessage, response: ServerResponse): void
  {
    const headers = { ...request.headers };
    LocalgateHeaderRewrite.apply(request.url ?? "/", headers, request.headers.host ?? "", route.names[0]!);

    const upstream = httpRequest({
      host: "127.0.0.1",
      port: route.port,
      method: request.method,
      path: request.url,
      headers
    });

    upstream.setTimeout(LocalgateHealth.requestTimeoutMs(), () =>
    {
      upstream.destroy();
      if (response.headersSent) return;
      this.health.noteTimeout(route);
      LocalgateProxy.sendText(response, 504, this.health.unresponsiveMessage(route));
    });

    upstream.once("response", upstreamResponse =>
    {
      // A stream that stays open on purpose (SSE, a long poll) must not be judged unresponsive, so the
      // inactivity timeout only guards the wait for the first byte.
      upstream.setTimeout(0);
      this.health.noteSuccess(route);
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });

    upstream.once("error", (error: NodeJS.ErrnoException) =>
    {
      if (response.headersSent)
      {
        response.destroy();
        return;
      }

      if (error.code == "ECONNREFUSED" || error.code == "ECONNRESET")
      {
        this.health.noteConnectionRefused(route);
        const state = this.registry.byId(route.id)?.state;
        const message = state == "starting" ? this.health.startingMessage(route) : this.health.deadMessage(route);
        return LocalgateProxy.sendText(response, 503, message);
      }

      LocalgateProxy.sendText(response, 502, `localgate: upstream error for ${route.names[0]}: ${error.message}\n`);
    });

    request.pipe(upstream);
  }

  // Hot module reload runs over a websocket, so the upgrade has to be proxied or every edit needs a
  // manual reload. It carries the reach for the same reason a plain request does: an upgrade is a
  // request first, and a listener that refuses a name must refuse it here too.
  private handleUpgrade(request: IncomingMessage, clientSocket: Duplex, head: Buffer,
    reachedFrom: LocalgateReach): void
  {
    const route = this.registry.byHostname(request.headers.host ?? "", reachedFrom);
    if (!route)
    {
      clientSocket.destroy();
      return;
    }

    const headers = { ...request.headers };
    LocalgateHeaderRewrite.apply(request.url ?? "/", headers, request.headers.host ?? "", route.names[0]!);

    const upstream = httpRequest({
      host: "127.0.0.1",
      port: route.port,
      method: request.method,
      path: request.url,
      headers
    });

    upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) =>
    {
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}`];
      for (const [key, value] of Object.entries(upstreamResponse.headers))
        lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);

      clientSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);

      this.upgraded.add(clientSocket).add(upstreamSocket);
      const forget = () =>
      {
        this.upgraded.delete(clientSocket);
        this.upgraded.delete(upstreamSocket);
      };

      upstreamSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.once("close", forget);
      clientSocket.once("close", forget);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    upstream.once("error", () => clientSocket.destroy());
    upstream.end();
  }

  // Nothing about what is running: this answer goes to the network. The `.localhost` hint is safe
  // because it is true of every machine, and it is the one mistake a colleague actually makes -
  // copying a URL that only ever meant "my own computer".
  private static offMachineMessage(requestedHost: string): string
  {
    const host = requestedHost.trim().toLowerCase().split(":")[0] ?? "";
    if (host.endsWith(".localhost"))
      return "localgate: no route for this hostname. Names on .localhost only ever mean the machine "
        + "asking, so this one cannot be served from here - ask for the shared name instead.\n";

    return "localgate: no route for this hostname\n";
  }

  private indexPage(requestedHost: string): string
  {
    const routes = this.registry.all();
    const lines = [`localgate: nothing is registered for "${requestedHost}".`, ""];

    if (routes.length == 0)
      lines.push("No routes. Start one with: localgate run npm run dev");
    else
    {
      lines.push("Active routes:");
      for (const route of routes)
        lines.push(`  ${route.names.join("  ")}  ->  127.0.0.1:${route.port}  [${route.state}]`);
    }

    lines.push("");
    return lines.join("\n");
  }

  private static sendText(response: ServerResponse, status: number, body: string): void
  {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
    response.end(body);
  }
}
