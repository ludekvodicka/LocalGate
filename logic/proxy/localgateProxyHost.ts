import { LocalgateMachineConfig } from "../config/localgateMachineConfig.ts";
import { LocalgateUrl } from "./localgateUrl.ts";
import { LocalgateControlApi } from "./localgateControlApi.ts";
import { LocalgateHealth } from "./localgateHealth.ts";
import { LocalgateProxy } from "./localgateProxy.ts";
import { LocalgateRegistry, type LocalgateRoute } from "./localgateRegistry.ts";

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
    const health = new LocalgateHealth(registry, machine?.autoRestart === true, LocalgateProxyHost.requestRestart);

    const proxy: LocalgateProxy = new LocalgateProxy(
      registry,
      health,
      new LocalgateControlApi(registry, () => proxy.checkIdle()),
      {
        port,
        lanIp: machine?.lanIp ?? null,
        externalSuffix: machine ? LocalgateMachineConfig.externalSuffix(machine) : null,
        gracePeriodMs: LocalgateProxyHost.gracePeriodMsConst,
        onIdle: () =>
        {
          process.stdout.write("localgate: no routes left, stopping\n");
          void proxy.stop().then(() => process.exit(0));
        }
      }
    );

    await proxy.start();
    process.stdout.write(`localgate proxy listening on 127.0.0.1:${port}`
      + `${machine?.lanIp ? ` and ${machine.lanIp}:${port}` : ""}\n`);

    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => void proxy.stop().then(() => process.exit(0)));
  }

  private static async requestRestart(route: LocalgateRoute): Promise<void>
  {
    if (!route.controlUrl) throw new Error(`route ${route.names[0]} has no control endpoint`);

    const response = await fetch(`${route.controlUrl}/restart`, { method: "POST" });
    if (!response.ok) throw new Error(`control endpoint answered ${response.status}`);
  }
}
