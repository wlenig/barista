# barista

Keeps macOS awake while Claude Code is working, lets it sleep when Claude is idle.

## Why

Claude Code already calls `caffeinate -t 300` on each turn, which prevents idle sleep for 5 minutes from the start of the turn. That's enough for short responses, but a single long-running turn — a multi-step agentic loop, a slow tool call, a large inference — can blow past 300 seconds, after which the Mac is free to sleep mid-task.

barista replaces that bounded window with `caffeinate -i -w <claude-pid>` for the duration of a turn. No timeout. The moment the turn finishes, caffeinate is killed and the Mac can sleep again — so you don't burn battery overnight just because a session is still open.

## How it works

A small Node script (plain ESM) wired up to the session and tool-call hooks starts and stops `caffeinate` based on what the session is actually doing.

| Event              | What barista does                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `UserPromptSubmit` | **start** `caffeinate -i -w <claude-pid>`                                                        |
| `PreToolUse` (Bash, `run_in_background: true`)  | snapshot Claude's child processes                                   |
| `PostToolUse` (Bash, `run_in_background: true`) | diff against the snapshot; record any new live PIDs as bg work      |
| `Stop` / `StopFailure` | if any tracked bg PID is still alive, hand caffeinate ownership to a detached watchdog; otherwise **stop** |
| `SessionEnd`       | **stop**, kill watchdog, clean up                                                                |

`-w <claude-pid>` is a safety net: if Claude Code crashes before `Stop` fires, caffeinate self-terminates with the parent process instead of leaking until reboot.

### Background work and Monitor

Claude Code's `run_in_background: true` Bash and the `Monitor` tool let the assistant fire off long-running processes and return control to the user. The turn ends, `Stop` fires — but the process is still going, and `Monitor` may wake the assistant minutes later when output arrives.

barista detects this by snapshotting Claude's process tree before and after each background-bash call: anything new that's still alive at `PostToolUse` is recorded as pending bg work. When `Stop` fires with bg work pending, instead of killing caffeinate, barista hands it to a detached watchdog that polls every 10s and only stops caffeinate once every tracked process has exited (or Claude itself has died).

When the bg leader is spawned in its own process group (the standard case for detached background work), barista tracks the **pgid** instead of the PID — process groups survive reparenting, so the bookkeeping stays correct even after the leader exits and its children get adopted by PID 1.

## Requirements

- macOS (the `caffeinate` binary)
- Node.js >= 18 (any active LTS works)

On any other platform, the script exits silently — installing barista is harmless, it just does nothing.

## Install

```
/plugin marketplace add wlenig/barista
/plugin install barista@barista
```

## License

MIT
