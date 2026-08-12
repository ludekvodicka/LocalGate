import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LocalgateMachineSettings =
{
  label: string;
  baseDomain: string;
  lanIp: string;
  autoRestart: boolean;
  // null leaves the port to the platform default. Set it only when the machine has arranged for
  // something else - a capability that permits 80 on Linux, or another port because 8080 is taken.
  proxyPort: number | null;
};

export class LocalgateMachineConfig
{
  private static readonly labelPatternConst = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

  static filePath(): string
  {
    return join(homedir(), ".localgate", "config.json");
  }

  // null means there is no machine config, which is a complete answer: every project stays on
  // `.localhost` and no external name exists anywhere. A fresh checkout behaves this way.
  static load(filePath: string = LocalgateMachineConfig.filePath()): LocalgateMachineSettings | null
  {
    let raw: string;
    try
    {
      raw = readFileSync(filePath, "utf8");
    }
    catch
    {
      return null;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const label = LocalgateMachineConfig.requireString(parsed, "label", filePath);
    if (!LocalgateMachineConfig.labelPatternConst.test(label))
      throw new Error(`${filePath}: "label" must be a DNS label (lowercase letters, digits, hyphens), got "${label}"`);

    return {
      label,
      baseDomain: LocalgateMachineConfig.requireString(parsed, "baseDomain", filePath),
      lanIp: LocalgateMachineConfig.requireString(parsed, "lanIp", filePath),
      autoRestart: parsed.autoRestart === true,
      proxyPort: LocalgateMachineConfig.optionalPort(parsed, "proxyPort", filePath)
    };
  }

  private static optionalPort(parsed: Record<string, unknown>, key: string, filePath: string): number | null
  {
    const value = parsed[key];
    if (value === undefined || value === null) return null;
    if (typeof value != "number" || !Number.isInteger(value) || value < 1 || value > 65_535)
      throw new Error(`${filePath}: "${key}" must be a port number between 1 and 65535`);
    return value;
  }

  static externalSuffix(settings: LocalgateMachineSettings): string
  {
    return `.${settings.label}.${settings.baseDomain}`;
  }

  private static requireString(parsed: Record<string, unknown>, key: string, filePath: string): string
  {
    const value = parsed[key];
    if (typeof value != "string" || value.length == 0)
      throw new Error(`${filePath}: "${key}" must be a non-empty string`);
    return value;
  }
}
