import { LocalgateAliasStore } from "./localgateAliasStore.ts";
import { LocalgateMachineConfig, type LocalgateMachineSettings } from "./localgateMachineConfig.ts";
import { LocalgateNames } from "./localgateNames.ts";
import { LocalgateProjectConfig, type LocalgateMode } from "./localgateProjectConfig.ts";
import { LocalgateUrl } from "../proxy/localgateUrl.ts";

export type LocalgateConfigReport =
{
  machineFilePath: string;
  machine: LocalgateMachineSettings | null;
  proxyPort: number;
  project: { name: string; mode: LocalgateMode; packageDirectory: string } | null;
  names: { local: string; lan: string | null; public: string | null } | null;
  aliases: { filePath: string; count: number };
};

// Localgate owns the naming and machine-config rules, so anything that needs them can read them from
// here instead of parsing ~/.localgate/config.json and re-deriving the names. Read-only by design:
// this reports what is configured, it never writes.
export class LocalgateConfigReporter
{
  static build(directory: string | null): LocalgateConfigReport
  {
    const machine = LocalgateMachineConfig.load();
    const report: LocalgateConfigReport = {
      machineFilePath: LocalgateMachineConfig.filePath(),
      machine,
      proxyPort: LocalgateUrl.proxyPort(machine),
      project: null,
      names: null,
      aliases: { filePath: LocalgateAliasStore.filePath(), count: LocalgateAliasStore.load().length }
    };

    if (directory === null) return report;

    const project = LocalgateProjectConfig.load(directory);
    report.project = { name: project.name, mode: project.mode, packageDirectory: project.packageDirectory };
    report.names = {
      local: LocalgateNames.local(project.name),
      lan: machine ? LocalgateNames.lan(project.name, machine) : null,
      public: machine ? LocalgateNames.publicName(project.name, machine) : null
    };
    return report;
  }
}
