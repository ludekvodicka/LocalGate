import { LocalgateUrl } from "../proxy/localgateUrl.ts";

// Keeps repositories machine-agnostic: a committed env file says `.localhost` everywhere, and what this
// machine actually answers on is substituted here, in memory, on the way into the child process.
//
// Only the variables a browser reads are rewritten. A remote viewer's browser resolves `.localhost` to
// its own machine, so those URLs must carry the shared name; server-side variables stay on `.localhost`,
// which is faster and works with no DNS at all.
//
// The job is "point this at the proxy", not "swap the suffix". That distinction is what the port makes:
// where the proxy cannot have 80 the value needs `:8080` even in mode local, where no suffix exists and
// nothing used to be rewritten at all.
export class LocalgateEnvRewrite
{
  private static readonly localSuffixConst = ".localhost";
  private static readonly browserFacingNamesConst = ["AUTH_URL", "NEXTAUTH_URL"];

  static apply(env: NodeJS.ProcessEnv, externalSuffix: string | null, proxyPort: number): NodeJS.ProcessEnv
  {
    const result: NodeJS.ProcessEnv = { ...env };

    for (const [key, value] of Object.entries(result))
    {
      if (!value || !LocalgateEnvRewrite.isBrowserFacing(key)) continue;

      const rewritten = LocalgateEnvRewrite.rewriteAuthority(value, externalSuffix, proxyPort);
      if (rewritten) result[key] = rewritten;
    }

    return result;
  }

  static isBrowserFacing(key: string): boolean
  {
    return key.startsWith("NEXT_PUBLIC_")
      || key.endsWith("_PUBLIC_URL")
      || LocalgateEnvRewrite.browserFacingNamesConst.includes(key);
  }

  // Substitutes the authority only, and by string replacement rather than URL.toString(), so a value
  // keeps its exact original shape - notably no trailing slash appears on a bare origin, which app code
  // concatenates onto. A port already in the value is replaced rather than kept: behind a proxy that
  // multiplexes by name, a browser-facing URL has exactly one correct port.
  private static rewriteAuthority(value: string, externalSuffix: string | null, proxyPort: number): string | null
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

    if (!url.hostname.endsWith(LocalgateEnvRewrite.localSuffixConst)) return null;

    const label = url.hostname.slice(0, -LocalgateEnvRewrite.localSuffixConst.length);
    if (label.length == 0) return null;

    const name = `${label}${externalSuffix ?? LocalgateEnvRewrite.localSuffixConst}`;
    const authority = LocalgateUrl.forName(name, proxyPort).replace("http://", "");

    return url.host == authority ? null : value.replace(url.host, authority);
  }
}
