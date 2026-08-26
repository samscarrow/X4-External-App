# X4 Co-Captain MCP Server

A standalone [MCP](https://modelcontextprotocol.io) server (stdio transport) that lets Claude act as a
co-captain for X4: Foundations by reading the data streams X4-External-App already collects:

| Source | Freshness | Tools |
|---|---|---|
| Live telemetry (`POST /api/data` from the in-game Lua extension) | seconds | `get_live_state`, `get_logbook`, `await_events` |
| Savegame SQLite DB (`data/x4_savegame.db`, filled by the watcher) | minutes (autosave cadence) | `get_fleet`, `get_stations`, `get_blueprints`, `list_savegames`, `get_db_schema`, `query_savegame_db` |
| Persistent events journal (`events` table, written by the app server on every game POST) | seconds, survives restarts | `await_events`, `search_events`, `get_activity_summary`, `server_status` |
| Tailored aggregations over live data | seconds | `get_trading_summary`, `situation_report` |
| Host machine text-to-speech | — | `speak` |
| Command queue → in-game bridge (`../game-extension/COMMAND_BRIDGE.md`) | next data POST (~2s) | `notify_player`, `write_logbook`, `get_command_queue`, `cancel_command` |

Reading tools never change game state. The write path goes through a server-side command
queue with an allowlist of command types (`notify`, `logbook`); commands only take effect
in-game once the command bridge is wired into the Lua extension (see
`../game-extension/COMMAND_BRIDGE.md`) — until then they park at `delivered` status,
visible in `get_command_queue`.

## Prerequisites

- Node.js 18+ (the parent app already requires Node 16+; use 18+ here for global `fetch`)
- X4-External-App server running (`node server.js` in the repo root) with:
  - the `mycu_external_app` extension installed in X4 (for live telemetry)
  - `X4_SAVEGAME_PATH` set in `.env` (for savegame data)

The server degrades gracefully: tools whose data source is unavailable return an explanatory
message instead of failing, so you can register it before everything is wired up.

## Install

```bash
cd mcp-server
npm install
npm test        # unit tests (classifier, summaries, SQL guard)
npm run smoke   # optional: lists tools and exercises a few calls
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `X4_APP_URL` | `http://127.0.0.1:8080` | Base URL of the running X4-External-App server |
| `X4_DB_PATH` | `../data/x4_savegame.db` (relative to this folder) | Savegame SQLite database |
| `X4_CREDITS_NOTABLE` | `100000` | Credit delta (abs) at which a change becomes `notable` |
| `X4_CREDITS_URGENT` | `1000000` | Credit **loss** at which a change becomes `urgent` |
| `X4_URGENT_REGEX` | `attack\|under fire\|destroy\|hostile\|boarding\|emergency\|distress` | Logbook pattern (case-insensitive) that marks an entry `urgent` |
| `X4_TTS_COMMAND` | *(platform default)* | TTS override: a command name, or a JSON array of command + args; `{text}` placeholders are substituted, otherwise the text is appended as the last argument |

## Events journal

X4 writes no journal files of its own, so the app server *is* the journal: on every game
POST it diffs the snapshot against the last (`utils/eventClassifier.js`), classifies the
changes, and persists them to the `events` table in SQLite. Events survive restarts of
both the game and the MCP server; a watchdog records `game_offline`/`game_online`
transitions when posting stops or resumes. `await_events` tails the journal with a cursor
(starting at the tail — use `search_events` for the past), so no event is lost even while
no co-captain loop is running.

## Event severity

Every event from `await_events` carries a severity — `info` < `notable` < `urgent` — and the
tool takes `min_severity` to suppress the quiet stuff (suppressed events are counted in the
response, never silently lost):

| Event | Severity |
|---|---|
| `logbook_entries` | per entry: `urgent` on combat pattern match, `notable` if highlighted or money ≥ notable threshold, else `info`; the event takes the max |
| `credits_changed` | `urgent` on a loss ≥ urgent threshold, `notable` on \|delta\| ≥ notable threshold, else `info` |
| `faction_relation_changed` | `urgent` when the relation drops while negative (shots may follow), else `notable` |
| `active_mission_changed`, `game_offline` | `notable` |
| `mission_offers_changed`, `savegame_parsed`, `game_online` | `info` |

## Text-to-speech (`speak`)

`speak` reads a sentence or two aloud on the machine running the MCP server, so advice reaches
you while you fly without alt-tabbing:

- **Windows**: PowerShell + System.Speech (SAPI) — works out of the box; optional `voice`
  (e.g. `Microsoft Zira Desktop`) and `rate` (−10…10)
- **macOS**: `say`; **Linux**: `spd-say` or `espeak` if installed
- Anything else: set `X4_TTS_COMMAND`, e.g. `["wsl-notify-send.exe","{text}"]`

## Register with Claude Code (Windows)

From any terminal:

```powershell
claude mcp add x4-cocaptain -- node "C:\path\to\X4-External-App\mcp-server\index.js"
```

With a non-default port:

```powershell
claude mcp add x4-cocaptain --env X4_APP_URL=http://127.0.0.1:8081 -- node "C:\path\to\X4-External-App\mcp-server\index.js"
```

(For Claude Desktop, add the equivalent `command`/`args`/`env` block to `claude_desktop_config.json`.)

## Using it as a co-captain

One-off questions while playing:

> What's my current situation? Any mission offers worth taking given my fleet?

> Which of my ships are below 60% hull, and where are they?

Analytical questions hit the SQLite DB (`query_savegame_db` + `get_db_schema`):

> How has my credit balance trended across the last ten savegames?

Near-real-time loop — `await_events` blocks until something happens (new logbook entries,
credit deltas, mission changes, faction relation changes, newly parsed savegames), so a
prompt like this makes Claude sit in the copilot seat:

> Call await_events with min_severity "notable" in a loop. Speak urgent events aloud with
> the speak tool in one short sentence; summarize notable ones in text with one line of
> advice. Stay quiet otherwise.

In Claude Code, the `/loop` command is a convenient way to keep that running.

## Tools

- `get_live_state [section]` — summary, or one of: `playerProfile`, `activeMission`, `missionOffers`, `logbook`, `playerGoals`, `currentResearch`, `transactionLog`, `factions`
- `get_logbook [limit] [search]` — recent logbook entries, filterable
- `await_events [timeout_seconds] [min_severity]` — long-poll new journal events (see above)
- `search_events [type] [min_severity] [since] [until] [q] [limit]` — query the persistent event history
- `get_trading_summary [filters...]` — tailored transaction aggregation: direction, event_type, partner, q, min_amount, since_time/until_time, newest, group_by (event_type/partner/none), top
- `get_activity_summary [hours] [type] [q] [top]` — windowed digest of the journal: counts, credit flow, urgent incidents, mission changes
- `situation_report` — one compact briefing (player, mission, fleet health, notable events, pending commands)
- `server_status` — bridge health: uptime, game online, journal size, queue depth
- `speak <text> [rate] [voice]` — read advice aloud via host TTS
- `notify_player <text>` — queue an in-game notification (via command bridge)
- `write_logbook <title> <text>` — queue an in-game logbook entry (via command bridge)
- `get_command_queue` — pending/delivered/executed command statuses
- `cancel_command <id>` — cancel a not-yet-delivered command
- `list_savegames` — parsed savegames with metadata
- `get_fleet [savegame_id]` — ships from a savegame (defaults to latest)
- `get_stations [savegame_id]` — stations from a savegame
- `get_blueprints [savegame_id] [owned_only]` — known blueprints
- `get_db_schema` — tables/DDL of the savegame DB
- `query_savegame_db <sql> [max_rows]` — single read-only SELECT/WITH statement

## Roadmap

- ~~**Phase 1**: read-only tools + `await_events` long-poll~~ ✓
- ~~**Phase 2**: event severity tiers, id-based logbook diffing, text-to-speech output~~ ✓
- **Phase 3**: write path — command queue piggybacked on the Lua extension's POST cycle ✓
  (server + MCP tools done; in-game Lua/MD wiring documented in
  `../game-extension/COMMAND_BRIDGE.md`, to be validated on the gaming PC)
- ~~**Phase 4a**: persistent events journal + `search_events`, tailored trading/activity
  summaries, `situation_report`, `server_status`, inventory/agents live sections, unit tests~~ ✓
- **Phase 4b**: fleet orders via the command bridge / SirNukes APIs; encyclopedia tools
  backed by the static X4 database

## Troubleshooting

- **"Cannot reach X4-External-App"** — start the app server (`node server.js`), or point
  `X4_APP_URL` at the right host/port (the app may auto-shift ports if 8080 is taken —
  its console prints the actual port).
- **"No live data yet"** — X4 isn't running or the `mycu_external_app` extension isn't
  installed/posting; savegame tools still work.
- **"Savegame database not found"** — run the app server once (it creates the DB), or set
  `X4_DB_PATH`.
- **better-sqlite3 install issues on Windows** — it ships prebuilt binaries for LTS Node;
  if your Node version has none, install the current LTS or the VS Build Tools.
