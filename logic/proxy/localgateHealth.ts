import { LocalgateNames } from "../config/localgateNames.ts";
import type { LocalgateRegistry, LocalgateRoute } from "./localgateRegistry.ts";

export type LocalgateRestartRequest = (route: LocalgateRoute) => Promise<void>;

// Detection is free: the proxy already forwards every request, so a wedged dev server shows up as
// consecutive timeouts on a connection that still opens. Acting on it is the risky half - a process
// paused at a breakpoint is externally indistinguishable from a wedged one - so the automatic restart is
// off unless the machine asks for it, never fires while a debugger is attached, and is bounded by a
// cooldown and an attempt cap. Reporting always happens.
export class LocalgateHealth
{
  private static readonly requestTimeoutMsConst = 30_000;
  private static readonly failuresBeforeUnresponsiveConst = 3;
  private static readonly startupGraceMsConst = 90_000;
  private static readonly cooldownMsConst = 5 * 60_000;
  private static readonly maxAutomaticAttemptsConst = 2;

  private readonly failures = new Map<string, number>();
  private readonly lastAutomaticRestart = new Map<string, number>();
  private readonly automaticAttempts = new Map<string, number>();

  constructor(
    private readonly registry: LocalgateRegistry,
    private readonly autoRestart: boolean,
    private readonly requestRestart: LocalgateRestartRequest,
    private readonly now: () => number = () => Date.now()
  ) {}

  static requestTimeoutMs(): number
  {
    return LocalgateHealth.requestTimeoutMsConst;
  }

  noteSuccess(route: LocalgateRoute): void
  {
    this.failures.delete(route.id);
    this.automaticAttempts.delete(route.id);
    this.registry.update(route.id, { state: "healthy", lastResponseAt: new Date(this.now()).toISOString() });
  }

  noteTimeout(route: LocalgateRoute): void
  {
    const count = (this.failures.get(route.id) ?? 0) + 1;
    this.failures.set(route.id, count);
    if (count < LocalgateHealth.failuresBeforeUnresponsiveConst) return;

    this.registry.update(route.id, { state: "unresponsive" });
    void this.considerAutomaticRestart(route);
  }

  // A refused connection during start-up is normal: the dev server has not bound its port yet. Past the
  // grace window with no response ever seen, the child is gone rather than slow.
  noteConnectionRefused(route: LocalgateRoute): void
  {
    const reference = Date.parse(route.lastResponseAt ?? route.startedAt);
    const withinGrace = this.now() - reference < LocalgateHealth.startupGraceMsConst;
    this.registry.update(route.id, { state: withinGrace ? "starting" : "dead" });
  }

  // `localgate restart` refuses an alias, because there is no process localgate owns to restart, so the
  // two kinds cannot share the closing advice.
  unresponsiveMessage(route: LocalgateRoute): string
  {
    const stalled = [
      `localgate: ${route.names[0]} is not responding.`,
      "",
      `The server accepted the connection but did not answer ${LocalgateHealth.failuresBeforeUnresponsiveConst} requests in a row`,
      `(${LocalgateHealth.requestTimeoutMsConst / 1000} s each). It is wedged, or it is paused in a debugger.`,
      ""
    ];

    if (route.kind == "app")
      return [
        ...stalled,
        "Restart it with:",
        `  localgate restart ${LocalgateNames.shortName(route.names[0])}`,
        `  (or run localgate restart in ${route.cwd ?? route.names[0]})`,
        ""
      ].join("\n");
    else if (route.kind == "alias")
      return [
        ...stalled,
        `The alias points at 127.0.0.1:${route.port}, a process localgate does not own, so restart it`,
        "yourself. Drop the alias with:",
        `  localgate alias --remove ${LocalgateNames.shortName(route.names[0])}`,
        ""
      ].join("\n");
    else
      throw new Error(`Unknown route kind: ${JSON.stringify(route.kind)}`);
  }

  // An alias points at a process localgate does not own, so neither half of the app advice applies to it:
  // there is no editor to start it from, and `prune` deliberately leaves aliases alone.
  deadMessage(route: LocalgateRoute): string
  {
    if (route.kind == "app")
      return [
        `localgate: nothing is listening for ${route.names[0]}.`,
        "",
        "The route is registered but its dev server is gone. Start it again from your editor,",
        "or run localgate prune to drop the route.",
        ""
      ].join("\n");
    else if (route.kind == "alias")
      return [
        `localgate: nothing is listening for ${route.names[0]}.`,
        "",
        `The alias points at 127.0.0.1:${route.port} and nothing answers there. Start whatever should`,
        "listen on that port, or drop the alias with:",
        `  localgate alias --remove ${LocalgateNames.shortName(route.names[0])}`,
        ""
      ].join("\n");
    else
      throw new Error(`Unknown route kind: ${JSON.stringify(route.kind)}`);
  }

  startingMessage(route: LocalgateRoute): string
  {
    return `localgate: ${route.names[0]} is still starting. Reload in a moment.\n`;
  }

  private async considerAutomaticRestart(route: LocalgateRoute): Promise<void>
  {
    if (!this.autoRestart) return;

    // The one refusal that is not a threshold: a paused debug session looks exactly like a wedge, and
    // killing it would destroy the session the developer is standing in.
    if (route.debuggerAttached) return;
    if (!route.controlUrl) return;

    const attempts = this.automaticAttempts.get(route.id) ?? 0;
    if (attempts >= LocalgateHealth.maxAutomaticAttemptsConst) return;

    const previous = this.lastAutomaticRestart.get(route.id);
    if (previous !== undefined && this.now() - previous < LocalgateHealth.cooldownMsConst) return;

    this.lastAutomaticRestart.set(route.id, this.now());
    this.automaticAttempts.set(route.id, attempts + 1);
    this.failures.delete(route.id);

    process.stderr.write(`localgate: ${route.names[0]} unresponsive, automatic restart ${attempts + 1}\n`);
    try
    {
      await this.requestRestart(route);
    }
    catch (error)
    {
      process.stderr.write(`localgate: automatic restart of ${route.names[0]} failed: ${String(error)}\n`);
    }
  }
}
