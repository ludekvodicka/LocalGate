import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LocalgateNodeOptions } from "./localgateNodeOptions.ts";

describe("LocalgateNodeOptions", () =>
{
  it("adds the bootstrap import and preserves existing Node options", () =>
  {
    const result = LocalgateNodeOptions.apply(
      { NODE_OPTIONS: "--max-old-space-size=4096" },
      "file:///C:/tools/localgateNodeBootstrap.mjs"
    );

    expect(result.NODE_OPTIONS)
      .toBe("--max-old-space-size=4096 --import=file:///C:/tools/localgateNodeBootstrap.mjs");
  });

  it("does not add the same bootstrap twice", () =>
  {
    const option = "--import=file:///C:/tools/localgateNodeBootstrap.mjs";
    expect(LocalgateNodeOptions.apply({ NODE_OPTIONS: option }, "file:///C:/tools/localgateNodeBootstrap.mjs")
      .NODE_OPTIONS).toBe(option);
  });

  it("makes a nested localhost name resolve to the Localgate loopback listener", () =>
  {
    const script = 'require("node:dns").lookup("myapp.localhost", { all: true }, '
      + '(error, addresses) => { if (error) throw error; process.stdout.write(JSON.stringify(addresses)); });';
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: LocalgateNodeOptions.apply({})
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });
});
