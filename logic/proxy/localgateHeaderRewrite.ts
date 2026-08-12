import type { IncomingHttpHeaders } from "node:http";

// Next.js blocks cross-origin requests to its dev endpoints unless the origin is allow-listed, and it
// allows `**.localhost` unconditionally. It inspects Origin (and Referer for no-cors requests), never
// Host, and only on `/_next/*` and `/__nextjs*`. Mapping the external suffix back to `.localhost` on
// exactly those requests keeps HMR and dev assets working from a shared name, with no
// `allowedDevOrigins` entry in any project - which is what keeps our domain out of every repository.
export class LocalgateHeaderRewrite
{
  private static readonly localSuffixConst = ".localhost";
  private static readonly internalPrefixesConst = ["/_next", "/__nextjs"];

  static isInternalPath(requestUrl: string): boolean
  {
    const path = requestUrl.split("?")[0] ?? "";
    return LocalgateHeaderRewrite.internalPrefixesConst.some(prefix => path.startsWith(prefix));
  }

  static apply(requestUrl: string, headers: IncomingHttpHeaders, externalSuffix: string | null): void
  {
    if (!externalSuffix || !LocalgateHeaderRewrite.isInternalPath(requestUrl)) return;

    for (const name of ["origin", "referer"] as const)
    {
      const value = headers[name];
      if (typeof value != "string") continue;

      const rewritten = LocalgateHeaderRewrite.toLocalName(value, externalSuffix);
      if (rewritten) headers[name] = rewritten;
    }
  }

  private static toLocalName(value: string, externalSuffix: string): string | null
  {
    let url: URL;
    try
    {
      url = new URL(value);
    }
    catch
    {
      return null;
    }

    if (!url.hostname.endsWith(externalSuffix)) return null;

    const label = url.hostname.slice(0, -externalSuffix.length);
    if (label.length == 0) return null;

    return value.replace(url.hostname, `${label}${LocalgateHeaderRewrite.localSuffixConst}`);
  }
}
