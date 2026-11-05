import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const htmlPath = path.join(root, "dist/renderer/web/index.html");
const html = await readFile(htmlPath, "utf8");
const assets = [...html.matchAll(/(?:src|href)="\.\.\/assets\/([^\"]+\.js)"/g)].map(match => match[1]);
assert.ok(assets.length > 0, "Web entry must reference JavaScript assets");

const rows = await Promise.all(assets.map(async name => {
  const size = (await readFile(path.join(root, "dist/renderer/assets", name))).byteLength;
  return { name, size };
}));
const total = rows.reduce((sum, row) => sum + row.size, 0);
const largest = rows.reduce((current, row) => row.size > current.size ? row : current);

// Keep authentication and the loading shell responsive on a cold Web visit.
assert.ok(total <= 400_000, `Web initial JavaScript is ${total} bytes; budget is 400000`);
assert.ok(largest.size <= 300_000, `Largest Web initial JavaScript is ${largest.size} bytes (${largest.name}); budget is 300000`);
console.log(JSON.stringify({ entry: "dist/renderer/web/index.html", files: rows.length, totalBytes: total, largest }, null, 2));
