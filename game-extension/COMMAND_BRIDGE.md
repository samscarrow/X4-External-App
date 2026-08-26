# Co-Captain Command Bridge Protocol

The write path that lets the co-captain talk back *inside* X4. The server side and MCP
tools are implemented and tested in this repo. The game side is a small patch to the
`mycu_external_app` extension, shipped in this repo under
`game-extension/mycu_external_app/` and installed with `game-extension/install-bridge.ps1`
(re-run it after updating the mod from Nexus/GitHub — updates overwrite the patched
`ui\ea.lua`).

## How it works

The in-game Lua extension already POSTs telemetry to `/api/data` every ~2 seconds and
ignores the response. The server now replies with JSON instead of `ok`:

```json
{ "status": "ok", "commands": [
    { "id": 7, "type": "notify",  "payload": { "text": "Miner under attack in Hatikvah's Choice" } },
    { "id": 8, "type": "logbook", "payload": { "title": "Co-captain", "text": "Recommended pulling the miner back to Argon Prime." } }
] }
```

The stock extension is unaffected (it never reads the body). A bridge-aware extension:

1. Parses the response of its own data POST.
2. Executes each command (see mapping below).
3. Acknowledges: `POST /api/commands/ack` with body `{ "ids": [7, 8] }`.

Command lifecycle on the server: `pending` → `delivered` (handed out in a POST response)
→ `executed` (acked by the game). `cancelled` if removed before delivery. Delivery is
at-most-once; unacked commands stay visible as `delivered` in `GET /api/commands` so a
missing bridge is diagnosable rather than silent.

## Server API

| Endpoint | Purpose |
|---|---|
| `POST /api/commands` `{type, payload}` | Enqueue (types: `notify`, `logbook`; queue cap 20) |
| `GET /api/commands` | `{pending, history}` with statuses |
| `POST /api/commands/ack` `{ids}` | Mark delivered commands executed |
| `DELETE /api/commands/:id` | Cancel a pending command |

The MCP tools `notify_player`, `write_logbook`, `get_command_queue`, and `cancel_command`
wrap these.

## Game-side integration (implemented)

> **Status: implemented and schema-validated.** The files live in
> `game-extension/mycu_external_app/` (based on mycu_external_app v361 / app v3.6.1) and
> are copied over the installed mod by `install-bridge.ps1`. Action names and attributes
> were validated against `libraries/md.xsd` + `libraries/common.xsd` extracted from the
> game's 08.cat (X4 v9.x). Protected UI Mode must be disabled (djfhe_http loads DLLs).

### 1. Lua: handle the POST response (`ui/ea.lua`)

The stock extension already ends every telemetry cycle with the `/api/data` POST callback.
The patch adds three functions and one call in that callback:

- `external.handleServerReply(response)` — `response:getJson()` (djfhe_http's parsed
  body), iterate `reply.commands`, collect executed ids, ack.
- `external.executeCommand(command)` — per-type validation and dispatch:
  `AddUITriggeredEvent("CoCaptainBridge", "notify"|"logbook", payloadTable)`. Commands
  with missing/invalid payloads (or unknown types) are **not acked**, so they stay
  `delivered` on the server and are diagnosable via `get_command_queue`.
- `external.ackCommands(ids)` — `POST /api/commands/ack` with `{ ids = ... }` using the
  same djfhe_http request API as the data POST (tables are JSON-encoded with
  `Content-Type: application/json` automatically).

### 2. Mission Director: execute commands (`md/cocaptain_bridge.xml`)

Listens for the UI events and performs the visible action. MD is the right layer: it can
write logbook entries, show notifications, and later (Phase 5) issue real orders.

Actual schema-validated actions (the originally sketched
`show_notification caption=... details=...` does **not** exist in the game schema):

```xml
<cue name="CoCaptain_OnNotify" instantiate="true">
  <conditions>
    <event_ui_triggered screen="'CoCaptainBridge'" control="'notify'" />
  </conditions>
  <actions>
    <show_notification text="event.param3.{'text'}" />
  </actions>
</cue>
<cue name="CoCaptain_OnLogbook" instantiate="true">
  <conditions>
    <event_ui_triggered screen="'CoCaptainBridge'" control="'logbook'" />
  </conditions>
  <actions>
    <write_to_logbook category="general" title="event.param3.{'title'}" text="event.param3.{'text'}" />
  </actions>
</cue>
```

`show_notification` accepts `text` (required) plus optional `timeout`, `priority`,
`sound`; `write_to_logbook` requires `category` (one of general/missions/news/upkeep/
diplomacy/alerts) and `title`. `event.param3` carries the Lua payload table.

## Safety posture

- Command types are allowlisted server-side (`notify`, `logbook` only); unknown types are
  rejected at enqueue, so the MCP layer cannot smuggle arbitrary instructions to MD.
- Queue is capped at 20 pending so a missing bridge can't accumulate unbounded backlog.
- Phase 5 (real fleet orders) will extend the type allowlist deliberately, one command at
  a time, each with its own MD cue, keeping an advise-by-default posture: the co-captain
  only enqueues an order on the player's explicit ask.
