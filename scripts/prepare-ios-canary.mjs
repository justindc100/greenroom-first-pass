#!/usr/bin/env node
// Builds the native fixture and warms a fresh simulator for the release
// canary (workflows/release-canary.yml). scripts/prepare-release-canary.mjs
// copies it into the disposable canary repository. No account or model secrets.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const fixture = path.resolve(process.argv[2] ?? "ios");
const cliIndex = process.argv.indexOf("--runner-cli");
const runnerCli = cliIndex < 0 ? null : path.resolve(process.argv[cliIndex + 1] ?? "");
if (cliIndex >= 0 && (!process.argv[cliIndex + 1] || !fs.existsSync(runnerCli))) throw new Error("--runner-cli must name the fetched candidate's agent-device CLI");
const run = (bin, args, options = {}) => {
  try { return execFileSync(bin, args, { cwd: fixture, encoding: "utf8", timeout: 900000, maxBuffer: 32 * 1024 * 1024, ...options }); }
  catch (error) {
    const diagnostic = String(error.stderr || error.stdout || error.message).trim().slice(-4000);
    throw new Error(`${bin} ${args.slice(0, 2).join(" ")} failed (${error.code ?? error.status ?? "unknown"}).\n${diagnostic}`);
  }
};
run("xcodegen", ["generate", "--spec", "project.yml"]);
run("xcodebuild", ["-project", "GreenroomNativeFixture.xcodeproj", "-scheme", "GreenroomNativeFixture", "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "build", "CODE_SIGNING_ALLOWED=NO", "build"]);
const artifact = path.join(fixture, "build/Build/Products/Debug-iphonesimulator/GreenroomNativeFixture.app");
if (!fs.existsSync(artifact)) throw new Error("Simulator artifact missing after build");
if (!process.argv.includes("--build-only")) {
  const runtimes = JSON.parse(run("xcrun", ["simctl", "list", "runtimes", "-j"])).runtimes.filter(item => item.isAvailable && item.identifier.includes(".iOS-"));
  const runtime = runtimes.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const types = JSON.parse(run("xcrun", ["simctl", "list", "devicetypes", "-j"])).devicetypes;
  const deviceType = types.find(item => item.name === "iPhone 16e") ?? types.find(item => item.name === "iPhone 16");
  if (!runtime || !deviceType) throw new Error("Canary requires an installed iOS runtime and iPhone 16 or 16e simulator type");
  const name = "Greenroom CI Canary";
  const devices = Object.values(JSON.parse(run("xcrun", ["simctl", "list", "devices", "-j"])).devices).flat().filter(item => item.isAvailable !== false);
  // When the reusable workflow's opt-in warm-up ran (lib/ios-warm.js, input
  // ios-warm, off by default since 0.3.16) it has created and booted the
  // named simulator already; reuse exactly that one. Otherwise create it
  // here and boot it, the 0.3.13 preparation path the release canary runs by
  // default; no GREENROOM_SIMULATOR_UDID is needed. Two of them means a host
  // that was not fresh.
  const existing = devices.filter(item => item.name === name);
  if (existing.length > 1) throw new Error("Canary simulator name is ambiguous; use a fresh CI host");
  const udid = existing[0]?.udid ?? run("xcrun", ["simctl", "create", name, deviceType.identifier, runtime.identifier]).trim();
  console.error(existing[0] ? `[canary] Reusing simulator ${udid} prepared by the workflow.` : `[canary] Created simulator ${udid}.`);
  try { run("xcrun", ["simctl", "boot", udid]); } catch (error) { if (!/current state: Booted/i.test(error.message)) throw error; }
  // Fresh hosted simulators perform first-boot data migration. The observed
  // CI boot was still migrating at three minutes; keep this bounded setup
  // outside the paid run rather than mistaking slow migration for readiness.
  console.error(`[canary] Waiting up to 10 minutes for simulator ${udid} to finish booting.`);
  const bootStarted = Date.now();
  run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 600000 });
  console.error(`[canary] Simulator ${udid} boot completed after ${Math.round((Date.now() - bootStarted) / 1000)} s.`);
  if (runnerCli) {
    const installStarted = Date.now();
    run("xcrun", ["simctl", "install", udid, artifact]);
    const prepareStarted = Date.now();
    run(process.execPath, [runnerCli, "prepare", "ios-runner", "--platform", "ios", "--udid", udid, "--timeout", "300000"], {
      cwd: process.cwd(), timeout: 330000, env: { ...process.env, AGENT_DEVICE_SESSION: `sim-${udid}` },
    });
    console.error(`[canary] Installed the fixture in ${Math.round((prepareStarted - installStarted) / 1000)} s; XCTest runner prepared in ${Math.round((Date.now() - prepareStarted) / 1000)} s.`);
  }
  const receipt = { device: name, udid, runtime: runtime.identifier, artifact, automationPrepared: Boolean(runnerCli) };
  fs.writeFileSync(path.join(fixture, "build/simulator.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} else console.log(`Built ${artifact}; no simulator created.`);
