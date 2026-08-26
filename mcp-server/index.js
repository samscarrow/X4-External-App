#!/usr/bin/env node
/**
 * X4 Co-Captain MCP server.
 *
 * Standalone stdio server that bridges Claude to the X4-External-App stack:
 *  - live telemetry via the app's REST API (fed by the in-game Lua extension)
 *  - fleet/station/blueprint data via the savegame SQLite database
 *  - a persistent events journal (diffed and written by the app server),
 *    tailed by await_events and queryable via search_events / summaries
 *  - a static game encyclopedia (ships, wares, modules, equipment, factions)
 *    extracted from the samscarrow/x4 repo - offline lookups and production
 *    chains via lib/encyclopedia.mjs and data/encyclopedia.json
 *  - speak: host text-to-speech so advice reaches the player while flying
 *  - write path: notify_player / write_logbook enqueue allowlisted commands
 *    that the in-game bridge executes (see ../game-extension/COMMAND_BRIDGE.md)
 *
 * See README.md for the environment variables (X4_APP_URL, X4_DB_PATH,
 * severity thresholds, TTS override).
 *
 * stdout carries the MCP protocol — all logging must go to stderr.
 */

import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { summarizeTransactions, summarizeEvents } from "./lib/summaries.mjs";
import { assertReadOnlySql } from "./lib/sqlGuard.mjs";
import {
    CATEGORIES,
    loadEncyclopedia,
    searchEncyclopedia,
    getEncyclopediaEntry,
    productionChain,
} from "./lib/encyclopedia.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_URL = (process.env.X4_APP_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const DB_PATH = process.env.X4_DB_PATH || path.join(__dirname, "..", "data", "x4_savegame.db");

// Severity tuning (thresholds live in utils/eventClassifier.js, applied by
// the app server when it writes the journal). The rank order is needed here
// for filtering.
const SEVERITY_RANK = { info: 0, notable: 1, urgent: 2 };

// Top-level keys the Lua extension POSTs to /api/data (see src/widgetConfig.js)
const LIVE_SECTIONS = [
    "playerProfile",
    "activeMission",
    "missionOffers",
    "logbook",
    "playerGoals",
    "currentResearch",
    "transactionLog",
    "factions",
    "inventory",
    "agents",
];

/* ------------------------------------------------------------------ helpers */

async function fetchJson(route, options = {}) {
    const url = `${APP_URL}${route}`;
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(5000),
            ...options,
        });
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = text;
        }
        return { ok: response.ok, status: response.status, data };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            error: `Cannot reach X4-External-App at ${url} (${error.message}). ` +
                `Is the app server running? Set X4_APP_URL if it listens elsewhere.`,
        };
    }
}

const jsonResult = (obj) => ({
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

const errorResult = (message) => ({
    content: [{ type: "text", text: message }],
    isError: true,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch the live game data object. Returns { gameData, error }.
 * gameData is null when the game / Lua extension hasn't posted yet.
 */
async function fetchLiveData() {
    const result = await fetchJson("/api/data");
    if (result.error) return { gameData: null, error: result.error };
    return { gameData: result.data ?? null, error: null };
}

async function resolveSavegameId(savegameId) {
    if (savegameId != null) return { id: savegameId, meta: null, error: null };
    const latest = await fetchJson("/api/savegames/latest");
    if (latest.error) return { id: null, meta: null, error: latest.error };
    if (!latest.ok) {
        return {
            id: null,
            meta: null,
            error: "No parsed savegames found yet. The watcher parses saves automatically " +
                "when X4_SAVEGAME_PATH is set, or trigger POST /api/savegames/parse-latest.",
        };
    }
    return { id: latest.data.id, meta: latest.data, error: null };
}

/* ------------------------------------------------------- savegame database */

let db = null;

function openDatabase() {
    if (db) return db;
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(
            `Savegame database not found at ${DB_PATH}. ` +
            `Run the X4-External-App server at least once (it creates the DB), ` +
            `or set X4_DB_PATH to its location.`
        );
    }
    const Database = require("better-sqlite3");
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    return db;
}

/* ---------------------------------------------------------- events journal */

// The app server diffs every game POST into a persistent events journal
// (SQLite, /api/events). This process only keeps a cursor.
let eventCursor = null;

async function fetchEvents(params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== "") query.set(key, String(value));
    }
    const result = await fetchJson(`/api/events?${query}`);
    if (result.error) return { error: result.error };
    if (result.status === 404) {
        return {
            error: "The app server has no /api/events endpoint — it predates the events journal. " +
                "Pull the latest X4-External-App and restart node server.js.",
        };
    }
    if (!result.ok) return { error: result.data?.error ?? `HTTP ${result.status}` };
    return { data: result.data };
}


/* ------------------------------------------------------------------ server */

const server = new McpServer({
    name: "x4-cocaptain",
    version: "0.5.0",
});

server.registerTool(
    "get_live_state",
    {
        title: "Get live game state",
        description:
            "Current in-game telemetry posted by the X4 Lua extension (updates every ~2s while the game runs). " +
            "Without arguments returns a compact summary plus the list of available sections. " +
            `Pass a section for full detail: ${LIVE_SECTIONS.join(", ")}.`,
        inputSchema: {
            section: z.enum(LIVE_SECTIONS).optional()
                .describe("Section of the live data object to return in full"),
        },
    },
    async ({ section }) => {
        const { gameData, error } = await fetchLiveData();
        if (error) return errorResult(error);
        if (!gameData) {
            return jsonResult({
                connected: false,
                message: "No live data yet — X4 is not running, or the mycu_external_app extension hasn't posted. " +
                    "Savegame tools still work.",
            });
        }
        if (section) {
            let value = gameData[section];
            if (Array.isArray(value) && value.length > 100) {
                value = { total: value.length, truncated_to: 100, items: value.slice(0, 100) };
            }
            return jsonResult({ section, data: value ?? null });
        }
        const summary = {
            connected: true,
            playerProfile: gameData.playerProfile ?? null,
            activeMission: gameData.activeMission?.name ?? gameData.activeMission?.title ?? null,
            counts: Object.fromEntries(
                LIVE_SECTIONS
                    .filter((key) => Array.isArray(gameData[key]))
                    .map((key) => [key, gameData[key].length])
            ),
            sections_present: LIVE_SECTIONS.filter((key) => gameData[key] != null),
        };
        return jsonResult(summary);
    }
);

server.registerTool(
    "get_logbook",
    {
        title: "Get logbook entries",
        description: "Recent in-game logbook entries from live telemetry, optionally filtered by a search string.",
        inputSchema: {
            limit: z.number().int().min(1).max(200).default(20)
                .describe("Maximum entries to return"),
            search: z.string().optional()
                .describe("Case-insensitive substring match on title, text, and faction"),
        },
    },
    async ({ limit, search }) => {
        const { gameData, error } = await fetchLiveData();
        if (error) return errorResult(error);
        const logbook = Array.isArray(gameData?.logbook) ? gameData.logbook : [];
        let entries = logbook;
        if (search) {
            const needle = search.toLowerCase();
            entries = entries.filter((entry) =>
                [entry?.title, entry?.text, entry?.factionname]
                    .some((field) => typeof field === "string" && field.toLowerCase().includes(needle))
            );
        }
        return jsonResult({
            total: logbook.length,
            matched: entries.length,
            entries: entries.slice(0, limit),
        });
    }
);

server.registerTool(
    "list_savegames",
    {
        title: "List parsed savegames",
        description: "All savegames the watcher has parsed into the database, with metadata (newest data wins).",
        inputSchema: {},
    },
    async () => {
        const result = await fetchJson("/api/savegames");
        if (result.error) return errorResult(result.error);
        return jsonResult(result.data);
    }
);

const savegameIdInput = {
    savegame_id: z.number().int().optional()
        .describe("Savegame DB id; defaults to the most recently parsed savegame"),
};

server.registerTool(
    "get_fleet",
    {
        title: "Get player fleet",
        description: "Player ships (name, class, type, sector, hull/shield health, commander) from a parsed savegame. " +
            "Note: savegame data lags the live game by up to one autosave interval.",
        inputSchema: savegameIdInput,
    },
    async ({ savegame_id }) => {
        const { id, meta, error } = await resolveSavegameId(savegame_id);
        if (error) return errorResult(error);
        const result = await fetchJson(`/api/savegames/${id}/ships`);
        if (result.error) return errorResult(result.error);
        return jsonResult({ savegame: meta ?? { id }, ship_count: result.data.length, ships: result.data });
    }
);

server.registerTool(
    "get_stations",
    {
        title: "Get player stations",
        description: "Player stations (name, sector, position, storage, workforce) from a parsed savegame.",
        inputSchema: savegameIdInput,
    },
    async ({ savegame_id }) => {
        const { id, meta, error } = await resolveSavegameId(savegame_id);
        if (error) return errorResult(error);
        const result = await fetchJson(`/api/savegames/${id}/stations`);
        if (result.error) return errorResult(result.error);
        return jsonResult({ savegame: meta ?? { id }, station_count: result.data.length, stations: result.data });
    }
);

server.registerTool(
    "get_blueprints",
    {
        title: "Get known blueprints",
        description: "Ship and station blueprints recorded in a parsed savegame.",
        inputSchema: {
            ...savegameIdInput,
            owned_only: z.boolean().default(false).describe("Return only owned blueprints"),
        },
    },
    async ({ savegame_id, owned_only }) => {
        const { id, meta, error } = await resolveSavegameId(savegame_id);
        if (error) return errorResult(error);
        const result = await fetchJson(`/api/savegames/${id}/blueprints`);
        if (result.error) return errorResult(result.error);
        let blueprints = result.data;
        if (owned_only) blueprints = blueprints.filter((bp) => bp.is_owned);
        return jsonResult({ savegame: meta ?? { id }, blueprint_count: blueprints.length, blueprints });
    }
);

server.registerTool(
    "get_db_schema",
    {
        title: "Get savegame DB schema",
        description: "Tables and CREATE statements of the savegame SQLite database — use before query_savegame_db.",
        inputSchema: {},
    },
    async () => {
        try {
            const database = openDatabase();
            const rows = database
                .prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name")
                .all();
            return jsonResult(rows);
        } catch (error) {
            return errorResult(error.message);
        }
    }
);

server.registerTool(
    "query_savegame_db",
    {
        title: "Query savegame database (read-only)",
        description: "Run a single read-only SELECT/WITH query against the savegame SQLite database " +
            "(tables: savegames, ships, stations, station_modules, inventory, blueprints). " +
            "Useful for historical/analytical questions across savegames.",
        inputSchema: {
            sql: z.string().describe("A single SELECT or WITH statement"),
            max_rows: z.number().int().min(1).max(2000).default(200)
                .describe("Row cap applied to the result"),
        },
    },
    async ({ sql, max_rows }) => {
        try {
            const database = openDatabase();
            const statement = database.prepare(assertReadOnlySql(sql));
            if (!statement.reader) {
                return errorResult("Statement returns no rows — only read queries are allowed.");
            }
            const rows = statement.all();
            return jsonResult({
                row_count: rows.length,
                truncated: rows.length > max_rows,
                rows: rows.slice(0, max_rows),
            });
        } catch (error) {
            return errorResult(`Query failed: ${error.message}`);
        }
    }
);

server.registerTool(
    "await_events",
    {
        title: "Wait for game events",
        description: "Long-poll for changes in the live game state: new logbook entries, credit changes, " +
            "active-mission changes, mission-offer changes, faction relation changes, newly parsed savegames, " +
            "and game online/offline transitions. Every event carries a severity (info < notable < urgent); " +
            "min_severity suppresses quieter events, which are counted but not returned. " +
            "Returns as soon as something qualifying happens, or {quiet: true} after the timeout. " +
            "Call in a loop to act as a co-captain.",
        inputSchema: {
            timeout_seconds: z.number().int().min(2).max(240).default(60)
                .describe("How long to wait before returning quiet"),
            min_severity: z.enum(["info", "notable", "urgent"]).default("info")
                .describe("Only return events at or above this severity"),
        },
    },
    async ({ timeout_seconds, min_severity }) => {
        const deadline = Date.now() + timeout_seconds * 1000;
        const startedAt = Date.now();
        let suppressed = 0;

        // First call in this process: start from the journal's tail so old
        // history isn't replayed (search_events covers the past).
        if (eventCursor == null) {
            const seed = await fetchEvents({ limit: 1 });
            if (seed.error) return errorResult(seed.error);
            eventCursor = seed.data.latest_id ?? 0;
        }

        while (true) {
            const page = await fetchEvents({ after_id: eventCursor, limit: 100 });
            if (page.error) return errorResult(page.error);
            const all = page.data.events;
            if (all.length > 0) {
                eventCursor = all[all.length - 1].id;
            }
            const events = all.filter(
                (event) => SEVERITY_RANK[event.severity] >= SEVERITY_RANK[min_severity]
            );
            suppressed += all.length - events.length;
            const waited = Math.round((Date.now() - startedAt) / 1000);

            if (events.length > 0) {
                return jsonResult({ events, suppressed_below_min_severity: suppressed, waited_seconds: waited });
            }
            if (Date.now() >= deadline) {
                return jsonResult({
                    quiet: true,
                    suppressed_below_min_severity: suppressed,
                    waited_seconds: waited,
                });
            }
            await sleep(2000);
        }
    }
);

server.registerTool(
    "search_events",
    {
        title: "Search event history",
        description: "Query the persistent events journal — every event the server has recorded across " +
            "sessions (X4 writes no journal of its own; this database is it). Filter by type, severity, " +
            "time range, and free text; newest first.",
        inputSchema: {
            type: z.string().optional()
                .describe("Comma-separated event types, e.g. 'logbook_entries,credits_changed'"),
            min_severity: z.enum(["info", "notable", "urgent"]).optional(),
            since: z.string().optional().describe("ISO timestamp lower bound (UTC), e.g. 2026-08-26T00:00:00Z"),
            until: z.string().optional().describe("ISO timestamp upper bound (UTC)"),
            q: z.string().optional().describe("Substring match against event payload"),
            limit: z.number().int().min(1).max(1000).default(50),
        },
    },
    async ({ type, min_severity, since, until, q, limit }) => {
        const result = await fetchEvents({ type, min_severity, since, until, q, limit });
        if (result.error) return errorResult(result.error);
        return jsonResult({ event_count: result.data.events.length, events: result.data.events });
    }
);

server.registerTool(
    "server_status",
    {
        title: "Get bridge health",
        description: "Health of the X4-External-App server: uptime, whether the game is posting data, " +
            "journal size, pending commands, parsed savegames.",
        inputSchema: {},
    },
    async () => {
        const result = await fetchJson("/api/status");
        if (result.error) return errorResult(result.error);
        if (!result.ok) return errorResult("App server has no /api/status endpoint — pull the latest and restart.");
        return jsonResult(result.data);
    }
);

/* ------------------------------------------------------- tailored summaries */

server.registerTool(
    "get_trading_summary",
    {
        title: "Summarize transactions (tailorable)",
        description: "Aggregate the accumulated in-game transaction log into a financial summary, shaped " +
            "per call: filter by direction, event type (e.g. 'trade', 'repair'), counterparty, amount, " +
            "in-game time range or newest-N; group by event_type, partner, or none; cap groups with top. " +
            "Use tight filters to answer specific questions ('income from station trades with TEL') " +
            "instead of dumping everything.",
        inputSchema: {
            direction: z.enum(["income", "expense", "all"]).default("all"),
            event_type: z.string().optional().describe("Substring match on the transaction's event type name"),
            partner: z.string().optional().describe("Substring match on the counterparty name"),
            q: z.string().optional().describe("Substring match on either field"),
            min_amount: z.number().optional().describe("Only transactions with |money| at least this"),
            since_time: z.number().optional().describe("Lower bound on the entry's in-game time value"),
            until_time: z.number().optional().describe("Upper bound on the entry's in-game time value"),
            newest: z.number().int().min(1).optional().describe("Only the N most recent entries"),
            group_by: z.enum(["event_type", "partner", "none"]).default("event_type"),
            top: z.number().int().min(1).max(50).default(10).describe("Max groups returned, ranked by |net|"),
        },
    },
    async (filters) => {
        const { gameData, error } = await fetchLiveData();
        if (error) return errorResult(error);
        const entries = gameData?.transactionLog;
        if (!Array.isArray(entries) || entries.length === 0) {
            return jsonResult({ matched: 0, message: "No transaction log data received from the game yet." });
        }
        return jsonResult(summarizeTransactions(entries, filters));
    }
);

server.registerTool(
    "get_activity_summary",
    {
        title: "Summarize recent activity",
        description: "Digest of the events journal over a time window: event counts by type and severity, " +
            "net credit flow, urgent incidents, and mission changes. Narrow with type/q the same way as " +
            "search_events when a focused digest is wanted (e.g. only combat, one faction).",
        inputSchema: {
            hours: z.number().min(0.1).max(720).default(24).describe("Look-back window in real hours"),
            type: z.string().optional().describe("Comma-separated event types to include"),
            q: z.string().optional().describe("Substring filter on event payloads"),
            top: z.number().int().min(1).max(50).default(10).describe("Max urgent events / mission changes listed"),
        },
    },
    async ({ hours, type, q, top }) => {
        const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const result = await fetchEvents({ since, type, q, limit: 1000 });
        if (result.error) return errorResult(result.error);
        return jsonResult({ window_hours: hours, since, ...summarizeEvents(result.data.events, { top }) });
    }
);

server.registerTool(
    "situation_report",
    {
        title: "Full situation report",
        description: "One compact briefing: player state, active mission, fleet health from the latest " +
            "savegame, recent notable events, and pending bridge commands. The right first call of a " +
            "co-captain session.",
        inputSchema: {},
    },
    async () => {
        const [{ gameData }, statusResult, saveResult, eventsResult, commandsResult] = await Promise.all([
            fetchLiveData(),
            fetchJson("/api/status"),
            fetchJson("/api/savegames/latest"),
            fetchEvents({ min_severity: "notable", limit: 10 }),
            fetchJson("/api/commands"),
        ]);

        const report = {
            bridge: statusResult.ok ? {
                game_online: statusResult.data.game_online,
                uptime_seconds: statusResult.data.uptime_seconds,
            } : { error: statusResult.error ?? "status unavailable" },
            player: gameData?.playerProfile ?? null,
            active_mission: gameData?.activeMission?.name ?? gameData?.activeMission?.title ?? null,
            mission_offers: Array.isArray(gameData?.missionOffers) ? gameData.missionOffers.length : null,
            recent_notable_events: eventsResult.error ? eventsResult.error : eventsResult.data.events,
            pending_commands: commandsResult.ok ? commandsResult.data.pending : null,
        };

        if (saveResult.ok && saveResult.data?.id != null) {
            const ships = await fetchJson(`/api/savegames/${saveResult.data.id}/ships`);
            if (ships.ok && Array.isArray(ships.data)) {
                const damaged = ships.data
                    .filter((ship) => typeof ship.hull_health === "number" && ship.hull_health < 70)
                    .sort((a, b) => a.hull_health - b.hull_health);
                report.fleet = {
                    savegame: { id: saveResult.data.id, filename: saveResult.data.filename, parsed_at: saveResult.data.parsed_at },
                    ship_count: ships.data.length,
                    damaged_count: damaged.length,
                    worst_damaged: damaged.slice(0, 5).map((ship) => ({
                        name: ship.ship_name, class: ship.ship_class, sector: ship.sector, hull: ship.hull_health,
                    })),
                };
            }
        } else {
            report.fleet = { message: "No parsed savegame yet." };
        }

        return jsonResult(report);
    }
);

/* ------------------------------------------------------------- encyclopedia */

function withEncyclopedia(fn) {
    return async (args) => {
        try {
            const bundle = loadEncyclopedia();
            return fn(bundle, args);
        } catch (error) {
            return errorResult(error.message);
        }
    };
}

server.registerTool(
    "encyclopedia_search",
    {
        title: "Search game encyclopedia",
        description: "Search the static X4 game database (offline, no game needed): ships, wares, station " +
            "modules, equipment, factions, races, ware groups. Substring query on name/id plus exact " +
            "filters. Returns compact rows; use encyclopedia_entry for full stats.",
        inputSchema: {
            category: z.enum(CATEGORIES),
            query: z.string().optional().describe("Substring match on name or id"),
            size: z.string().optional().describe("e.g. 'Large', 'Medium'"),
            type: z.string().optional().describe("Ship type ('Destroyer'), module type ('Production'), equipment type ('Engines')"),
            purpose: z.string().optional().describe("Ship purpose: Fight, Trade, Mine, Build, Auxiliary, Salvage"),
            race: z.string().optional().describe("Maker race id, e.g. 'argon', 'teladi'"),
            group: z.string().optional().describe("Ware group id, e.g. 'hightech'"),
            class: z.string().optional().describe("Equipment class, e.g. 'Turret', 'Shield Generator'"),
            limit: z.number().int().min(1).max(50).default(15),
        },
    },
    withEncyclopedia((bundle, args) => jsonResult(searchEncyclopedia(bundle, args.category, args)))
);

server.registerTool(
    "encyclopedia_entry",
    {
        title: "Get encyclopedia entry",
        description: "Full record for one entity by id or name: ship hulls/shields/engines, ware prices and " +
            "production recipes (plus what it's used in), module workforce and production, equipment stats, " +
            "faction lore.",
        inputSchema: {
            category: z.enum(CATEGORIES),
            id: z.string().describe("Entity id (e.g. 'ship_arg_l_destroyer_01_a', 'hullparts') or name ('Behemoth Vanguard')"),
        },
    },
    withEncyclopedia((bundle, { category, id }) => {
        const entry = getEncyclopediaEntry(bundle, category, id);
        if (!entry) return errorResult(`No ${category} entry matching '${id}'. Try encyclopedia_search first.`);
        return jsonResult(entry);
    })
);

server.registerTool(
    "production_chain",
    {
        title: "Compute production chain",
        description: "What it takes to produce a ware: the full recipe tree expanded down to raw resources, " +
            "plus flattened input totals. Useful for station planning ('what feeds a Hull Parts factory?').",
        inputSchema: {
            ware: z.string().describe("Ware id or name, e.g. 'hullparts' or 'Hull Parts'"),
            amount: z.number().min(1).default(1).describe("Units of the target ware"),
            method: z.string().default("default").describe("Preferred production method: default, teladi, argon, paranid, recycling"),
            max_depth: z.number().int().min(1).max(10).default(10),
        },
    },
    withEncyclopedia((bundle, { ware, amount, method, max_depth }) => {
        const chain = productionChain(bundle, ware, { amount, method, max_depth });
        if (!chain) return errorResult(`No ware matching '${ware}'. Try encyclopedia_search with category 'wares'.`);
        return jsonResult(chain);
    })
);

/* ------------------------------------------------------ write path (Phase 3) */

async function enqueueCommand(type, payload) {
    const result = await fetchJson("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, payload }),
    });
    if (result.error) return errorResult(result.error);
    if (!result.ok) return errorResult(result.data?.error ?? `Enqueue failed (HTTP ${result.status})`);
    return jsonResult({
        ...result.data,
        note: "Delivered to the game on its next data POST (~2s). 'executed' status requires " +
            "a command-bridge-aware extension (see game-extension/COMMAND_BRIDGE.md); with the " +
            "stock extension commands reach 'delivered' but are ignored in-game.",
    });
}

server.registerTool(
    "notify_player",
    {
        title: "Show in-game notification",
        description: "Queue a short notification to display inside X4 via the command bridge. " +
            "Use for co-captain callouts that should reach the player in-game rather than in chat. " +
            "Check get_command_queue if unsure the bridge is installed.",
        inputSchema: {
            text: z.string().min(1).max(500).describe("Notification text (keep it short)"),
        },
    },
    async ({ text }) => enqueueCommand("notify", { text })
);

server.registerTool(
    "write_logbook",
    {
        title: "Write player logbook entry",
        description: "Queue a logbook entry to be written inside X4 via the command bridge — " +
            "a durable co-captain note the player can read later in the in-game logbook.",
        inputSchema: {
            title: z.string().min(1).max(100).describe("Entry title"),
            text: z.string().min(1).max(1000).describe("Entry body"),
        },
    },
    async ({ title, text }) => enqueueCommand("logbook", { title, text })
);

server.registerTool(
    "get_command_queue",
    {
        title: "Inspect command queue",
        description: "Pending commands awaiting delivery to the game, and recent history with statuses " +
            "(pending → delivered → executed once the in-game bridge acknowledges; cancelled). " +
            "Commands stuck at 'delivered' mean the game extension isn't executing the bridge protocol.",
        inputSchema: {},
    },
    async () => {
        const result = await fetchJson("/api/commands");
        if (result.error) return errorResult(result.error);
        return jsonResult(result.data);
    }
);

server.registerTool(
    "cancel_command",
    {
        title: "Cancel pending command",
        description: "Remove a not-yet-delivered command from the queue by id.",
        inputSchema: {
            id: z.number().int().describe("Command id from notify_player/write_logbook/get_command_queue"),
        },
    },
    async ({ id }) => {
        const result = await fetchJson(`/api/commands/${id}`, { method: "DELETE" });
        if (result.error) return errorResult(result.error);
        if (!result.ok) return errorResult(result.data?.error ?? `Cancel failed (HTTP ${result.status})`);
        return jsonResult(result.data);
    }
);

/* --------------------------------------------------------------------- TTS */

const execFileAsync = promisify(execFile);

async function commandExists(cmd) {
    try {
        await execFileAsync(process.platform === "win32" ? "where" : "which", [cmd]);
        return true;
    } catch {
        return false;
    }
}

async function speakText(text, rate, voice) {
    // User-supplied engine wins: X4_TTS_COMMAND is argv-style JSON or a plain
    // command name; "{text}" placeholders are replaced, otherwise text is
    // appended as the final argument.
    const custom = process.env.X4_TTS_COMMAND;
    if (custom) {
        let argv;
        try {
            argv = JSON.parse(custom);
        } catch {
            argv = [custom];
        }
        if (!Array.isArray(argv) || argv.length === 0) {
            throw new Error("X4_TTS_COMMAND must be a command name or a JSON array of command + args");
        }
        let substituted = false;
        argv = argv.map((arg) => {
            if (typeof arg === "string" && arg.includes("{text}")) {
                substituted = true;
                return arg.replaceAll("{text}", text);
            }
            return arg;
        });
        if (!substituted) argv.push(text);
        await execFileAsync(argv[0], argv.slice(1), { timeout: 60000 });
        return `custom (${argv[0]})`;
    }

    if (process.platform === "win32") {
        const psText = text.replace(/'/g, "''");
        const psVoice = voice ? voice.replace(/'/g, "''") : null;
        const script = [
            "Add-Type -AssemblyName System.Speech;",
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
            `$s.Rate = ${rate};`,
            psVoice ? `try { $s.SelectVoice('${psVoice}') } catch {};` : "",
            `$s.Speak('${psText}');`,
        ].join(" ");
        await execFileAsync("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { timeout: 60000 });
        return "windows-sapi";
    }

    if (process.platform === "darwin") {
        const args = voice ? ["-v", voice, text] : [text];
        await execFileAsync("say", args, { timeout: 60000 });
        return "macos-say";
    }

    for (const engine of ["spd-say", "espeak"]) {
        if (await commandExists(engine)) {
            const args = engine === "spd-say" ? ["--wait", text] : [text];
            await execFileAsync(engine, args, { timeout: 60000 });
            return engine;
        }
    }
    throw new Error(
        "No TTS engine found. On Windows this uses PowerShell SAPI automatically; " +
        "on Linux install spd-say or espeak, or set X4_TTS_COMMAND."
    );
}

server.registerTool(
    "speak",
    {
        title: "Speak text aloud",
        description: "Read short co-captain advice aloud through the host machine's text-to-speech " +
            "(Windows SAPI via PowerShell; macOS say; Linux spd-say/espeak; or the X4_TTS_COMMAND override). " +
            "Use for time-critical or hands-off-keyboard moments while the player is flying; keep it to a sentence or two.",
        inputSchema: {
            text: z.string().min(1).max(1000).describe("What to say"),
            rate: z.number().int().min(-10).max(10).default(1)
                .describe("Speech rate (Windows SAPI scale; ignored by engines without rate support)"),
            voice: z.string().optional()
                .describe("Voice name, e.g. 'Microsoft Zira Desktop' (best-effort; engine default when omitted)"),
        },
    },
    async ({ text, rate, voice }) => {
        try {
            const engine = await speakText(text, rate, voice);
            return jsonResult({ spoken: true, engine, characters: text.length });
        } catch (error) {
            return errorResult(`TTS failed: ${error.message}`);
        }
    }
);

/* -------------------------------------------------------------------- main */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
    `x4-cocaptain MCP server running (app: ${APP_URL}, db: ${DB_PATH})`
);
