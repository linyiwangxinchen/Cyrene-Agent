import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
// Reuse ExcelJS's declared archive dependency; no new lockfile dependency.
const archiveRequire = createRequire(require.resolve("exceljs/package.json"));
const archiver = archiveRequire("archiver");
const source = path.join(root, "extensions/bili-garden");
const manifest = JSON.parse(
  await readFile(path.join(source, "manifest.json"), "utf8"),
);
const output = path.join(
  root,
  "release",
  `bili-garden-${manifest.version}.zip`,
);
await mkdir(path.dirname(output), { recursive: true });
const zip = archiver("zip", { zlib: { level: 9 } });
async function add(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["test", "node_modules", ".venv", "__pycache__"].includes(entry.name))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await add(full);
    else if (!/\.(pyc|log|sqlite)$/.test(entry.name))
      zip.file(full, {
        name: `bili-garden/${path.relative(source, full).replaceAll("\\", "/")}`,
      });
  }
}
const stream = createWriteStream(output);
const done = new Promise((resolve, reject) => {
  stream.on("close", resolve);
  stream.on("error", reject);
  zip.on("error", reject);
});
zip.pipe(stream);
await add(source);
await zip.finalize();
await done;
console.log(output);
