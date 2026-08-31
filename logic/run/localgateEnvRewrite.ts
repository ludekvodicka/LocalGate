import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import { LocalgateNames } from "../config/localgateNames.ts";
import type { LocalgateMode } from "../config/localgateProjectConfig.ts";
import { LocalgateUrl } from "../proxy/localgateUrl.ts";

// Keeps repositories machine-agnostic: a committed env file says `.localhost` everywhere, and what this
// machine actually answers on is substituted here, in memory, on the way into the child process.
//
// A remote viewer's browser resolves `.localhost` to its own machine, so browser-facing URLs must carry
// the shared name. Server-side URLs keep `.localhost`, but still need the proxy's non-default port.
//
// The job is "point this at the proxy", not "swap the suffix". That distinction is what the port makes:
// where the proxy cannot have 80 the value needs `:8080` even in mode local, where no suffix exists and
// nothing used to be rewritten at all.
export class LocalgateEnvRewrite
{
  private static readonly localSuffixConst = ".localhost";
  private static readonly browserFacingNamesConst = ["AUTH_URL", "NEXTAUTH_URL"];

  static apply(env: NodeJS.ProcessEnv, mode: LocalgateMode, machine: LocalgateMachineSettings | null,
    proxyPort: number): NodeJS.ProcessEnv
  {
    const result: NodeJS.ProcessEnv = { ...env };

    for (const [key, value] of Object.entries(result))
    {
      if (!value) continue;

      const rewritten = LocalgateEnvRewrite.isBrowserFacing(key)
        ? LocalgateEnvRewrite.rewriteBrowserAuthority(value, mode, machine, proxyPort)
        : LocalgateEnvRewrite.rewriteServerAuthority(value, proxyPort);
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
  private static rewriteBrowserAuthority(value: string, mode: LocalgateMode, machine: LocalgateMachineSettings | null,
    proxyPort: number): string | null
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

    const name = LocalgateNames.browserName(label, mode, machine);
    const publiclyExposed = mode == "internet" && machine?.publicPrefix;
    const browserPort = publiclyExposed ? 80 : proxyPort;
    const authority = LocalgateUrl.forName(name, browserPort).replace("http://", "");
    const protocol = publiclyExposed && (url.protocol == "http:" || url.protocol == "https:") ? "https:" : url.protocol;

    if (url.host == authority && url.protocol == protocol) return null;
    const withAuthority = value.replace(url.host, authority);
    return `${protocol}${withAuthority.slice(url.protocol.length)}`;
  }

  private static rewriteServerAuthority(value: string, proxyPort: number): string | null
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

    const authority = LocalgateUrl.forName(url.hostname, proxyPort).replace("http://", "");
    if (url.host == authority) return null;
    return value.replace(url.host, authority);
  }
}
