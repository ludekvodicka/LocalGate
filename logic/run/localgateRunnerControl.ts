import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// What the endpoint may ask of the runner that owns the dev process. `restart` and `stop` both resolve
// only once the work is done and reject with the reason it is not, because the answer is the only thing
// the caller ever sees: a `200` written before the kill is how `localgate stop` came to print "stopped"
// for a process the system had refused to end.
export type LocalgateRunnerControlHandler =
{
  routeId(): string | null;
  logs(lines: number): string[];
  restart(): Promise<void>;
  stop(): Promise<void>;
  // Runs once the stop's answer has left this server, and not inside `stop` itself: ending the runner
  // closes this server, and a socket cut before the answer left it would report a transport failure for
  // a stop that worked.
  stopped(): void;
};

// The runner's own endpoint, on loopback and nowhere else: how `localgate restart`, `localgate stop`,
// `localgate logs` and the start page's stop button reach the process that owns the dev server.
export class LocalgateRunnerControl
{
  private static readonly defaultLogLinesConst = 80;

  private readonly handler: LocalgateRunnerControlHandler;
  private server: Server | null;
  // The stop answer a caller is waiting for, from the request until it has left the socket. Closing the
  // server destroys that socket, so the close waits for it.
  private answering: Promise<void> | null;

  constructor(handler: LocalgateRunnerControlHandler)
  {
    this.handler = handler;
    this.server = null;
    this.answering = null;
  }

  // Loopback only: the control channel must not be reachable from the LAN.
  start(): Promise<string>
  {
    const server = createServer((request, response) => this.dispatch(request, response));
    this.server = server;

    return new Promise<string>((resolve, reject) =>
    {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () =>
      {
        const address = server.address();
        if (!address || typeof address == "string")
        {
          reject(new Error("control server has no port"));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  // What a refused control call says, as the tail of a sentence that has already named the status code:
  // the reason the runner wrote, or nothing when it wrote nothing. It is the reading half of `refusal`
  // below, and it lives here so the shape of that body has one owner - `localgate restart`, `localgate
  // stop` and the start page's stop button all report the same refusal, and the page has no terminal to
  // send its reader to for the rest of it.
  static refusalDetail(body: string): string
  {
    const text = body.trim();
    if (text.length == 0) return "";

    try
    {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed == "object" && parsed !== null && "error" in parsed && typeof parsed.error == "string")
        return `: ${parsed.error}`;
    }
    catch
    {
      // Not JSON, so the body is whatever the runner wrote and is reported as it stands.
    }

    return `: ${text}`;
  }

  async close(): Promise<void>
  {
    const server = this.server;
    if (!server) return;

    this.server = null;
    if (this.answering) await this.answering;

    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private dispatch(request: IncomingMessage, response: ServerResponse): void
  {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, payload: unknown) =>
    {
      const body = JSON.stringify(payload);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    };

    if (url.pathname == "/ping") return send(200, { ok: true, id: this.handler.routeId() });

    if (url.pathname == "/logs")
    {
      const requested = url.searchParams.get("lines") ?? String(LocalgateRunnerControl.defaultLogLinesConst);
      return send(200, { lines: this.handler.logs(Math.max(1, Number.parseInt(requested, 10))) });
    }

    if (url.pathname == "/restart" && request.method == "POST")
    {
      void this.handler.restart().then(
        () => send(200, { ok: true }),
        (error: unknown) => send(409, LocalgateRunnerControl.refusal(error))
      );
      return;
    }

    if (url.pathname == "/stop" && request.method == "POST")
    {
      // From here on the runner's exit has to wait for this answer. The kill below ends the child, the
      // runner ends with it, and closing this server on the way out would cut the socket the caller is
      // still waiting on - a stop that worked, reported as a broken connection.
      const answered = new Promise<void>(resolve => response.once("close", () => resolve()));
      this.answering = answered;

      void this.handler.stop().then(
        () =>
        {
          send(200, { ok: true });
          void answered.then(() => this.handler.stopped());
        },
        (error: unknown) => send(409, LocalgateRunnerControl.refusal(error))
      );
      return;
    }

    return send(404, LocalgateRunnerControl.refusal(`unknown ${request.method} ${url.pathname}`));
  }

  // Everything this endpoint refuses says why in the same field, because that reason is the only account
  // of what happened: a kill the system turned down, a port still held, a verb this runner does not know.
  private static refusal(error: unknown): { error: string }
  {
    return { error: String(error) };
  }
}
