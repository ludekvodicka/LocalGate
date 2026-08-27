import { LocalgateProxyClient } from "../client/localgateProxyClient.ts";
import { LocalgateBanner } from "./localgateBanner.ts";
import { LocalgateCloudflareInfo } from "../cloudflare/localgateCloudflareInfo.ts";
import { LocalgateAliasStore } from "../config/localgateAliasStore.ts";
import { LocalgateMachineConfig } from "../config/localgateMachineConfig.ts";
import { LocalgateNames } from "../config/localgateNames.ts";
import { LocalgateProjectConfig } from "../config/localgateProjectConfig.ts";
import { LocalgateConfigReporter } from "../config/localgateConfigReport.ts";
import { LocalgateAliasRoute } from "../proxy/localgateAliasRoute.ts";
import { LocalgateProxyHost } from "../proxy/localgateProxyHost.ts";
import { LocalgateUrl } from "../proxy/localgateUrl.ts";
import { LocalgateRouteConflictError } from "../proxy/localgateRegistry.ts";
import type { LocalgateRoute } from "../proxy/localgateRegistry.ts";
import { LocalgateRunner } from "../run/localgateRunner.ts";

export class LocalgateCli
{
  static async main(args: string[]): Promise<number>
  {
    const command = args[0];
    const rest = args.slice(1);

    if (command === undefined || command == "help" || command == "--help" || command == "-h")
    {
      LocalgateCli.printUsage();
      return 0;
    }

    if (command == "run")
    {
      const { force, command: childCommand } = LocalgateRunner.parseOptions(rest);
      return new LocalgateRunner(childCommand, process.cwd(), force).run();
    }
    // Internal: how a runner brings the resident half up. Not in the usage text on purpose.
    else if (command == "__proxy") { await LocalgateProxyHost.run(); return 0; }
    else if (command == "list") return LocalgateCli.list(rest.includes("--json"));
    else if (command == "status") return LocalgateCli.status(rest);
    else if (command == "restart") return LocalgateCli.control(rest, "restart");
    else if (command == "stop") return LocalgateCli.control(rest, "stop");
    else if (command == "logs") return LocalgateCli.logs(rest);
    else if (command == "alias") return LocalgateCli.alias(rest);
    else if (command == "config") return LocalgateCli.config(rest);
    else if (command == "cloudflare-info") return LocalgateCli.cloudflareInfo();
    else if (command == "prune") return LocalgateCli.prune();
    else
    {
      process.stderr.write(`localgate: unknown command "${command}"\n\n`);
      LocalgateCli.printUsage();
      return 1;
    }
  }

  private static async list(asJson: boolean): Promise<number>
  {
    const routes = await LocalgateProxyClient.list();

    if (asJson)
    {
      process.stdout.write(`${JSON.stringify({ routes }, null, 2)}\n`);
      return 0;
    }

    if (routes.length == 0)
    {
      process.stdout.write("No routes. Nothing is running, and the proxy is not needed until something is.\n");

      const dormant = LocalgateAliasStore.load().length;
      if (dormant > 0)
        process.stdout.write(`${dormant} alias(es) will answer again when the proxy next starts.\n`);

      return 0;
    }

    process.stdout.write("Active routes:\n\n");
    const proxyPort = LocalgateProxyClient.proxyPort();
    for (const route of routes)
    {
      process.stdout.write(`  ${LocalgateCli.routeUrls(route, proxyPort).join("\n  ")}\n`);
      process.stdout.write(`      -> 127.0.0.1:${route.port}  [${route.state}]  ${route.kind}`
        + `${route.debuggerAttached ? "  debugger" : ""}\n`);
      if (route.cwd) process.stdout.write(`      ${route.cwd}\n`);
      process.stdout.write("\n");
    }

    return 0;
  }

  // Read-only: what this machine and this project are configured as, and the names that follow from it.
  // Other tools ask for this instead of parsing ~/.localgate/config.json and re-deriving the names, which
  // is how two copies of the same rules start to drift.
  private static config(args: string[]): number
  {
    const asJson = args.includes("--json");
    const directory = args.find(argument => !argument.startsWith("--")) ?? process.cwd();
    const report = LocalgateConfigReporter.build(directory);

    if (asJson)
    {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }

    process.stdout.write([
      `machine config  ${report.machineFilePath}${report.machine ? "" : " (missing - this machine serves .localhost only)"}`,
      `label           ${report.machine?.label ?? "-"}`,
      `base domain     ${report.machine?.baseDomain ?? "-"}`,
      `lan ip          ${report.machine?.lanIp ?? "-"}`,
      `public prefix   ${report.machine?.publicPrefix ?? "-"}`,
      `proxy port      ${report.proxyPort}`,
      `project         ${report.project ? `${report.project.name} (${report.project.mode})` : "-"}`,
      `local name      ${report.names?.local ?? "-"}`,
      `lan name        ${report.names?.lan ?? "-"}`,
      `public name     ${report.names?.public ?? "-"}`,
      `aliases         ${report.aliases.filePath} (${report.aliases.count})`,
      ""
    ].join("\n"));
    return 0;
  }

  private static async status(args: string[]): Promise<number>
  {
    const asJson = args.includes("--json");
    const route = await LocalgateCli.resolve(args.find(argument => !argument.startsWith("--")));

    if (!route)
    {
      const message = { running: false, reason: "no route for this directory or name" };
      process.stdout.write(asJson ? `${JSON.stringify(message, null, 2)}\n` : `${message.reason}\n`);
      return 1;
    }

    if (asJson)
    {
      const logs = await LocalgateCli.fetchLogs(route, 20);
      process.stdout.write(`${JSON.stringify({ ...route, logTail: logs }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write([
      LocalgateCli.routeUrls(route, LocalgateProxyClient.proxyPort()).join("\n"),
      `port        127.0.0.1:${route.port}`,
      `state       ${route.state}`,
      `mode        ${route.mode}`,
      `command     ${route.command ?? "-"}`,
      `directory   ${route.cwd ?? "-"}`,
      `pids        runner ${route.runnerPid ?? "-"}, child ${route.childPid ?? "-"}`,
      `debugger    ${route.debuggerAttached ? "attached" : "no"}`,
      `started     ${route.startedAt}`,
      ""
    ].join("\n"));

    return 0;
  }

  private static async control(args: string[], action: "restart" | "stop"): Promise<number>
  {
    const route = await LocalgateCli.resolve(args.find(argument => !argument.startsWith("--")));
    if (!route) return LocalgateCli.reportUnresolved();

    if (!route.controlUrl)
    {
      process.stderr.write(`localgate: ${route.names[0]} is an alias, there is no process to ${action}\n`);
      return 1;
    }

    const response = await fetch(`${route.controlUrl}/${action}`, { method: "POST" });
    if (!response.ok)
    {
      process.stderr.write(`localgate: ${action} failed, the runner answered ${response.status}\n`);
      return 1;
    }

    process.stdout.write(`localgate: ${route.names[0]} ${action == "restart" ? "restarted" : "stopped"}\n`);
    return 0;
  }

  private static async logs(args: string[]): Promise<number>
  {
    const linesIndex = args.indexOf("--lines");
    const lines = linesIndex >= 0 ? Number.parseInt(args[linesIndex + 1] ?? "80", 10) : 80;
    const route = await LocalgateCli.resolve(args.find((argument, index) =>
      !argument.startsWith("--") && index != linesIndex + 1));

    if (!route) return LocalgateCli.reportUnresolved();

    const collected = await LocalgateCli.fetchLogs(route, lines);
    process.stdout.write(collected.length > 0 ? `${collected.join("\n")}\n` : "no output captured yet\n");
    return 0;
  }

  private static async alias(args: string[]): Promise<number>
  {
    if (args[0] == "--remove") return LocalgateCli.aliasRemove(args[1]);

    const [name, portText] = args;
    const port = Number.parseInt(portText ?? "", 10);

    if (!name || !Number.isFinite(port))
    {
      process.stderr.write("localgate: usage is localgate alias <name> <port>\n");
      return 1;
    }

    // The store applies exactly these two rules when it reads the file back, so anything refused here
    // would otherwise register, print a banner, and be dropped without a word at the next proxy boot.
    if (!LocalgateMachineConfig.isLabel(name) || !LocalgateAliasStore.isPort(port))
    {
      process.stderr.write(`localgate: ${name} ${portText} cannot be an alias. The name must be a DNS `
        + "label (lowercase letters, digits, hyphens) and the port a number from 1 to 65535.\n");
      return 1;
    }

    const machine = LocalgateMachineConfig.load();

    if (port == LocalgateUrl.proxyPort(machine))
    {
      process.stderr.write(`localgate: port ${port} is localgate's own port, so the alias would only `
        + "send requests back to the proxy. Point it at the port the service listens on.\n");
      return 1;
    }

    await LocalgateProxyClient.ensureRunning();

    let route: LocalgateRoute;
    try
    {
      route = await LocalgateProxyClient.register(LocalgateAliasRoute.registration(name, port, machine));
    }
    catch (error)
    {
      if (!(error instanceof LocalgateRouteConflictError)) throw error;

      process.stderr.write(`localgate: ${name} is the name of a running dev server `
        + `(${error.existing.command ?? "?"} in ${error.existing.cwd ?? "?"}), so an alias cannot take it.\n`);
      return 1;
    }

    // Only once the proxy took the name: a refused registration must not leave an entry that the next
    // proxy boot would restore. A disk failure here is worth saying out loud rather than throwing over
    // the banner, because the alias is already live and useful - it just will not come back.
    try
    {
      LocalgateAliasStore.add({ name, port });
    }
    catch (error)
    {
      process.stderr.write(`localgate: ${name} is live, but ${LocalgateAliasStore.filePath()} could not `
        + `be written, so it will not survive a proxy restart: ${String(error)}\n`);
    }

    process.stdout.write(LocalgateBanner.render(route, LocalgateProxyClient.proxyPort()));
    return 0;
  }

  // Removal has to work with the proxy down, because an alias outliving the proxy is the whole point of
  // persisting it. With nothing listening, dropping the file entry IS the removal: the only other reader
  // of the file is the next proxy boot.
  private static async aliasRemove(argument: string | undefined): Promise<number>
  {
    if (!argument)
    {
      process.stderr.write("localgate: usage is localgate alias --remove <name>\n");
      return 1;
    }

    // The store knows an alias by the short name it was registered under, while a route answers to its
    // full hostnames too - and those are the names a person reads in `localgate list`. Reduce once, so
    // the route and the file cannot end up disagreeing about what was removed.
    const name = LocalgateNames.shortName(argument);
    const route = await LocalgateProxyClient.resolve({ name });

    // An app that took an alias's name evicts the route but not the intent, so the entry has to go even
    // here - otherwise the alias comes back at the next proxy boot and nothing can stop it.
    if (route && route.kind != "alias")
    {
      const forgotten = LocalgateAliasStore.remove(name);
      if (forgotten)
      {
        process.stdout.write(`localgate: ${name} is a running dev server, so its route stays. `
          + "The persisted alias of that name was removed.\n");
        return 0;
      }

      process.stderr.write(`localgate: ${name} is a running dev server, not an alias\n`);
      return 1;
    }

    if (route) await LocalgateProxyClient.deregister(route.id);
    const dropped = LocalgateAliasStore.remove(name);

    if (!route && !dropped)
    {
      process.stderr.write(`localgate: no alias named ${name}\n`);
      return 1;
    }

    process.stdout.write(`localgate: alias ${name} removed\n`);
    return 0;
  }

  private static cloudflareInfo(): number
  {
    const machine = LocalgateMachineConfig.load();
    if (!machine)
    {
      process.stderr.write(`localgate: no machine config at ${LocalgateMachineConfig.filePath()}, `
        + "so this machine serves .localhost only\n");
      return 1;
    }

    const project = LocalgateProjectConfig.load(process.cwd());
    const publicName = LocalgateNames.publicName(project.name, machine);
    if (!publicName)
    {
      process.stderr.write(`localgate: ${LocalgateMachineConfig.filePath()} has no publicPrefix\n`);
      return 1;
    }

    if (project.mode != "internet")
      process.stdout.write(`Note: this project's mode is "${project.mode}". Set it to "internet" `
        + "in package.json when you actually want the entries below to be live.\n\n");

    process.stdout.write(LocalgateCloudflareInfo.render(
      publicName,
      machine.lanIp,
      LocalgateUrl.proxyPort(machine)
    ));

    return 0;
  }

  private static async prune(): Promise<number>
  {
    const routes = await LocalgateProxyClient.list();
    let dropped = 0;

    for (const route of routes)
    {
      if (!route.controlUrl) continue;

      const alive = await fetch(`${route.controlUrl}/ping`, { signal: AbortSignal.timeout(1_000) })
        .then(response => response.ok)
        .catch(() => false);

      if (alive) continue;

      await LocalgateProxyClient.deregister(route.id);
      process.stdout.write(`dropped ${route.names[0]} (its runner is gone)\n`);
      dropped++;
    }

    if (dropped == 0) process.stdout.write("nothing to prune\n");
    return 0;
  }

  private static async fetchLogs(route: LocalgateRoute, lines: number): Promise<string[]>
  {
    if (!route.controlUrl) return [];

    return fetch(`${route.controlUrl}/logs?lines=${lines}`, { signal: AbortSignal.timeout(2_000) })
      .then(response => response.json() as Promise<{ lines: string[] }>)
      .then(payload => payload.lines)
      .catch(() => []);
  }

  private static resolve(selector: string | undefined): Promise<LocalgateRoute | null>
  {
    return selector
      ? LocalgateProxyClient.resolve({ name: selector })
      : LocalgateProxyClient.resolve({ directory: process.cwd() });
  }

  private static reportUnresolved(): number
  {
    process.stderr.write("localgate: no route for this directory or name. "
      + "Start the dev server from your editor, or pass the app name.\n");
    return 1;
  }

  private static routeUrls(route: LocalgateRoute, proxyPort: number): string[]
  {
    return route.names.map((name, index) => route.mode == "internet" && index == 2
      ? `https://${name}`
      : LocalgateUrl.forName(name, proxyPort));
  }

  private static printUsage(): void
  {
    process.stdout.write(
      "localgate - stable names for local dev servers\n\n" +
      "  localgate run [--force] <cmd...>  run a dev server behind its name\n" +
      "                                  --force takes over a running one without asking\n" +
      "  localgate list [--json]         show active routes\n" +
      "  localgate status [app] [--json] state of one route (defaults to this directory)\n" +
      "  localgate restart [app]         restart a route's dev server\n" +
      "  localgate stop [app]            stop a route's dev server\n" +
      "  localgate logs [app] [--lines N]  tail a route's captured output\n" +
      "  localgate alias <name> <port>   register a static route (e.g. a docker service); it is\n" +
      "                                  remembered and comes back when the proxy restarts\n" +
      "  localgate alias --remove <name> drop a static route and forget it\n" +
      "  localgate config [dir] [--json] machine + project config and the names it implies\n" +
      "  localgate cloudflare-info       print the DNS and ingress entries to paste\n" +
      "  localgate prune                 drop routes whose runner is gone\n\n" +
      "[app] is optional: with no argument a command acts on the route owning the current directory.\n"
    );
  }
}
