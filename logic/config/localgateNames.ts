import type { LocalgateMachineSettings } from "./localgateMachineConfig.ts";
import type { LocalgateMode } from "./localgateProjectConfig.ts";

export class LocalgateNames
{
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
