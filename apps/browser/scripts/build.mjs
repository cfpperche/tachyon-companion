#!/usr/bin/env node
/**
 * Build unpacked Chromium extension into dist-unpacked/.
 * UI is a Chrome Side Panel (not action popup) — same surface class as Claude in Chrome.
 */
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const outDir = join(appRoot, "dist-unpacked");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "icons"), { recursive: true });

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

await esbuild.build({
  entryPoints: [join(appRoot, "src/sidepanel/sidepanel.ts")],
  bundle: true,
  outfile: join(outDir, "sidepanel.js"),
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: true,
  logLevel: "info",
});

copyFileSync(join(appRoot, "manifest.json"), join(outDir, "manifest.json"));
copyFileSync(join(appRoot, "src/sidepanel/sidepanel.html"), join(outDir, "sidepanel.html"));
copyFileSync(join(appRoot, "src/sidepanel/sidepanel.css"), join(outDir, "sidepanel.css"));

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, "icons", `icon${size}.png`), solidPng(size, [0x4c, 0x6e, 0xf5]));
}

console.log(`Unpacked extension → ${outDir}`);
console.log("Chrome → Extensions → Load unpacked → select this folder.");
console.log("Toolbar icon opens the Side Panel (not a popup).");

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
