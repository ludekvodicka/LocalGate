import type { LocalgateMachineSettings } from "./localgateMachineConfig.ts";
import type { LocalgateMode } from "./localgateProjectConfig.ts";

export class LocalgateNames
{
  // The start page answers on this label instead of a route, on `.localhost` and on the machine's own
  // domain. It is resolved before the route table, so a project or alias holding the same name would be
  // registered, listed and never reached - refused at registration instead.
  static readonly startNameConst = "start";

  private static readonly dnsLabelMaxLengthConst = 63;

  static local(projectName: string): string
  {
    return `${projectName}.localhost`;
  }

  static lan(projectName: string, machine: LocalgateMachineSettings): string
  {
    return `${projectName}.${machine.label}.${machine.baseDomain}`;
  }

  static publicName(projectName: string, machine: LocalgateMachineSettings): string | null
  {
    if (!machine.publicPrefix) return null;

    const label = `${machine.publicPrefix}-${projectName}`;
    if (label.length > LocalgateNames.dnsLabelMaxLengthConst)
      throw new Error(`public hostname label "${label}" is longer than ${LocalgateNames.dnsLabelMaxLengthConst} characters`);
    return `${label}.${machine.baseDomain}`;
  }

  // The short name a person types, from any of the names a route answers to. Every layer needs it - the
  // banner, the proxy's error pages, the CLI - and each one deriving it again is how they drift apart.
  static shortName(hostname: string): string
  {
    return hostname.split(".")[0];
  }

  // Takes the short name as well as any hostname built from it, because the name arrives as both: a
  // project name from package.json, an alias argument, and a full hostname from `localgate list`.
  static isReserved(name: string): boolean
  {
    return LocalgateNames.shortName(name) == LocalgateNames.startNameConst;
  }

  static routeNames(projectName: string, mode: LocalgateMode, machine: LocalgateMachineSettings | null): string[]
  {
    const local = LocalgateNames.local(projectName);
    if (mode == "local") return [local];
    else if (mode == "lan") return machine ? [local, LocalgateNames.lan(projectName, machine)] : [local];
    else if (mode == "internet")
    {
      if (!machine) return [local];
      const publicName = LocalgateNames.publicName(projectName, machine);
      return publicName ? [local, LocalgateNames.lan(projectName, machine), publicName] : [local, LocalgateNames.lan(projectName, machine)];
    }
    else
      throw new Error(`unknown localgate mode: ${JSON.stringify(mode)}`);
  }

  static browserName(projectName: string, mode: LocalgateMode, machine: LocalgateMachineSettings | null): string
  {
    if (mode == "local") return LocalgateNames.local(projectName);
    else if (mode == "lan") return machine ? LocalgateNames.lan(projectName, machine) : LocalgateNames.local(projectName);
    else if (mode == "internet")
      return machine ? LocalgateNames.publicName(projectName, machine) ?? LocalgateNames.lan(projectName, machine) : LocalgateNames.local(projectName);
    else
      throw new Error(`unknown localgate mode: ${JSON.stringify(mode)}`);
  }
}
