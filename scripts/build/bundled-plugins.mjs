import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
/** Copy only distributable sources, never environments, tests or local data. */
export async function stageBundledPlugins(destination) {
  for (const id of ["bili-garden"]) {
    const source = path.join(root, "extensions", id);
    const manifest = JSON.parse(
      await readFile(path.join(source, "manifest.json"), "utf8"),
    );
    if (manifest.id !== id || manifest.defaultEnabled !== false)
      throw new Error("Bundled plugin must be opt-in");
    await mkdir(destination, { recursive: true });
    await cp(source, path.join(destination, id), {
      recursive: true,
      filter: (file) => {
        const rel = path.relative(source, file).replaceAll("\\", "/");
        return (
          !rel
            .split("/")
            .some((s) =>
              ["test", "node_modules", "__pycache__", ".venv", ".git"].includes(
                s,
              ),
            ) && !/\.(sqlite|log|pyc)$/.test(rel)
        );
      },
    });
  }
}
