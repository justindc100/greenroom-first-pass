#!/usr/bin/env node
// No-model hosted iOS smoke (workflows/ios-host-smoke.yml). Measures how often
// and how long a simulator host's display-capture and accessibility paths
// stall, so a runner decision can rest on data instead of on paid canaries:
// the three hosted native failures of 2026-09-09 (GR-12) were transient
// stalls of exactly these paths on GitHub's macos-26 image, and the passing
// run left no per-operation timings behind.
//
//   node scripts/ios-host-smoke.mjs <fixture-dir> --runner-cli <agent-device.mjs>
//       [--rounds 10] [--report <path>] [--app io.greenroom.fixture]
//       [--udid <udid>] [--label <text>]
//
// Without --udid it runs scripts/prepare-ios-canary.mjs first (build, fresh
// "Greenroom CI Canary" simulator, bootstatus, install, `prepare ios-runner`:
// the 0.3.13 preparation path, no warm-up) and keeps its boot/install/XCTest
// split. Then it opens the fixture through the given agent-device CLI and
// runs <rounds> rounds of four operations, each timed on the wall clock:
//   1. `agent-device snapshot -i --json`      (XCTest accessibility tree)
//   2. `xcrun simctl io <udid> screenshot`    (host-side display capture, the
//                                              same call the daemon makes)
//   3. `agent-device click <x> <y> --settle`  (a synthesized coordinate tap on
//                                              the tab bar, the adapter's own
//                                              tap path; in-runner it needs an
//                                              XCUIScreen screenshot)
//   4. `agent-device screenshot <file>`       (capture through the daemon)
// Slowness is recorded, never fatal. The exit code is non-zero only when the
// preparation, the open or an operation itself fails (a tool error), so a
// slow but working host still yields a complete report. No model is called,
// no Greenroom run is minted and nothing talks to the control plane.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const option = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };
const fixture = path.resolve(argv.find((arg, i) => !arg.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--"))) ?? "ios");
const runnerCli = option("--runner-cli") ? path.resolve(option("--runner-cli")) : null;
const rounds = Number.parseInt(option("--rounds", "10"), 10);
const app = option("--app", "io.greenroom.fixture");
const report = path.resolve(option("--report", path.join(fixture, "build/ios-host-smoke.json")));
const label = option("--label", "");
const prepareScript = path.resolve(option("--prepare-script", path.join(path.dirname(fileURLToPath(import.meta.url)), "prepare-ios-canary.mjs")));
if (!runnerCli || !fs.existsSync(runnerCli)) throw new Error("--runner-cli must name an agent-device CLI (the runner bundle's dist/node_modules/agent-device/bin/agent-device.mjs)");
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("--rounds must be an integer from 1 to 100");

const SLOW_MS = 5000;              // the diagnosis's "over 5 s" threshold
const OPERATION_TIMEOUT_MS = 90000; // above the CLI's own 60 s snapshot bound; a kill here is recorded as a tool error
const OPEN_TIMEOUT_MS = 180000;     // the adapter's open budget
const ABORT_AFTER_FAILED_OPERATIONS = 4; // one whole round of failures means the runner is gone; stop paying for restarts
const stateDir = process.env.AGENT_DEVICE_STATE_DIR || path.join(os.homedir(), ".agent-device");
const log = (line) => console.error(`[smoke] ${line}`);

function run(bin, args, { timeout = OPERATION_TIMEOUT_MS, env = process.env, cwd, tee = false } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; if (tee) process.stderr.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (tee) process.stderr.write(chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    const finish = (code, error) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: error ? `${stderr}\n${error.message}` : stderr, timedOut, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

// agent-device --json reports a failure as {success:false,error:{code,message,hint}}
// on stdout with exit 1 (harness/src/adapters/ios-ad.js agentDeviceJsonError).
function agentDeviceError(result) {
  if (result.timedOut) return { code: "SMOKE_KILLED", message: `killed after ${OPERATION_TIMEOUT_MS} ms` };
  const text = String(result.stdout ?? "").trim();
  for (const candidate of [text, ...text.split(/\r?\n/).filter((line) => line.startsWith("{")).reverse()]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.success === false && parsed.error) return { code: parsed.error.code ?? "UNKNOWN", message: parsed.error.message ?? "", hint: parsed.error.hint };
      if (parsed?.success === true) return null;
    } catch { /* not JSON */ }
  }
  if (result.code === 0) return null;
  const line = String(result.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  return { code: `EXIT_${result.code}`, message: line.slice(0, 500) };
}

async function hostSample(phase) {
  const capture = async (bin, args) => { const r = await run(bin, args, { timeout: 20000 }); return (r.stdout || r.stderr).trim(); };
  const top = await capture("top", ["-l", "1", "-n", "0"]);
  const topHead = top.split("\n").slice(0, 12).join("\n");
  const loadMatch = /Load Avg: ([\d.]+), ([\d.]+), ([\d.]+)/.exec(top);
  const cpuMatch = /CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/.exec(top);
  // Two 1 s samples: top's first sample reports no per-process CPU. The ten
  // busiest processes say what is loading the host (a 3-vCPU hosted VM
  // showed load 85 before the job's own work started on 2026-09-09).
  const topProcesses = (await capture("top", ["-l", "2", "-s", "1", "-n", "10", "-o", "cpu", "-stats", "pid,cpu,mem,state,command"])).split(/\n(?=Processes:)/).at(-1)?.split("\n").filter((line) => /^\s*\d+\s/.test(line)).map((line) => line.trim()) ?? [];
  const vmStat = await capture("vm_stat", []);
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 16384);
  const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
  return {
    phase, at: new Date().toISOString(),
    ncpu: Number(await capture("sysctl", ["-n", "hw.ncpu"])),
    memsizeGiB: Math.round(Number(await capture("sysctl", ["-n", "hw.memsize"])) / 2 ** 30 * 10) / 10,
    model: await capture("sysctl", ["-n", "hw.model"]),
    uptime: await capture("uptime", []),
    loadAvg: loadMatch ? loadMatch.slice(1, 4).map(Number) : null,
    cpu: cpuMatch ? { user: Number(cpuMatch[1]), sys: Number(cpuMatch[2]), idle: Number(cpuMatch[3]) } : null,
    freeMiB: Math.round((pages("Pages free") + pages("Pages speculative")) * pageSize / 2 ** 20),
    swapouts: pages("Swapouts"),
    topProcesses, topHead, vmStat,
  };
}

const xcodebuildPids = async () => (await run("pgrep", ["-x", "xcodebuild"], { timeout: 10000 })).stdout.trim().split(/\s+/).filter(Boolean).map(Number);

// Reuses the canary preparation exactly (same script, same bounds) and reads
// the split it prints: boot, install and XCTest preparation seconds.
async function prepare() {
  if (!fs.existsSync(prepareScript)) throw new Error(`prepare script missing: ${prepareScript}`);
  log(`Preparing ${fixture} with ${prepareScript} (0.3.13 path: build, create, boot, install, prepare ios-runner).`);
  const result = await run(process.execPath, [prepareScript, fixture, "--runner-cli", runnerCli], { timeout: 1500000, tee: true });
  if (result.code !== 0) throw new Error(`preparation failed (${result.timedOut ? "killed" : `exit ${result.code}`}): ${result.stderr.trim().split("\n").slice(-5).join(" | ")}`);
  const seconds = (pattern) => { const m = pattern.exec(result.stderr); return m ? Number(m[1]) : null; };
  const receiptPath = path.join(fixture, "build/simulator.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (!receipt.automationPrepared) throw new Error("preparation did not prepare the XCTest runner (missing --runner-cli?)");
  return {
    wallSeconds: Math.round(result.ms / 1000),
    bootSeconds: seconds(/boot completed after (\d+) s/),
    installSeconds: seconds(/Installed the fixture in (\d+) s/),
    xctestPrepareSeconds: seconds(/XCTest runner prepared in (\d+) s/),
    reusedSimulator: /Reusing simulator/.test(result.stderr),
    receipt,
  };
}

// The tab bar is the harmless control: tapping Today or Progress changes only
// the selected tab. Located from the first snapshot (largest-y node with the
// label); the iPhone 16/16e tab-bar geometry is the fallback.
function tabTargets(snapshotStdout) {
  const fallback = { Today: { x: 39, y: 812 }, Progress: { x: 195, y: 812 } };
  let nodes = [];
  try { const payload = JSON.parse(snapshotStdout); nodes = (payload?.data ?? payload)?.nodes ?? []; } catch { /* fallback geometry */ }
  const targets = {};
  for (const name of ["Today", "Progress"]) {
    const hits = nodes.filter((node) => node.label === name && node.rect && Number.isFinite(node.rect.x) && Number.isFinite(node.rect.y) && node.rect.width > 0).sort((a, b) => b.rect.y - a.rect.y);
    const node = hits[0];
    targets[name] = node ? { x: Math.round(node.rect.x + node.rect.width / 2), y: Math.round(node.rect.y + node.rect.height / 2), ref: node.ref ?? null, fromSnapshot: true } : { ...fallback[name], fromSnapshot: false };
  }
  return { targets, nodeCount: nodes.length };
}

const MARKERS = {
  runnerBusy: /RUNNER_BUSY/g,
  runnerWedged: /RUNNER_WEDGED/g,
  watchdog: /main thread execution timed out/g,
  buildInterrupted: /\*\* BUILD INTERRUPTED \*\*/g,
  screenshotTimeout: /Timed out while requesting screenshot/g,
  treeSnapshotTimeout: /timed out while preparing tree snapshot/g,
  snapshotTiersDeferred: /snapshot tiers were deferred/g,
  sessionNotFound: /SESSION_NOT_FOUND/g,
  daemonStartFailed: /Failed to start daemon/g,
  abandonedWork: /ABANDONED_WORK_DRAINED/g,
  testExecuteFailed: /TEST EXECUTE FAILED/g,
};
function scanSessionLogs(udid) {
  const dir = path.join(stateDir, "sessions", `sim-${udid}`);
  const files = [];
  const add = (file) => { if (fs.existsSync(file)) files.push(file); };
  add(path.join(dir, "runner.log")); add(path.join(dir, "events.ndjson")); add(path.join(stateDir, "daemon.log"));
  const requests = path.join(dir, "requests");
  if (fs.existsSync(requests)) for (const name of fs.readdirSync(requests)) add(path.join(requests, name));
  const counts = Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0]));
  const xcodebuildInvocations = new Set();
  for (const file of files) {
    let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const [key, pattern] of Object.entries(MARKERS)) counts[key] += (text.match(pattern) ?? []).length;
    if (file.endsWith("runner.log")) for (const m of text.matchAll(/xcodebuild(?:\[| pid[= ])(\d+)/g)) xcodebuildInvocations.add(m[1]);
  }
  return { stateDir, sessionDir: dir, files: files.map((file) => path.relative(stateDir, file)), counts, xcodebuildPidsInRunnerLog: [...xcodebuildInvocations] };
}

const stats = (values) => {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, min: sorted[0], median: at(0.5), p90: at(0.9), max: sorted.at(-1), overSlow: sorted.filter((v) => v > SLOW_MS).length };
};

async function main() {
  const startedAt = new Date();
  const outDir = path.dirname(report);
  fs.mkdirSync(outDir, { recursive: true });
  // Screenshots stay beside the build (20 PNGs per run); only round 1's pair
  // is copied next to the report as evidence of what was on screen.
  const shots = path.join(fixture, "build/smoke-screenshots"); fs.mkdirSync(shots, { recursive: true });
  const cliVersion = (await run(process.execPath, [runnerCli, "--version"], { timeout: 30000 })).stdout.trim();
  const result = {
    schemaVersion: "1.0", kind: "ios-host-smoke", label, startedAt: startedAt.toISOString(), finishedAt: null,
    actionsRunId: process.env.GITHUB_RUN_ID ?? null, actionsRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, runnerName: process.env.RUNNER_NAME ?? null,
    host: { platform: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version, agentDevice: cliVersion, stateDir },
    fixture, app, rounds, slowThresholdMs: SLOW_MS, operationTimeoutMs: OPERATION_TIMEOUT_MS,
    before: null, preparation: null, open: null, targets: null, operations: [], perRound: [], after: null, xcodebuild: {}, sessionLogs: null, summary: null, error: null,
  };
  const save = () => { result.finishedAt = new Date().toISOString(); fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n"); };
  let exitCode = 0;
  try {
    result.before = await hostSample("before");
    log(`Host: ${result.before.ncpu} cpu, ${result.before.memsizeGiB} GiB, load ${result.before.loadAvg?.join("/") ?? "?"}, free ${result.before.freeMiB} MiB.`);
    let udid = option("--udid");
    if (udid) result.preparation = { skipped: true, receipt: { udid } };
    else { result.preparation = await prepare(); udid = result.preparation.receipt.udid; }
    log(`Simulator ${udid}; boot ${result.preparation.bootSeconds ?? "?"} s, install ${result.preparation.installSeconds ?? "?"} s, XCTest prepare ${result.preparation.xctestPrepareSeconds ?? "?"} s, prepare step ${result.preparation.wallSeconds ?? "?"} s.`);
    result.after = null;
    const env = { ...process.env, AGENT_DEVICE_SESSION: `sim-${udid}` };
    const ad = (args, options = {}) => run(process.execPath, [runnerCli, ...args, "--json"], { env, ...options });
    let streak = 0; // consecutive failed operations
    const record = (round, op, r, extra = {}) => {
      const error = agentDeviceError(r);
      const entry = { round, op, ms: Math.round(r.ms), ok: !error, error, stdoutBytes: r.stdout.length, ...extra };
      streak = error ? streak + 1 : 0;
      result.operations.push(entry);
      log(`round ${round} ${op}: ${entry.ms} ms${error ? ` FAILED ${error.code}: ${error.message}` : ""}${entry.ms > SLOW_MS ? " (slow)" : ""}`);
      save();
      return entry;
    };

    const open = await ad(["open", app, "--platform", "ios", "--udid", udid, "--relaunch"], { timeout: OPEN_TIMEOUT_MS });
    const openEntry = record(0, "open", open);
    if (!openEntry.ok) throw new Error(`open failed: ${openEntry.error.code}: ${openEntry.error.message}`);
    result.open = { ms: openEntry.ms };
    const first = await ad(["snapshot", "-i"]);
    const firstEntry = record(0, "snapshot", first);
    if (!firstEntry.ok) throw new Error(`first snapshot failed: ${firstEntry.error.code}: ${firstEntry.error.message}`);
    result.targets = tabTargets(first.stdout);
    log(`Tab targets: Today (${result.targets.targets.Today.x},${result.targets.targets.Today.y}) Progress (${result.targets.targets.Progress.x},${result.targets.targets.Progress.y})${result.targets.targets.Today.fromSnapshot ? "" : " [fallback geometry]"}; ${result.targets.nodeCount} interactive nodes.`);
    result.xcodebuild.beforeRounds = await xcodebuildPids();

    for (let round = 1; round <= rounds; round++) {
      const target = result.targets.targets[round % 2 ? "Progress" : "Today"];
      const roundStarted = Date.now();
      const entries = [];
      entries.push(record(round, "snapshot", await ad(["snapshot", "-i"])));
      entries.push(record(round, "simctl-screenshot", await run("xcrun", ["simctl", "io", udid, "screenshot", path.join(shots, `round-${round}-simctl.png`)], { env })));
      entries.push(record(round, "tap", await ad(["click", String(target.x), String(target.y), "--settle"]), { target: { x: target.x, y: target.y, label: round % 2 ? "Progress" : "Today" } }));
      entries.push(record(round, "agent-device-screenshot", await ad(["screenshot", path.join(shots, `round-${round}-agent-device.png`)])));
      result.perRound.push({ round, ms: Date.now() - roundStarted, failed: entries.filter((entry) => !entry.ok).length, slow: entries.filter((entry) => entry.ms > SLOW_MS).length, xcodebuildPids: await xcodebuildPids() });
      save();
      if (streak >= ABORT_AFTER_FAILED_OPERATIONS) { result.abortedAfterRound = round; log(`Aborting after round ${round}: ${streak} consecutive failed operations (the runner is gone; the remaining rounds would only measure restarts).`); break; }
    }
    for (const name of ["round-1-simctl.png", "round-1-agent-device.png"]) if (fs.existsSync(path.join(shots, name))) fs.copyFileSync(path.join(shots, name), path.join(outDir, name));
    result.xcodebuild.afterRounds = await xcodebuildPids();
    result.after = await hostSample("after");
    const close = await ad(["close"], { timeout: 60000 });
    record(0, "close", close);
    result.xcodebuild.afterClose = await xcodebuildPids();
    result.sessionLogs = scanSessionLogs(udid);
  } catch (error) {
    result.error = String(error.message ?? error);
    log(`Tool error: ${result.error}`);
    exitCode = 1;
  }
  if (!result.after) result.after = await hostSample("after").catch(() => null);
  const ops = result.operations.filter((entry) => entry.round > 0);
  const byOp = {};
  for (const op of ["snapshot", "simctl-screenshot", "tap", "agent-device-screenshot"]) byOp[op] = { ...stats(ops.filter((entry) => entry.op === op && entry.ok).map((entry) => entry.ms)), failed: ops.filter((entry) => entry.op === op && !entry.ok).length };
  const all = ops.map((entry) => entry.ms);
  result.summary = {
    roundsCompleted: result.perRound.length, operations: ops.length, failedOperations: ops.filter((entry) => !entry.ok).length,
    overSlow: all.filter((ms) => ms > SLOW_MS).length, maxMs: all.length ? Math.max(...all) : null, medianMs: stats(all).median ?? null, byOp,
    failureCodes: [...new Set(ops.filter((entry) => !entry.ok).map((entry) => entry.error.code))],
    xcodebuildAliveAfterRounds: (result.xcodebuild.afterRounds ?? []).length > 0, xcodebuildAliveAfterClose: (result.xcodebuild.afterClose ?? []).length > 0,
  };
  if (ops.some((entry) => !entry.ok)) exitCode = 1;
  save();
  const table = [
    "| operation | n | median ms | p90 ms | max ms | over 5 s | failed |", "| --- | --- | --- | --- | --- | --- | --- |",
    ...Object.entries(byOp).map(([op, s]) => `| ${op} | ${s.count} | ${s.median ?? "-"} | ${s.p90 ?? "-"} | ${s.max ?? "-"} | ${s.overSlow ?? 0} | ${s.failed} |`),
  ].join("\n");
  const prep = result.preparation ?? {};
  const summaryText = `## iOS host smoke${label ? ` (${label})` : ""}\n\nHost ${result.before?.ncpu ?? "?"} cpu / ${result.before?.memsizeGiB ?? "?"} GiB; boot ${prep.bootSeconds ?? "?"} s, install ${prep.installSeconds ?? "?"} s, XCTest prepare ${prep.xctestPrepareSeconds ?? "?"} s, prepare step ${prep.wallSeconds ?? "?"} s; open ${result.open?.ms ?? "?"} ms; ${result.summary.roundsCompleted}/${rounds} rounds, ${result.summary.overSlow} operations over 5 s, max ${result.summary.maxMs ?? "?"} ms, ${result.summary.failedOperations} failed${result.summary.failureCodes.length ? ` (${result.summary.failureCodes.join(", ")})` : ""}; xcodebuild alive after rounds: ${result.summary.xcodebuildAliveAfterRounds}, after close: ${result.summary.xcodebuildAliveAfterClose}; log markers: ${result.sessionLogs ? Object.entries(result.sessionLogs.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none" : "not scanned"}${result.error ? `\n\nTool error: ${result.error}` : ""}\n\n${table}\n`;
  console.log(summaryText);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText);
  log(`Report written to ${report}; exit ${exitCode}.`);
  process.exit(exitCode);
}

main();
