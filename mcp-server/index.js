#!/usr/bin/env node
/**
 * X4 Co-Captain MCP server — Phase 1 (read-only).
 *
 * Standalone stdio server that bridges Claude to the X4-External-App stack:
 *  - live telemetry via the app's REST API (fed by the in-game Lua extension)
 *  - fleet/station/blueprint data via the savegame SQLite database
 *  - await_events: a long-poll that diffs live snapshots so a co-captain
 *    loop can wait for something to happen instead of polling by hand
 *
 * Environment:
 *  X4_APP_URL  base URL of the running X4-External-App server (default http://127.0.0.1:8080)
 *  X4_DB_PATH  path to x4_savegame.db (default ../data/x4_savegame.db relative to this file)
 *
 * stdout carries the MCP protocol — all logging must go to stderr.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_URL = (process.env.X4_APP_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const DB_PATH = process.env.X4_DB_PATH || path.join(__dirname, "..", "data", "x4_savegame.db");

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

function assertReadOnlySql(sql) {
    const stripped = sql
        .replace(/--.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
    if (!/^(select|with)\b/i.test(stripped)) {
        throw new Error("Only SELECT / WITH queries are allowed (read-only database).");
    }
    if (/;[\s\S]*\S/.test(stripped)) {
        throw new Error("Only a single SQL statement is allowed.");
    }
    return stripped;
}

/* ------------------------------------------------------------ event differ */

// State persisted across await_events calls for the lifetime of this process.
const eventState = {
    initialized: false,
    gameOnline: null,
    credits: null,
    missionName: null,
    offerCount: null,
    latestSavegameId: null,
    logbookKeys: new Set(),
    factionRelations: new Map(),
};

const logbookKey = (entry) =>
    [entry?.passedtime, entry?.title, entry?.text, entry?.money].join("|");

function snapshotEvents(gameData, latestSavegame) {
    const events = [];
    const state = eventState;
    const online = gameData != null;

    if (state.initialized && online !== state.gameOnline) {
        events.push({ type: online ? "game_online" : "game_offline" });
    }
    state.gameOnline = online;

    if (online) {
        const credits = gameData.playerProfile?.credits;
        if (state.initialized && typeof credits === "number" &&
            typeof state.credits === "number" && credits !== state.credits) {
            events.push({
                type: "credits_changed",
                from: state.credits,
                to: credits,
                delta: credits - state.credits,
            });
        }
        if (typeof credits === "number") state.credits = credits;

        const missionName = gameData.activeMission?.name ?? gameData.activeMission?.title ?? null;
        if (state.initialized && missionName !== state.missionName) {
            events.push({ type: "active_mission_changed", from: state.missionName, to: missionName });
        }
        state.missionName = missionName;

        const offers = Array.isArray(gameData.missionOffers) ? gameData.missionOffers.length : null;
        if (state.initialized && offers != null && state.offerCount != null && offers !== state.offerCount) {
            events.push({ type: "mission_offers_changed", from: state.offerCount, to: offers });
        }
        if (offers != null) state.offerCount = offers;

        const logbook = Array.isArray(gameData.logbook) ? gameData.logbook : [];
        const newEntries = logbook.filter((entry) => !state.logbookKeys.has(logbookKey(entry)));
        if (state.initialized && newEntries.length > 0) {
            events.push({ type: "logbook_entries", count: newEntries.length, entries: newEntries.slice(0, 20) });
        }
        state.logbookKeys = new Set(logbook.map(logbookKey));

        const factions = Array.isArray(gameData.factions) ? gameData.factions : [];
        for (const faction of factions) {
            const name = faction?.factionname ?? faction?.name;
            const relation = faction?.relation ?? faction?.relationvalue ?? faction?.reputation;
            if (name == null || relation == null) continue;
            const previous = state.factionRelations.get(name);
            if (state.initialized && previous != null && previous !== relation) {
                events.push({ type: "faction_relation_changed", faction: name, from: previous, to: relation });
            }
            state.factionRelations.set(name, relation);
        }
    }

    const saveId = latestSavegame?.id ?? null;
    if (state.initialized && saveId != null && saveId !== state.latestSavegameId) {
        events.push({
            type: "savegame_parsed",
            savegame_id: saveId,
            filename: latestSavegame?.filename,
        });
    }
    if (saveId != null) state.latestSavegameId = saveId;

    state.initialized = true;
    return events;
}

/* ------------------------------------------------------------------ server */

const server = new McpServer({
    name: "x4-cocaptain",
    version: "0.1.0",
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
            "and game online/offline transitions. Returns as soon as something happens, or {quiet: true} " +
            "after the timeout. Call in a loop to act as a co-captain.",
        inputSchema: {
            timeout_seconds: z.number().int().min(2).max(240).default(60)
                .describe("How long to wait before returning quiet"),
        },
    },
    async ({ timeout_seconds }) => {
        const deadline = Date.now() + timeout_seconds * 1000;
        const startedAt = Date.now();

        while (true) {
            const { gameData } = await fetchLiveData();
            const latest = await fetchJson("/api/savegames/latest");
            const latestSavegame = latest.ok ? latest.data : null;

            const events = snapshotEvents(gameData, latestSavegame);
            const waited = Math.round((Date.now() - startedAt) / 1000);

            if (events.length > 0) {
                return jsonResult({ events, waited_seconds: waited });
            }
            if (Date.now() >= deadline) {
                return jsonResult({
                    quiet: true,
                    waited_seconds: waited,
                    game_online: eventState.gameOnline === true,
                });
            }
            await sleep(2000);
        }
    }
);

/* -------------------------------------------------------------------- main */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
    `x4-cocaptain MCP server running (app: ${APP_URL}, db: ${DB_PATH})`
);
