import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { LocalgateHeaderRewrite } from "./localgateHeaderRewrite.ts";

describe("LocalgateHeaderRewrite", () =>
{
  const suffix = ".dev.example.com";

  const headers = (): IncomingHttpHeaders => ({
    host: "web.dev.example.com",
    origin: "http://web.dev.example.com",
    referer: "http://web.dev.example.com/blog/article"
  });

  it("recognises only Next's internal endpoints", () =>
  {
    expect(LocalgateHeaderRewrite.isInternalPath("/_next/static/chunks/main.js")).toBe(true);
    expect(LocalgateHeaderRewrite.isInternalPath("/__nextjs_original-stack-frame?x=1")).toBe(true);
    expect(LocalgateHeaderRewrite.isInternalPath("/blog/article")).toBe(false);
    expect(LocalgateHeaderRewrite.isInternalPath("/api/health")).toBe(false);
  });

  it("maps Origin and Referer back to .localhost on an internal request", () =>
  {
    const result = headers();
    LocalgateHeaderRewrite.apply("/_next/static/chunks/main.js", result, suffix);

    expect(result.origin).toBe("http://web.localhost");
    expect(result.referer).toBe("http://web.localhost/blog/article");
  });

  it("never touches Host, because routing already happened on it", () =>
  {
    const result = headers();
    LocalgateHeaderRewrite.apply("/_next/static/chunks/main.js", result, suffix);

    expect(result.host).toBe("web.dev.example.com");
  });

  it("leaves application requests alone", () =>
  {
    const result = headers();
    LocalgateHeaderRewrite.apply("/blog/article", result, suffix);

    expect(result.origin).toBe("http://web.dev.example.com");
    expect(result.referer).toBe("http://web.dev.example.com/blog/article");
  });

  it("does nothing in mode local, where there is no external suffix", () =>
  {
    const result = headers();
    LocalgateHeaderRewrite.apply("/_next/static/chunks/main.js", result, null);

    expect(result.origin).toBe("http://web.dev.example.com");
  });

  it("ignores an origin from a different host and the opaque literal null", () =>
  {
    const result: IncomingHttpHeaders = { origin: "https://evil.example.com", referer: "null" };
    LocalgateHeaderRewrite.apply("/_next/static/x.js", result, suffix);

    expect(result.origin).toBe("https://evil.example.com");
    expect(result.referer).toBe("null");
  });

  it("keeps a websocket upgrade origin working for HMR", () =>
  {
    const result: IncomingHttpHeaders = { origin: "http://web.dev.example.com" };
    LocalgateHeaderRewrite.apply("/_next/webpack-hmr", result, suffix);

    expect(result.origin).toBe("http://web.localhost");
  });
});
