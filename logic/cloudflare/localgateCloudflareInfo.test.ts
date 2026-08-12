import { describe, expect, it } from "vitest";
import { LocalgateCloudflareInfo } from "./localgateCloudflareInfo.ts";

describe("LocalgateCloudflareInfo", () =>
{
  const text = LocalgateCloudflareInfo.render("web.dev.example.com", "192.0.2.10");

  it("prints the DNS record and the ingress entry ready to paste", () =>
  {
    expect(text).toContain("web.dev.example.com   CNAME   <tunnel-id>.cfargotunnel.com");
    expect(text).toContain("- hostname: web.dev.example.com");
    expect(text).toContain("service: http://192.0.2.10:80");
  });

  it("states both consequences and that nothing was sent", () =>
  {
    expect(text).toContain("direct LAN path");
    expect(text).toContain("anyone holding the URL");
    expect(text).toContain("holds no API token");
  });
});
