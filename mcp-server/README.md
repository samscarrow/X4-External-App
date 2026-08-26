# X4 Co-Captain MCP Server (Phase 1)

A standalone [MCP](https://modelcontextprotocol.io) server (stdio transport) that lets Claude act as a
co-captain for X4: Foundations by reading the data streams X4-External-App already collects:

| Source | Freshness | Tools |
|---|---|---|
| Live telemetry (`POST /api/data` from the in-game Lua extension) | seconds | `get_live_state`, `get_logbook`, `await_events` |
| Savegame SQLite DB (`data/x4_savegame.db`, filled by the watcher) | minutes (autosave cadence) | `get_fleet`, `get_stations`, `get_blueprints`, `list_savegames`, `get_db_schema`, `query_savegame_db` |

Phase 1 is **read-only** — no tool changes game state or writes to the database.

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
npm run smoke   # optional: lists tools and exercises a few calls
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `X4_APP_URL` | `http://127.0.0.1:8080` | Base URL of the running X4-External-App server |
| `X4_DB_PATH` | `../data/x4_savegame.db` (relative to this folder) | Savegame SQLite database |

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

> Call await_events in a loop. When events arrive, tell me only what matters
> (attacks, mission changes, big transactions) and give one-line advice. Stay quiet otherwise.

In Claude Code, the `/loop` command is a convenient way to keep that running.

## Tools

- `get_live_state [section]` — summary, or one of: `playerProfile`, `activeMission`, `missionOffers`, `logbook`, `playerGoals`, `currentResearch`, `transactionLog`, `factions`
- `get_logbook [limit] [search]` — recent logbook entries, filterable
- `await_events [timeout_seconds]` — long-poll for game events (see above)
- `list_savegames` — parsed savegames with metadata
- `get_fleet [savegame_id]` — ships from a savegame (defaults to latest)
- `get_stations [savegame_id]` — stations from a savegame
- `get_blueprints [savegame_id] [owned_only]` — known blueprints
- `get_db_schema` — tables/DDL of the savegame DB
- `query_savegame_db <sql> [max_rows]` — single read-only SELECT/WITH statement

## Roadmap

- **Phase 2**: server-side event severity tiers, richer diffing, text-to-speech output
- **Phase 3**: write path — command queue piggybacked on the Lua extension's POST cycle
  (in-game notifications, then structured commands)
- **Phase 4**: fleet orders via SirNukes Mod Support APIs / named pipes; encyclopedia tools
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
