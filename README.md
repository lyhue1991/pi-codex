# pi-codex

Non-blocking background shell extension for the [Pi](https://github.com/earendil-works/pi) coding agent.

Inspired by [OpenAI Codex](https://github.com/openai/codex)'s unified-exec / `write_stdin` design, this extension lets the agent run long-running commands (builds, tests, dev servers, file watchers) without blocking the workflow.

## The problem

When the Pi agent runs a long bash command via the built-in `bash` tool, it blocks until the command finishes. A 10-minute build or a long-running test suite stalls the entire agent loop — no monitoring, no intervention, no progress reports.

## The solution

pi-codex adds two LLM-callable tools that work together:

| Tool | Purpose |
|------|---------|
| **`bash_bg`** | Spawn a command in the background, wait briefly for initial output, then return a `session_id` if the process is still running. |
| **`bash_io`** | Poll a running process for new output, write to its stdin, or send Ctrl-C — all without blocking the agent loop. |

### How it works

```
Agent calls bash_bg("npm run build")
  └─ spawns process, waits 10s for initial output
  └─ process still running → returns session_id: 1

Agent calls bash_io(session_id=1, chars="")
  └─ polls for 5s, returns new output since last poll
  └─ process still running → returns session_id: 1

Agent calls bash_io(session_id=1, chars="")
  └─ polls for 5s, returns new output
  └─ process exited with code 0 → returns exit code

Agent continues with next step
```

### Key features

- **Non-blocking**: The agent yields control after `yield_time_ms` and can do other work between polls.
- **Interactive**: Write to stdin to respond to prompts, answer y/n confirmations, or provide credentials.
- **Interruptible**: Send `\u0003` (Ctrl-C) to kill a misbehaving process without losing the agent's context.
- **Bounded memory**: A rolling head+tail buffer (4 KiB head + 252 KiB tail) caps retained output per process.
- **Session-scoped**: Processes survive across tool calls but are cleaned up on session shutdown.

## Installation

### Via `pi install` (recommended)

```bash
# From npm
pi install npm:@lyhue1991/pi-codex

# From GitHub
pi install github:lyhue1991/pi-codex

# Local path
pi install /path/to/pi-codex
```

`pi install` clones/downloads the package into pi's managed extension directory, runs `npm install` for any dependencies, and registers it in settings. The extension loads automatically on the next pi startup.

To verify it's installed:

```bash
pi list
```

To remove:

```bash
pi uninstall npm:@lyhue1991/pi-codex
```

### Manual

Copy or symlink this directory to:

```bash
# Project-local
cp -r pi-codex /path/to/project/.pi/extensions/pi-codex

# Global
cp -r pi-codex ~/.pi/agent/extensions/pi-codex
```

Pi discovers extensions in `.pi/extensions/` automatically on startup — no additional configuration needed.

## How the agent uses it

Once installed, the extension adds the two tools to the agent's system prompt:

```
## Available tools
- bash_bg: non-blocking shell, returns session_id for bash_io
- bash_io: poll or send input to bash_bg process

## Guidelines
- Use `bash_bg` for long-running commands (builds, tests, servers).
- Poll a running process by calling `bash_io` with an empty `chars` string.
- Send input or Ctrl-C via `bash_io` with `chars` set to the input text or \u0003.
- After a process exits, do NOT call `bash_io` for that session_id again.
```

The agent learns when to use `bash_bg` vs the regular `bash` tool from these guidelines.

## API reference

### `bash_bg`

Spawns a command and waits for initial output.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `command` | `string` | — | Bash command to execute |
| `yield_time_ms` | `int?` | `10000` | Ms to wait before returning (range: 250–30000) |

Returns the initial output, exit code (if finished), or `session_id` (if still running).

### `bash_io`

Interacts with a running background process.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `session_id` | `int` | — | Process ID from `bash_bg` |
| `chars` | `string?` | `""` | Text to write to stdin. `\u0003` = Ctrl-C |
| `yield_time_ms` | `int?` | `5000` | Ms to wait for output (range: 250–30000) |

Returns incremental output since the last call, plus exit code if the process finished.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Agent loop (pi-agent-core)                          │
│                                                      │
│  bash_bg ──► BackgroundProcessManager.spawn()        │
│                  ├── child_process.spawn()           │
│                  ├── RollingBuffer (head+tail)       │
│                  └── returns session_id              │
│                                                      │
│  bash_io ──► BackgroundProcessManager.writeStdin()   │
│                  ├── child.stdin.write() / SIGINT    │
│                  ├── poll delta buffer               │
│                  └── returns output + status         │
│                                                      │
│  session_shutdown ──► manager.cleanup()              │
└──────────────────────────────────────────────────────┘
```

### Comparison with Codex

| Aspect | Codex unified-exec | pi-codex |
|--------|-------------------|----------|
| Process spawn | PTY (tokio) | pipe (`child_process.spawn`) |
| Output streaming | broadcast channels + delta events | RollingBuffer + delta snapshots |
| Output truncation | HeadTailBuffer (1 MiB) | RollingBuffer (256 KiB) |
| Process store | `ProcessStore` (Mutex<HashMap>) | `Map<number, ManagedProcess>` |
| Interrupt | PTY Ctrl-C write | `child.kill("SIGINT")` |
| Cleanup | turn/token cancellation | `session_shutdown` event |

pi-codex uses pipe-based stdio instead of PTY, which is sufficient for builds, tests, servers, and most non-TUI commands. Interactive TUI applications (vim, htop) are not supported — use pi's built-in [interactive-shell](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/interactive-shell.ts) extension for those.

## `package.json` fields

pi-codex declares its entry point via the `pi.extensions` field:

```json
{
  "name": "@lyhue1991/pi-codex",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.83.0",
    "typebox": "^1.3.7"
  }
}
```

The `dependencies` are declared for type-checking and tooling. At runtime, pi's extension loader resolves `@earendil-works/pi-coding-agent` and `typebox` through its own virtual module system — npm installs with `--legacy-peer-deps` so these host-provided packages are never duplicated.

## Requirements

- [Pi](https://github.com/earendil-works/pi) coding agent v0.83.0+
- Node.js 22+

## License

MIT
