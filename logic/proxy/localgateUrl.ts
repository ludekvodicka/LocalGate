import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import type { LocalgateRoute } from "./localgateRegistry.ts";

// How far an address reaches, which is also the word every surface prints in front of it.
export type LocalgateAddressLabel = "local" | "network" | "internet";

export type LocalgateAddress =
{
  label: LocalgateAddressLabel;
  hostname: string;
  url: string;
};

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

  // A route's names as URLs a person can paste, each labelled with how far it reaches. The banner, the
  // CLI listing and the start page all show the same three lines, and each one deciding for itself is
  // how the public address ends up written with the proxy's internal port, which never serves it.
  static routeAddresses(route: LocalgateRoute, port: number): LocalgateAddress[]
  {
    return route.names.map((hostname, index) =>
    {
      const label = LocalgateUrl.labelAt(index);
      return { label, hostname, url: label == "internet" ? `https://${hostname}` : LocalgateUrl.forName(hostname, port) };
    });
  }

  // The `Host` header as a bare hostname: the port the client used is not how a route is found, and a
  // header that carries none is not an error. Lowercased, because a hostname is case-insensitive and
  // every name in the table is written in lower case.
  static hostnameOf(hostHeader: string): string | null
  {
    const host = hostHeader.trim().toLowerCase().split(":")[0];
    return host ? host : null;
  }

  // The position in `names` IS the reach: LocalgateNames.routeNames appends the shared name and then the
  // public one as the mode grants them, so a route never has a fourth.
  private static labelAt(index: number): LocalgateAddressLabel
  {
    if (index == 0) return "local";
    else if (index == 1) return "network";
    else if (index == 2) return "internet";
    else
      throw new Error(`a route cannot have a name at position ${index}`);
  }
}
