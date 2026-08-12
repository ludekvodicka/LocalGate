import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";

// Where the proxy listens, and how a route's name is written down for a person to paste. One place,
// because the two have to agree: every URL localgate prints is a name plus this port, and every
// client that talks to the control API has to find the same listener without being told.
export class LocalgateUrl
{
  // Windows lets a normal user bind 80, so the name stands alone and the port never appears. Linux and
  // macOS reserve everything below 1024 for root, and a dev tool that starts itself on demand has no
  // business asking for that, so the port moves into the URL instead.
  private static readonly windowsPortConst = 80;
  private static readonly elsewherePortConst = 8080;
  private static readonly defaultHttpPortConst = 80;

  static proxyPort(settings: LocalgateMachineSettings | null, platform: NodeJS.Platform = process.platform): number
  {
    if (settings?.proxyPort != null) return settings.proxyPort;
    return platform == "win32" ? LocalgateUrl.windowsPortConst : LocalgateUrl.elsewherePortConst;
  }

  static forName(name: string, port: number): string
  {
    return port == LocalgateUrl.defaultHttpPortConst ? `http://${name}` : `http://${name}:${port}`;
  }
}
