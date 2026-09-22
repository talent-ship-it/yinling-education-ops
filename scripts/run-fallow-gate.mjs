import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const binary = resolve(root, "node_modules/.bin/fallow");
const verifyCache = resolve(process.env.RUNNER_TEMP || tmpdir(), "yinling-fallow-verify");
mkdirSync(verifyCache, { recursive: true });

const commands = [
  ["dead-code", "--baseline", "fallow-baselines/dead-code.json", "--fail-on-stale-baseline", "--no-cache"],
  ["health", "--baseline", "fallow-baselines/health.json", "--baseline-mode", "identity", "--fail-on-stale-baseline", "--no-cache"],
  ["dupes", "--baseline", "fallow-baselines/dupes.json", "--fail-on-stale-baseline", "--no-cache", "--no-fragments"],
];

for (const args of commands) {
  const result = spawnSync(binary, [...args, "--format", "json", "--quiet"], {
    cwd: root,
    env: {
      ...process.env,
      FALLOW_SUGGESTIONS: "off",
      FALLOW_UPDATE_CHECK: "off",
      FALLOW_VERIFY_CACHE_DIR: verifyCache,
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 2);
  }
  process.stdout.write(`Fallow ${args[0]} baseline: PASS\n`);
}

process.stdout.write("Fallow regression gate: PASS\n");
