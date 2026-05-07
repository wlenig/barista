import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const STATE_DIR = "/tmp/barista";

export const caffeinatePidFile = (sid: string) => join(STATE_DIR, `${sid}.caffeinate.pid`);
export const watchdogPidFile = (sid: string) => join(STATE_DIR, `${sid}.watchdog.pid`);
export const bgDir = (sid: string) => join(STATE_DIR, `${sid}.bg`);
export const pgDir = (sid: string) => join(STATE_DIR, `${sid}.pg`);
export const preToolSnapFile = (sid: string) => join(STATE_DIR, `${sid}.pre.json`);

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface ProcRow { pid: number; ppid: number; pgid: number }

function positiveInt(value: string): number {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readPidFile(file: string): number {
  return existsSync(file) ? positiveInt(readFileSync(file, "utf8")) : 0;
}

// Note: side-effecting read — removes the file if its pid is dead. Single
// writer per session in practice, so the implicit cleanup is safe.
export function hasLivePidFile(file: string): boolean {
  if (!existsSync(file)) return false;
  const pid = readPidFile(file);
  if (pid && isAlive(pid)) return true;
  rmSync(file, { force: true });
  return false;
}

export function killPidFile(file: string): void {
  const pid = readPidFile(file);
  if (pid) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  rmSync(file, { force: true });
}

export function parseProcTable(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: positiveInt(m[1]), ppid: positiveInt(m[2]), pgid: positiveInt(m[3]) });
  }
  return rows;
}

function readProcTable(): ProcRow[] {
  return parseProcTable(execSync("ps -A -o pid=,ppid=,pgid=").toString());
}

function childrenByParent(procs: ProcRow[]): Map<number, number[]> {
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    const children = childrenOf.get(p.ppid) ?? [];
    children.push(p.pid);
    childrenOf.set(p.ppid, children);
  }
  return childrenOf;
}

function descendants(childrenOf: Map<number, number[]>, rootPid: number, excluded: Set<number>): number[] {
  const found: number[] = [];
  const visit = (pid: number) => {
    for (const child of childrenOf.get(pid) ?? []) {
      if (excluded.has(child)) continue;
      found.push(child);
      visit(child);
    }
  };
  visit(rootPid);
  return found;
}

export function startCaffeinate(sid: string, watchPid: number): void {
  const f = caffeinatePidFile(sid);
  if (hasLivePidFile(f)) return;
  const child = spawn("caffeinate", ["-i", "-w", String(watchPid)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid) writeFileSync(f, String(child.pid));
}

export function stopCaffeinate(sid: string): void {
  killPidFile(caffeinatePidFile(sid));
}

export function getPgid(pid: number): number {
  try {
    return positiveInt(execSync(`ps -o pgid= -p ${pid}`).toString().trim());
  } catch {
    return 0;
  }
}

// All PIDs in the descendant tree of `rootPid`, excluding any PID in `exclude`.
export function descendantPids(rootPid: number, exclude: number[]): number[] {
  return descendants(childrenByParent(readProcTable()), rootPid, new Set(exclude));
}

// Record fresh bg PIDs. Process groups are tags, not tree edges — they survive
// reparenting, so when a bg process lives in its own pgid (the standard case
// for detached background shells, since Claude Code spawns them in a new pgrp)
// we track the pgid: `pgrep -g <pgid>` keeps finding orphans after the leader
// dies and its children get adopted by PID 1. We only fall back to PID
// tracking when the bg process happens to share Claude's pgid, in which case
// we can't distinguish its descendants from Claude's own.
export function recordBg(sid: string, pids: number[], claudePgid: number): void {
  if (pids.length === 0) return;
  const pidToPgid = new Map(readProcTable().map(p => [p.pid, p.pgid]));
  const bg = bgDir(sid);
  const pg = pgDir(sid);
  for (const pid of pids) {
    const pgid = pidToPgid.get(pid) ?? 0;
    if (pgid && pgid !== claudePgid) {
      mkdirSync(pg, { recursive: true });
      writeFileSync(join(pg, String(pgid)), "");
    } else {
      mkdirSync(bg, { recursive: true });
      writeFileSync(join(bg, String(pid)), "");
    }
  }
}

// Walk the tracked bg set (PIDs and pgids) against the live process table.
// Drop entries with no live representatives; for PID entries, also expand to
// any live descendants so we keep tracking work even after the original
// leader dies. Returns the number of items still considered alive.
export function reconcileBg(sid: string): number {
  const bg = bgDir(sid);
  const pg = pgDir(sid);
  const hasBg = existsSync(bg);
  const hasPg = existsSync(pg);
  if (!hasBg && !hasPg) return 0;

  const procs = readProcTable();
  const livePids = new Set(procs.map(p => p.pid));
  const livePgids = new Set(procs.map(p => p.pgid));
  const childrenOf = childrenByParent(procs);

  let alive = 0;

  // PID entries: keep alive ones, expand descendants of alive ones.
  if (hasBg) {
    const tracked = new Set<number>();
    for (const f of readdirSync(bg)) {
      const pid = positiveInt(f);
      if (pid) tracked.add(pid);
    }
    const queue = [...tracked].filter(p => livePids.has(p));
    while (queue.length) {
      const pid = queue.shift()!;
      for (const child of childrenOf.get(pid) ?? []) {
        if (!tracked.has(child)) {
          tracked.add(child);
          if (livePids.has(child)) queue.push(child);
        }
      }
    }
    for (const f of readdirSync(bg)) rmSync(join(bg, f), { force: true });
    for (const pid of tracked) {
      if (livePids.has(pid)) {
        writeFileSync(join(bg, String(pid)), "");
        alive++;
      }
    }
  }

  // Pgid entries: keep ones with any live member.
  if (hasPg) {
    for (const f of readdirSync(pg)) {
      const pgid = positiveInt(f);
      if (!pgid || !livePgids.has(pgid)) {
        rmSync(join(pg, f), { force: true });
      } else {
        alive++;
      }
    }
  }

  return alive;
}

export function writeSnapshot(file: string, pids: number[]): void {
  writeFileSync(file, JSON.stringify(pids));
}

export function readSnapshot(file: string): number[] {
  return JSON.parse(readFileSync(file, "utf8")) as number[];
}
