# Local control authority

Localgate's control authority is the local host process. `LocalgateProxy` serves
`LocalgateControlApi` only from the listener bound to `127.0.0.1`. The LAN listener does not dispatch
the reserved control path. It cannot register, inspect or change Localgate routes through that API.
Proxy routes targeting the proxy's own port are rejected, so a LAN route cannot loop back into the
control listener.

The start page is the one route information the LAN listener does serve, and there it is read-only and
filtered by reach: it renders only routes that listener would forward, without local ports, commands or
directories, and nothing on it changes the machine.

Its stop button is the exception, and it stays on the loopback listener with the rest of the control
surface. The LAN listener neither renders it nor accepts its POST. Because that POST is reachable by any
site the local browser opens, it additionally requires an `Origin` equal to the page's own, and it ends
a process only by asking the owning runner. `docs/architecture/start-page.md` records both halves.

The control API deliberately has no application account list. A process able to reach the local
loopback listener belongs to its trusted operating-system boundary. It is not a per-user permission
service and should not be exposed as one. Paired or remote controllers must enforce their own host
authorization before invoking local control operations.

Applications served through Localgate remain responsible for their own backend accounts and
operation permissions. Publishing a route, resolving a hostname or forwarding a request grants no
application role. The account-authority migration does not change this existing trust model.

Entry points are `logic/proxy/localgateProxy.ts` and `logic/proxy/localgateControlApi.ts`. This note
records the existing listener boundary; it introduces no additional authentication mechanism.
