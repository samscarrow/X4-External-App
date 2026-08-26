# Co-Captain Command Bridge Protocol

The write path that lets the co-captain talk back *inside* X4. The server side and MCP
tools are implemented and tested in this repo; the game side is a small patch to the
`mycu_external_app` extension (distributed separately via Nexus/Steam, not in this repo),
documented here for wiring up on the gaming machine.

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

## Game-side integration (to be wired on the gaming PC)

> **Status: sketch, not shipped.** The extension's Lua source isn't in this repo, and the
> exact function names below need validating against the installed mod and current game
> version (9.x has changed base Lua files repeatedly; mind Protected UI Mode). Once the
> extension files are available, this is a ~30-line change.

### 1. Lua: handle the POST response

In the extension's update loop, where the data POST completes, parse the body and forward
each command to Mission Director via a UI event, then ack:

```lua
-- after the /api/data POST returns `responseText`:
local ok, reply = pcall(function () return json.decode(responseText) end)
if ok and reply and reply.commands and #reply.commands > 0 then
    local ackIds = {}
    for _, command in ipairs(reply.commands) do
        -- Hand off to MD; UI Lua stays dumb, MD does game-state work
        AddUITriggeredEvent("CoCaptainBridge", command.type, command.payload)
        table.insert(ackIds, command.id)
    end
    -- POST /api/commands/ack with { ids = ackIds } using the same HTTP
    -- mechanism the extension uses for /api/data
end
```

### 2. Mission Director: execute commands

A small MD script (`md/cocaptain_bridge.xml` in the extension) listens for the UI events
and performs the visible action. MD is the right layer: it can write logbook entries, show
notifications, and later (Phase 4) issue real orders.

```xml
<?xml version="1.0" encoding="utf-8"?>
<mdscript name="CoCaptainBridge" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <cues>
    <cue name="OnNotify" instantiate="true">
      <conditions>
        <event_ui_triggered screen="'CoCaptainBridge'" control="'notify'" />
      </conditions>
      <actions>
        <show_notification caption="'Co-captain'" details="event.param3.{'text'}" />
      </actions>
    </cue>
    <cue name="OnLogbook" instantiate="true">
      <conditions>
        <event_ui_triggered screen="'CoCaptainBridge'" control="'logbook'" />
      </conditions>
      <actions>
        <write_to_logbook category="general"
                          title="event.param3.{'title'}"
                          text="event.param3.{'text'}" />
      </actions>
    </cue>
  </cues>
</mdscript>
```

(Exact attribute names for `show_notification`/`write_to_logbook` should be checked
against the game's `libraries/md.xsd` on the gaming PC.)

## Safety posture

- Command types are allowlisted server-side (`notify`, `logbook` only); unknown types are
  rejected at enqueue, so the MCP layer cannot smuggle arbitrary instructions to MD.
- Queue is capped at 20 pending so a missing bridge can't accumulate unbounded backlog.
- Phase 4 (real fleet orders) will extend the type allowlist deliberately, one command at
  a time, each with its own MD cue.
