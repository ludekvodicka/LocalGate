import { describe, expect, it } from "vitest";
import type { LocalgateMachineSettings } from "./localgateMachineConfig.ts";
import { LocalgateNames } from "./localgateNames.ts";

describe("LocalgateNames", () =>
{
  const machine = (publicPrefix: string | null = "pub"): LocalgateMachineSettings => ({
    label: "dev",
    baseDomain: "example.com",
    lanIp: "192.0.2.10",
    publicPrefix,
    autoRestart: false,
    proxyPort: null
  });

  it("maps all three exposure modes to their exact route names", () =>
  {
    expect(LocalgateNames.routeNames("myapp", "local", machine()))
      .toEqual(["myapp.localhost"]);
    expect(LocalgateNames.routeNames("myapp", "lan", machine()))
      .toEqual(["myapp.localhost", "myapp.dev.example.com"]);
    expect(LocalgateNames.routeNames("myapp", "internet", machine()))
      .toEqual(["myapp.localhost", "myapp.dev.example.com", "pub-myapp.example.com"]);
  });

  it("keeps a fresh machine safe when no machine config or public prefix exists", () =>
  {
    expect(LocalgateNames.routeNames("myapp", "internet", null)).toEqual(["myapp.localhost"]);
    expect(LocalgateNames.routeNames("myapp", "internet", machine(null)))
      .toEqual(["myapp.localhost", "myapp.dev.example.com"]);
  });

  it("selects the browser-facing name for each mode", () =>
  {
    expect(LocalgateNames.browserName("myapp", "local", machine())).toBe("myapp.localhost");
    expect(LocalgateNames.browserName("myapp", "lan", machine())).toBe("myapp.dev.example.com");
    expect(LocalgateNames.browserName("myapp", "internet", machine())).toBe("pub-myapp.example.com");
  });

  it("rejects a public label longer than DNS permits", () =>
  {
    expect(() => LocalgateNames.publicName("x".repeat(60), machine("pub")))
      .toThrow(/longer than 63 characters/);
  });
});
