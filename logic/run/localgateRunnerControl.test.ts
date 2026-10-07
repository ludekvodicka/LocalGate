import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalgateRunnerControl, type LocalgateRunnerControlHandler } from "./localgateRunnerControl.ts";

type Deferred = { promise: Promise<void>; release: () => void };

describe("LocalgateRunnerControl", () =>
{
  const opened: LocalgateRunnerControl[] = [];

  const deferred = (): Deferred =>
  {
    let release: () => void = () => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };

  // What the runner would do, replaced one member at a time: `events` is the order the runner saw, which
  // is the part the stop is about - the kill, then the answer, then this process ending.
  const startControl = async (overrides: Partial<LocalgateRunnerControlHandler> = {}) =>
  {
    const events: string[] = [];
    const control = new LocalgateRunnerControl({
      routeId: overrides.routeId ?? (() => "r1"),
      logs: overrides.logs ?? (lines => ["one", "two", "three"].slice(-lines)),
      restart: overrides.restart ?? (() => Promise.resolve()),
      stop: overrides.stop ?? (() => Promise.resolve()),
      stopped: overrides.stopped ?? (() => events.push("stopped"))
    });

    const url = await control.start();
    opened.push(control);
    return { control, url, events };
  };

  afterEach(async () =>
  {
    for (const control of opened.splice(0)) await control.close();
  });

  it("serves the runner's route id and its captured output", async () =>
  {
    const { url } = await startControl();

    expect(await (await fetch(`${url}/ping`)).json()).toEqual({ ok: true, id: "r1" });
    expect(await (await fetch(`${url}/logs?lines=2`)).json()).toEqual({ lines: ["two", "three"] });

    const unknown = await fetch(`${url}/nope`);
    expect(unknown.status).toBe(404);
  });

  it("answers a restart with what the runner reported", async () =>
  {
    const { url } = await startControl({ restart: () => Promise.reject(new Error("myapp.localhost still answers")) });

    const refused = await fetch(`${url}/restart`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Error: myapp.localhost still answers" });
  });

  // The regression this guards: the stop answered `200` and only then asked the runner to kill anything,
  // so `localgate stop` printed "stopped" for a kill the system had not even been asked about yet, and a
  // kill it went on to refuse was reported the same as one that worked.
  it("answers a stop only once the kill has finished", async () =>
  {
    const killing = deferred();
    const { url, events } = await startControl({
      stop: () =>
      {
        events.push("killing");
        return killing.promise;
      }
    });

    let answered = false;
    const pending = fetch(`${url}/stop`, { method: "POST" }).then(response => { answered = true; return response; });

    await vi.waitFor(() => expect(events).toEqual(["killing"]));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    killing.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await vi.waitFor(() => expect(events).toEqual(["killing", "stopped"]));
  });

  // A refused stop leaves the runner where it is: the process it could not kill is still serving its
  // route, and it is still the owner the next stop can ask.
  it("refuses a stop the kill did not achieve and leaves the runner alive", async () =>
  {
    const failure = "myapp.localhost still answers on 127.0.0.1:61346 after killing 41188 - it was not stopped";
    const { url, events } = await startControl({ stop: () => Promise.reject(new Error(failure)) });

    const response = await fetch(`${url}/stop`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `Error: ${failure}` });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toEqual([]);
  });

  // The reason is written here and read by everything that reports a refusal - the CLI and the start
  // page both call this, so the body they parse is the one this endpoint actually wrote.
  it("hands every reader the reason out of its own refusal body", async () =>
  {
    const { url } = await startControl({ stop: () => Promise.reject(new Error("port still held")) });

    const refused = await fetch(`${url}/stop`, { method: "POST" });
    expect(LocalgateRunnerControl.refusalDetail(await refused.text())).toBe(": Error: port still held");

    const unknown = await fetch(`${url}/nope`, { method: "POST" });
    expect(LocalgateRunnerControl.refusalDetail(await unknown.text())).toBe(": unknown POST /nope");
  });

  // A runner that answered with something else is still the only account of what happened, so what it
  // wrote is reported as it stands rather than dropped for not being the expected shape.
  it("reports a body that is not its own shape as it stands, and an empty one not at all", () =>
  {
    expect(LocalgateRunnerControl.refusalDetail("Bad Gateway")).toBe(": Bad Gateway");
    expect(LocalgateRunnerControl.refusalDetail("{\"reason\":\"other\"}")).toBe(": {\"reason\":\"other\"}");
    expect(LocalgateRunnerControl.refusalDetail("   ")).toBe("");
    expect(LocalgateRunnerControl.refusalDetail("")).toBe("");
  });

  // The kill usually ends the child, and the runner's own exit path closes this server on its way out. It
  // has to wait here, or a stop that worked reaches its caller as a broken connection.
  it("lets an answer in flight out before the runner's exit closes the server", async () =>
  {
    const killing = deferred();
    const entered = deferred();
    const { control, url } = await startControl({
      stop: () =>
      {
        entered.release();
        return killing.promise;
      }
    });

    const pending = fetch(`${url}/stop`, { method: "POST" });
    await entered.promise;

    const closing = control.close();
    killing.release();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await closing;
  });
});
