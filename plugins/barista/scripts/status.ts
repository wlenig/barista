#!/usr/bin/env node
// Requires Node >= 23 (TypeScript stripping is on by default).
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
  getPgid,
  hasLivePidFile,
  isAlive,
  killPidFile,
  pgDir,
  preToolSnapFile,
  reconcileBg,
  readSnapshot,
  recordBg,
  startCaffeinate,
  stopCaffeinate,
  watchdogPidFile,
  writeSnapshot,
} from "./lib.ts";

if (process.platform !== "darwin") process.exit(0);
const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 23) process.exit(0);

interface HookPayload {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: { run_in_background?: boolean; [k: string]: unknown };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function startWatchdog(sid: string, claudePid: number): void {
  const f = watchdogPidFile(sid);
  if (hasLivePidFile(f)) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(
    process.execPath,
    [join(here, "watchdog.ts"), sid, String(claudePid)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  if (child.pid) writeFileSync(f, String(child.pid));
}

function isBgBash(payload: HookPayload): boolean {
  return payload.tool_name === "Bash"
    && payload.tool_input?.run_in_background === true;
}

const payload = JSON.parse(await readStdin()) as HookPayload;
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

  case "PostToolUse":
    if (isBgBash(payload) && existsSync(preToolSnapFile(sid))) {
      const before = new Set(readSnapshot(preToolSnapFile(sid)));
      const after = descendantPids(claudePid, [process.pid]);
      const fresh = after.filter(pid => !before.has(pid) && isAlive(pid));
      recordBg(sid, fresh, getPgid(claudePid));
      rmSync(preToolSnapFile(sid), { force: true });
    }
    // Even on non-bg tool calls, reconcile so descendants get captured while
    // their tracked parents are still alive.
    reconcileBg(sid);
    break;

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
