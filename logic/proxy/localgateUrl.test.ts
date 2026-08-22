import { describe, expect, it } from "vitest";
import { LocalgateUrl } from "./localgateUrl.ts";
import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";

describe("LocalgateUrl", () =>
{
  const machine = (proxyPort: number | null = null): LocalgateMachineSettings => ({
    label: "dev",
    baseDomain: "example.com",
    lanIp: "192.0.2.10",
    publicPrefix: null,
    autoRestart: false,
    proxyPort
  });

  it("binds 80 on Windows and 8080 where that would need root", () =>
  {
    expect(LocalgateUrl.proxyPort(null, "win32")).toBe(80);
    expect(LocalgateUrl.proxyPort(null, "linux")).toBe(8080);
    expect(LocalgateUrl.proxyPort(null, "darwin")).toBe(8080);
  });

  it("lets a machine that arranged the privilege ask for 80 anywhere", () =>
  {
    expect(LocalgateUrl.proxyPort(machine(80), "linux")).toBe(80);
    expect(LocalgateUrl.proxyPort(machine(9000), "win32")).toBe(9000);
  });

  it("keeps the port out of a URL only when it is the one a browser assumes", () =>
  {
    expect(LocalgateUrl.forName("web.localhost", 80)).toBe("http://web.localhost");
    expect(LocalgateUrl.forName("web.localhost", 8080)).toBe("http://web.localhost:8080");
    expect(LocalgateUrl.forName("web.dev.example.com", 8080)).toBe("http://web.dev.example.com:8080");
  });
});
