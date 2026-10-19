// Compare prebuilt test binaries, never compile inside a timed measurement.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const [before, after, requestedOutput] = process.argv.slice(2);
if (!before || !after)
  throw new Error(
    "usage: node compare-micro.mjs <before.test> <after.test> [output-dir]",
  );
const output =
  requestedOutput ?? mkdtempSync(join(tmpdir(), "brocade-site-micro-"));
const binaries = { before, after };
const requestedProfiles = process.env.SITE_MICRO_PROFILES?.split(",");
const rounds = Number(process.env.SITE_MICRO_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20)
  throw new Error("SITE_MICRO_ROUNDS must be 1..20");
const profiles = [
  { id: "p1", cpus: "4", procs: 1 },
  { id: "e1", cpus: "16", procs: 1 },
  { id: "p4", cpus: "0,2,4,6", procs: 4 },
  { id: "e4", cpus: "16,17,18,19", procs: 4 },
].filter(
  (profile) => !requestedProfiles || requestedProfiles.includes(profile.id),
);
if (
  !profiles.length ||
  requestedProfiles?.some(
    (id) => !profiles.some((profile) => profile.id === id),
  )
)
  throw new Error("unknown SITE_MICRO_PROFILES");
const cores = () =>
  Object.fromEntries(
    readFileSync("/proc/stat", "utf8")
      .split("\n")
      .filter((line) => /^cpu\d+\s/.test(line))
      .map((line) => {
        const [name, ...values] = line.trim().split(/\s+/);
        return [name, values.map(Number)];
      }),
  );
const usage = (a, b) =>
  Object.fromEntries(
    Object.entries(a).map(([name, values]) => {
      const delta = values.map((value, i) => b[name][i] - value);
      const total = delta.slice(0, 8).reduce((sum, value) => sum + value, 0);
      return [
        name,
        total > 0 ? (100 * (total - delta[3] - delta[4])) / total : 0,
      ];
    }),
  );
const metrics = (text) => {
  let benchmark = "";
  const result = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("Benchmark"))
      benchmark = line.trim().split(/\s+/)[0].replace(/-\d+$/, "");
    const match = line.match(
      /\b(\d+)\s+([\d.]+) ns\/op\b.*?\b(\d+) B\/op\s+(\d+) allocs\/op/,
    );
    if (match)
      result.push({
        benchmark,
        iterations: Number(match[1]),
        ns_per_op: Number(match[2]),
        bytes_per_op: Number(match[3]),
        allocs_per_op: Number(match[4]),
      });
  }
  if (result.length === 0) throw new Error("no Go benchmark metrics found");
  return result;
};
const results = [];
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const metadata = {
  started_at: new Date().toISOString(),
  before_sha256: hash(before),
  after_sha256: hash(after),
  rounds,
  profiles: profiles.map((profile) => profile.id),
};
for (const profile of profiles) {
  for (let round = 1; round <= rounds; round++) {
    for (const phase of round % 2 ? ["before", "after"] : ["after", "before"]) {
      const start = cores();
      const { stdout, stderr } = await run(
        "taskset",
        [
          "-c",
          profile.cpus,
          binaries[phase],
          "-test.run",
          "^$",
          "-test.bench",
          process.env.SITE_MICRO_BENCH ??
            (profile.id === "p1"
              ? "BenchmarkSiteCounter|BenchmarkSiteConnection|BenchmarkSiteClassify"
              : "BenchmarkSiteCounter|BenchmarkSiteConnection"),
          "-test.benchtime=400ms",
          "-test.count=1",
        ],
        {
          env: { ...process.env, GOMAXPROCS: String(profile.procs) },
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const row = {
        profile: profile.id,
        cpus: profile.cpus,
        procs: profile.procs,
        round,
        phase,
        metrics: metrics(stdout),
        core_busy_percent: usage(start, cores()),
      };
      results.push(row);
      writeFileSync(
        join(output, `${profile.id}-${round}-${phase}.log`),
        stdout + stderr,
      );
      writeFileSync(
        join(output, "results.json"),
        JSON.stringify({ ...metadata, results }, null, 2) + "\n",
      );
      process.stdout.write(`${profile.id} ${round} ${phase} completed\n`);
    }
  }
}
process.stdout.write(`Results: ${join(output, "results.json")}\n`);
