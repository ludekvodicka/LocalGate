import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalgateAliasStore } from "./localgateAliasStore.ts";

describe("LocalgateAliasStore", () =>
{
  const scratchDirectory = (): string => mkdtempSync(join(tmpdir(), "localgate-aliases-"));

  const withContents = (contents: unknown): string =>
  {
    const path = join(scratchDirectory(), "aliases.json");
    writeFileSync(path, typeof contents == "string" ? contents : JSON.stringify(contents));
    return path;
  };

  it("returns nothing when the file does not exist", () =>
  {
    expect(LocalgateAliasStore.load(join(tmpdir(), "localgate-no-such-directory", "aliases.json"))).toEqual([]);
  });

  it("round-trips an alias and creates the directory on the first write", () =>
  {
    const path = join(scratchDirectory(), "deep", "aliases.json");
    LocalgateAliasStore.add({ name: "myapp", port: 8_001 }, path);

    expect(LocalgateAliasStore.load(path)).toEqual([{ name: "myapp", port: 8_001 }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ aliases: [{ name: "myapp", port: 8_001 }] });
  });

  it("replaces the port when the same name is added again", () =>
  {
    const path = join(scratchDirectory(), "aliases.json");
    LocalgateAliasStore.add({ name: "myapp", port: 8_001 }, path);
    LocalgateAliasStore.add({ name: "cms", port: 8_002 }, path);
    LocalgateAliasStore.add({ name: "myapp", port: 8_003 }, path);

    expect(LocalgateAliasStore.load(path)).toEqual([{ name: "cms", port: 8_002 }, { name: "myapp", port: 8_003 }]);
  });

  it("reports whether a removal dropped anything", () =>
  {
    const path = join(scratchDirectory(), "aliases.json");
    LocalgateAliasStore.add({ name: "myapp", port: 8_001 }, path);

    expect(LocalgateAliasStore.remove("cms", path)).toBe(false);
    expect(LocalgateAliasStore.remove("myapp", path)).toBe(true);
    expect(LocalgateAliasStore.load(path)).toEqual([]);
  });

  it("treats unparseable JSON as empty and leaves the file alone", () =>
  {
    const path = withContents("{ not json");

    expect(LocalgateAliasStore.load(path)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("treats a file without an alias list as empty", () =>
  {
    expect(LocalgateAliasStore.load(withContents({ aliases: "myapp" }))).toEqual([]);
  });

  it("skips an entry whose name is not a DNS label or whose port is not a port", () =>
  {
    const path = withContents({ aliases: [
      { name: "Bad Name", port: 8_001 },
      { name: "myapp", port: 70_000 },
      { name: "myapp", port: "8001" },
      { name: "cms", port: 8_002 }
    ] });

    expect(LocalgateAliasStore.load(path)).toEqual([{ name: "cms", port: 8_002 }]);
  });

  it("keeps the valid entries when a broken one is rewritten", () =>
  {
    const path = withContents({ aliases: [{ name: "Bad Name", port: 8_001 }, { name: "cms", port: 8_002 }] });
    LocalgateAliasStore.add({ name: "myapp", port: 8_003 }, path);

    expect(LocalgateAliasStore.load(path)).toEqual([{ name: "cms", port: 8_002 }, { name: "myapp", port: 8_003 }]);
  });

  // The warning is the only trace a dropped alias leaves, and the store is the only place that can say it.
  it("says on stderr what it skipped", () =>
  {
    const path = withContents({ aliases: [{ name: "Bad Name", port: 8_001 }, { name: "cms", port: 8_002 }] });
    const written = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try
    {
      expect(LocalgateAliasStore.load(path)).toEqual([{ name: "cms", port: 8_002 }]);
      expect(written).toHaveBeenCalledTimes(1);
      expect(String(written.mock.calls[0][0])).toContain("not a DNS label");
    }
    finally
    {
      written.mockRestore();
    }
  });

  it("says on stderr that a file without an alias list was ignored", () =>
  {
    const path = withContents({ routes: [] });
    const written = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try
    {
      expect(LocalgateAliasStore.load(path)).toEqual([]);
      expect(String(written.mock.calls[0][0])).toContain("no alias list");
    }
    finally
    {
      written.mockRestore();
    }
  });

  it("agrees with the CLI about which ports are storable", () =>
  {
    expect(LocalgateAliasStore.isPort(8_001)).toBe(true);
    expect(LocalgateAliasStore.isPort(0)).toBe(false);
    expect(LocalgateAliasStore.isPort(70_000)).toBe(false);
    expect(LocalgateAliasStore.isPort(8_001.5)).toBe(false);
  });

  it("puts the file next to the machine config", () =>
  {
    expect(LocalgateAliasStore.filePath().endsWith(join(".localgate", "aliases.json"))).toBe(true);
  });
});
