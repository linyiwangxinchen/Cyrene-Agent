import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp,readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {preparePluginZip,discardPreparedPlugin}=require('../../dist/main/plugins/installer.js');
const root=await mkdtemp(path.join(os.tmpdir(),'cyrene-garden-package-'));
const prepared=await preparePluginZip(path.resolve('release/bili-garden-0.1.0.zip'),path.join(root,'plugins'));
try{
  assert.equal(prepared.manifest.id,'bili-garden');assert.equal(prepared.manifest.defaultEnabled,false);
  assert.equal(await readFile(path.join(prepared.pluginDir,'vendor/bilibili-mcp/mcp_server.py'),'utf8'),await readFile('extensions/bili-garden/vendor/bilibili-mcp/mcp_server.py','utf8'));
  console.log('PASS actual host ZIP import, large-file integrity, manifest and cleanup');
}finally{await discardPreparedPlugin(prepared);}
