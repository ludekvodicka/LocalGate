import { LocalgateNames } from "../config/localgateNames.ts";
import type { LocalgateMachineSettings } from "../config/localgateMachineConfig.ts";
import type { LocalgatePersistedAlias } from "../config/localgateAliasStore.ts";
import type { LocalgateMode } from "../config/localgateProjectConfig.ts";
import type { LocalgateRegistry, LocalgateRouteRegistration } from "./localgateRegistry.ts";

// One builder for the registration an alias produces, shared by the `alias` command and by the proxy's
// boot restore. Two copies of this literal is how a restored alias ends up subtly different from the one
// the person registered - a missing name, a different mode - in the half of the flow nobody watches.
export class LocalgateAliasRoute
{
  static registration(name: string, port: number, machine: LocalgateMachineSettings | null): LocalgateRouteRegistration
  {
    const mode: LocalgateMode = machine ? "lan" : "local";

    return {
      names: LocalgateNames.routeNames(name, mode, machine),
      port,
      kind: "alias",
      mode,
      cwd: null,
      command: null,
      controlUrl: null,
      runnerPid: null,
      childPid: null,
      debuggerAttached: false
    };
  }

  // Replays persisted intent into a fresh table. Kept out of the proxy host so the step that actually
  // fixes a lost alias can be tested without binding a port.
  static restore(registry: LocalgateRegistry, aliases: LocalgatePersistedAlias[],
    machine: LocalgateMachineSettings | null, now: string): string[]
  {
    const restored: string[] = [];
    for (const alias of aliases)
    {
      // The table is empty at boot, so nothing can collide; a name repeated in a hand-edited file
      // replaces the earlier row, the same as re-running the alias command.
      registry.register(LocalgateAliasRoute.registration(alias.name, alias.port, machine), now);
      restored.push(`localgate: restored alias ${alias.name} -> 127.0.0.1:${alias.port}`);
    }

    return restored;
  }
}
