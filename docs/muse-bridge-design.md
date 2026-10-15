# `muse bridge`

Status: **implemented** in `packages/muse-bridge` (npm `muse-agent-bridge`),
driven by `muse bridge …`. The protocol and the full loop are verified live
(AGENTS.md item 16).

## Goal

Let the Muse agent hand work to the user's own agent runtimes (Claude Code,
LilOS, Grokbot, a shell command) and get the result back. The CLI drives Muse;
the bridge adds the reverse direction.

```
Muse agent (cloud VM)
  └─ device.invoke ─────────►  muse bridge (user's machine, long-running)
                                 ├─ policy gate   (full | auto | manual | off)
                                 ├─ approval      (macos | terminal | muse thread)
                                 ├─ runtime adapter (shell, claude-code, http, mcp)
                                 └─ audit log
  ◄── client.invoke.result ────┘
```

Verified end to end: Muse called `claude.ask`, the bridge ran headless Claude
Code in an allowed folder as a background job, Muse polled `bridge.job_status`,
and reported Claude's answer back to the user.

## Protocol (verified live)

1. Open `chat.subscribe` and keep it open; the node exists only while the
   connection does, so the bridge re-registers after every reconnect.
2. `node.register {node_id, display_name, platform: "web", commands_v2}`.
   `commands_v2` is required (a placeholder `ping` is enough).
3. `client.register_capabilities` with commands under
   `capabilities.device_commands`. Each: `{description, required, optional,
   permissions, datatype, timeout_ms}`. **Param `type` is numeric:**
   1 string, 2 integer, 3 number, 4 boolean (`node.list` reports names back).
   Commands under `hatch_app_commands` are accepted but never invoked.
4. The agent calls `device.invoke`; the bridge gets `client.invoke`
   `{invoke_id, command_id, params_json, timeout_ms}` on its own connection.
5. Reply `client.invoke.result {invoke_id, ok, payload_json | error}`.
6. **Muse abandons an invoke after ~30 s** (`node_invoke_timeout`). A late
   reply is lost even if the command ran.

**Muse adds no approval step for these commands.** Every safeguard is in the
bridge.

## Safeguard levels

Each command has a level, set only in config. A request can never raise its own
level and Muse can never edit the config.

| Level | Behaviour |
|---|---|
| `full` | Runs at once. Hard rules still apply. |
| `auto` | Runs at once if every rule passes; otherwise asks. |
| `manual` | Always asks. No answer in time = Deny. Default for new commands. |
| `off` | Not registered; Muse never sees it. |

Hard rules (every level, refuse outright):

- `max_input_bytes`.
- `cwd_allow`: every path-like string param (absolute, `~`, `.`, or containing
  `/`, plus the names `cwd`/`path`/`dir`/`directory`/`repo`/`file`/`folder`)
  must be inside an allowed root, symlinks resolved. The adapter then runs the
  canonical path that was checked, so a later symlink swap or `~` cannot change
  it. Commands that touch local files (`claude.ask`) refuse to load without
  `cwd_allow`.
- `max_concurrent`, `per_hour`: checked and reserved in one atomic step, so a
  burst of invokes cannot all slip through.
- Approval prompts are themselves limited (6 per command per minute, 3 pending)
  so a flood cannot wear the user down into clicking Allow.

Soft rule (`auto` falls back to asking): request text that tries to widen
access ("set level…", "ignore previous instructions", `bypassPermissions`).
This is a tripwire, not a boundary; only use `auto` for genuinely safe commands.

Children (shell, Claude Code, MCP servers) get a scrubbed environment (`PATH`,
`HOME`, locale and a few others), never the bridge's own, so secrets such as
`MUSE_COOKIE` cannot reach the agent through command output. Shell template
params may not start with `-`, so they cannot become program options.
Approval prompts show agent-written params on one line, labelled untrusted.

## Approval channels

Pick the one the user is looking at (`approval.channel`):

| Channel | How | Notes |
|---|---|---|
| `macos` | Native dialog, Deny is default. Request text goes in as an AppleScript argument, never spliced into the script. | Works under launchd. |
| `terminal` | `[y/N]` prompt in the bridge's terminal. | Foreground only; refused for background runs. |
| `muse` | Posts a request with a one-time code into the "Muse bridge approvals" thread; the user replies `allow <code>` or `deny <code>` from any Muse app (iPhone, Mac, web). | Only `message.user` events in that thread count; agent text arrives as `delta.*` and can never answer. |

Because of Muse's 30 s window, `approval.timeout_seconds` is capped at 25. A
slower answer would approve a command whose result nobody receives.

## Long-running work

Commands whose limit exceeds Muse's window run as background jobs: the invoke
returns `{status: "accepted", job_id}` at once and the built-in, read-only
`bridge.job_status {job_id}` returns the result later. The bridge registers
`bridge.job_status` automatically when any command can become a job, and caps
every advertised `timeout_ms` at the window.

## Runtime adapters

A runtime picks its adapter with `options.kind` (default: the runtime id), so
several runtimes can share a kind.

| Kind | What it runs | Safety |
|---|---|---|
| `shell` | Fixed argv templates from config. `{name}` items take a string param as one whole argv item. | No shell, no free-form commands; the program itself cannot be a param. |
| `claude-code` | Headless `claude -p --output-format json` in an allowed folder; prompt on stdin. | `--restricted --strict-mcp-config --add-dir <cwd>`: no Bash/REPL/WebFetch, file tools confined to the folder (verified live: `/etc/hosts` refused). Permission mode from config (`plan` default; `bypassPermissions` refused); `--permission-prompts none`; `--max-budget-usd` (default 2); absolute `cwd` only; `cwd_allow` required. |
| `http` | JSON POST to a fixed URL per command (e.g. a LilOS API). | Loopback or Tailscale (100.64.0.0/10) only; no redirects; secrets via `env:NAME` headers. |
| `mcp` | Tools of a local stdio MCP server (e.g. Grokbot), as `<runtime>.<tool>`. | Only tools listed in config are exposed; `readOnlyHint` suggests `auto`. |

New runtimes implement `RuntimeAdapter` (`commands`, `run`, optional `health`)
in one file.

## Config

`~/.config/muse/bridge.json` (mode 0600). Validation is strict: unknown keys
and bad values are errors. `muse bridge init` writes a safe starter: only a
read-only `full` command, Claude Code at `manual` with rules, and disabled
LilOS (`http`) and Grokbot (`mcp`) examples.

```json
{
  "display_name": "Muse bridge (my-mac)",
  "approval": { "channel": "macos", "timeout_seconds": 25 },
  "runtimes": {
    "claude-code": {
      "enabled": true,
      "options": { "permission_mode": "plan", "max_budget_usd": 2 },
      "commands": {
        "claude.ask": {
          "level": "manual",
          "rules": { "cwd_allow": ["~/Desktop/Oscar"], "per_hour": 5, "max_concurrent": 1, "max_seconds": 900 }
        }
      }
    }
  }
}
```

Several machines: give each bridge a distinct `display_name` (the starter
includes the hostname). The node id is derived from hostname + display name.

## Audit and kill switch

- Audit: `~/.config/muse/bridge-audit.jsonl` (0600), one line per invoke: time,
  command, level, decision, result, duration, and a SHA-256 digest of the
  params. Never params, prompts, results or secrets.
- `muse bridge stop` signals the bridge, waits for it to unregister from Muse,
  and force-kills it after 10 s. `muse bridge uninstall` removes the login item.
- `MUSE_BRIDGE_DEBUG=1` logs every gateway event name (no payloads).

## CLI

```
muse bridge init [--channel macos|terminal|muse] [--repo DIR] [--force]
muse bridge commands            what Muse will see, with each level and rules
muse bridge start [--config P]  connect and serve (foreground)
muse bridge stop                kill switch
muse bridge status | log [--tail N]
muse bridge install | uninstall launchd login item (macOS)
```

## Known limits

- Terms of service: this registers an unofficial client as a device. Opt-in,
  off until `muse bridge start`.
- Jobs live in memory; a bridge restart loses running jobs.
- `claude-code` cost is enforced by Claude's own `--max-budget-usd`; a single
  small call cost about $0.50 in testing.
