import type { IncomingMessage, ServerResponse } from "node:http";
import { LocalgateRouteConflictError } from "./localgateRegistry.ts";
import type { LocalgateRegistry, LocalgateRouteRegistration } from "./localgateRegistry.ts";

// The registry lives in the proxy's memory, so runners and the CLI reach it over this API. It is served
// only on the loopback listener: nothing on the LAN can register, restart or even enumerate routes.
export class LocalgateControlApi
{
  static readonly pathPrefixConst = "/__localgate/";

  // onChange lets the proxy re-evaluate whether it still has a reason to run, since the registry itself
  // is a plain table and emits nothing.
  constructor(private readonly registry: LocalgateRegistry, private readonly onChange: () => void) {}

  static handles(requestUrl: string): boolean
  {
    return requestUrl.startsWith(LocalgateControlApi.pathPrefixConst);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname.slice(LocalgateControlApi.pathPrefixConst.length);
    const method = request.method ?? "GET";

    try
    {
      if (route == "ping" && method == "GET")
        return LocalgateControlApi.sendJson(response, 200, { ok: true });

      if (route == "routes" && method == "GET")
        return LocalgateControlApi.sendJson(response, 200, { routes: this.registry.all() });

      if (route == "routes" && method == "POST")
      {
        const registration = await LocalgateControlApi.readJson(request) as LocalgateRouteRegistration;
        const created = this.registry.register(registration, new Date().toISOString());
        this.onChange();
        return LocalgateControlApi.sendJson(response, 201, { route: created });
      }

      if (route == "resolve" && method == "GET")
      {
        const name = url.searchParams.get("name");
        const directory = url.searchParams.get("cwd");
        const found = name ? this.registry.byName(name) : directory ? this.registry.byDirectory(directory) : null;
        return LocalgateControlApi.sendJson(response, found ? 200 : 404, { route: found });
      }

      if (route.startsWith("routes/") && method == "DELETE")
      {
        const removed = this.registry.remove(route.slice("routes/".length));
        this.onChange();
        return LocalgateControlApi.sendJson(response, removed ? 200 : 404, { removed });
      }

      if (route.startsWith("routes/") && method == "PATCH")
      {
        const patch = await LocalgateControlApi.readJson(request) as Record<string, unknown>;
        const updated = this.registry.update(route.slice("routes/".length), patch);
        return LocalgateControlApi.sendJson(response, 200, { route: updated });
      }

      return LocalgateControlApi.sendJson(response, 404, { error: `unknown control route ${method} ${url.pathname}` });
    }
    catch (error)
    {
      if (error instanceof LocalgateRouteConflictError)
        return LocalgateControlApi.sendJson(response, 409, { error: error.message, existing: error.existing });

      return LocalgateControlApi.sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private static async readJson(request: IncomingMessage): Promise<unknown>
  {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    return body.length > 0 ? JSON.parse(body) : {};
  }

  private static sendJson(response: ServerResponse, status: number, payload: unknown): void
  {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    response.end(body);
  }
}
