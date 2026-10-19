#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('usage: prepare.cjs ISOLATED_V6_SOURCE NEW_OUTPUT');
const source = fs.realpathSync(sourceArg), output = path.resolve(outputArg);
const h9 = path.resolve(__dirname, '../xray-handoff');
const frozen = {
  'h9_test.go': '9348833f094a909b3ce8509c23a992084c6c23e9af829cefc62c9b521b1641ca',
  'h9_process_test.go': 'cbfa362cacc2737039012c8464114f4c08098ea22a8337a26ba57502c4d11ee3',
  'h9_topology_test.go': 'bc1862ddcad56663218307c11e422c14d06e06cf4a28880859c6397ae2c281fc',
};
for (const [name, expected] of Object.entries(frozen)) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(h9, name))).digest('hex');
  if (actual !== expected) throw new Error('frozen H9 source changed: ' + name);
}
const prepared = spawnSync(process.execPath, [path.join(h9, 'prepare-integration.cjs'), source, output], {encoding: 'utf8'});
if (prepared.status !== 0) throw new Error(prepared.stderr || prepared.stdout);
let fixture = fs.readFileSync(path.join(h9, 'h9_test.go'), 'utf8');
function replaceOnce(before, after) {
  if (fixture.split(before).length !== 2) throw new Error('H10 overlay anchor is not unique: ' + before);
  fixture = fixture.replace(before, after);
}
fixture = fixture.replaceAll('TestH9MixedLifecycle', 'h10Boundary').replaceAll('TestH9EarlyHalfCloseBoundary', 'TestH10EarlyHalfCloseBoundary');
replaceOnce('"schema_version": 9', '"schema_version": 10');
replaceOnce('"initial_persistent_flows": 32', '"initial_persistent_flows": 1');
replaceOnce('b.result["boundary"] = os.Getenv("H9_BOUNDARY")', 'b.result["boundary"] = os.Getenv("H9_BOUNDARY")\n\tb.result["h10_path"] = os.Getenv("H10_PATH")\n\tb.result["h10_direction"] = os.Getenv("H10_DIRECTION")\n\tb.result["required_active_after_eof_us"] = int64(3000000)');
replaceOnce('f.Error = err.Error()', 'f.Error = err.Error()\n\t\tf.HalfClose["error_observed_us"] = time.Since(h9Current.base.start).Microseconds()');
replaceOnce('if f.Mode == "upload" {\n\t\t\t<-f.clientEnded', 'if f.Mode == "upload" {\n\t\t\tif os.Getenv("H10_DIRECTION") != "upload" {\n\t\t\t\t<-f.clientEnded\n\t\t\t}');
replaceOnce('if os.Getenv("H9_BOUNDARY") != "" {\n\t\tfor _, path := range []string{"via-A", "direct-REALITY"} {\n\t\t\th.startFlow("boundary-"+path, path, "b0", "download", "server-ended", "origin-1")', 'if os.Getenv("H9_BOUNDARY") != "" {\n\t\tfor _, path := range h10Paths(t) {\n\t\t\th.startFlow("boundary-"+path, path, "b0", os.Getenv("H10_DIRECTION"), "server-ended", "origin-1")');
replaceOnce('2500 * time.Millisecond', '3100 * time.Millisecond');
fixture += `
// H10 deliberately runs one path per process tree. A failure cannot truncate
// another path through test cleanup, unlike the exploratory H9 boundary.
func h10Paths(t *testing.T) []string {
  t.Helper()
  p, direction := os.Getenv("H10_PATH"), os.Getenv("H10_DIRECTION")
  if p != "via-A" && p != "direct-REALITY" { t.Fatal("explicit H10 path required") }
  if direction != "download" && direction != "upload" { t.Fatal("explicit H10 direction required") }
  return []string{p}
}
`;
const generated = path.join(output, 'h10-halfclose_test.go');
fs.writeFileSync(generated, fixture);
const formatted = spawnSync('gofmt', ['-w', generated], {encoding: 'utf8'});
if (formatted.status !== 0) throw new Error(formatted.stderr || 'gofmt failed');
const overlayPath = path.join(output, 'overlay.json');
const overlay = JSON.parse(fs.readFileSync(overlayPath));
overlay.Replace[path.join(source, 'testing/handofflab/h9_test.go')] = generated;
fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'h9-source-manifest.json'), JSON.stringify(frozen, null, 2) + '\n');
console.log(JSON.stringify({source, output, overlay: overlayPath}));
