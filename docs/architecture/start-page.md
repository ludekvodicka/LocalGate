# The start page

`http://start.localhost` is a page the proxy serves from itself: every route on the machine, with the
addresses each one answers on. It exists because the route table had no face. `localgate list` prints
it in a terminal, and the 404 page prints it only to whoever already guessed a wrong hostname - so a
person with a browser open had nowhere to start unless they remembered a name.

## The name is reserved, not registered

The page has no route. `LocalgateProxy.handleRequest` resolves it after the control API and **before**
the registry lookup, because a route that took the name would otherwise shadow the page. That order is
why `LocalgateNames.isReserved` exists and why `LocalgateRegistry.register` and `update` refuse the name
outright: without the refusal such a route would register, appear in every listing, and never be
reachable in a browser. `localgate alias start <port>` and `localgate run` in a project named `start`
refuse earlier, so the message can name the file that decides it.

The page answers on two names, both built from the same `LocalgateNames` helpers every route uses:

| Name | Listener |
|---|---|
| `start.localhost` | loopback only |
| `start.<label>.<baseDomain>` | loopback and LAN, and only when `~/.localgate/config.json` exists |

## Reach decides the contents, not the name

The LAN listener answers the shared name, and what it renders is narrower than what loopback gets:

- A route with no address off this machine - mode `local`, whose only name is on `.localhost` - is
  **absent**, name included. Mode `local` means the app never leaves the machine, and listing its name
  on the LAN would hand out the inventory the mode exists to keep back.
- The `.localhost` address is dropped from the routes that remain. Off this machine that name means the
  computer that resolved it, so it can only mislead.
- The upstream port, the command line and the working directory are omitted. They are local detail, and
  the LAN answer has never carried any.

`LocalgateStartPage.addressesOf` performs both filters, and a route left with no address is not listed.
This mirrors `LocalgateRegistry.answers`, which is what keeps a `.localhost` name off the LAN listener
in the first place; the page must not be the one surface that contradicts it.

The page is not served on a public name. A tunnel forwards whatever `Host` it was configured with, so
reaching it from the internet would take a deliberate DNS entry and ingress rule for `start.<label>`;
localgate never prints one, and `localgate cloudflare-info` only ever names a project.

## One card, one click

Each route is a card, and the whole card opens it - the name is the link, and a stretched `::after`
overlay makes the padding around it clickable too. The address behind the card is the **first address
this listener can reach**: the `.localhost` name on loopback, the shared name on the LAN. A card that
opened a name the reader cannot resolve would be a dead link for exactly the person who clicked it.

The remaining addresses are chips above that overlay, so each one still opens its own name.

The monogram is the name's first letter plus the start of its last word, because our names share their
beginning and differ at the end: `web-myapp-admin` and `web-myapp-app` are `WAD` and `WAP`, while
the initials of the leading words would make both of them `WM`. Its colour is a hash of the same name,
so a card looks the same after every refresh and an app can be found by where its colour is. The name
itself wraps instead of truncating - it is what the reader is looking for, and `web-myapp-customer-frontend`
is long enough that an ellipsis would cut off the half that identifies it.

## The badge asks the port, it does not repeat the table

The proxy's own health is learned from forwarded traffic, which costs nothing and is exactly right for
what it guards: `unresponsive` and the automatic restart both need a request that went unanswered. But
it says nothing about a route nobody has opened. A route is registered as `starting` and only leaves
that state when a request is forwarded, so a dev server that has been up for an hour, and an alias whose
container is gone, both read `starting` for as long as nobody visits them. After a proxy restart that is
every route at once, which is what made the page look like a list of things perpetually booting.

So the page probes instead. `LocalgatePortProbe` opens a TCP connection to each route's port on
loopback, all of them in parallel, and the badge is decided from the answer:

| Probe | Route | Badge |
|---|---|---|
| accepts | any | **running** |
| accepts | every request timed out (`unresponsive`) | **not responding** - the probe cannot see a wedged app, only the traffic can |
| refused | an app launched within the startup grace window | **starting** - a dev server binds its port a moment after launch |
| refused | anything else, an alias included | **not running**, and the card is dimmed |
| not run | any | the state the table holds, as before |

An alias never gets the starting grace: it points at a container somebody else starts, so there is no
launch to wait for. Its card carries the way out instead - `localgate alias --remove <name>` - because a
dead alias is not a fault to report but a row the reader may be done with. The row itself stays: alias
intent is persisted on purpose, and the next proxy start would bring it back anyway.

A connection accepted is not a promise that the service behind it is well. Where a port is forwarded -
Docker Desktop, WSL - the forwarder may accept the connection itself, so "running" there means the
forward is up. Asking for more would mean sending a real HTTP request to every app on every render,
which wakes dev servers, fills their logs and triggers a rebuild in Next.js; that price is not worth a
badge.

## Stopping a dev server from the page

An app card carries a `stop` button, and it is the one thing on the page that changes the machine. It
is deliberately narrow:

- **Loopback only.** Ending a process is control, and control lives behind the same listener boundary as
  `/__localgate/*`. The LAN listener never renders the button and refuses the POST whatever it carries.
- **Only where something can be asked.** For an app that is its runner, reached through `controlUrl`.
  An alias has no runner, so it gets a button only when `~/.localgate/aliases.json` carries a `stop`
  command for it; localgate then runs that line. The question names the command, because a click that
  runs a shell line should say which one. A stop command never crosses the control API - only that file
  can carry one, so a form POST from a web page cannot plant one for the reader to click later.
- **Two steps, no script.** The button is a link to `/?confirm=<name>`, which re-renders that one card
  with the question and a form. Only the form's POST stops anything, so nothing is ended by a prefetch,
  a crawler or a restored tab. While a card is asking, the page's auto-refresh is left out of the
  markup - a question that reloads under the cursor answers itself.
- **Same-origin POSTs only.** A form POST needs no permission to leave the page it sits on, so any site
  the developer happens to open could otherwise end every dev server on the machine. The `Origin` header
  must equal this page's own origin; browsers always send it on a POST.
- **Addressed by name, not by route id.** Ids are handed out per proxy process, so a tab left open
  across a proxy restart could confirm `r3` and end whatever `r3` has become. A name that no longer
  exists stops nothing, which is the state the click was asking for anyway.

The proxy does not kill anything itself. For an app it posts to the runner's own `/stop`, and the runner
ends the child tree, releases the port and deregisters its route - the same path `localgate stop` takes.
For an alias it runs the configured line through `LocalgateShellCommand` and waits for it, so a failure
can be reported instead of leaving the reader with a page that still lists what they asked to end. The
answer is a 303 back to the list with `?stopped=<name>`, whose note the next auto-refresh clears; a
command that fails or hangs answers 502 with its exit code and the tail of its output.

What comes back from either is reported rather than summarized. A runner that refuses the stop answers
`409` with the reason its kill gave, and the page prints that reason after the status code, because the
reader of this page is exactly the one who does not have a terminal open to ask. The body is parsed by
`LocalgateRunnerControl.refusalDetail`, in the class that writes it, and `localgate stop`, `localgate
restart` and the proxy's automatic restart all report a refusal through the same call.

Stopping an alias does not remove it. The route and the remembered intent both stay, and the card simply
reads **not running** afterwards - which is the truth, and what `localgate alias --remove` is for.

## Everything else

- **Auto-refresh** is a `<meta http-equiv="refresh">` every 5 s. A route appears the moment a dev server
  registers and its state changes while the page is open, so a list that is only true at load time is
  the one thing this page must not be. No script and no fetch: the page has no control-API access, and
  it is served to the LAN.
- **Self-contained.** Inline CSS, no external asset, no font download. It also renders in a dark theme
  through `prefers-color-scheme`.
- **Escaped.** A command line and a working directory are free text from whatever was started, so
  everything goes through `LocalgateStartPage.escape` on the way into the page.
- **Addresses come from `LocalgateUrl.routeAddresses`**, shared with the banner and `localgate list`.
  The position in `route.names` is the reach - local, network, internet - which is also why the public
  address is written with `https` and without the proxy's internal port.

Entry points: `logic/proxy/localgateStartPage.ts`, dispatched from `logic/proxy/localgateProxy.ts` and
constructed in `logic/proxy/localgateProxyHost.ts`.
