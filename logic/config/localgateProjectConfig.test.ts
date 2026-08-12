import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalgateProjectConfig } from "./localgateProjectConfig.ts";

describe("LocalgateProjectConfig", () =>
{
  const writeProject = (packageJson: unknown): string =>
  {
    const directory = mkdtempSync(join(tmpdir(), "localgate-project-"));
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
    return directory;
  };

  it("defaults to mode local with the package name, so an unconfigured project stays on .localhost", () =>
  {
    const directory = writeProject({ name: "myapp" });
    const settings = LocalgateProjectConfig.load(directory);
    expect(settings.mode).toBe("local");
    expect(settings.name).toBe("myapp");
  });

  it("reads mode lan", () =>
  {
    const directory = writeProject({ name: "myapp", localgate: { mode: "lan" } });
    expect(LocalgateProjectConfig.load(directory).mode).toBe("lan");
  });

  it("reads mode internet", () =>
  {
    const directory = writeProject({ name: "myshop", localgate: { mode: "internet" } });
    expect(LocalgateProjectConfig.load(directory).mode).toBe("internet");
  });

  it("throws on an unknown mode instead of silently serving it locally", () =>
  {
    const directory = writeProject({ name: "web", localgate: { mode: "public" } });
    expect(() => LocalgateProjectConfig.load(directory)).toThrow(/must be local, lan or internet/);
  });

  it("throws when the key is not an object", () =>
  {
    const directory = writeProject({ name: "web", localgate: "lan" });
    expect(() => LocalgateProjectConfig.load(directory)).toThrow(/must be an object/);
  });

  it("prefers an explicit name override", () =>
  {
    const directory = writeProject({ name: "myapp", localgate: { mode: "lan", name: "shortname" } });
    expect(LocalgateProjectConfig.load(directory).name).toBe("shortname");
  });

  it("drops an npm scope, which cannot be part of a hostname", () =>
  {
    const directory = writeProject({ name: "@acme/admin" });
    expect(LocalgateProjectConfig.load(directory).name).toBe("admin");
  });

  it("rejects a package name that cannot be a hostname label", () =>
  {
    const directory = writeProject({ name: "My_App" });
    expect(() => LocalgateProjectConfig.load(directory)).toThrow(/not usable as a hostname label/);
  });

  it("finds the project from a nested directory, so a command works anywhere in the tree", () =>
  {
    const directory = writeProject({ name: "myapp", localgate: { mode: "lan" } });
    const nested = join(directory, "app", "blog", "_components");
    mkdirSync(nested, { recursive: true });

    const settings = LocalgateProjectConfig.load(nested);
    expect(settings.packageDirectory).toBe(directory);
    expect(settings.mode).toBe("lan");
  });
});
