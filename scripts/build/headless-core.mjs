import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp } from 'node:fs/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await build({
  entryPoints: [path.join(root, 'src/server/core/worker.ts')], outfile: path.join(root, 'dist/headless/core.cjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', packages: 'external', sourcemap: true,
  alias: { electron: path.join(root, 'src/server/core/platform.ts') },
  plugins: [{ name: 'browser-music-output', setup(build) { build.onResolve({ filter: /mpv-controller$/ }, args => args.importer.endsWith('music-service.ts') ? { path: path.join(root, 'src/server/core/web-music-player.ts') } : undefined); } }],
  external: ['electron-updater'],
});
await build({ entryPoints: [path.join(root, 'src/main/knowledge-base/knowledge-index-worker.ts')], outfile: path.join(root, 'dist/headless/knowledge-index-worker.js'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', packages: 'external' });
await cp(path.join(root, 'src/main/plugin-panel'), path.join(root, 'dist/plugin-panel'), { recursive: true });
