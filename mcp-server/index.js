#!/usr/bin/env node
/**
 * X4 Co-Captain MCP server.
 *
 * Standalone stdio server that bridges Claude to the X4-External-App stack:
 *  - live telemetry via the app's REST API (fed by the in-game Lua extension)
 *  - fleet/station/blueprint data via the savegame SQLite database
 *  - await_events: a severity-tiered long-poll that diffs live snapshots so
 *    a co-captain loop can wait for something to happen instead of polling
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

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_URL = (process.env.X4_APP_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const DB_PATH = process.env.X4_DB_PATH || path.join(__dirname, "..", "data", "x4_savegame.db");

// Severity tuning (see README): credit deltas below NOTABLE are info,
// large losses at/above URGENT are urgent; logbook entries matching the
// combat pattern are urgent.
const CREDITS_NOTABLE = parseInt(process.env.X4_CREDITS_NOTABLE || "100000", 10);
const CREDITS_URGENT = parseInt(process.env.X4_CREDITS_URGENT || "1000000", 10);
const URGENT_LOGBOOK_PATTERN = new RegExp(
    process.env.X4_URGENT_REGEX ||
    "attack|under fire|destroy|hostile|boarding|emergency|distress",
    "i"
);

const SEVERITY_RANK = { info: 0, notable: 1, urgent: 2 };
const maxSeverity = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

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

// Upstream v3.6.1 accumulates logbook entries with stable ids; prefer that
// identity, fall back to content for older extensions.
const logbookKey = (entry) =>
    entry?.id != null
        ? `${entry.id}_${entry.time ?? ""}`
        : [entry?.passedtime, entry?.title, entry?.text, entry?.money].join("|");

function classifyLogbookEntry(entry) {
    const haystack = `${entry?.title ?? ""} ${entry?.text ?? ""}`;
    if (URGENT_LOGBOOK_PATTERN.test(haystack)) return "urgent";
    if (entry?.highlighted || Math.abs(entry?.money ?? 0) >= CREDITS_NOTABLE) return "notable";
    return "info";
}

function classifyCredits(delta) {
    if (delta <= -CREDITS_URGENT) return "urgent";
    if (Math.abs(delta) >= CREDITS_NOTABLE) return "notable";
    return "info";
}

function classifyRelation(from, to) {
    // A relation dropping into or further into negative territory means
    // shots may follow; everything else is worth a mention, not an alarm.
    if (to < 0 && to < from) return "urgent";
    return "notable";
}

function snapshotEvents(gameData, latestSavegame) {
    const events = [];
    const state = eventState;
    const online = gameData != null;

    if (state.initialized && online !== state.gameOnline) {
        events.push({
            type: online ? "game_online" : "game_offline",
            severity: online ? "info" : "notable",
        });
    }
    state.gameOnline = online;

    if (online) {
        const credits = gameData.playerProfile?.credits;
        if (state.initialized && typeof credits === "number" &&
            typeof state.credits === "number" && credits !== state.credits) {
            const delta = credits - state.credits;
            events.push({
                type: "credits_changed",
                severity: classifyCredits(delta),
                from: state.credits,
                to: credits,
                delta,
            });
        }
        if (typeof credits === "number") state.credits = credits;

        const missionName = gameData.activeMission?.name ?? gameData.activeMission?.title ?? null;
        if (state.initialized && missionName !== state.missionName) {
            events.push({
                type: "active_mission_changed",
                severity: "notable",
                from: state.missionName,
                to: missionName,
            });
        }
        state.missionName = missionName;

        const offers = Array.isArray(gameData.missionOffers) ? gameData.missionOffers.length : null;
        if (state.initialized && offers != null && state.offerCount != null && offers !== state.offerCount) {
            events.push({ type: "mission_offers_changed", severity: "info", from: state.offerCount, to: offers });
        }
        if (offers != null) state.offerCount = offers;

        const logbook = Array.isArray(gameData.logbook) ? gameData.logbook : [];
        const newEntries = logbook.filter((entry) => !state.logbookKeys.has(logbookKey(entry)));
        if (state.initialized && newEntries.length > 0) {
            const annotated = newEntries
                .slice(0, 20)
                .map((entry) => ({ ...entry, severity: classifyLogbookEntry(entry) }));
            events.push({
                type: "logbook_entries",
                severity: annotated.reduce((acc, entry) => maxSeverity(acc, entry.severity), "info"),
                count: newEntries.length,
                entries: annotated,
            });
        }
        state.logbookKeys = new Set(logbook.map(logbookKey));

        const factions = Array.isArray(gameData.factions) ? gameData.factions : [];
        for (const faction of factions) {
            const name = faction?.factionname ?? faction?.name;
            const relation = faction?.relation ?? faction?.relationvalue ?? faction?.reputation;
            if (name == null || relation == null) continue;
            const previous = state.factionRelations.get(name);
            if (state.initialized && previous != null && previous !== relation) {
                events.push({
                    type: "faction_relation_changed",
                    severity: classifyRelation(previous, relation),
                    faction: name,
                    from: previous,
                    to: relation,
                });
            }
            state.factionRelations.set(name, relation);
        }
    }

    const saveId = latestSavegame?.id ?? null;
    if (state.initialized && saveId != null && saveId !== state.latestSavegameId) {
        events.push({
            type: "savegame_parsed",
            severity: "info",
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
    version: "0.3.0",
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

        while (true) {
            const { gameData } = await fetchLiveData();
            const latest = await fetchJson("/api/savegames/latest");
            const latestSavegame = latest.ok ? latest.data : null;

            const all = snapshotEvents(gameData, latestSavegame);
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
                    game_online: eventState.gameOnline === true,
                });
            }
            await sleep(2000);
        }
    }
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
