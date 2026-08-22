import type { IncomingHttpHeaders } from "node:http";

// Next.js blocks cross-origin requests to its dev endpoints unless the origin is allow-listed, and it
// allows `**.localhost` unconditionally. It inspects Origin (and Referer for no-cors requests), never
// Host, and only on `/_next/*` and `/__nextjs*`. Mapping the name used for this request back to the
// route's canonical `.localhost` name keeps HMR and dev assets working from LAN and public names, with no
// `allowedDevOrigins` entry in any project - which is what keeps our domain out of every repository.
export class LocalgateHeaderRewrite
{
  private static readonly internalPrefixesConst = ["/_next", "/__nextjs"];

  static isInternalPath(requestUrl: string): boolean
  {
    const path = requestUrl.split("?")[0] ?? "";
    return LocalgateHeaderRewrite.internalPrefixesConst.some(prefix => path.startsWith(prefix));
  }

  static apply(requestUrl: string, headers: IncomingHttpHeaders, requestHost: string, canonicalName: string): void
  {
    if (!LocalgateHeaderRewrite.isInternalPath(requestUrl)) return;

    const requestHostname = LocalgateHeaderRewrite.hostnameOf(requestHost);
    if (!requestHostname) return;

    for (const name of ["origin", "referer"] as const)
    {
      const value = headers[name];
      if (typeof value != "string") continue;

      const rewritten = LocalgateHeaderRewrite.toCanonicalName(value, requestHostname, canonicalName);
      if (rewritten) headers[name] = rewritten;
    }
  }

  private static toCanonicalName(value: string, requestHostname: string, canonicalName: string): string | null
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

    if (url.hostname.toLowerCase() != requestHostname) return null;

    const authorityStart = value.indexOf("://") + 3;
    if (authorityStart < 3) return null;
    const suffixOffset = value.slice(authorityStart).search(/[/?#]/);
    const authorityEnd = suffixOffset < 0 ? value.length : authorityStart + suffixOffset;
    const authority = `${canonicalName}${url.port ? `:${url.port}` : ""}`;
    return `${value.slice(0, authorityStart)}${authority}${value.slice(authorityEnd)}`;
  }

  private static hostnameOf(host: string): string | null
  {
    try
    {
      return new URL(`http://${host}`).hostname.toLowerCase();
    }
    catch
    {
      return null;
    }
  }
}
