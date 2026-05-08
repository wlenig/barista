#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATE_DIR,
  bgDir,
  descendantPids,
  hasLivePidFile,
  isAlive,
  killPidFile,
  pgDir,
  preToolSnapFile,
  readProcTable,
  reconcileBg,
  readSnapshot,
  recordBg,
  startCaffeinate,
  stopCaffeinate,
  watchdogPidFile,
  writeSnapshot,
} from "./lib.mjs";

if (process.platform !== "darwin") process.exit(0);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function startWatchdog(sid, claudePid) {
  const f = watchdogPidFile(sid);
  if (hasLivePidFile(f)) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(
    process.execPath,
    [join(here, "watchdog.mjs"), sid, String(claudePid)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  if (child.pid) writeFileSync(f, String(child.pid));
}

function isBgBash(payload) {
  return payload.tool_name === "Bash"
    && payload.tool_input?.run_in_background === true;
}

const payload = JSON.parse(await readStdin());
const event = payload.hook_event_name;
const sid = payload.session_id;
const claudePid = process.ppid;

mkdirSync(STATE_DIR, { recursive: true });

switch (event) {
  case "UserPromptSubmit":
    killPidFile(watchdogPidFile(sid));
    startCaffeinate(sid, claudePid);
    break;

  case "PreToolUse":
    if (isBgBash(payload)) {
      writeSnapshot(preToolSnapFile(sid), descendantPids(claudePid, [process.pid]));
    }
    break;

  case "PostToolUse": {
    let procs;
    if (isBgBash(payload) && existsSync(preToolSnapFile(sid))) {
      procs = readProcTable();
      const before = new Set(readSnapshot(preToolSnapFile(sid)));
      const after = descendantPids(claudePid, [process.pid], procs);
      const fresh = after.filter(pid => !before.has(pid) && isAlive(pid));
      const claudePgid = procs.find(p => p.pid === claudePid)?.pgid ?? 0;
      recordBg(sid, fresh, claudePgid, procs);
      rmSync(preToolSnapFile(sid), { force: true });
    }
    // Even on non-bg tool calls, reconcile so descendants get captured while
    // their tracked parents are still alive.
    reconcileBg(sid, procs);
    break;
  }

  case "Stop":
  case "StopFailure":
    if (reconcileBg(sid) > 0) {
      startWatchdog(sid, claudePid);
    } else {
      stopCaffeinate(sid);
    }
    break;

  case "SessionEnd":
    killPidFile(watchdogPidFile(sid));
    stopCaffeinate(sid);
    rmSync(bgDir(sid), { recursive: true, force: true });
    rmSync(pgDir(sid), { recursive: true, force: true });
    rmSync(preToolSnapFile(sid), { force: true });
    break;
}
