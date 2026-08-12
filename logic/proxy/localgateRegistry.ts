import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalgateMode } from "../config/localgateProjectConfig.ts";

export type LocalgateRouteKind = "app" | "alias";

// Which listener a lookup is answering for. The proxy binds loopback always and the LAN address when
// the machine has one, and the two do not serve the same names.
export type LocalgateReach = "loopback" | "lan";

export type LocalgateRouteState = "starting" | "healthy" | "unresponsive" | "dead";

export type LocalgateRoute =
{
  id: string;
  // The local name first, the external one second when the mode grants it. Both point at one port.
  names: string[];
  port: number;
  kind: LocalgateRouteKind;
  mode: LocalgateMode;
  cwd: string | null;
  command: string | null;
  controlUrl: string | null;
  runnerPid: number | null;
  childPid: number | null;
  debuggerAttached: boolean;
  startedAt: string;
  state: LocalgateRouteState;
  lastResponseAt: string | null;
};

export type LocalgateRouteRegistration =
{
  names: string[];
  port: number;
  kind: LocalgateRouteKind;
  mode: LocalgateMode;
  cwd: string | null;
  command: string | null;
  controlUrl: string | null;
  runnerPid: number | null;
  childPid: number | null;
  debuggerAttached: boolean;
};

// A name is already owned by a live runner. Its own kind so the control API can answer 409 and the
// caller can tell a collision apart from a malformed registration.
export class LocalgateRouteConflictError extends Error
{
  constructor(readonly existing: LocalgateRoute)
  {
    super(`${existing.names[0]} is already registered by runner ${existing.runnerPid ?? "?"}`);
    this.name = "LocalgateRouteConflictError";
  }
}

// The table lives in the proxy process and nowhere else: no state file, so there is no lock to take
// and no stale row to prune after a crash. Runners and the CLI reach it over the proxy's loopback
// control API, and a route disappears when its owner stops answering.
export class LocalgateRegistry
{
  private static readonly localSuffixConst = ".localhost";

  private readonly routes = new Map<string, LocalgateRoute>();
  private nextId = 1;

  register(registration: LocalgateRouteRegistration, now: string): LocalgateRoute
  {
    if (registration.names.length == 0)
      throw new Error("a route needs at least one name");

    // Taking a name away from a live runner used to be silent, which left that runner holding its port
    // with no route pointing at it - unreachable, and invisible to stop/restart/status. A runner may
    // still re-register its own names, which is how the heartbeat recovers from a proxy restart.
    for (const name of registration.names)
    {
      const existing = this.findByName(name);
      if (!existing) continue;
      if (existing.controlUrl && existing.runnerPid != registration.runnerPid)
        throw new LocalgateRouteConflictError(existing);
      this.routes.delete(existing.id);
    }

    const route: LocalgateRoute = {
      ...registration,
      id: `r${this.nextId++}`,
      startedAt: now,
      state: "starting",
      lastResponseAt: null
    };
    this.routes.set(route.id, route);
    return route;
  }

  remove(id: string): boolean
  {
    return this.routes.delete(id);
  }

  all(): LocalgateRoute[]
  {
    return [...this.routes.values()];
  }

  isEmpty(): boolean
  {
    return this.routes.size == 0;
  }

  byId(id: string): LocalgateRoute | null
  {
    return this.routes.get(id) ?? null;
  }

  // Exact name first, then a parent-domain match, so a request to `app.dev.example.com` still finds a
  // route registered as `app.dev.example.com` while a stray subdomain of it resolves to the same app.
  // The reach is not optional: a lookup that did not say where the request came from is how a
  // `.localhost` name ends up answered on the LAN.
  byHostname(hostHeader: string, reachedFrom: LocalgateReach): LocalgateRoute | null
  {
    const host = LocalgateRegistry.hostnameOf(hostHeader);
    if (!host) return null;

    for (const route of this.routes.values())
      for (const name of route.names)
        if (name == host && LocalgateRegistry.answers(name, reachedFrom)) return route;

    for (const route of this.routes.values())
      for (const name of route.names)
        if (host.endsWith(`.${name}`) && LocalgateRegistry.answers(name, reachedFrom)) return route;

    return null;
  }

  byName(name: string): LocalgateRoute | null
  {
    for (const route of this.routes.values())
      if (route.names.some(candidate => candidate == name || candidate.startsWith(`${name}.`)))
        return route;
    return null;
  }

  // The working directory is the anchor an agent has: whichever route owns this directory or one of
  // its ancestors is the one the caller means. The deepest match wins when projects are nested.
  byDirectory(directory: string): LocalgateRoute | null
  {
    const target = resolve(directory);
    let best: LocalgateRoute | null = null;
    let bestDepth = -1;

    for (const route of this.routes.values())
    {
      if (!route.cwd) continue;
      const routeDirectory = resolve(route.cwd);
      if (!LocalgateRegistry.contains(routeDirectory, target)) continue;

      const depth = routeDirectory.split(sep).length;
      if (depth > bestDepth)
      {
        best = route;
        bestDepth = depth;
      }
    }

    return best;
  }

  update(id: string, patch: Partial<Pick<LocalgateRoute, "state" | "lastResponseAt" | "childPid" | "debuggerAttached">>): LocalgateRoute
  {
    const route = this.routes.get(id);
    if (!route) throw new Error(`unknown route ${id}`);
    Object.assign(route, patch);
    return route;
  }

  private findByName(name: string): LocalgateRoute | null
  {
    for (const route of this.routes.values())
      if (route.names.includes(name)) return route;
    return null;
  }

  private static hostnameOf(hostHeader: string): string | null
  {
    const host = hostHeader.trim().toLowerCase().split(":")[0];
    return host ? host : null;
  }

  // `.localhost` resolves to the loopback address of whoever looked it up, so off this machine it
  // names somebody else's computer. Serving it on the LAN listener would hand out every route,
  // including the local-mode ones whose whole point is that they never leave the machine.
  private static answers(name: string, reachedFrom: LocalgateReach): boolean
  {
    return reachedFrom == "loopback" || !name.endsWith(LocalgateRegistry.localSuffixConst);
  }

  // `relative` between two drives has no relative form, so it returns the target unchanged - an
  // absolute path, which does not start with `..` and would read as "inside the parent". Without the
  // absolute check every route on one drive contains every directory on another.
  private static contains(parent: string, child: string): boolean
  {
    if (parent == child) return true;
    const difference = relative(parent, child);
    return difference.length > 0 && !difference.startsWith("..") && !isAbsolute(difference);
  }
}
