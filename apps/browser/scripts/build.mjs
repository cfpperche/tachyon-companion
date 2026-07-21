#!/usr/bin/env node
/**
 * Build MV3 extension:
 * - background.js (TS, no UI framework)
 * - sidepanel.js (Preact + browser-ui + Radix via preact/compat)
 * - sidepanel.css (Tailwind + design tokens)
 */
import * as esbuild from "esbuild";
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const repoRoot = join(appRoot, "../..");
const outDir = join(appRoot, "dist-unpacked");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "icons"), { recursive: true });

// Only remap React → preact/compat for Radix. Do NOT alias package root
// `preact` to a single .js file — that breaks preact/hooks and preact/jsx-runtime.
const preactCompat = join(repoRoot, "node_modules/preact/compat/dist/compat.module.js");
const preactJsx = join(repoRoot, "node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js");

function resolveOrThrow(p, label) {
  if (!existsSync(p)) throw new Error(`Missing ${label}: ${p} — run npm install from monorepo root`);
  return p;
}

await esbuild.build({
  entryPoints: [join(appRoot, "src/background.ts")],
  bundle: true,
  outfile: join(outDir, "background.js"),
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: true,
  logLevel: "info",
});

// Content script (vanilla TS) — DOM read only; injected via chrome.scripting.
mkdirSync(join(outDir, "content"), { recursive: true });
await esbuild.build({
  entryPoints: [join(appRoot, "src/content/snapshot.ts")],
  bundle: true,
  outfile: join(outDir, "content/snapshot.js"),
  format: "iife",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: true,
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [join(appRoot, "src/sidepanel/main.tsx")],
  bundle: true,
  outfile: join(outDir, "sidepanel.js"),
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: true,
  logLevel: "info",
  jsx: "automatic",
  jsxImportSource: "preact",
  alias: {
    react: resolveOrThrow(preactCompat, "preact/compat"),
    "react-dom": resolveOrThrow(preactCompat, "preact/compat"),
    "react/jsx-runtime": resolveOrThrow(preactJsx, "preact/jsx-runtime"),
  },
});

const tw = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "tailwindcss",
    "-c",
    join(appRoot, "tailwind.config.js"),
    "-i",
    join(appRoot, "src/styles/input.css"),
    "-o",
    join(outDir, "sidepanel.css"),
    "--minify",
  ],
  { cwd: appRoot, stdio: "inherit", shell: false },
);
if (tw.status !== 0) process.exit(tw.status ?? 1);

copyFileSync(join(appRoot, "manifest.json"), join(outDir, "manifest.json"));
copyFileSync(join(appRoot, "src/sidepanel/sidepanel.html"), join(outDir, "sidepanel.html"));

// Tachyon Mono (JetBrains Mono) — same assets as shell webviews.
const fontsSrc = join(repoRoot, "packages/browser-ui/fonts/tachyon");
const fontsDst = join(outDir, "fonts/tachyon");
if (!existsSync(fontsSrc)) {
  throw new Error(`Missing Tachyon Mono fonts at ${fontsSrc}`);
}
mkdirSync(fontsDst, { recursive: true });
cpSync(fontsSrc, fontsDst, { recursive: true });

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, "icons", `icon${size}.png`), solidPng(size, [0x4c, 0x6e, 0xf5]));
}

console.log(`Staging build → ${outDir}`);
console.log("(staging only — not for Chrome Load unpacked)");

// Always promote to dist/releases/ unless explicitly skipped (pack-chrome does its own publish).
if (process.env.TACHYON_COMPANION_STAGING_ONLY !== "1") {
  const publish = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/publish-browser-release.mjs")],
    { cwd: repoRoot, stdio: "inherit", shell: false },
  );
  if (publish.status !== 0) process.exit(publish.status ?? 1);
} else {
  console.log("Skipped publish (TACHYON_COMPANION_STAGING_ONLY=1). Run: npm run pack:chrome");
}

function solidPng(size, rgb) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk("IHDR", (() => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(size, 0);
    b.writeUInt32BE(size, 4);
    b[8] = 8;
    b[9] = 2;
    return b;
  })());
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
