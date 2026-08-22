import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { LocalgateMachineConfig } from "../config/localgateMachineConfig.ts";
import { LocalgateUrl } from "../proxy/localgateUrl.ts";
import { LocalgateRouteConflictError } from "../proxy/localgateRegistry.ts";
import type { LocalgateRoute, LocalgateRouteRegistration } from "../proxy/localgateRegistry.ts";

// Every process other than the proxy reaches the route table through here. The table has no file, so
// this client is the only way in - and it is loopback-only, which is what keeps the LAN out of it.
export class LocalgateProxyClient
{
  private static readonly startTimeoutMsConst = 15_000;

  // Resolved once per process rather than per call: it reads the machine config from disk, and a
  // long-lived runner asks for this on every heartbeat. Public because everything that prints a URL
  // needs the same answer, and asking the one component that already talks to the proxy beats every
  // caller loading the config for itself.
  private static port: number | null = null;

  static proxyPort(): number
  {
    LocalgateProxyClient.port ??= LocalgateUrl.proxyPort(LocalgateMachineConfig.load());
    return LocalgateProxyClient.port;
  }

  private static baseUrl(): string
  {
    return `http://127.0.0.1:${LocalgateProxyClient.proxyPort()}/__localgate`;
  }

  static async ping(): Promise<boolean>
  {
    try
    {
      const response = await fetch(`${LocalgateProxyClient.baseUrl()}/ping`, {
        signal: AbortSignal.timeout(1_000)
      });
      return response.ok;
    }
    catch
    {
      return false;
    }
  }

  static async ensureRunning(): Promise<void>
  {
    if (await LocalgateProxyClient.ping()) return;

    LocalgateProxyClient.spawnDetached();

    const deadline = Date.now() + LocalgateProxyClient.startTimeoutMsConst;
    for (;;)
    {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (await LocalgateProxyClient.ping()) return;
      if (Date.now() >= deadline)
        throw new Error(`localgate proxy did not come up on port ${LocalgateProxyClient.proxyPort()} within `
          + `${LocalgateProxyClient.startTimeoutMsConst / 1000} s (is something else holding the port?)`);
    }
  }

  static async register(registration: LocalgateRouteRegistration): Promise<LocalgateRoute>
  {
    const payload = await LocalgateProxyClient.send("POST", "/routes", registration) as { route: LocalgateRoute };
    return payload.route;
  }

  static async deregister(id: string): Promise<void>
  {
    await LocalgateProxyClient.send("DELETE", `/routes/${id}`);
  }

  static async patch(id: string, patch: Record<string, unknown>): Promise<LocalgateRoute>
  {
    const payload = await LocalgateProxyClient.send("PATCH", `/routes/${id}`, patch) as { route: LocalgateRoute };
    return payload.route;
  }

  static async list(): Promise<LocalgateRoute[]>
  {
    if (!await LocalgateProxyClient.ping()) return [];
    const payload = await LocalgateProxyClient.send("GET", "/routes") as { routes: LocalgateRoute[] };
    return payload.routes;
  }

  static async resolve(selector: { name?: string; directory?: string }): Promise<LocalgateRoute | null>
  {
    if (!await LocalgateProxyClient.ping()) return null;

    const query = selector.name
      ? `name=${encodeURIComponent(selector.name)}`
      : `cwd=${encodeURIComponent(selector.directory ?? "")}`;

    const response = await fetch(`${LocalgateProxyClient.baseUrl()}/resolve?${query}`);
    if (!response.ok) return null;
    return ((await response.json()) as { route: LocalgateRoute | null }).route;
  }

  // Two levels of spawn on Windows, deliberately: `cmd` exits immediately, so the proxy's recorded
  // parent is already gone and the tree kill VSCode performs when a terminal closes cannot reach it.
  // Otherwise closing one project's terminal would take the routing of every other project with it.
  private static spawnDetached(): void
  {
    const entry = join(fileURLToPath(new URL("../../", import.meta.url)), "bin", "localgate.mjs");

    const child = process.platform == "win32"
      ? spawn("cmd", ["/c", "start", "\"\"", "/b", process.execPath, entry, "__proxy"],
        { detached: true, stdio: "ignore", windowsHide: true })
      : spawn(process.execPath, [entry, "__proxy"], { detached: true, stdio: "ignore" });

    child.unref();
  }

  private static async send(method: string, path: string, body?: unknown): Promise<unknown>
  {
    const init: RequestInit = { method };
    if (body !== undefined)
    {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${LocalgateProxyClient.baseUrl()}${path}`, init);

    // A collision travels as its own type so the runner can name the process that holds the name,
    // rather than reporting a bare status code.
    if (response.status == 409)
    {
      const payload = await response.json() as { existing: LocalgateRoute };
      throw new LocalgateRouteConflictError(payload.existing);
    }

    if (!response.ok)
      throw new Error(`localgate proxy answered ${response.status} for ${method} ${path}`);

    return response.json();
  }
}
