import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalgateMachineConfig } from "./localgateMachineConfig.ts";

describe("LocalgateMachineConfig", () =>
{
  const writeConfig = (contents: unknown): string =>
  {
    const path = join(mkdtempSync(join(tmpdir(), "localgate-machine-")), "config.json");
    writeFileSync(path, typeof contents == "string" ? contents : JSON.stringify(contents));
    return path;
  };

  it("returns null when the file does not exist, which means mode local everywhere", () =>
  {
    expect(LocalgateMachineConfig.load(join(tmpdir(), "localgate-does-not-exist", "config.json"))).toBe(null);
  });

  it("reads label, domain and IP, and leaves autoRestart off unless it is exactly true", () =>
  {
    const path = writeConfig({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10" });
    expect(LocalgateMachineConfig.load(path)).toEqual({
      label: "dev",
      baseDomain: "example.com",
      lanIp: "192.0.2.10",
      autoRestart: false,
      proxyPort: null
    });
  });

  it("honours autoRestart when it is true", () =>
  {
    const path = writeConfig({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10", autoRestart: true });
    expect(LocalgateMachineConfig.load(path)?.autoRestart).toBe(true);
  });

  it("rejects a label that cannot be a DNS label", () =>
  {
    const path = writeConfig({ label: "Bad Label", baseDomain: "example.com", lanIp: "192.0.2.10" });
    expect(() => LocalgateMachineConfig.load(path)).toThrow(/must be a DNS label/);
  });

  it("reads an optional proxy port and refuses one that is not a port", () =>
  {
    const withPort = writeConfig({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10", proxyPort: 80 });
    expect(LocalgateMachineConfig.load(withPort)?.proxyPort).toBe(80);

    const without = writeConfig({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10" });
    expect(LocalgateMachineConfig.load(without)?.proxyPort).toBe(null);

    const bad = writeConfig({ label: "dev", baseDomain: "example.com", lanIp: "192.0.2.10", proxyPort: 70_000 });
    expect(() => LocalgateMachineConfig.load(bad)).toThrow(/"proxyPort" must be a port number/);
  });

  it("rejects a missing required field", () =>
  {
    const path = writeConfig({ label: "dev", lanIp: "192.0.2.10" });
    expect(() => LocalgateMachineConfig.load(path)).toThrow(/"baseDomain" must be a non-empty string/);
  });

  it("builds the external suffix", () =>
  {
    expect(LocalgateMachineConfig.externalSuffix({
      label: "dev",
      baseDomain: "example.com",
      lanIp: "192.0.2.10",
      autoRestart: false,
      proxyPort: null
    })).toBe(".dev.example.com");
  });
});
