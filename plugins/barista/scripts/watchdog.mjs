#!/usr/bin/env node
// Detached polling daemon. Spawned by status.mjs at Stop time when background
// shells are still alive. Owns caffeinate until either the bg set drains or
// Claude itself exits.
import { rmSync } from "node:fs";
import {
  bgDir,
  isAlive,
  pgDir,
  reconcileBg,
  stopCaffeinate,
  watchdogPidFile,
} from "./lib.mjs";

const sid = process.argv[2];
const claudePid = parseInt(process.argv[3] ?? "", 10);

if (!sid || !claudePid) process.exit(1);

const POLL_MS = 10_000;

function done() {
  stopCaffeinate(sid);
  rmSync(bgDir(sid), { recursive: true, force: true });
  rmSync(pgDir(sid), { recursive: true, force: true });
  rmSync(watchdogPidFile(sid), { force: true });
  process.exit(0);
}

function tick() {
  if (!isAlive(claudePid)) done();
  if (reconcileBg(sid) === 0) done();
}

// First tick fast: catch transient parents (e.g. `bash -c "foo &"`) that may
// exit between Stop firing and the steady-state poll cadence.
setTimeout(tick, 500);
setInterval(tick, POLL_MS);
