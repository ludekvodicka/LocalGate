import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalgateConfigReporter } from "./localgateConfigReport.ts";

describe("LocalgateConfigReporter", () =>
{
  const created: string[] = [];
  const previousProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;

  // homedir() reads USERPROFILE on Windows and HOME elsewhere, which is the seam that lets this test
  // report on a fake machine instead of the one it runs on.
  function fakeHome(machine?: Record<string, unknown>): string
  {
    const home = mkdtempSync(join(tmpdir(), "localgate-report-"));
    created.push(home);
    process.env.USERPROFILE = home;
    process.env.HOME = home;

    if (machine)
    {
      mkdirSync(join(home, ".localgate"), { recursive: true });
      writeFileSync(join(home, ".localgate", "config.json"), JSON.stringify(machine));
    }
    return home;
  }

  function fakeProject(home: string, name: string, mode?: string): string
  {
    const directory = join(home, "project");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"),
      JSON.stringify(mode ? { name, localgate: { mode } } : { name }));
    return directory;
  }

  afterEach(() =>
  {
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    for (const directory of created) rmSync(directory, { recursive: true, force: true });
    created.length = 0;
  });

  it("reports the machine config and the port it implies", () =>
  {
    fakeHome({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10", publicPrefix: "pub" });

    const report = LocalgateConfigReporter.build(null);

    expect(report.machine?.label).toBe("dev");
    expect(report.machine?.publicPrefix).toBe("pub");
    expect(report.proxyPort).toBe(process.platform == "win32" ? 80 : 8080);
    expect(report.project).toBe(null);
    expect(report.names).toBe(null);
  });

  it("reports the alias file and how many aliases will come back with the proxy", () =>
  {
    const home = fakeHome({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10" });
    const aliasFile = join(home, ".localgate", "aliases.json");
    writeFileSync(aliasFile, JSON.stringify({ aliases: [{ name: "myapp", port: 8_001 }] }));

    expect(LocalgateConfigReporter.build(null).aliases).toEqual({ filePath: aliasFile, count: 1 });
  });

  it("reports zero aliases on a machine that never registered one", () =>
  {
    fakeHome();

    expect(LocalgateConfigReporter.build(null).aliases.count).toBe(0);
  });

  it("derives all three names for a project", () =>
  {
    const home = fakeHome({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10", publicPrefix: "pub" });
    const directory = fakeProject(home, "myapp", "internet");

    const report = LocalgateConfigReporter.build(directory);

    expect(report.project?.name).toBe("myapp");
    expect(report.project?.mode).toBe("internet");
    expect(report.names).toEqual({
      local: "myapp.localhost",
      lan: "myapp.dev.example.com",
      public: "pub-myapp.example.com"
    });
  });

  it("leaves the public name empty when the machine has no prefix", () =>
  {
    const home = fakeHome({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10" });
    const directory = fakeProject(home, "myapp");

    const report = LocalgateConfigReporter.build(directory);

    expect(report.names?.public).toBe(null);
    expect(report.names?.lan).toBe("myapp.dev.example.com");
    expect(report.project?.mode).toBe("local");
  });

  it("reports a machine that has no config at all", () =>
  {
    const home = fakeHome();
    const directory = fakeProject(home, "myapp");

    const report = LocalgateConfigReporter.build(directory);

    expect(report.machine).toBe(null);
    expect(report.names).toEqual({ local: "myapp.localhost", lan: null, public: null });
  });
});
