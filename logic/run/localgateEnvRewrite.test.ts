import { describe, expect, it } from "vitest";
import { LocalgateEnvRewrite } from "./localgateEnvRewrite.ts";

describe("LocalgateEnvRewrite", () =>
{
  const suffix = ".dev.example.com";

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
    expect(LocalgateEnvRewrite.apply(pilotEnv(), null)).toEqual(pilotEnv());
  });

  it("rewrites only the variables a browser reads", () =>
  {
    const result = LocalgateEnvRewrite.apply(pilotEnv(), suffix);

    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://myapp.dev.example.com");
    expect(result.AUTH_URL).toBe("http://myapp.dev.example.com");
    expect(result.NEXTAUTH_URL).toBe("http://myapp.dev.example.com/api/auth");
    expect(result.APP_BACKEND_WAGTAIL_API_PUBLIC_URL).toBe("http://cms.dev.example.com");
  });

  it("leaves server-only variables on .localhost", () =>
  {
    const result = LocalgateEnvRewrite.apply(pilotEnv(), suffix);

    expect(result.APP_BACKEND_WAGTAIL_API_URL).toBe("http://cms.localhost/api/v2");
    expect(result.APP_BACKEND_API_URL).toBe("http://api.localhost");
  });

  it("does not add a trailing slash to a bare origin", () =>
  {
    const result = LocalgateEnvRewrite.apply({ NEXT_PUBLIC_APP_URL: "http://web.localhost" }, suffix);
    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://web.dev.example.com");
  });

  it("keeps an explicit port", () =>
  {
    const result = LocalgateEnvRewrite.apply({ NEXT_PUBLIC_APP_URL: "http://web.localhost:8080/x" }, suffix);
    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://web.dev.example.com:8080/x");
  });

  it("ignores a value that is not a URL and a host that is not .localhost", () =>
  {
    const result = LocalgateEnvRewrite.apply({
      AUTH_SECRET: "not-a-url",
      NEXT_PUBLIC_CDN_URL: "https://cdn.example.com/assets",
      NEXT_PUBLIC_PLAIN: "web.localhost"
    }, suffix);

    expect(result.AUTH_SECRET).toBe("not-a-url");
    expect(result.NEXT_PUBLIC_CDN_URL).toBe("https://cdn.example.com/assets");
    expect(result.NEXT_PUBLIC_PLAIN).toBe("web.localhost");
  });

  it("rewrites the host, not an occurrence of the name inside the path", () =>
  {
    const result = LocalgateEnvRewrite.apply(
      { NEXT_PUBLIC_APP_URL: "http://web.localhost/redirect?to=http://web.localhost/next" },
      suffix
    );

    expect(result.NEXT_PUBLIC_APP_URL)
      .toBe("http://web.dev.example.com/redirect?to=http://web.localhost/next");
  });

  it("leaves a bare .localhost host alone", () =>
  {
    const result = LocalgateEnvRewrite.apply({ NEXT_PUBLIC_APP_URL: "http://localhost" }, suffix);
    expect(result.NEXT_PUBLIC_APP_URL).toBe("http://localhost");
  });
});
