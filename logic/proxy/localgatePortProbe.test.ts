import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { LocalgatePortProbe } from "./localgatePortProbe.ts";

describe("LocalgatePortProbe", () =>
{
  const open: Server[] = [];

  const listen = async (): Promise<number> =>
  {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    open.push(server);

    const address = server.address();
    if (!address || typeof address == "string") throw new Error("no port");
    return address.port;
  };

  afterEach(async () =>
  {
    while (open.length > 0)
    {
      const server = open.pop()!;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("tells a bound port from a free one", async () =>
  {
    const port = await listen();

    expect(await LocalgatePortProbe.listening(port)).toBe(true);
    // Taken and released, so nothing is listening on it and nothing else has claimed it either.
    const free = await listen();
    await new Promise<void>(resolve => open.pop()!.close(() => resolve()));
    expect(await LocalgatePortProbe.listening(free)).toBe(false);
  });

  it("answers for every route in one pass, keyed by route id", async () =>
  {
    const port = await listen();
    const routes = [{ id: "r1", port }, { id: "r2", port: 1 }];

    const answers = await LocalgatePortProbe.listeningRoutes(routes);

    expect(answers.get("r1")).toBe(true);
    expect(answers.get("r2")).toBe(false);
  });
});
