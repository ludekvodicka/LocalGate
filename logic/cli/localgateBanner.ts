import { LocalgateNames } from "../config/localgateNames.ts";
import type { LocalgateRoute } from "../proxy/localgateRegistry.ts";
import { LocalgateUrl } from "../proxy/localgateUrl.ts";

// What a command prints once a name answers. `run` and `alias` share it because to the person reading the
// terminal they are the same event, and the one-line variant `alias` used to print is how a shared name
// goes unnoticed - the script that registered one then wrote its own `.localhost` block instead.
//
// The route and the port the proxy answers on are the ONLY inputs. The title, the column alignment and
// even which command to type next are decided here rather than passed in, because a caller that
// hand-builds a padded string is a caller that can drift out of format again.
export class LocalgateBanner
{
  private static readonly labelWidthConst = 11;

  static render(route: LocalgateRoute, proxyPort: number): string
  {
    const [local, network, internet] = route.names;
    const [nextLabel, nextCommand] = LocalgateBanner.next(route);

    const lines = ["", `  localgate   ${LocalgateBanner.appName(route)}   ·   ${LocalgateBanner.subtitle(route)}`, ""];

    if (internet) lines.push(LocalgateBanner.row("internet", `https://${internet}`));
    if (network) lines.push(LocalgateBanner.row("network", LocalgateUrl.forName(network, proxyPort)));
    lines.push(LocalgateBanner.row("local", LocalgateUrl.forName(local, proxyPort)));
    lines.push("", LocalgateBanner.row("upstream", `127.0.0.1:${route.port}`), LocalgateBanner.row(nextLabel, nextCommand), "");

    return `${lines.join("\n")}\n`;
  }

  // The short name a person types, which is the first label of the local name.
  static appName(route: LocalgateRoute): string
  {
    return LocalgateNames.shortName(route.names[0]);
  }

  private static subtitle(route: LocalgateRoute): string
  {
    if (route.kind == "app") return `mode ${route.mode}`;
    else if (route.kind == "alias") return `alias   ·   mode ${route.mode}`;
    else
      throw new Error(`Unknown route kind: ${JSON.stringify(route.kind)}`);
  }

  // An alias has no process, so there is nothing to restart. It used to need the line that put it back
  // after a proxy restart; now that its intent is remembered, the line it needs is the way out.
  private static next(route: LocalgateRoute): [string, string]
  {
    if (route.kind == "app") return ["restart", "localgate restart"];
    else if (route.kind == "alias") return ["remove", `localgate alias --remove ${LocalgateBanner.appName(route)}`];
    else
      throw new Error(`Unknown route kind: ${JSON.stringify(route.kind)}`);
  }

  private static row(label: string, value: string): string
  {
    return `    ${label.padEnd(LocalgateBanner.labelWidthConst)}${value}`;
  }
}
