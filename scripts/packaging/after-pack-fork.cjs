const { copyFile } = require('node:fs/promises');
const path = require('node:path');

// Preserve the author's and model's notices alongside the installed executable.
module.exports = async function afterPack(context) {
  for (const name of ['LICENSE', 'MODEL_LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
    await copyFile(path.join(context.packager.projectDir, name), path.join(context.appOutDir, name));
  }
};
