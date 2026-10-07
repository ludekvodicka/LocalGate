import { LocalgateAliasStore } from "../config/localgateAliasStore.ts";
import { LocalgateMachineConfig, type LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import { LocalgateNames } from "../config/localgateNames.ts";
import { LocalgateRunnerControl } from "../run/localgateRunnerControl.ts";
import { LocalgateShellCommand } from "../run/localgateShellCommand.ts";
import { LocalgateAliasRoute } from "./localgateAliasRoute.ts";
import { LocalgateUrl } from "./localgateUrl.ts";
import { LocalgateControlApi } from "./localgateControlApi.ts";
import { LocalgateHealth } from "./localgateHealth.ts";
import { LocalgateProxy } from "./localgateProxy.ts";
import { LocalgateRegistry, type LocalgateRoute } from "./localgateRegistry.ts";
import { LocalgateStartPage } from "./localgateStartPage.ts";

// Boots the long-lived half of localgate. Started on demand by the first `run` or `alias`, and it exits
// once the last route disappears, so nothing is installed and nothing runs when no dev server does.
export class LocalgateProxyHost
{
  private static readonly gracePeriodMsConst = 20_000;

  static async run(): Promise<void>
  {
    const machine = LocalgateMachineConfig.load();
    const port = LocalgateUrl.proxyPort(machine);
    const registry = new LocalgateRegistry();
    const health = new LocalgateHealth(registry, machine?.autoRestart === true,
      route => LocalgateProxyHost.request(route, "restart"));

    const proxy: LocalgateProxy = new LocalgateProxy(
      registry,
      health,
      new LocalgateControlApi(registry, () => proxy.checkIdle()),
      // The configured port rather than the bound one, because the page writes addresses for a person to
      // click, and those are the names and the port they would have typed themselves.
      new LocalgateStartPage(registry, machine, port, {
        // Read at each render rather than held from boot, so an alias that gains a stop command gets
        // its button without restarting the proxy every dev server on this machine depends on.
        aliasStopCommands: () => LocalgateAliasStore.stopCommands(),
        stop: route => LocalgateProxyHost.stop(route)
      }),
      {
        port,
        lanIp: machine?.lanIp ?? null,
        gracePeriodMs: LocalgateProxyHost.gracePeriodMsConst,
        onIdle: () =>
        {
          process.stdout.write("localgate: no routes left, stopping\n");
          void proxy.stop().then(() => process.exit(0));
        }
      }
    );

    LocalgateProxyHost.restoreAliases(registry, machine);

    await proxy.start();
    process.stdout.write(`localgate proxy listening on 127.0.0.1:${port}`
      + `${machine?.lanIp ? ` and ${machine.lanIp}:${port}` : ""}\n`
      + `localgate: start page at ${LocalgateStartPage.localUrl(port)}\n`);

    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => void proxy.stop().then(() => process.exit(0)));
  }

  // Runs before `start()`, whose last step is the idle check: routes registered by then keep the fresh
  // proxy from scheduling its own exit, exactly as a live alias does.
  private static restoreAliases(registry: LocalgateRegistry, machine: LocalgateMachineSettings | null): void
  {
    const restored = LocalgateAliasRoute.restore(registry, LocalgateAliasStore.load(), machine, new Date().toISOString());
    for (const line of restored) process.stdout.write(`${line}\n`);
  }

  // Two kinds of route, two ways to end one. An app has a runner, and only the runner can end the child
  // tree, release the port and deregister its own route. An alias has nothing of ours behind it, so all
  // that can be done is to run the line the machine's owner wrote for it.
  static async stop(route: LocalgateRoute): Promise<void>
  {
    if (route.controlUrl) return LocalgateProxyHost.request(route, "stop");

    const name = LocalgateNames.shortName(route.names[0]!);
    const command = LocalgateAliasStore.stopCommands().get(name);
    if (!command) throw new Error(`${name} is an alias with no stop command in ${LocalgateAliasStore.filePath()}`);

    await LocalgateShellCommand.run(command);
  }

  // The proxy never kills anything itself: it asks the runner that owns the process, which is the only
  // one that can end the child tree, release the port and deregister its own route.
  private static async request(route: LocalgateRoute, action: "restart" | "stop"): Promise<void>
  {
    if (!route.controlUrl) throw new Error(`route ${route.names[0]} has no control endpoint`);

    const response = await fetch(`${route.controlUrl}/${action}`, { method: "POST" });
    // With the reason the runner wrote, not the status alone: this message is what the start page shows
    // its reader, and a bare `409` there sends them to a terminal to find out what the kill hit.
    if (!response.ok)
      throw new Error(`control endpoint answered ${response.status}`
        + LocalgateRunnerControl.refusalDetail(await response.text().catch(() => "")));
  }
}
