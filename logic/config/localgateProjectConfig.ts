import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export type LocalgateMode = "local" | "lan" | "internet";

export type LocalgateProjectSettings =
{
  name: string;
  mode: LocalgateMode;
  packageDirectory: string;
};

export class LocalgateProjectConfig
{
  private static readonly namePatternConst = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

  static load(startDirectory: string): LocalgateProjectSettings
  {
    const packageDirectory = LocalgateProjectConfig.findPackageDirectory(startDirectory);
    if (!packageDirectory)
      return { name: LocalgateProjectConfig.nameFromDirectory(startDirectory), mode: "local", packageDirectory: startDirectory };

    const parsed = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as Record<string, unknown>;
    const key = parsed.localgate;

    return {
      name: LocalgateProjectConfig.resolveName(key, parsed.name, packageDirectory),
      mode: LocalgateProjectConfig.resolveMode(key, packageDirectory),
      packageDirectory
    };
  }

  static findPackageDirectory(startDirectory: string): string | null
  {
    let directory = startDirectory;
    for (;;)
    {
      try
      {
        readFileSync(join(directory, "package.json"), "utf8");
        return directory;
      }
      catch
      {
        const parent = dirname(directory);
        if (parent == directory) return null;
        directory = parent;
      }
    }
  }

  // A missing key means mode `local`: names on `.localhost` only, no rewriting, no external name. That
  // is why a project that must leave no trace of our infrastructure needs no configuration at all.
  private static resolveMode(key: unknown, packageDirectory: string): LocalgateMode
  {
    if (key === undefined || key === null) return "local";
    if (typeof key != "object" || Array.isArray(key))
      throw new Error(`${packageDirectory}/package.json: "localgate" must be an object, got ${JSON.stringify(key)}`);

    const mode = (key as Record<string, unknown>).mode;
    if (mode === undefined) return "local";
    if (mode == "local") return "local";
    else if (mode == "lan") return "lan";
    else if (mode == "internet") return "internet";
    else
      throw new Error(`${packageDirectory}/package.json: "localgate.mode" must be local, lan or internet, got ${JSON.stringify(mode)}`);
  }

  private static resolveName(key: unknown, packageName: unknown, packageDirectory: string): string
  {
    const override = typeof key == "object" && key !== null ? (key as Record<string, unknown>).name : undefined;
    if (typeof override == "string" && override.length > 0)
      return LocalgateProjectConfig.requireHostnameLabel(override, `${packageDirectory}/package.json: "localgate.name"`);

    if (typeof packageName == "string" && packageName.length > 0)
    {
      // A scoped name (@org/web) is not a usable hostname label, so the scope is dropped the way
      // portless dropped it: the package's own short name is what a person types into the browser.
      const short = packageName.startsWith("@") ? packageName.slice(packageName.indexOf("/") + 1) : packageName;
      return LocalgateProjectConfig.requireHostnameLabel(short, `${packageDirectory}/package.json: "name"`);
    }

    return LocalgateProjectConfig.nameFromDirectory(packageDirectory);
  }

  private static nameFromDirectory(directory: string): string
  {
    return basename(directory).toLowerCase();
  }

  private static requireHostnameLabel(value: string, source: string): string
  {
    if (!LocalgateProjectConfig.namePatternConst.test(value))
      throw new Error(`${source} is not usable as a hostname label (lowercase letters, digits, hyphens): "${value}"`);
    return value;
  }
}
