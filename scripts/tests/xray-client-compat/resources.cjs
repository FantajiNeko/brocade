'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function parseStat(text) {
  const end = text.lastIndexOf(')');
  if (end < 0) throw new Error('invalid proc stat');
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  return {pid, comm: text.slice(text.indexOf('(') + 1, end), pgrp: Number(fields[2]),
    user_ticks: Number(fields[11]), system_ticks: Number(fields[12]), threads: Number(fields[17]),
    start_ticks: Number(fields[19]), virtual_bytes: Number(fields[20]), rss_pages: Number(fields[21])};
}

function monitor(group, output, maxSamples) {
  const ticks = spawnSync('getconf', ['CLK_TCK'], {encoding: 'utf8', timeout: 2000});
  const pages = spawnSync('getconf', ['PAGESIZE'], {encoding: 'utf8', timeout: 2000});
  const clockTicks = Number(ticks.stdout?.trim()), pageSize = Number(pages.stdout?.trim());
  if (ticks.error || ticks.status !== 0 || !clockTicks || pages.error || pages.status !== 0 || !pageSize) throw new Error('cannot determine proc resource units');
  const fd = fs.openSync(path.join(output, 'resources.jsonl'), 'wx', 0o600);
  const start = process.hrtime.bigint(), failures = [];
  let count = 0;
  fs.writeSync(fd, JSON.stringify({schema_version: 11, clock_ticks: clockTicks, page_size: pageSize, owned_process_group: group, sample_interval_ms: 1000, scope: 'local process group including harness; shared-host observational data, not isolated throughput benchmark'}) + '\n');
  const sample = () => {
    if (count++ >= maxSamples) return;
    const processes = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = parseStat(fs.readFileSync('/proc/' + name + '/stat', 'utf8'));
        if (stat.pgrp === group) processes.push(stat);
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code) && failures.length < 20) failures.push({pid: name, error: error.message});
      }
    }
    fs.writeSync(fd, JSON.stringify({at_ms: Number(process.hrtime.bigint() - start) / 1e6, processes}) + '\n');
  };
  sample();
  const timer = setInterval(sample, 1000);
  return () => { clearInterval(timer); sample(); fs.writeSync(fd, JSON.stringify({sampling_errors: failures}) + '\n'); fs.closeSync(fd); };
}
module.exports = {parseStat, monitor};
