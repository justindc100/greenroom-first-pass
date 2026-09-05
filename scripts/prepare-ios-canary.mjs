#!/usr/bin/env node
// Copied into the disposable canary repository. No account or model secrets.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const fixture = path.resolve(process.argv[2] ?? "ios");
const run = (bin, args, options = {}) => execFileSync(bin, args, { cwd: fixture, encoding: "utf8", timeout: 900000, maxBuffer: 32 * 1024 * 1024, ...options });
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
  const devices = Object.values(JSON.parse(run("xcrun", ["simctl", "list", "devices", "-j"])).devices).flat();
  if (devices.some(item => item.name === name)) throw new Error("Canary simulator already exists; use a fresh CI host");
  const udid = run("xcrun", ["simctl", "create", name, deviceType.identifier, runtime.identifier]).trim();
  run("xcrun", ["simctl", "boot", udid]);
  run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 180000 });
  const receipt = { device: name, udid, runtime: runtime.identifier, artifact };
  fs.writeFileSync(path.join(fixture, "build/simulator.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} else console.log(`Built ${artifact}; no simulator created.`);
