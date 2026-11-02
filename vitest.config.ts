import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// A machine that sets AX_TEST_TMPDIR wants test fixtures in that folder (excluded from antivirus
// scans) instead of the system temp. Redirecting here, in the vitest main process, takes effect
// before any test runs; workers and the processes tests spawn inherit it.
if (process.env.AX_TEST_TMPDIR) {
  const projectTmpdir = join(process.env.AX_TEST_TMPDIR, "Localgate");
  mkdirSync(projectTmpdir, { recursive: true });
  Object.assign(process.env, { TEMP: projectTmpdir, TMP: projectTmpdir, TMPDIR: projectTmpdir });
}

export default defineConfig({
  test: {
    include: ["logic/**/*.test.ts"],
    environment: "node"
  }
});
