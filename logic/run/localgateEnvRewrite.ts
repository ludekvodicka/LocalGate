// Keeps repositories machine-agnostic: a committed env file says `.localhost` everywhere, and the
// machine's own suffix is substituted here, in memory, on the way into the child process. Only the
// variables a browser reads are rewritten - a remote viewer's browser resolves `.localhost` to its own
// machine, so those URLs must carry the shared name. Server-side variables stay on `.localhost`, which
// is faster and works with no DNS at all.
export class LocalgateEnvRewrite
{
  private static readonly localSuffixConst = ".localhost";
  private static readonly browserFacingNamesConst = ["AUTH_URL", "NEXTAUTH_URL"];

  static apply(env: NodeJS.ProcessEnv, externalSuffix: string | null): NodeJS.ProcessEnv
  {
    const result: NodeJS.ProcessEnv = { ...env };
    if (!externalSuffix) return result;

    for (const [key, value] of Object.entries(result))
    {
      if (!value || !LocalgateEnvRewrite.isBrowserFacing(key)) continue;

      const rewritten = LocalgateEnvRewrite.rewriteHostname(value, externalSuffix);
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

  // Substitutes inside the authority component only, and by string replacement rather than
  // URL.toString(), so a value keeps its exact original shape - notably no trailing slash appears on a
  // bare origin, which app code concatenates onto.
  private static rewriteHostname(value: string, externalSuffix: string): string | null
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

    return value.replace(url.hostname, `${label}${externalSuffix}`);
  }
}
