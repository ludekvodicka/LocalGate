import { describe, expect, it } from "vitest";
import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import { LocalgateEnvRewrite } from "./localgateEnvRewrite.ts";

describe("LocalgateEnvRewrite", () =>
{
  const machine = (publicPrefix: string | null = "pub"): LocalgateMachineSettings => ({
    label: "dev",
    baseDomain: "example.com",
    lanIp: "192.0.2.10",
    publicPrefix,
    autoRestart: false,
    proxyPort: null
  });

  const pilotEnv = () => ({
    NEXT_PUBLIC_APP_URL: "http://myapp.localhost",
    AUTH_URL: "http://myapp.localhost",
    NEXTAUTH_URL: "http://myapp.localhost/api/auth",
    APP_BACKEND_WAGTAIL_API_PUBLIC_URL: "http://cms.localhost",
    APP_BACKEND_WAGTAIL_API_URL: "http://cms.localhost/api/v2",
    APP_BACKEND_API_URL: "http://api.localhost",
    AUTH_SECRET: "not-a-url"
  });

  it("changes nothing without an external suffix, which is mode local", () =>
  {
    expect(LocalgateEnvRewrite.apply(pilotEnv(), "local", machine(), 80)).toEqual(pilotEnv());
  });

  it("rewrites only the variables a browser reads", () =>
  {
    const result = LocalgateEnvRewrite.apply(pilotEnv(), "lan", machine(), 80);

    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://myapp.dev.example.com");
    expect(result.AUTH_URL).toBe("http://myapp.dev.example.com");
    expect(result.NEXTAUTH_URL).toBe("http://myapp.dev.example.com/api/auth");
    expect(result.APP_BACKEND_WAGTAIL_API_PUBLIC_URL).toBe("http://cms.dev.example.com");
  });

  it("leaves server-only variables on .localhost", () =>
  {
    const result = LocalgateEnvRewrite.apply(pilotEnv(), "lan", machine(), 80);

    expect(result.APP_BACKEND_WAGTAIL_API_URL).toBe("http://cms.localhost/api/v2");
    expect(result.APP_BACKEND_API_URL).toBe("http://api.localhost");
  });

  it("does not add a trailing slash to a bare origin", () =>
  {
    const result = LocalgateEnvRewrite.apply({ NEXT_PUBLIC_APP_URL: "http://web.localhost" }, "lan", machine(), 80);
    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://web.dev.example.com");
  });

  // Behind a proxy that multiplexes by name there is exactly one port a browser-facing URL can mean, so
  // a port written into the value by hand is replaced rather than carried through.
  it("replaces a port already in the value with the one the proxy answers on", () =>
  {
    const result = LocalgateEnvRewrite.apply(
      { NEXT_PUBLIC_APP_URL: "http://web.localhost:3000/x" },
      "lan",
      machine(),
      80
    );
    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://web.dev.example.com/x");
  });

  // Mode local used to mean "rewrite nothing". Where the proxy cannot have 80 that leaves every
  // browser-facing URL pointing at a port with nothing behind it.
  it("adds the proxy port in mode local, where there is no suffix to swap", () =>
  {
    const result = LocalgateEnvRewrite.apply(pilotEnv(), "local", machine(), 8_080);

    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://myapp.localhost:8080");
    expect(result.NEXTAUTH_URL).toBe("http://myapp.localhost:8080/api/auth");
    expect(result.APP_BACKEND_WAGTAIL_API_URL).toBe("http://cms.localhost/api/v2");
  });

  it("carries both the shared name and the port when neither is the default", () =>
  {
    const result = LocalgateEnvRewrite.apply(pilotEnv(), "lan", machine(), 8_080);

    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://myapp.dev.example.com:8080");
    expect(result.AUTH_URL).toBe("http://myapp.dev.example.com:8080");
  });

  it("ignores a value that is not a URL and a host that is not .localhost", () =>
  {
    const result = LocalgateEnvRewrite.apply({
      AUTH_SECRET: "not-a-url",
      NEXT_PUBLIC_CDN_URL: "https://cdn.example.com/assets",
      NEXT_PUBLIC_PLAIN: "web.localhost"
    }, "lan", machine(), 80);

    expect(result.AUTH_SECRET).toBe("not-a-url");
    expect(result.NEXT_PUBLIC_CDN_URL).toBe("https://cdn.example.com/assets");
    expect(result.NEXT_PUBLIC_PLAIN).toBe("web.localhost");
  });

  it("rewrites the host, not an occurrence of the name inside the path", () =>
  {
    const result = LocalgateEnvRewrite.apply(
      { NEXT_PUBLIC_APP_URL: "http://web.localhost/redirect?to=http://web.localhost/next" },
      "lan",
      machine(),
      80
    );

    expect(result.NEXT_PUBLIC_APP_URL)
      .toBe("http://web.dev.example.com/redirect?to=http://web.localhost/next");
  });

  it("leaves a bare .localhost host alone", () =>
  {
    const result = LocalgateEnvRewrite.apply({ NEXT_PUBLIC_APP_URL: "http://localhost" }, "lan", machine(), 80);
    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://localhost");
  });

  it("uses the prefixed public name in internet mode without exposing the proxy's LAN port", () =>
  {
    const result = LocalgateEnvRewrite.apply(pilotEnv(), "internet", machine(), 8_080);

    expect(result.NEXT_PUBLIC_APP_URL).toBe("https://pub-myapp.example.com");
    expect(result.APP_BACKEND_WAGTAIL_API_PUBLIC_URL).toBe("https://pub-cms.example.com");
  });
});
