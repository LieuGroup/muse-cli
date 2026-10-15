# Muse-cli — Agent Guide

Clean-room client for **Muse** (`muse.ai`, Meta's personal AI agent, codename
"Hatch") so Oscar's agents (Claude, LilOS employees) can drive it from a
terminal or over MCP. `CLAUDE.md` is a symlink to this file; edit `AGENTS.md`.

## Layout (Bun monorepo)

| Path | Purpose |
|---|---|
| `packages/muse-core` | npm `muse-agent-core`. SDK: Noise XX transport, HTTP-over-Noise envelope, session/auth, gateway client, `ask()`, RPC catalog |
| `packages/muse-cli` | npm `muse-agent-cli`, binary `muse` (renders from core) |
| `packages/muse-mcp` | npm `muse-agent-mcp`, binary `muse-mcp` (renders from core) |
| `reference/` | **Gitignored.** Meta source recovered from public source maps. Read-only study material |

Dependencies are one-way: `muse-cli` and `muse-mcp` import `muse-core`, never
the reverse. The CLI resolves `muse-core` through its `dist/`, so rebuild core
(`bun run build`) before running the CLI from source.

## How Muse works (verified)

1. Auth is the user's own muse.ai browser session (`hatch_sess` cookie).
2. `GET /api/session?vm_state=live` lists the account's agent VM(s).
3. `POST /api/hatch/token {vmAddress, vmName}` mints a per-VM `vm_auth_token`.
4. `wss://hatch.metaaivm.com/v1/noise?vm_id&auth_token&app_id=hatch-web&request_id`
   then a `Noise_XX_25519_AESGCM_SHA256` handshake.
5. Each RPC is an HTTP request (verb + path) wrapped in protobuf frames. The
   333-method map is in `muse-core/src/rpc-catalog.generated.ts`.
6. Streams (`chat.stream`, `*.subscribe`) are NDJSON: an ack line, then
   `{type:"event",event,payload}` lines (`delta.text_append`, `delta.message_done`, …).
7. `/api/*` calls need same-origin fetch metadata (`Sec-Fetch-Site: same-origin`…)
   or they return 403.
8. A reply's `reply_to_message_id` is empty. Match a turn by session scope, the
   `message.user` echo of our `message_id`, then the next main-lane
   `delta.message_start` (see `turn-tracker.ts`). `delta.message_done` carries a
   `transcript` with the final text.
9. VM file paths are relative to `/home/hatch`; absolute paths are rejected.
10. Generated media arrives as `delta.presentation` (kinds image/audio/file/video/slides…)
    with `sandbox://` paths; download bytes with `fs.raw` (binary). Images land in
    `workspace/imagine_media`, podcasts in `workspace/podcasts/<slug>/`, documents in
    `workspace/your_files/`. `artifacts.list` takes `collection` + `first` (not `limit`).
11. Video generation is region-locked (unavailable in AU as of Oct 2026).
12. Browser: `computer.context` lists live browser tasks (`browser_task_id`,
    `current_site`, `latest_screenshot` sandbox path). The VM runs Chrome on X
    display `:98`, 1920x1080. `browser_task.present` then `browser_stream.attach`
    (`/api/browser-task/{id}/websockify?mode=attach`, request body left open) is
    a raw RFB 3.8 stream, security type None. `vnc-bridge.ts` exposes it on a
    loopback TCP port. Attaching does not take control; `browser_task.takeover`
    / `release` do. `lease_info`, `lease_overrides`, `local_testing` are
    Meta-internal only.
13. The VM ships Muse's own guides in `~/docs/*.md` (copied to `reference/muse-docs/`):
    the authoritative description of features, limits and device capabilities.
14. Devices: the Muse Mac app (`com.meta.endo`, native Swift + bundled Hatch web UI)
    and iOS app register as nodes. `node.list` returns each node's `online`,
    `enabled_permissions` and `commands_v2` (description, `permission_required`,
    `required`/`optional` params). The agent invokes them; the CLI can only list
    them (`muse nodes`). Mac commands cover computer use, iMessage, Mail, Notes,
    files, calendar, reminders, contacts; `system.run` and `browser.proxy` are retired.

Confidential VMs (CVM: SEV-SNP attestation + PIN-derived key) are **not**
supported. The client detects a CVM and stops with exit code 4.

## Commands

- `bun run verify`: Biome, `tsc -b`, Vitest, build. Must pass before you hand off.
- `bun run gen:catalog`: regenerate the RPC catalog from `reference/` (only if it exists locally).
- Live smoke check (read-only): `muse status` (Chrome cookie is the macOS default).
- Local install: `~/.bun/bin/muse` is a wrapper that runs `packages/muse-cli/src/cli.ts`;
  rebuild core (`bun run --cwd packages/muse-core build`) after changing it.
- Test sends only in a throwaway thread: `muse threads new "test"` then `muse ask "…" --thread <id>`,
  and archive it afterwards.

## Hard rules

- **Never commit or publish `reference/`.** Production code is original. Do not paste Meta source into `packages/`.
- **Zero secret leaks.** Never print, log, or commit cookies, `vm_auth_token`, notary tokens, or the WS URL (it carries the token).
- **Safety tags.** Methods tagged `destructive` or `sensitive` need Oscar's explicit OK (`--allow-unsafe` / `allow_unsafe`).
- **Don't spam the live agent.** Send real `ask` messages only when testing send/stream code.
- Reply to Oscar in the language he writes in. Code, comments, and docs are in English. Use conventional commits, and commit only when asked.
