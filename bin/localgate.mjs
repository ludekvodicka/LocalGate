#!/usr/bin/env node
// Runs the TypeScript sources directly through tsx: no build step, so a working copy is always
// runnable. A published build would swap this for compiled output.
import { register } from "tsx/esm/api";

register();

const { LocalgateCli } = await import("../logic/cli/localgateCli.ts");
process.exitCode = await LocalgateCli.main(process.argv.slice(2));
