#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const [sourceArg, preparedArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !preparedArg || !outputArg) throw new Error('usage: build.cjs SOURCE PREPARED FRESH_HARNESS');
const source = fs.realpathSync(sourceArg), prepared = fs.realpathSync(preparedArg), output = path.resolve(outputArg);
if (fs.existsSync(output) || fs.existsSync(output + '.build.json')) throw new Error('fresh build output required');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceManifest = path.join(prepared, 'source-manifest.json');
const metadata = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));
if (metadata.schema_version !== 11 || fs.realpathSync(metadata.source_root) !== source) throw new Error('wrong prepared source');
for (const entry of metadata.files) if (digest(entry.path) !== entry.sha256) throw new Error('prepared source changed');
const overlay = path.join(prepared, 'overlay.json'), overlayHash = digest(overlay);
const replacements = JSON.parse(fs.readFileSync(overlay, 'utf8')).Replace;
if (!replacements || Object.keys(replacements).length !== metadata.files.length || new Set(metadata.files.map(e => e.virtual_path)).size !== metadata.files.length) throw new Error('overlay/source manifest membership differs');
for (const entry of metadata.files) {
  if (replacements[entry.virtual_path] !== entry.path) throw new Error('overlay/source manifest path differs');
  const relative = path.relative(prepared, fs.realpathSync(entry.path));
  if (relative === '' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('prepared replacement escaped immutable snapshot');
}
fs.mkdirSync(path.dirname(output), {recursive: true});
const tmp = path.join(path.dirname(output), 'go-tmp');
fs.mkdirSync(tmp, {recursive: true});
const log = fs.openSync(output + '.build.log', 'wx', 0o600);
const args = ['test', '-buildvcs=false', '-p=1', '-overlay', overlay, '-c', './testing/handofflab', '-o', output];
const build = spawnSync('go', args, {cwd: source, env: {...process.env, GOTMPDIR: tmp}, stdio: ['ignore', log, log], timeout: 600000});
fs.closeSync(log);
const manifest = {schema_version: 11, source, prepared, source_manifest: sourceManifest, source_manifest_sha256: digest(sourceManifest), overlay_sha256: overlayHash, command: ['go', ...args], exit_code: build.status, signal: build.signal, error: build.error?.message || '', sources: metadata.files, completed_at: new Date().toISOString()};
if (!build.error && build.status === 0 && !build.signal && fs.existsSync(output)) {
  for (const entry of metadata.files) if (digest(entry.path) !== entry.sha256) throw new Error('prepared source changed during compile');
  if (digest(overlay) !== overlayHash) throw new Error('overlay changed during compile');
  manifest.harness_sha256 = digest(output);
}
fs.writeFileSync(output + '.build.json', JSON.stringify(manifest, null, 2) + '\n');
if (!manifest.harness_sha256) throw new Error('harness compile failed, inspect ' + output + '.build.log');
console.log(JSON.stringify({output, sha256: manifest.harness_sha256, manifest: output + '.build.json'}));
