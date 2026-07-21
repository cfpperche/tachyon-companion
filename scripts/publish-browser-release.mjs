#!/usr/bin/env node
/**
 * Promote the browser staging build (apps/browser/dist-unpacked) into the
 * canonical dogfood/release location:
 *
 *   dist/releases/tachyon-companion-browser-<version>/
 *   dist/releases/tachyon-companion-browser-<version>.zip
 *   dist/releases/tachyon-companion-browser-<version>.json
 *   dist/releases/LATEST  (plain text path to the unpacked folder)
 *
 * Every pack path must end here so agents never point Chrome at staging.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browserPkg = JSON.parse(readFileSync(join(root, "apps/browser/package.json"), "utf8"));
const version = browserPkg.version;
const stagingDir = join(root, "apps/browser/dist-unpacked");
const releasesDir = join(root, "dist/releases");
const outName = `tachyon-companion-browser-${version}`;
const outDir = join(releasesDir, outName);
const zipPath = join(releasesDir, `${outName}.zip`);
const latestPath = join(releasesDir, "LATEST");
const latestJsonPath = join(releasesDir, "LATEST.json");

if (!existsSync(join(stagingDir, "manifest.json"))) {
  console.error(`publish-browser-release: missing staging manifest at ${stagingDir}`);
  console.error("Run the browser build first (npm run pack -w @tachyon-companion/browser).");
  process.exit(1);
}

const stagingManifest = JSON.parse(readFileSync(join(stagingDir, "manifest.json"), "utf8"));
if (stagingManifest.version !== version) {
  console.error(
    `publish-browser-release: version skew package.json=${version} manifest=${stagingManifest.version}`,
  );
  process.exit(1);
}

mkdirSync(releasesDir, { recursive: true });
rmSync(outDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
cpSync(stagingDir, outDir, { recursive: true });

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
`;
  const py = spawnSync("python3", ["-c", pyScript], { cwd: releasesDir, stdio: "inherit" });
  if (py.status !== 0) {
    console.error("publish-browser-release: zip failed — need zip(1) or python3");
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

const checksum = sha256(zipPath);
const bytes = statSync(zipPath).size;
const wslUnc = `\\\\wsl.localhost\\Ubuntu${outDir.replace(/\//g, "\\")}`;
const meta = {
  name: "tachyon-companion-browser",
  version,
  builtAt: new Date().toISOString(),
  protocolVersion: 1,
  /** Canonical Load unpacked path (always under dist/releases/). */
  unpackedDir: outDir,
  /** Windows Explorer / Chrome on Windows host. */
  unpackedDirWindowsUnc: wslUnc,
  /** Intermediate only — never Load unpacked from staging. */
  stagingDir,
  zip: zipPath,
  zipSha256: checksum,
  zipBytes: bytes,
  files: walkFiles(outDir),
  install: {
    unpacked: "Chrome → chrome://extensions → Developer mode → Load unpacked → select unpackedDir",
    windowsUnc: wslUnc,
    zipNote: "Zip is for archive/distribution; local dogfood uses the folder under dist/releases/",
    script: "bash scripts/install-chrome.sh",
    doNotUse: "apps/browser/dist-unpacked is staging only — not for dogfood",
  },
};

writeFileSync(join(releasesDir, `${outName}.json`), `${JSON.stringify(meta, null, 2)}\n`);
// Stable pointers for agents/scripts (always last successful pack).
writeFileSync(latestPath, `${outDir}\n`);
writeFileSync(latestJsonPath, `${JSON.stringify({ version, unpackedDir: outDir, unpackedDirWindowsUnc: wslUnc, zip: zipPath, zipSha256: checksum }, null, 2)}\n`);

console.log("");
console.log("Chrome package ready (canonical dogfood path)");
console.log(`  version:  ${version}`);
console.log(`  folder:   ${outDir}`);
console.log(`  windows:  ${wslUnc}`);
console.log(`  zip:      ${zipPath}`);
console.log(`  sha256:   ${checksum}`);
console.log(`  size:     ${bytes} bytes`);
console.log(`  latest:   ${latestPath}`);
console.log("");
console.log("Install (Load unpacked):");
console.log(`  ${outDir}`);
console.log("  or Windows: " + wslUnc);
console.log("  or: bash scripts/install-chrome.sh");
console.log("");
console.log("Do NOT Load unpacked from apps/browser/dist-unpacked (staging only).");
