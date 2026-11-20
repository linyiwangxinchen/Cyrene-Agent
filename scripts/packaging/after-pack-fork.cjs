const { copyFile, cp, stat } = require('node:fs/promises');
const path = require('node:path');

// Preserve the author's and model's notices alongside the installed executable.
module.exports = async function afterPack(context) {
  for (const name of ['LICENSE', 'MODEL_LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
    await copyFile(path.join(context.packager.projectDir, name), path.join(context.appOutDir, name));
  }
  // Character reference images are kept out of Git; ship them only when prepared locally.
  const references = path.join(context.packager.projectDir, 'resources', 'character-references');
  if (await stat(references).then(info => info.isDirectory(), () => false)) {
    await cp(references, path.join(context.appOutDir, 'resources', 'character-references'), { recursive: true });
  }
};
