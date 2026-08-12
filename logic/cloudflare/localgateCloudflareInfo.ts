// Prints, never applies. Exposing a dev server to the internet is two entries in systems localgate has
// no business holding credentials for, so it hands you the exact text and stops there.
export class LocalgateCloudflareInfo
{
  static render(hostname: string, lanIp: string): string
  {
    return [
      `To reach http://${hostname} from outside the LAN, add these two entries.`,
      "",
      "1. Cloudflare DNS, proxied (a specific record wins over the wildcard):",
      "",
      `     ${hostname}   CNAME   <tunnel-id>.cfargotunnel.com`,
      "",
      "2. Ingress list of the shared cloudflared container:",
      "",
      `     - hostname: ${hostname}`,
      `       service: http://${lanIp}:80`,
      "",
      "cloudflared keeps the Host header, so the proxy routes it like any LAN request.",
      "",
      "Two things worth knowing before you paste this:",
      `  - the direct LAN path for ${hostname} disappears; visitors go out to Cloudflare and back`,
      "  - anyone holding the URL reaches this dev server, so switch the mode back to lan afterwards",
      "",
      "localgate sent nothing to Cloudflare and holds no API token.",
      ""
    ].join("\n");
  }
}
