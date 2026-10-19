'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {specs,sha256,validateRelease,verifyArchive,validateMembers,validateELF}=require('./fetch-clients.cjs');

const spec=specs[0];
function release(){return {draft:false,prerelease:false,tag_name:'v'+spec.version,html_url:`https://github.com/${spec.repository}/releases/tag/v${spec.version}`,assets:[{name:spec.asset,size:3,digest:'sha256:'+sha256(Buffer.from('abc')),browser_download_url:`https://github.com/${spec.repository}/releases/download/v${spec.version}/${spec.asset}`}]};}
test('pinned official stable release and archive digest agree',()=>{const a=validateRelease(release(),spec);verifyArchive(Buffer.from('abc'),a);});
for(const [name,mutate] of [
  ['prerelease',r=>r.prerelease=true],['draft',r=>r.draft=true],['wrong version',r=>r.tag_name='v99.0.0'],
  ['foreign repository',r=>r.html_url='https://example.com/release'],['missing digest',r=>delete r.assets[0].digest],
  ['foreign asset',r=>r.assets[0].browser_download_url='https://example.com/file'],['duplicate asset',r=>r.assets.push({...r.assets[0]})],
  ['unbounded asset',r=>r.assets[0].size=2**40],
])test('reject '+name,()=>{const r=release();mutate(r);assert.throws(()=>validateRelease(r,spec));});
test('reject digest or length corruption before decompression',()=>{const a=release().assets[0];assert.throws(()=>verifyArchive(Buffer.from('abd'),a));assert.throws(()=>verifyArchive(Buffer.from('abcd'),a));});
test('safe exact archive member accepted',()=>validateMembers(['root/','root/LICENSE','root/binary'],'root/binary'));
for(const name of ['/absolute','../escape','root/../escape','root\\escape','C:/escape','root//escape','./root/binary','root/\0bad'])test('reject unsafe member '+JSON.stringify(name),()=>assert.throws(()=>validateMembers([name,'root/binary'],'root/binary')));
test('duplicate or missing executable rejected',()=>{assert.throws(()=>validateMembers(['xray','xray'],'xray'));assert.throws(()=>validateMembers(['README'],'xray'));});
test('ELF validation excludes wrong machine or non-binary extraction',()=>{const b=Buffer.alloc(64);Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(b);b.writeUInt16LE(62,18);validateELF(b);b.writeUInt16LE(183,18);assert.throws(()=>validateELF(b));assert.throws(()=>validateELF(Buffer.from('../evil')));});
