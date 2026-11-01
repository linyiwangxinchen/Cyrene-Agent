import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp,readFile,access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {preparePluginZip,discardPreparedPlugin}=require('../../dist/main/plugins/installer.js');
const root=await mkdtemp(path.join(os.tmpdir(),'cyrene-garden-package-'));
const prepared=await preparePluginZip(path.resolve('release/bili-garden-0.1.0.zip'),path.join(root,'plugins'));
try{
  assert.equal(prepared.manifest.id,'bili-garden');assert.equal(prepared.manifest.defaultEnabled,false);
  for (const file of ['python/bilibili_backend.py','python/asr_model.py']) {
    assert.equal(await readFile(path.join(prepared.pluginDir,file),'utf8'),await readFile(path.join('extensions/bili-garden',file),'utf8'));
  }
  await assert.rejects(() => access(path.join(prepared.pluginDir,'vendor/bilibili-mcp/mcp_server.py')));
  console.log('PASS actual host ZIP import, backend integrity, manifest and cleanup');
}finally{await discardPreparedPlugin(prepared);}
