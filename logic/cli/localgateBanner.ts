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
    const [local, shared] = route.names;
    const [nextLabel, nextCommand] = LocalgateBanner.next(route);

    const lines = ["", `  localgate   ${LocalgateBanner.appName(route)}   ·   ${LocalgateBanner.subtitle(route)}`, ""];

    if (shared) lines.push(LocalgateBanner.row("shared", LocalgateUrl.forName(shared, proxyPort)));
    lines.push(LocalgateBanner.row("local", LocalgateUrl.forName(local, proxyPort)));
    lines.push("", LocalgateBanner.row("upstream", `127.0.0.1:${route.port}`), LocalgateBanner.row(nextLabel, nextCommand), "");

    return `${lines.join("\n")}\n`;
  }

  // The short name a person types, which is the first label of the local name.
  static appName(route: LocalgateRoute): string
  {
    return route.names[0].split(".")[0];
  }

  private static subtitle(route: LocalgateRoute): string
  {
    if (route.kind == "app") return `mode ${route.mode}`;
    else if (route.kind == "alias") return `alias   ·   mode ${route.mode}`;
    else
      throw new Error(`Unknown route kind: ${JSON.stringify(route.kind)}`);
  }

  // An alias has no process, so there is nothing to restart - what it needs instead is the line that puts
  // it back, because the route table is in memory and a proxy restart drops it.
  private static next(route: LocalgateRoute): [string, string]
  {
    if (route.kind == "app") return ["restart", "localgate restart"];
    else if (route.kind == "alias") return ["re-add", `localgate alias ${LocalgateBanner.appName(route)} ${route.port}`];
    else
      throw new Error(`Unknown route kind: ${JSON.stringify(route.kind)}`);
  }

  private static row(label: string, value: string): string
  {
    return `    ${label.padEnd(LocalgateBanner.labelWidthConst)}${value}`;
  }
}
