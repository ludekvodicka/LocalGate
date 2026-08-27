import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LocalgateMachineConfig } from "./localgateMachineConfig.ts";

export type LocalgatePersistedAlias =
{
  name: string;
  port: number;
};

// Records alias INTENT - the short name and the port, nothing else. An alias is the one route with no
// process behind it, so a runner heartbeat cannot bring it back after a proxy restart and a file is its
// only possible owner of record. Names and mode are deliberately not stored: re-deriving them at restore
// time is what keeps a changed machine label or domain from resurrecting hostnames nobody uses any more.
// The CLI alias command is the only writer; the proxy reads this once at boot and never writes it.
export class LocalgateAliasStore
{
  private static readonly maxPortConst = 65_535;
  private static readonly directoryModeConst = 0o700;
  private static readonly fileModeConst = 0o600;

  static filePath(): string
  {
    return join(homedir(), ".localgate", "aliases.json");
  }

  // The one port rule for an alias, so the command that writes an entry and the loader that reads it back
  // cannot disagree about what is storable.
  static isPort(value: number): boolean
  {
    return Number.isInteger(value) && value >= 1 && value <= LocalgateAliasStore.maxPortConst;
  }

  // Never throws. A hand-edited or half-written file must not take down a proxy boot that every dev
  // server on the machine depends on, so a bad entry is dropped and the rest still load.
  static load(filePath: string = LocalgateAliasStore.filePath()): LocalgatePersistedAlias[]
  {
    let raw: string;
    try
    {
      raw = readFileSync(filePath, "utf8");
    }
    catch (error)
    {
      // A machine that never registered an alias is the ordinary case and says nothing. Anything else -
      // no permission, a directory in the way - is worth a line, because it loses aliases that exist.
      if ((error as NodeJS.ErrnoException).code != "ENOENT")
        process.stderr.write(`localgate: ${filePath} could not be read, continuing without its aliases: ${String(error)}\n`);
      return [];
    }

    let parsed: unknown;
    try
    {
      parsed = JSON.parse(raw);
    }
    catch
    {
      // Left on disk on purpose: the next add or remove rewrites it, and until then the person can
      // still see what they typed.
      process.stderr.write(`localgate: ${filePath} is not valid JSON, ignoring the aliases in it\n`);
      return [];
    }

    const entries = (parsed as { aliases?: unknown } | null)?.aliases;
    if (!Array.isArray(entries))
    {
      process.stderr.write(`localgate: ${filePath} has no alias list, ignoring it\n`);
      return [];
    }

    const aliases: LocalgatePersistedAlias[] = [];
    for (const entry of entries)
    {
      const alias = LocalgateAliasStore.validated(entry, filePath);
      if (alias) aliases.push(alias);
    }

    return aliases;
  }

  // Upsert by name, because re-running `localgate alias myapp 8002` moves an existing alias to a new
  // port the same way the registry replaces the live route.
  static add(alias: LocalgatePersistedAlias, filePath: string = LocalgateAliasStore.filePath()): void
  {
    const aliases = LocalgateAliasStore.load(filePath).filter(existing => existing.name != alias.name);
    aliases.push(alias);
    LocalgateAliasStore.write(aliases, filePath);
  }

  static remove(name: string, filePath: string = LocalgateAliasStore.filePath()): boolean
  {
    const aliases = LocalgateAliasStore.load(filePath);
    const kept = aliases.filter(alias => alias.name != name);
    if (kept.length == aliases.length) return false;

    LocalgateAliasStore.write(kept, filePath);
    return true;
  }

  // Throws on a disk failure, unlike `load`: a caller that cannot write has to decide what to tell the
  // user, and a silently dropped write is an alias that goes missing at the next boot.
  private static write(aliases: LocalgatePersistedAlias[], filePath: string): void
  {
    // The file lists this machine's internal services, so it stays readable by its owner alone.
    mkdirSync(dirname(filePath), { recursive: true, mode: LocalgateAliasStore.directoryModeConst });

    // Write beside the file, flush it, then rename over the target. Losing every alias to a crash
    // halfway through a write is the failure this file exists to prevent, and without the flush the
    // rename can still publish an empty file after a power cut.
    const temporary = `${filePath}.tmp`;
    const handle = openSync(temporary, "w", LocalgateAliasStore.fileModeConst);
    try
    {
      writeSync(handle, `${JSON.stringify({ aliases }, null, 2)}\n`);
      fsyncSync(handle);
    }
    finally
    {
      closeSync(handle);
    }

    renameSync(temporary, filePath);
  }

  private static validated(entry: unknown, filePath: string): LocalgatePersistedAlias | null
  {
    const candidate = entry as { name?: unknown; port?: unknown } | null;
    const name = candidate?.name;
    const port = candidate?.port;

    if (typeof name != "string" || !LocalgateMachineConfig.isLabel(name))
    {
      process.stderr.write(`localgate: ${filePath} holds an alias whose name is not a DNS label, skipping it\n`);
      return null;
    }

    if (typeof port != "number" || !LocalgateAliasStore.isPort(port))
    {
      process.stderr.write(`localgate: ${filePath} holds alias ${name} without a usable port, skipping it\n`);
      return null;
    }

    return { name, port };
  }
}
