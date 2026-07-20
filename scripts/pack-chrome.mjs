#!/usr/bin/env node
/**
 * Build the MV3 extension and produce a versioned Chrome package:
 *   dist/releases/tachyon-companion-browser-<version>.zip
 *   dist/releases/tachyon-companion-browser-<version>/   (unpacked copy)
 *
 * Chrome Web Store / enterprise can take the zip; local dogfood uses the folder
 * (Load unpacked) or scripts/install-chrome.sh.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browserPkg = JSON.parse(readFileSync(join(root, "apps/browser/package.json"), "utf8"));
const version = browserPkg.version;
const unpackedSrc = join(root, "apps/browser/dist-unpacked");
const releasesDir = join(root, "dist/releases");
const outName = `tachyon-companion-browser-${version}`;
const outDir = join(releasesDir, outName);
const zipPath = join(releasesDir, `${outName}.zip`);

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`→ build browser extension v${version}`);
run("npm", ["run", "pack", "-w", "@tachyon-companion/browser"]);

if (!existsSync(join(unpackedSrc, "manifest.json"))) {
  console.error("dist-unpacked/manifest.json missing after build");
  process.exit(1);
}

mkdirSync(releasesDir, { recursive: true });
rmSync(outDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
cpSync(unpackedSrc, outDir, { recursive: true });

// Prefer system zip; fall back to Python zipfile (no zip(1) required).
const zip = spawnSync("zip", ["-r", "-q", zipPath, outName], { cwd: releasesDir, stdio: "inherit" });
if (zip.status !== 0) {
  const pyScript = `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
out = Path(${JSON.stringify(outDir)})
zp = Path(${JSON.stringify(zipPath)})
name = ${JSON.stringify(outName)}
with ZipFile(zp, "w", ZIP_DEFLATED) as zf:
    for p in sorted(out.rglob("*")):
        if p.is_file():
            zf.write(p, arcname=str(Path(name) / p.relative_to(out)))
print(zp)
`;
  const py = spawnSync("python3", ["-c", pyScript], { cwd: releasesDir, stdio: "inherit" });
  if (py.status !== 0) {
    console.error("zip failed — need zip(1) or python3");
    process.exit(py.status ?? 1);
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

const files = walkFiles(outDir);
const checksum = sha256(zipPath);
const bytes = statSync(zipPath).size;
const manifest = {
  name: "tachyon-companion-browser",
  version,
  builtAt: new Date().toISOString(),
  protocolVersion: 1,
  unpackedDir: outDir,
  zip: zipPath,
  zipSha256: checksum,
  zipBytes: bytes,
  files,
  install: {
    unpacked: "Chrome → chrome://extensions → Developer mode → Load unpacked → select the folder",
    zipNote: "Zip is for archive/distribution; Chrome still prefers Load unpacked for local dogfood",
    script: "bash scripts/install-chrome.sh",
  },
};
const manifestPath = join(releasesDir, `${outName}.json`);
const { writeFileSync } = await import("node:fs");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("");
console.log("Chrome package ready");
console.log(`  version:  ${version}`);
console.log(`  folder:   ${outDir}`);
console.log(`  zip:      ${zipPath}`);
console.log(`  sha256:   ${checksum}`);
console.log(`  size:     ${bytes} bytes`);
console.log(`  meta:     ${manifestPath}`);
console.log("");
console.log("Install:");
console.log("  1. Open chrome://extensions");
console.log("  2. Enable Developer mode");
console.log("  3. Load unpacked → select the folder above");
console.log("  or: bash scripts/install-chrome.sh");
