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
| `POST /api/commands` `{type, payload}` | Enqueue (types: `notify`, `logbook`, `set_guidance`, `fly_my_ship_to`, `order_ship_to`, `clear_ship_orders`, `ping_ship`; queue cap 20) |
| `GET /api/commands` | `{pending, history}` with statuses |
| `POST /api/commands/ack` `{ids}` | Mark delivered commands executed |
| `DELETE /api/commands/:id` | Cancel a pending command |

The MCP tools `notify_player`, `write_logbook`, `set_guidance`, `get_command_queue`, and
`cancel_command` wrap these.

## Command types

| Type | Payload | Game-side effect |
|---|---|---|
| `notify` | `{text}` | Ticker notification (`show_notification`) |
| `logbook` | `{title, text}` | Logbook entry, category General (`write_to_logbook`) |
| `set_guidance` | `{sector?, x?, y?, z?}` or `{clear: true}` | HUD guidance via the **vanilla guidance system**: the bridge cue resolves the sector (macro id via dynamic `macro.{...}` lookup, or exact `knownname`; omitted = player's current sector) and signals `md.Guidance.NewTarget` with `[$Sector, $Offset]` — the same entry point vanilla scripts use, so mission display, path plotting, arrival auto-end, and cleanup are all stock behaviour. `x/y/z` are km offsets from sector centre; without them guidance targets the sector itself. `clear` signals `md.Guidance.EndGuidance`. Note: guidance shares the single active-mission slot — an active mission supersedes it (vanilla `GuidanceLost` aborts co-captain guidance when a mission takes the slot). |
| `fly_my_ship_to` | `{sector?, x?, y?, z?}` | Issues `MoveWait` ("Fly and Wait") with `immediate="true"` to `player.occupiedship` — the same order as the map's right-click move. Shares the `order_ship_to` MD cue (the Lua layer maps it to that control with no `ship` field). |
| `order_ship_to` | `{ship, sector?, x?, y?, z?}` | Generalised move order: any **player-owned** ship, resolved by `idcode` (e.g. `VYU-077`, unambiguous — preferred) or exact `knownname` (first match wins on collisions, with a ticker warning). Guards refuse, with an in-game notice, when the ship has no assigned NPC captain or the player is at its helm. Success posts a ticker notice + logbook audit entry (ship, captain, destination). **Watcher cues** then listen for `event_object_order_finished` / `event_object_order_cancelled` on that exact order and write arrival/cancellation to ticker + logbook — and since the events journal ingests logbook entries, the co-captain sees order completion via `await_events`. |
| `clear_ship_orders` | `{ship?}` | The undo: `cancel_all_orders` on a named own ship, or the ship the player is aboard when omitted. Ticker + logbook audit entry; the captain idles until given new orders. |
| `ping_ship` | `{ship}` | Locate an own ship: signals `md.Guidance.NewTarget` with the ship component, so the HUD marker **tracks the ship live** (vanilla handles the moving target and cleanup), and reports the ship's current sector in the ticker. HUD-only; subject to the same active-mission supersession as `set_guidance`. |

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

### Lua → MD table key convention (learned the hard way)

When a Lua table crosses into MD via `AddUITriggeredEvent`, **the engine prefixes every
string key with `$`**: Lua `{ ship = "VYU-077" }` arrives in MD as key `$ship`, readable
as `event.param3.{'$ship'}` (or `event.param3.$ship`). Reading `{'ship'}` fails with
`Property lookup failed: event.param3.ship` — visible only in `debug.log` (launch with
`-logfile debug.log`), while the Lua-side ack still reports `executed`. This bit every
command type at once on 2026-08-26: notifications silently showed nothing, logbook
writes failed, and `set_guidance` fell back to the player's current sector. Convention
confirmed against sn_mod_support_apis (`interact_menu_api.xml` reads
`event.param3.$id` for a plain Lua `id` key). Keep Lua keys **unprefixed** and MD
lookups **`$`-prefixed**.

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

## Fleet telemetry (read path)

Beyond commands, the bridge also feeds the co-captain live fleet data — no savegame
parsing involved. `CoCaptain_FleetSweep` (MD, every 30s) runs
`find_ship owner="faction.player"` and writes one entry per ship — `idcode`, `name`,
`size` S/M/L/XL, `purpose` fight/trade/mine/auxiliary/build/salvage/other, `hull`/
`shield` %, `sector` name, `x/y/z` km, `docked`, current `order` id, fleet `commander` —
to the player-entity blackboard var `$cocaptain_fleet`. `ui/ea.lua` reads it back with
`GetNPCBlackboard` (the MD `$` key prefix is stripped on the way into Lua — the reverse
of the write direction) and attaches it to the telemetry POST as `fleet`, using the
extension's own change-detection so it only transmits when the sweep changes (~every
30s). The server merges it into `/api/data`; the MCP `get_fleet` tool serves it with
purpose/sector/name filters, falling back to parsed-savegame ships when the live key is
absent. The `idcode` values are exactly what `order_ship_to` / `ping_ship` accept.

## Safety posture

- Command types are allowlisted server-side (see the table above); unknown types are
  rejected at enqueue, so the MCP layer cannot smuggle arbitrary instructions to MD.
- Queue is capped at 20 pending so a missing bridge can't accumulate unbounded backlog.
- Phase 5 (fleet orders) extends the type allowlist deliberately, keeping an
  advise-by-default posture: the co-captain only enqueues an order on the player's
  explicit ask. Landed 2026-08-26: `set_guidance` (HUD-only), `fly_my_ship_to` /
  `order_ship_to` (movement orders with MD-side guards, logbook audit trail, and
  arrival/cancellation feedback), `clear_ship_orders` (the undo), `ping_ship`
  (HUD-only locate). All ship commands are restricted to player-owned ships and refuse
  when the player is at the helm. Held deliberately: docking orders (station-name
  ambiguity), combat and trade orders (bigger posture conversation).
