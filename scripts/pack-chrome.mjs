#!/usr/bin/env node
/**
 * Build the MV3 extension and publish to the canonical release location:
 *   dist/releases/tachyon-companion-browser-<version>/
 *
 * Staging (apps/browser/dist-unpacked) is intermediate only — never dogfood from there.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("→ build browser extension (staging)");
// --staging-only avoids double-publish if the workspace pack also publishes.
run("npm", ["run", "pack:staging", "-w", "@tachyon-companion/browser"]);

console.log("→ publish to dist/releases/");
run("node", [join(root, "scripts/publish-browser-release.mjs")]);
