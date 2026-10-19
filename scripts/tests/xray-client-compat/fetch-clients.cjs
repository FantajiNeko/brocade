#!/usr/bin/env node
'use strict';

// Public release artifacts only. No installer, package script, or source patch
// is executed. Archives are verified before extracting one member to stdout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');

const LIMIT = 200 * 1024 * 1024;
const specs = [
  {id:'xray-official-26.3.27',family:'xray',version:'26.3.27',repository:'XTLS/Xray-core',metadata:'xray-v26.3.27.json',asset:'Xray-linux-64.zip',format:'zip',member:'xray',cohort:'older-official-stable',local:'./.tools/xray.26.3.27.bak',cachedArchive:'./.tools/xray.zip'},
  {id:'mihomo-1.19.29',family:'mihomo',version:'1.19.29',repository:'MetaCubeX/mihomo',metadata:'mihomo-v1.19.29.json',asset:'mihomo-linux-amd64-v1-go120-v1.19.29.gz',format:'gz',cohort:'older-local-version-official-build',local:'./.tools/mihomo'},
  {id:'mihomo-1.19.32',family:'mihomo',version:'1.19.32',repository:'MetaCubeX/mihomo',metadata:'mihomo-latest.json',asset:'mihomo-linux-amd64-v1-v1.19.32.gz',format:'gz',cohort:'current-stable-as-of-2026-10-15'},
  {id:'sing-box-1.12.0',family:'sing-box',version:'1.12.0',repository:'SagerNet/sing-box',metadata:'sing-box-v1.12.0.json',asset:'sing-box-1.12.0-linux-amd64.tar.gz',format:'tar.gz',member:'sing-box-1.12.0-linux-amd64/sing-box',cohort:'representative-older-stable-not-user-observed'},
  {id:'sing-box-1.14.3',family:'sing-box',version:'1.14.3',repository:'SagerNet/sing-box',metadata:'sing-box-latest.json',asset:'sing-box-1.14.3-linux-amd64.tar.gz',format:'tar.gz',member:'sing-box-1.14.3-linux-amd64/sing-box',cohort:'current-stable-as-of-2026-10-15'},
];

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function validateRelease(release, spec) {
  assert.equal(release.draft, false, 'draft release rejected');
  assert.equal(release.prerelease, false, 'prerelease rejected');
  assert.equal(release.tag_name, 'v' + spec.version, 'release version mismatch');
  assert.equal(release.html_url, `https://github.com/${spec.repository}/releases/tag/v${spec.version}`, 'wrong official repository');
  const matches = release.assets.filter(a => a.name === spec.asset);
  assert.equal(matches.length, 1, 'expected exactly one named release asset');
  const asset = matches[0];
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/, 'official sha256 asset digest required');
  assert.equal(asset.browser_download_url, `https://github.com/${spec.repository}/releases/download/v${spec.version}/${spec.asset}`, 'unexpected asset URL');
  assert(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size < LIMIT, 'invalid asset size');
  return asset;
}

function verifyArchive(data, asset) {
  assert.equal(data.length, asset.size, 'archive size mismatch');
  assert.equal(sha256(data), asset.digest.slice(7), 'official archive digest mismatch');
}

function validateMembers(names, member) {
  assert(names.length > 0 && names.length < 1000, 'invalid archive entry count');
  for (const name of names) {
    assert(name.length > 0 && name.length < 512, 'invalid archive member name');
    assert(!name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && !/^[a-z]:/i.test(name), 'unsafe archive member');
    const parts = name.replace(/\/$/, '').split('/');
    assert(parts.every(p => p && p !== '.' && p !== '..'), 'unsafe archive traversal');
  }
  assert.equal(names.filter(n => n === member).length, 1, 'missing or duplicate executable member');
}

function validateELF(binary) {
  assert(binary.length >= 64 && binary.length < LIMIT, 'invalid executable size');
  assert(binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'not an ELF executable');
  assert.equal(binary[4], 2, 'not ELF64');
  assert.equal(binary[5], 1, 'not little-endian ELF');
  assert.equal(binary.readUInt16LE(18), 62, 'not x86-64 ELF');
}

function command(executable, args, extra = {}) {
  const r = spawnSync(executable, args, {timeout:30000, maxBuffer:LIMIT, ...extra});
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${executable} failed (${r.signal || r.status}): ${r.stderr?.toString()}`);
  return r.stdout;
}

function extractBinary(archive, spec) {
  if (spec.format === 'gz') return zlib.gunzipSync(fs.readFileSync(archive), {maxOutputLength:LIMIT});
  const list = spec.format === 'zip'
    ? command('unzip', ['-Z', '-1', archive]).toString('utf8')
    : command('tar', ['-tzf', archive]).toString('utf8');
  const names = list.trimEnd().split('\n');
  validateMembers(names, spec.member);
  // Even if an archive contained a link entry, it cannot write to the filesystem:
  // only the exact member's stdout is retained and must be an ELF executable.
  return spec.format === 'zip'
    ? command('unzip', ['-p', archive, spec.member])
    : command('tar', ['-xOzf', archive, '--', spec.member]);
}

function writeFreshOrIdentical(file, data, mode = 0o600) {
  if (fs.existsSync(file)) {
    assert(fs.lstatSync(file).isFile(), 'refuse existing non-regular file');
    assert.equal(sha256(fs.readFileSync(file)), sha256(data), `refuse changed existing evidence: ${file}`);
    return;
  }
  fs.writeFileSync(file, data, {flag:'wx', mode});
}

function download(url, output) {
  assert(!fs.existsSync(output), 'refuse to overwrite a downloaded artifact');
  command('curl', ['--fail','--location','--proto','=https','--proto-redir','=https','--tlsv1.2','--max-time','120','--retry','2','--max-filesize',String(LIMIT),'--silent','--show-error',url,'--output',output], {timeout:360000});
}

function identify(binary, family, version) {
  const args = family === 'mihomo' ? ['-v'] : ['version'];
  const output = command(binary, args, {encoding:'utf8'});
  const prefix = family === 'mihomo' ? 'Mihomo Meta v' : family === 'sing-box' ? 'sing-box version ' : 'Xray ';
  assert(output.startsWith(prefix + version + (family === 'sing-box' ? '\n' : ' ')), 'unexpected actual client version');
  return {version_output:output, version_args:args};
}

function localRecord(root, id, input, version, cohort, expectedSHA256) {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, {recursive:true});
  const bytes = fs.readFileSync(input);
  assert.equal(sha256(bytes),expectedSHA256,'frozen baseline changed');
  validateELF(bytes);
  const binary = path.join(directory, 'xray');
  writeFreshOrIdentical(binary, bytes, 0o700);
  return {id,family:'xray',version,binary,sha256:sha256(bytes),official_verified:false,published_digest:null,archive_sha256:null,cohort,source:{kind:'frozen-local-build',path:fs.realpathSync(input)},...identify(binary,'xray',version)};
}

function main(outputArg) {
  if (!outputArg) throw new Error('usage: fetch-clients.cjs CLIENT_OUTPUT_DIRECTORY (run from repository root)');
  const root = path.resolve(outputArg);
  fs.mkdirSync(path.join(root, 'provenance'), {recursive:true});
  assert(!fs.existsSync(path.join(root, 'catalog.json')), 'refuse to replace a frozen client catalog');
  const clients = [];
  const baseline = localRecord(root,'xray-brocade-baseline-26.4.25','target/h6/xray-baseline','26.4.25','unchanged-brocade-baseline-not-official-xray','38a335e3bba579ef919164b19df7cd7c59a14859b2ef31e17e1f1dc6b49bcae2');
  clients.push(baseline);
  writeFreshOrIdentical(path.join(root, baseline.id, 'client.json'), JSON.stringify(baseline,null,2)+'\n');
  console.log(JSON.stringify(baseline));
  for (const spec of specs) {
    const api = `https://api.github.com/repos/${spec.repository}/releases/tags/v${spec.version}`;
    const metadata = path.join(root,'provenance',spec.metadata);
    if (!fs.existsSync(metadata)) download(api,metadata);
    const release = JSON.parse(fs.readFileSync(metadata,'utf8'));
    const asset = validateRelease(release,spec);
    const directory = path.join(root,spec.id);
    fs.mkdirSync(directory,{recursive:true});
    const archive = path.join(directory,spec.asset);
    if (!fs.existsSync(archive)) {
      if (spec.cachedArchive && fs.existsSync(spec.cachedArchive)) {
        const data = fs.readFileSync(spec.cachedArchive);
        verifyArchive(data,asset);
        writeFreshOrIdentical(archive,data);
      } else download(asset.browser_download_url,archive);
    }
    const data = fs.readFileSync(archive);
    verifyArchive(data,asset);
    const bytes = extractBinary(archive,spec);
    validateELF(bytes);
    const binary = path.join(directory,spec.family === 'xray' ? 'xray' : spec.family);
    writeFreshOrIdentical(binary,bytes,0o700);
    const record = {id:spec.id,family:spec.family,version:spec.version,binary,sha256:sha256(bytes),official_verified:true,published_digest:asset.digest,archive_sha256:sha256(data),cohort:spec.cohort,
      source:{kind:'official-github-release',repository:spec.repository,release_url:release.html_url,release_api_url:api,asset_url:asset.browser_download_url,asset_name:asset.name,release_tag:release.tag_name,published_at:release.published_at,metadata_file:metadata,metadata_sha256:sha256(fs.readFileSync(metadata))},...identify(binary,spec.family,spec.version)};
    if (spec.local && fs.existsSync(spec.local)) {
      const local = fs.readFileSync(spec.local);
      record.local_comparison={path:fs.realpathSync(spec.local),sha256:sha256(local),matches_official:sha256(local)===record.sha256};
      if (spec.family === 'mihomo' && !record.local_comparison.matches_official) {
        const localDirectory=path.join(root,'mihomo-local-1.19.29');fs.mkdirSync(localDirectory,{recursive:true});
        const localBinary=path.join(localDirectory,'mihomo');validateELF(local);writeFreshOrIdentical(localBinary,local,0o700);
        clients.push({id:'mihomo-local-1.19.29',family:'mihomo',version:'1.19.29',binary:localBinary,sha256:sha256(local),official_verified:false,published_digest:null,archive_sha256:null,cohort:'local-build-not-matched-to-official',source:{kind:'local-file',path:fs.realpathSync(spec.local)},...identify(localBinary,'mihomo','1.19.29')});
      }
    }
    clients.push(record);
    writeFreshOrIdentical(path.join(directory,'client.json'),JSON.stringify(record,null,2)+'\n');
    console.log(JSON.stringify(record));
  }
  const catalog={schema_version:1,generated_at:new Date().toISOString(),selection_as_of:'2026-10-15',clients};
  writeFreshOrIdentical(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');
}

module.exports={specs,sha256,validateRelease,verifyArchive,validateMembers,validateELF,extractBinary};
if(require.main===module) main(process.argv[2]);
