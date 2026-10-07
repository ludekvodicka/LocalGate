import { connect } from "node:net";
import type { LocalgateRoute } from "./localgateRegistry.ts";

// Whether anything is listening on a route's port, right now.
//
// The proxy's own health is learned from forwarded traffic, which costs nothing but says nothing at all
// about a route nobody has opened: a dev server that has been up for an hour and an alias whose
// container is down both sit at "starting" until someone visits them. A connection to loopback answers
// that question directly and costs a millisecond, so the start page asks it rather than repeating a
// guess back to the reader.
export class LocalgatePortProbe
{
  // Loopback either accepts or refuses at once. The timeout is for the case in between - a port being
  // dropped by a firewall rule - where the page must not wait on it.
  private static readonly timeoutMsConst = 400;

  static listening(port: number, timeoutMs: number = LocalgatePortProbe.timeoutMsConst): Promise<boolean>
  {
    return new Promise<boolean>(resolve =>
    {
      const socket = connect({ host: "127.0.0.1", port });
      const settle = (answer: boolean) =>
      {
        socket.destroy();
        resolve(answer);
      };

      socket.setTimeout(timeoutMs, () => settle(false));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
  }

  // All of them at once, keyed by route id: a page that probed eight ports one after another would
  // answer eight timeouts later in the worst case. It takes the two fields it dials with rather than the
  // whole route, because that is all a port probe can honestly need.
  static async listeningRoutes(routes: Pick<LocalgateRoute, "id" | "port">[]): Promise<Map<string, boolean>>
  {
    const answers = await Promise.all(routes.map(route => LocalgatePortProbe.listening(route.port)));
    return new Map(routes.map((route, index) => [route.id, answers[index]!]));
  }
}
