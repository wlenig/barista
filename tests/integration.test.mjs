// Integration tests for status.mjs. Hooks are driven by piping payloads
// through stdin, just like the real harness invokes them. The `caffeinate`
// and `ps` binaries are shadowed via PATH by the executable scripts in
// tests/fakes/ — the fake caffeinate logs START/TERM events to $BARISTA_LOG
// and the fake ps reads its rows from $BARISTA_PS, both per-test files.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  bgDir,
  caffeinatePidFile,
  isAlive,
  killPidFile,
  pgDir,
  preToolSnapFile,
  watchdogPidFile,
} from "../plugins/barista/scripts/lib.mjs";

const STATUS_HOOK = resolve("plugins/barista/scripts/status.mjs");
const FAKES_DIR = resolve("tests/fakes");
const BACKGROUND_BASH = {
  tool_name: "Bash",
  tool_input: { run_in_background: true },
};

const skip = process.platform !== "darwin"
  ? "status.mjs is a no-op outside macOS"
  : false;

let counter = 0;
const sidFor = (name) => `barista-test-${process.pid}-${Date.now()}-${++counter}-${name}`;

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); }
    catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

function readPid(file) {
  return Number(readFileSync(file, "utf8"));
}

function assertFileMissing(file) {
  assert.equal(existsSync(file), false);
}

async function assertLogEventually(log, pattern) {
  await waitFor(() => assert.match(log(), pattern));
}

function createHookHarness(t, sid) {
  const dir = mkdtempSync(join(tmpdir(), "barista-test-"));
  const log = join(dir, "caffeinate.log");
  const psFile = join(dir, "ps.txt");
  writeFileSync(psFile, "");

  const env = {
    ...process.env,
    BARISTA_LOG: log,
    BARISTA_PS: psFile,
    PATH: `${FAKES_DIR}:${process.env.PATH}`,
  };

  t.after(() => {
    killPidFile(watchdogPidFile(sid));
    killPidFile(caffeinatePidFile(sid));
    rmSync(preToolSnapFile(sid), { force: true });
    rmSync(bgDir(sid), { recursive: true, force: true });
    rmSync(pgDir(sid), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    fireHook(hook_event_name, extra = {}) {
      const result = spawnSync(process.execPath, [STATUS_HOOK], {
        env, encoding: "utf8",
        input: JSON.stringify({ session_id: sid, hook_event_name, ...extra }),
      });
      assert.equal(result.status, 0, `${hook_event_name}: ${result.stderr}`);
    },
    setProcessTable(rows) {
      const table = rows.map(({ pid, ppid, pgid }) => `${pid} ${ppid} ${pgid}`);
      writeFileSync(psFile, `${table.join("\n")}\n`);
    },
    readLog: () => existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

test("response-only turn: caffeinate starts on UserPromptSubmit, ends on Stop", { skip }, async (t) => {
  const sid = sidFor("response");
  const hook = createHookHarness(t, sid);

  hook.fireHook("UserPromptSubmit");

  const cpid = readPid(caffeinatePidFile(sid));
  assert.ok(isAlive(cpid), "caffeinate starts");
  await assertLogEventually(
    hook.readLog,
    new RegExp(`^START ${cpid} -i -w \\d+`, "m"),
  );

  hook.fireHook("Stop");

  await assertLogEventually(hook.readLog, new RegExp(`TERM ${cpid}`));
  assert.equal(hook.readLog().match(/START/g).length, 1);
  assertFileMissing(caffeinatePidFile(sid));
  assertFileMissing(watchdogPidFile(sid));
});

test("background turn: bg recorded, watchdog owns caffeinate after Stop, SessionEnd drains it", { skip }, async (t) => {
  const sid = sidFor("background");
  const hook = createHookHarness(t, sid);
  let bg;

  t.after(() => {
    if (bg?.pid) try { process.kill(bg.pid, "SIGKILL"); } catch {}
  });

  hook.fireHook("UserPromptSubmit");
  const cpid = readPid(caffeinatePidFile(sid));

  hook.fireHook("PreToolUse", BACKGROUND_BASH);
  bg = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    detached: true, stdio: "ignore",
  });
  bg.unref();

  // claudePid is process.ppid inside the hook = this test's process.pid.
  // Stage a synthetic proc table: claudePid in its own pgid 9000, bg in its
  // own pgrp so it gets tracked as a pgid (the realistic detached-bg case).
  hook.setProcessTable([
    { pid: process.pid, ppid: 1, pgid: 9000 },
    { pid: bg.pid, ppid: process.pid, pgid: bg.pid },
  ]);
  hook.fireHook("PostToolUse", BACKGROUND_BASH);

  hook.fireHook("Stop");
  hook.fireHook("StopFailure");

  const wpid = readPid(watchdogPidFile(sid));
  assert.equal(existsSync(join(pgDir(sid), String(bg.pid))), true);
  assert.ok(isAlive(cpid), "caffeinate stays alive across Stop");
  assert.ok(isAlive(wpid), "watchdog took ownership");
  assert.equal(hook.readLog().includes(`TERM ${cpid}`), false);

  hook.fireHook("SessionEnd");

  await assertLogEventually(hook.readLog, new RegExp(`TERM ${cpid}`));
  assertFileMissing(watchdogPidFile(sid));
  assertFileMissing(caffeinatePidFile(sid));
  assertFileMissing(pgDir(sid));
});

test("PreToolUse on non-background Bash takes no snapshot", { skip }, async (t) => {
  const sid = sidFor("nonbg");
  const hook = createHookHarness(t, sid);

  hook.fireHook("UserPromptSubmit");
  hook.fireHook("PreToolUse", {
    tool_name: "Bash",
    tool_input: { run_in_background: false },
  });

  assertFileMissing(preToolSnapFile(sid));
});
