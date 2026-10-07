import type { IncomingMessage, ServerResponse } from "node:http";
import { LocalgateNames } from "../config/localgateNames.ts";
import { LocalgateHealth } from "./localgateHealth.ts";
import { LocalgatePortProbe } from "./localgatePortProbe.ts";
import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import type { LocalgateReach, LocalgateRegistry, LocalgateRoute, LocalgateRouteState } from "./localgateRegistry.ts";
import { LocalgateUrl, type LocalgateAddress } from "./localgateUrl.ts";

// How the page ends what a route points at, and how it knows whether it can. One object rather than two
// callbacks, because the button and the action behind it must not drift apart: a button that appears for
// something nothing can stop is a click that fails, and the reverse is a verb nobody can find.
//
// An app is ended by asking its runner. An alias has no runner, so it can be ended only where the
// machine's owner wrote down how, which is `stop` in ~/.localgate/aliases.json - hence the names rather
// than a flag on the route: that file is the only source, and nothing reaching the proxy over a socket
// can add to it.
export type LocalgateRouteStopper =
{
  aliasStopCommands(): ReadonlyMap<string, string>;
  stop(route: LocalgateRoute): Promise<void>;
};

// What the current request asks the page to show on top of the list: one card awaiting confirmation,
// and the name of whatever was just stopped. Both come from the query string and name a route.
export type LocalgateStartPageView =
{
  confirming?: string | null;
  stopped?: string | null;
  // Route id to "something accepts a connection on its port". A route missing from the map was not
  // probed, and then the card falls back to the health the proxy learned from forwarded traffic.
  listening?: ReadonlyMap<string, boolean>;
};

// The one page localgate serves from itself: every route on this machine and the addresses each one
// answers on, so a person has somewhere to start that does not depend on remembering a name.
//
// It is reach-aware for the same reason the route table is. On loopback it shows everything, including
// the upstream port and the directory a route was started from. On the LAN listener it answers only on
// the machine's own domain and lists only what a LAN caller can actually open: a route in mode `local`
// has no address off this machine, so it does not appear at all, and neither do the local paths and
// ports, which are nobody else's business.
export class LocalgateStartPage
{
  private static readonly refreshSecondsConst = 5;
  private static readonly stopPathConst = "/stop";

  // A hub and three routes, which is what the proxy is. Inline, because the page is served to the LAN
  // and must not fetch anything: a tab icon is not worth a request that could fail or be logged.
  private static readonly faviconConst = "data:image/svg+xml,"
    + "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
    + "%3Crect width='32' height='32' rx='8' fill='%232f6df6'/%3E"
    + "%3Ccircle cx='10' cy='16' r='3.2' fill='white'/%3E"
    + "%3Crect x='17' y='8' width='7' height='4' rx='2' fill='white'/%3E"
    + "%3Crect x='17' y='14' width='7' height='4' rx='2' fill='white'/%3E"
    + "%3Crect x='17' y='20' width='7' height='4' rx='2' fill='white'/%3E%3C/svg%3E";

  private static readonly styleConst = `
    :root { color-scheme: light dark; --bg: #f4f5f9; --fg: #16161b; --muted: #6b6b78; --card: #ffffff;
      --line: #e3e3ec; --link: #1b52c0; --shadow: 0 1px 2px rgba(16, 16, 32, .06);
      --shadow-lift: 0 8px 24px rgba(16, 16, 32, .13); --mark-l: 42%; --mark-s: 58%;
      --ok: #17914f; --warn: #a37000; --bad: #c03028; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #131317; --fg: #ededf2; --muted: #9797a4; --card: #1d1d23; --line: #2d2d37;
        --link: #8ab0ff; --shadow: none; --shadow-lift: 0 8px 24px rgba(0, 0, 0, .5);
        --mark-l: 58%; --mark-s: 52%; --ok: #3ecf8e; --warn: #e0a92e; --bad: #ff6f62; } }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 2.25rem 1.25rem 3rem; background: var(--bg); color: var(--fg);
      font: 15px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
    main { max-width: 62rem; margin: 0 auto; }
    header { display: flex; align-items: center; gap: .7rem; margin-bottom: .3rem; }
    .logo { width: 1.9rem; height: 1.9rem; border-radius: .5rem; flex: none; }
    h1 { margin: 0; font-size: 1.3rem; font-weight: 650; letter-spacing: .01em; }
    .sub, footer { color: var(--muted); font-size: .85rem; }
    .sub { margin: 0 0 1.6rem; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem;
      grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); }
    /* A column, so the cards in one row line their footers up however many addresses each one has. */
    .card { position: relative; display: flex; flex-direction: column; background: var(--card);
      border: 1px solid var(--line); border-radius: .9rem; padding: 1rem 1.1rem; box-shadow: var(--shadow);
      transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; }
    .card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); border-color: var(--link); }
    /* Nothing answers on its port. Still listed, because the name exists and an alias comes back at the
       next proxy start, but it should not read like the apps that are actually up. */
    .card.down { opacity: .62; }
    .card.down:hover { opacity: 1; }
    .head { display: flex; align-items: flex-start; gap: .7rem; }
    .mark { flex: none; width: 2.4rem; height: 2.4rem; border-radius: .65rem; display: grid;
      place-items: center; font-size: .78rem; font-weight: 700; letter-spacing: .02em; color: white;
      background: hsl(var(--hue) var(--mark-s) var(--mark-l)); }
    .title { min-width: 0; }
    /* The whole card opens the address this listener can reach, and the stretched overlay is what makes
       the padding clickable too. Every other link sits above it, so they still open their own address.
       The name wraps rather than truncating: it is what the reader is looking for, and real project names
       are long enough (web-myapp-customer-frontend) that an ellipsis would cut the distinguishing half. */
    .name { display: block; font-size: 1.06rem; font-weight: 640; color: var(--fg);
      line-height: 1.25; overflow-wrap: anywhere; }
    .name::after { content: ""; position: absolute; inset: 0; border-radius: .9rem; }
    .card:hover .name { color: var(--link); }
    .primary { display: block; font-size: .82rem; color: var(--link); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .state { margin-left: auto; flex: none; display: flex; align-items: center; gap: .35rem;
      padding-top: .2rem; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em;
      color: var(--muted); }
    .dot { width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; }
    .state.healthy { color: var(--ok); }
    .state.starting { color: var(--warn); }
    .state.unresponsive, .state.dead { color: var(--bad); }
    .chips { display: flex; flex-wrap: wrap; gap: .35rem; margin: .75rem 0 .75rem; }
    .chip { position: relative; z-index: 1; font-size: .76rem; padding: .2rem .55rem; border-radius: 1rem;
      border: 1px solid var(--line); color: var(--muted); background: var(--bg); }
    a.chip { color: var(--link); }
    a.chip:hover { border-color: var(--link); }
    a { text-decoration: none; }
    a:hover { text-decoration: underline; }
    .meta { margin-top: auto; padding-top: .7rem; border-top: 1px solid var(--line); color: var(--muted);
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .76rem;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    a.chip.danger { color: var(--bad); }
    a.chip.danger:hover { border-color: var(--bad); }
    .confirm { position: relative; z-index: 1; margin: .75rem 0; }
    .confirm p { margin: 0 0 .6rem; font-size: .85rem; }
    .confirm form { display: inline; }
    .kill { font: inherit; font-size: .76rem; padding: .25rem .7rem; margin-right: .35rem; cursor: pointer;
      color: white; background: var(--bad); border: 1px solid var(--bad); border-radius: 1rem; }
    .notice { margin: -.9rem 0 1.4rem; font-size: .85rem; color: var(--muted); }
    .empty { background: var(--card); border: 1px dashed var(--line); border-radius: .9rem;
      padding: 2rem 1.1rem; text-align: center; color: var(--muted); }
    footer { margin-top: 1.9rem; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  `;

  constructor(
    private readonly registry: LocalgateRegistry,
    private readonly machine: LocalgateMachineSettings | null,
    private readonly proxyPort: number,
    private readonly stopper: LocalgateRouteStopper
  ) {}

  // What to print in a terminal so the reader can click it. The page is always on `.localhost`, whatever
  // the machine is called, because that name needs no configuration and no DNS.
  static localUrl(proxyPort: number): string
  {
    return LocalgateUrl.forName(LocalgateNames.local(LocalgateNames.startNameConst), proxyPort);
  }

  handles(hostHeader: string, reachedFrom: LocalgateReach): boolean
  {
    const host = LocalgateUrl.hostnameOf(hostHeader);
    if (!host) return false;

    if (reachedFrom == "loopback") return host == this.localName() || host == this.lanName();
    else if (reachedFrom == "lan") return host == this.lanName();
    else
      throw new Error(`unknown localgate reach: ${JSON.stringify(reachedFrom)}`);
  }

  // The page serves two verbs of its own, so the proxy hands it the request rather than a rendering
  // call: a GET draws the list, and the POST behind the confirm button ends a dev server.
  async handle(request: IncomingMessage, response: ServerResponse, reachedFrom: LocalgateReach): Promise<void>
  {
    const url = new URL(request.url ?? "/", "http://localgate.invalid");

    if (request.method == "POST") return this.handleStop(request, response, url, reachedFrom);

    LocalgateStartPage.sendHtml(response, 200, this.render(reachedFrom, {
      confirming: url.searchParams.get("confirm"),
      stopped: url.searchParams.get("stopped"),
      listening: await LocalgatePortProbe.listeningRoutes(this.registry.all())
    }));
  }

  render(reachedFrom: LocalgateReach, view: LocalgateStartPageView = {}): string
  {
    const loopback = reachedFrom == "loopback";
    const entries = this.visible(reachedFrom);
    const confirming = loopback ? view.confirming ?? null : null;
    // Once per render rather than once per card: this reads the alias file, and it is the same answer
    // for every card on the page.
    const aliasStops = this.stopper.aliasStopCommands();

    return [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "<meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      // A route appears the moment a dev server registers and its state changes while you look at the
      // page, so a list that only tells the truth at load time is the one thing this page must not be.
      // It reloads the plain list, which is how the "stopped" note clears itself; and it is left out
      // entirely while a card is asking a question, because that question must not expire under the
      // cursor of whoever is reading it.
      confirming ? "" : `<meta http-equiv="refresh" content="${LocalgateStartPage.refreshSecondsConst}; url=/">`,
      "<title>localgate</title>",
      `<link rel="icon" href="${LocalgateStartPage.faviconConst}">`,
      `<style>${LocalgateStartPage.styleConst}</style>`,
      "</head>",
      "<body><main>",
      `<header><img class="logo" alt="" src="${LocalgateStartPage.faviconConst}"><h1>localgate</h1></header>`,
      `<p class="sub">${LocalgateStartPage.escape(this.subtitle(entries.length, loopback))}</p>`,
      loopback && view.stopped ? `<p class="notice">${LocalgateStartPage.escape(view.stopped)} was stopped. `
        + "Start it again from the editor it was launched in.</p>" : "",
      entries.length == 0
        ? `<p class="empty">${LocalgateStartPage.escape(LocalgateStartPage.emptyMessage(loopback))}</p>`
        : `<ul>${entries.map(entry => LocalgateStartPage.card(entry, loopback, confirming,
            view.listening?.get(entry.route.id), LocalgateStartPage.stopsWith(entry.route, aliasStops))).join("")}</ul>`,
      `<footer>${LocalgateStartPage.escape(LocalgateStartPage.footer(loopback, confirming))}</footer>`,
      "</main></body>",
      "</html>",
      ""
    ].join("\n");
  }

  // Ending a dev server is process control, which belongs to the loopback listener alone - the same
  // boundary the control API sits behind. A POST that arrives on the LAN listener is refused whatever
  // it carries, and the button that makes one is never rendered there in the first place.
  private async handleStop(request: IncomingMessage, response: ServerResponse, url: URL,
    reachedFrom: LocalgateReach): Promise<void>
  {
    if (reachedFrom != "loopback")
      return LocalgateStartPage.sendHtml(response, 404, LocalgateStartPage.refusal("not found here"));

    if (url.pathname != LocalgateStartPage.stopPathConst)
      return LocalgateStartPage.sendHtml(response, 404, LocalgateStartPage.refusal("no such page"));

    // The page is reachable by any site the developer happens to be browsing, and a form POST needs no
    // permission to leave one. Without this check a page anywhere could end every dev server on the
    // machine; with it, only a form served from this page can. Browsers always send Origin on a POST.
    if (request.headers.origin != `http://${request.headers.host ?? ""}`)
      return LocalgateStartPage.sendHtml(response, 403,
        LocalgateStartPage.refusal("this request did not come from the start page"));

    // By name rather than by the route id: ids are handed out per proxy process, so a tab left open
    // across a proxy restart could otherwise confirm r3 and end whatever r3 has become. A name that no
    // longer exists simply stops nothing, which is the state the click was asking for anyway.
    const name = url.searchParams.get("name") ?? "";
    const route = name ? this.registry.byName(name) : null;

    const stopsWith = route ? LocalgateStartPage.stopsWith(route, this.stopper.aliasStopCommands()) : null;
    if (!route || !stopsWith)
    {
      response.writeHead(303, { location: "/" });
      response.end();
      return;
    }

    // What a runner or a shell command reports back is the only account of what happened, and swallowing
    // it would leave the reader with a page that quietly still lists the thing they asked to end.
    try
    {
      await this.stopper.stop(route);
    }
    catch (error)
    {
      return LocalgateStartPage.sendHtml(response, 502,
        LocalgateStartPage.refusal(`${name} could not be stopped: ${error instanceof Error ? error.message : String(error)}`));
    }

    response.writeHead(303, { location: `/?stopped=${encodeURIComponent(name)}` });
    response.end();
  }

  private localName(): string
  {
    return LocalgateNames.local(LocalgateNames.startNameConst);
  }

  // null when the machine has no config, and compared against a hostname that is never null, so the page
  // simply has no shared name on a machine that has none either.
  private lanName(): string | null
  {
    return this.machine ? LocalgateNames.lan(LocalgateNames.startNameConst, this.machine) : null;
  }

  // The routes this listener may show, each with the addresses that listener can reach. A route left
  // with no address - mode `local`, seen from the LAN - is not listed at all, name included.
  private visible(reachedFrom: LocalgateReach): { route: LocalgateRoute; addresses: LocalgateAddress[] }[]
  {
    return this.registry.all()
      .map(route => ({ route, addresses: LocalgateStartPage.addressesOf(route, this.proxyPort, reachedFrom) }))
      .filter(entry => entry.addresses.length > 0)
      .sort((left, right) => LocalgateStartPage.appName(left.route).localeCompare(LocalgateStartPage.appName(right.route)));
  }

  private static addressesOf(route: LocalgateRoute, proxyPort: number, reachedFrom: LocalgateReach): LocalgateAddress[]
  {
    const addresses = LocalgateUrl.routeAddresses(route, proxyPort);

    if (reachedFrom == "loopback") return addresses;
    // The `.localhost` address is the local one by construction, and off this machine it names the
    // computer that reads it, so printing it there would be an invitation to a dead link at best.
    else if (reachedFrom == "lan") return addresses.filter(address => address.label != "local");
    else
      throw new Error(`unknown localgate reach: ${JSON.stringify(reachedFrom)}`);
  }

  // One card per route, opening on a click anywhere in it. The address it opens is the first one this
  // listener can reach - the `.localhost` name on this machine, the shared name off it - because a card
  // that opened the wrong one would be a dead link for exactly the person who clicked it.
  // What ends this route, as a sentence for the person about to click: the runner for an app, and the
  // machine's own line for an alias. null means nothing can, and then there is no button.
  private static stopsWith(route: LocalgateRoute, aliasStops: ReadonlyMap<string, string>): string | null
  {
    if (route.controlUrl) return "its dev server and the terminal it runs in end with it";

    const command = aliasStops.get(LocalgateStartPage.appName(route));
    return command ? `localgate runs: ${command}` : null;
  }

  private static card(entry: { route: LocalgateRoute; addresses: LocalgateAddress[] },
    loopback: boolean, confirming: string | null, listening: boolean | undefined,
    stopsWith: string | null): string
  {
    const { route, addresses } = entry;
    const name = LocalgateStartPage.appName(route);
    const [primary, ...rest] = addresses;
    const meta = (reachable: boolean | undefined) => LocalgateStartPage.meta(route, reachable);
    // A card asking the question must not also be one big link to the app, or the click meant for
    // "no, go back" opens the dev server instead.
    const asking = confirming == name;

    const status = LocalgateStartPage.statusOf(route, listening);

    const parts = [
      `<li class="card${listening === false ? " down" : ""}">`,
      "<div class=\"head\">",
      `<span class="mark" style="--hue: ${LocalgateStartPage.hueOf(name)}">`
        + `${LocalgateStartPage.escape(LocalgateStartPage.monogram(name))}</span>`,
      "<span class=\"title\">",
      asking
        ? `<span class="name">${LocalgateStartPage.escape(name)}</span>`
        : `<a class="name" href="${LocalgateStartPage.escape(primary!.url)}">${LocalgateStartPage.escape(name)}</a>`,
      `<span class="primary">${LocalgateStartPage.escape(primary!.hostname)}</span>`,
      "</span>",
      `<span class="state ${status.shade}"><span class="dot"></span>`
        + `${LocalgateStartPage.escape(status.word)}</span>`,
      "</div>"
    ];

    if (asking && stopsWith) parts.push(LocalgateStartPage.confirmBlock(name, stopsWith));
    else
    {
      const chips = rest.map(address => `<a class="chip" href="${LocalgateStartPage.escape(address.url)}">`
        + `${LocalgateStartPage.escape(address.label)}  ·  ${LocalgateStartPage.escape(address.hostname)}</a>`);

      if (route.kind == "alias") chips.push("<span class=\"chip\">alias</span>");
      if (loopback && route.debuggerAttached) chips.push("<span class=\"chip\">debugger</span>");
      // Off this machine there is no stopping at all: that is process control, and it stays on loopback.
      if (loopback && stopsWith)
        chips.push(`<a class="chip danger" href="/?confirm=${encodeURIComponent(name)}">stop</a>`);

      if (chips.length > 0) parts.push(`<div class="chips">${chips.join("")}</div>`);
    }

    // The full line in `title` as well as on the card: the directory is the long part, and it is the
    // part a person hovers to read when the card has cut it off.
    if (loopback) parts.push(`<div class="meta" title="${LocalgateStartPage.escape(meta(listening))}">`
      + `${LocalgateStartPage.escape(meta(listening))}</div>`);

    parts.push("</li>");
    return parts.join("");
  }

  // The second step of the stop, and the only form on the page. A POST, because it ends a process:
  // a link would be followed by a prefetch, a crawler or a restored tab.
  private static confirmBlock(name: string, stopsWith: string): string
  {
    const safe = LocalgateStartPage.escape(name);
    return "<div class=\"confirm\">"
      + `<p>Stop ${safe}? ${LocalgateStartPage.escape(stopsWith)}.</p>`
      + `<form method="post" action="${LocalgateStartPage.stopPathConst}?name=${encodeURIComponent(name)}">`
      + "<button class=\"kill\" type=\"submit\">yes, stop it</button></form>"
      + "<a class=\"chip\" href=\"/\">cancel</a>"
      + "</div>";
  }

  private static refusal(reason: string): string
  {
    return `<!doctype html><meta charset="utf-8"><title>localgate</title>`
      + `<p>localgate: ${LocalgateStartPage.escape(reason)}.</p>`;
  }

  // The first letter of the name plus the start of its last word, because our names share their
  // beginning and differ at the end: web-myapp-admin and web-myapp-app are WAD and WAP, while
  // initials of the leading words would make both of them WM.
  private static monogram(name: string): string
  {
    const words = name.split("-").filter(word => word.length > 0);
    if (words.length == 0) return "?";
    if (words.length == 1) return words[0]!.slice(0, 2).toUpperCase();
    return `${words[0]![0]!}${words[words.length - 1]!.slice(0, 2)}`.toUpperCase();
  }

  // A colour the name always gets back, so a card keeps its look across a refresh and a person finds an
  // app by where the colour is rather than by reading every tile.
  private static hueOf(name: string): number
  {
    let hash = 0;
    for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360;
    return hash;
  }

  private static meta(route: LocalgateRoute, listening: boolean | undefined): string
  {
    const parts = [`127.0.0.1:${route.port}`];

    // An alias outlives whatever it points at, on purpose, so a dead one is not a fault to report but a
    // row the reader may simply be done with. The way out belongs next to it.
    if (listening === false && route.kind == "alias")
      parts.push(`nothing there  ·  localgate alias --remove ${LocalgateStartPage.appName(route)}`);

    if (route.command) parts.push(route.command);
    if (route.cwd) parts.push(route.cwd);
    return parts.join("  ·  ");
  }

  // What the badge says. The probe answers the question the reader is actually asking - is this thing
  // up - and the traffic-learned state refines it: a port that accepts connections while every request
  // times out is wedged, not running. Without a probe result the state is all there is.
  private static statusOf(route: LocalgateRoute, listening: boolean | undefined): { word: string; shade: string }
  {
    if (listening === undefined)
      return { word: LocalgateStartPage.stateWord(route.state), shade: route.state };

    if (listening)
      return route.state == "unresponsive"
        ? { word: "not responding", shade: "unresponsive" }
        : { word: "running", shade: "healthy" };

    // Nothing on the port. For an app just launched that is normal - the dev server binds its port a
    // moment later - and the same grace window the proxy uses for a refused request applies here. An
    // alias starts nothing, so for it there is no such moment.
    const since = Date.parse(route.lastResponseAt ?? route.startedAt);
    const starting = route.kind == "app" && Date.now() - since < LocalgateHealth.startupGraceMs();
    return starting ? { word: "starting", shade: "starting" } : { word: "not running", shade: "dead" };
  }

  private static stateWord(state: LocalgateRouteState): string
  {
    if (state == "starting") return "starting";
    else if (state == "healthy") return "running";
    else if (state == "unresponsive") return "not responding";
    else if (state == "dead") return "not running";
    else
      throw new Error(`unknown localgate route state: ${JSON.stringify(state)}`);
  }

  private static appName(route: LocalgateRoute): string
  {
    return LocalgateNames.shortName(route.names[0]!);
  }

  private subtitle(count: number, loopback: boolean): string
  {
    const routes = count == 1 ? "1 route" : `${count} routes`;
    if (!loopback) return `${routes} on ${this.machine?.label ?? "this machine"}, reachable from this network`;
    return this.machine ? `${routes} on ${this.machine.label}` : `${routes} on this machine`;
  }

  private static emptyMessage(loopback: boolean): string
  {
    return loopback
      ? "No routes yet. Start one with: localgate run npm run dev"
      : "No shared routes. Everything running here is in mode local.";
  }

  private static footer(loopback: boolean, confirming: string | null): string
  {
    // The refresh is off while a card is asking, so the footer must not keep promising one.
    if (confirming) return "localgate list";
    return loopback
      ? `localgate list  ·  refreshes every ${LocalgateStartPage.refreshSecondsConst} s`
      : `refreshes every ${LocalgateStartPage.refreshSecondsConst} s`;
  }

  private static sendHtml(response: ServerResponse, status: number, body: string): void
  {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
    response.end(body);
  }

  // A command line and a working directory are free text from whatever was started, and they are printed
  // into a page, so nothing goes in unescaped - including the values that look safe today.
  private static escape(value: string): string
  {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
