const fs = require('fs');
const path = require('path');
const dotenvAbsolutePath = path.join(__dirname, '.env');
require('dotenv').config({ path: dotenvAbsolutePath });
const net = require("node:net");

const bodyParser = require('body-parser');
const express = require('express');
const app = express();

const hostname = process.env.APP_HOST || '127.0.0.1';
const port = process.env.APP_PORT || 8080;

const chalk = require('chalk');
const { version } = require("./package.json");
const { normalizeObjectRecursively } = require('./utils/textProcessor');

const isPackaged = !!process.pkg;
const runtimeDir = isPackaged ? path.dirname(process.execPath) : __dirname;
const devFilePath = path.join(runtimeDir, 'dev-data.json');

// Import savegame services
const DatabaseService = require('./services/database');
const SavegameParser = require('./services/savegameParser');
const SavegameWatcher = require('./services/savegameWatcher');
const { EventDiffer } = require('./utils/eventClassifier');

// Game considered offline after this long without a data POST
const GAME_STALE_MS = 15000;

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Command types the co-captain may enqueue for the in-game bridge
const ALLOWED_COMMAND_TYPES = [
    'notify', 'logbook', 'set_guidance', 'fly_my_ship_to',
    'order_ship_to', 'clear_ship_orders', 'ping_ship', 'set_weapons_hold',
    'get_ship_loadout', 'rekit_ship',
];
const COMMAND_QUEUE_LIMIT = 20;
const COMMAND_HISTORY_LIMIT = 100;

class Server {
    dataObject = null;
    updatePending = false;
    lastOutputMessage = null;
    db = null;
    savegameParser = null;
    savegameWatcher = null;
    commandQueue = [];
    commandHistory = [];
    nextCommandId = 1;
    differ = new EventDiffer();
    lastPostAt = null;
    startedAt = Date.now();

    constructor (app, hostname, port) {
        this.app = app;
        this.hostname = hostname;
        this.port = port;

        // Initialize savegame services
        this.initializeSavegameServices();
    }

    /**
     * Initialize savegame parsing services
     */
    initializeSavegameServices() {
        try {
            // Initialize database
            this.db = new DatabaseService();
            this.db.init();

            // Initialize parser
            this.savegameParser = new SavegameParser(this.db);

            // Initialize watcher if savegame path is configured
            const savegamePath = process.env.X4_SAVEGAME_PATH;
            if (savegamePath && fs.existsSync(savegamePath)) {
                this.savegameWatcher = new SavegameWatcher(this.savegameParser, savegamePath);
                this.savegameWatcher.start();
                this.outputMessage(chalk.green(`✓ Watching savegames at: ${savegamePath}`));
            } else {
                this.savegameWatcher = new SavegameWatcher(this.savegameParser);
                if (!savegamePath) {
                    this.outputMessage(chalk.yellow('X4_SAVEGAME_PATH not set in .env - savegame auto-parsing disabled'));
                    this.outputMessage(chalk.yellow('Set X4_SAVEGAME_PATH in .env to enable automatic savegame parsing'));
                }
            }
        } catch (error) {
            console.error(chalk.red('Failed to initialize savegame services:'), error);
        }
    }

    /**
     * Merge new entries into existing ones, deduplicating by key and sorting by time (newest first)
     */
    mergeEntries (existing, incoming, key) {
        if (!existing || !Array.isArray(existing)) {
            return incoming;
        }

        const compositeKey = (entry) => `${entry[key]}_${entry.time}`;

        const map = new Map();
        for (const entry of existing) {
            map.set(compositeKey(entry), entry);
        }
        for (const entry of incoming) {
            map.set(compositeKey(entry), entry);
        }

        return Array.from(map.values()).sort((a, b) => (b.time || 0) - (a.time || 0));
    }

    /**
     * Run the event differ over a snapshot (null = game offline) and persist
     * whatever it produces to the events journal.
     */
    recordEvents (gameData) {
        if (!this.db) return;
        try {
            const latestSavegame = this.db.getLatestSavegame() ?? null;
            for (const event of this.differ.diff(gameData, latestSavegame)) {
                this.db.insertEvent(event);
            }
        } catch (error) {
            console.error(chalk.red('Failed to record events:'), error);
        }
    }

    /**
     * Watchdog: when the game stops posting, record the offline transition
     * (and pick up savegame_parsed events while no data POSTs arrive).
     */
    startStaleWatchdog () {
        setInterval(() => {
            const stale = !this.lastPostAt || (Date.now() - this.lastPostAt) > GAME_STALE_MS;
            if (stale && this.differ.initialized) {
                this.recordEvents(null);
            }
        }, 5000).unref();
        return this;
    }

    /**
     * Hand all pending commands to the game and move them to history as
     * 'delivered'. 'executed' requires an ack from the in-game bridge.
     */
    deliverPendingCommands () {
        if (this.commandQueue.length === 0) {
            return [];
        }
        const commands = this.commandQueue.splice(0);
        const deliveredAt = new Date().toISOString();
        for (const command of commands) {
            command.status = 'delivered';
            command.delivered_at = deliveredAt;
            this.pushCommandHistory(command);
        }
        return commands;
    }

    /**
     * Append to command history, keeping it bounded
     */
    pushCommandHistory (command) {
        this.commandHistory.push(command);
        if (this.commandHistory.length > COMMAND_HISTORY_LIMIT) {
            this.commandHistory.splice(0, this.commandHistory.length - COMMAND_HISTORY_LIMIT);
        }
    }

    /**
     * Check if new release is out
     */
    checkVersion () {
        const versionCheck = require('github-version-checker');
        const { version } = require('./package.json');

        const options = {
            token: '',
            repo: 'X4-External-App',
            owner: 'mycumycu',
            currentVersion: version,
        };

        versionCheck(options, null).then((update) => {
            if (update) { // update is null if there is no update available, so check here
                this.outputMessage(chalk.yellow(`An update is available: ${update.name}\nYou are on version ${options.currentVersion}!`));
                this.updatePending = true;
            } else {
                this.outputMessage(chalk.green(`You are up to date.`));
            }
        }).catch(function () {
            console.error(chalk.red(`Couldn't connect to github server to check updates.`));
        });

        return this
    }

    /**
     *
     */
    serve () {
        let serveStatic = require('serve-static');
        let portfinder = require('portfinder');
        let localIpV4Address = require("local-ipv4-address");

        localIpV4Address()
            .catch((err) => {
                const reason = (err && err.message) ? err.message : String(err);
                this.outputMessage(chalk.yellow(`Could not determine LAN IPv4 address (${reason}).`));
                this.outputMessage(chalk.yellow(`Tip: On some Linux systems, installing 'net-tools' (which includes the 'netstat' command) may help.`));
                return null;
            })
            .then((ipAddress) => {
                portfinder.getPort({ port: this.port }, (err, port) => {
                    this.app.use(serveStatic(path.join(__dirname, 'dist'), {
                        etag: false,
                        lastModified: false,
                        cacheControl: false,
                        maxAge: 0,
                        setHeaders: (res) => {
                            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                            res.setHeader('Pragma', 'no-cache');
                            res.setHeader('Expires', '0');
                            res.setHeader('Surrogate-Control', 'no-store');
                        }
                    }));
                    this.app.listen(port, () => {
                        require('child_process').exec(`start http://${this.hostname}:${port}`);

                        this.outputMessage(`*********************************************`);
                        this.outputMessage(`** Server running at http://${this.hostname}:${port}`);
                        this.outputMessage(
                            ipAddress ?
                                `** Local IPv4 address: ${ipAddress}` :
                                `** Local IPv4 address: unavailable (local IPv4 not detected)`
                        );
                        this.outputMessage(`*********************************************`);

                        this.checkPortChange(port)
                    });
                });
            })

        return this
    }

    /**
     * Notify user if the port has changed
     */
    checkPortChange (port) {
        if (port !== parseInt(this.port)) {
            this.outputMessage(chalk.yellow(`Port ${this.port} is already in use. Using port ${port} instead.`));
            this.outputMessage(chalk.yellow(`Update the relevant port settings in the '\\extensions\\mycu_external_app\\ui\\config.lua' file.`));
            this.outputMessage();
        }
    }

    /**
     *
     */
    setApi () {
        /**
         * Handle data consumed by components
         */
        this.app.get('/api/data', (request, response) => {
            // In local env, the dev-data.json snapshot is only a stand-in for
            // when no game is posting - live data always wins when present.
            if (!isPackaged && this.lastPostAt == null && fs.existsSync(devFilePath)) {
                try {
                    // In local env - load from file
                    const raw = fs.readFileSync(devFilePath, 'utf8');
                    this.dataObject = JSON.parse(raw);
                } catch (e) {
                    console.error(chalk.red(`Failed to load ${devFilePath}:`), e);
                }
            }

            if (this.dataObject) {
                this.dataObject.updatePending = this.updatePending;
            }

            response.json(this.dataObject);
        });

        /**
         * Handle incoming data from X4
         */
        this.app.post('/api/data', (request, response) => {
            // Normalize output (handle line breaks, color codes, etc.)
            const newData = normalizeObjectRecursively(request.body);

            // Incrementally accumulate list-type data instead of replacing
            if (newData.transactionLog && Array.isArray(newData.transactionLog)) {
                newData.transactionLog = this.mergeEntries(
                    this.dataObject?.transactionLog, newData.transactionLog, 'entryid'
                );
            }
            if (newData.logbook && Array.isArray(newData.logbook)) {
                newData.logbook = this.mergeEntries(
                    this.dataObject?.logbook, newData.logbook, 'id'
                );
            }

            // Merge new data with existing
            this.dataObject = { ...this.dataObject, ...newData };

            // Journal: diff this snapshot against the last and persist events
            this.lastPostAt = Date.now();
            this.recordEvents(this.dataObject);

            if (!isPackaged) {
                try {
                    if (!fs.existsSync(devFilePath) && this.dataObject != null) {
                        // In local env: create dev-data.json
                        fs.writeFileSync(devFilePath, JSON.stringify(this.dataObject, null, 2));
                        this.outputMessage(chalk.green(`Development data file created at ${devFilePath}`));
                    }
                } catch (e) {
                    console.error(chalk.red(`Failed to write ${devFilePath}:`), e);
                }
            }

            // Piggyback pending co-captain commands on the reply. The stock
            // extension ignores the response body, so this is backward
            // compatible; a command-bridge-aware extension executes them and
            // acknowledges via POST /api/commands/ack.
            response.json({ status: 'ok', commands: this.deliverPendingCommands() });
        });

        /**
         * Events journal (co-captain persistent event history)
         */
        this.app.get('/api/events', (request, response) => {
            try {
                const { after_id, since, until, type, min_severity, q, limit } = request.query;
                const events = this.db.searchEvents({
                    after_id: after_id != null ? parseInt(after_id) : undefined,
                    since,
                    until,
                    types: type ? String(type).split(',').map((t) => t.trim()).filter(Boolean) : undefined,
                    min_severity,
                    q,
                    limit: limit != null ? parseInt(limit) : undefined,
                });
                response.json({ events, latest_id: this.db.getLatestEventId() });
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        /**
         * Server / bridge health
         */
        this.app.get('/api/status', (request, response) => {
            try {
                const lastPostAgo = this.lastPostAt ? Math.round((Date.now() - this.lastPostAt) / 1000) : null;
                response.json({
                    version,
                    uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
                    game_online: this.lastPostAt != null && (Date.now() - this.lastPostAt) <= GAME_STALE_MS,
                    last_data_post_seconds_ago: lastPostAgo,
                    events_total: this.db.getLatestEventId(),
                    events_last_24h: this.db.getEventCounts(new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
                    commands_pending: this.commandQueue.length,
                    savegames_parsed: this.db.getAllSavegames().length,
                });
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        /**
         * Command queue endpoints (co-captain write path)
         */

        // Enqueue a command for the in-game bridge
        this.app.post('/api/commands', (request, response) => {
            const { type, payload } = request.body ?? {};

            if (!ALLOWED_COMMAND_TYPES.includes(type)) {
                return response.status(400).json({
                    error: `Unknown command type '${type}'. Allowed: ${ALLOWED_COMMAND_TYPES.join(', ')}`,
                });
            }
            if (this.commandQueue.length >= COMMAND_QUEUE_LIMIT) {
                return response.status(429).json({
                    error: `Command queue full (${COMMAND_QUEUE_LIMIT} pending). The game may not be running a command-bridge-aware extension.`,
                });
            }

            const command = {
                id: this.nextCommandId++,
                type,
                payload: payload ?? {},
                status: 'pending',
                queued_at: new Date().toISOString(),
            };
            this.commandQueue.push(command);
            response.json(command);
        });

        // Inspect pending queue and recent history
        this.app.get('/api/commands', (request, response) => {
            response.json({ pending: this.commandQueue, history: this.commandHistory });
        });

        // Game-side acknowledgement that delivered commands were executed
        this.app.post('/api/commands/ack', (request, response) => {
            const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
            let acked = 0;
            for (const command of this.commandHistory) {
                if (ids.includes(command.id) && command.status === 'delivered') {
                    command.status = 'executed';
                    command.executed_at = new Date().toISOString();
                    acked++;
                }
            }
            response.json({ acked });
        });

        // Cancel a pending command
        this.app.delete('/api/commands/:id', (request, response) => {
            const id = parseInt(request.params.id);
            const index = this.commandQueue.findIndex((command) => command.id === id);
            if (index === -1) {
                return response.status(404).json({ error: 'No pending command with that id' });
            }
            const [command] = this.commandQueue.splice(index, 1);
            command.status = 'cancelled';
            command.cancelled_at = new Date().toISOString();
            this.pushCommandHistory(command);
            response.json(command);
        });

        /**
         * Savegame API Endpoints
         */

        // Get all savegames
        this.app.get('/api/savegames', (request, response) => {
            try {
                const savegames = this.db.getAllSavegames();
                response.json(savegames);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        // Get latest savegame
        this.app.get('/api/savegames/latest', (request, response) => {
            try {
                const savegame = this.db.getLatestSavegame();
                if (!savegame) {
                    return response.status(404).json({ error: 'No savegames found' });
                }
                response.json(savegame);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        // Get complete savegame data with all related entities
        this.app.get('/api/savegames/:id', (request, response) => {
            try {
                const savegameId = parseInt(request.params.id);
                const data = this.db.getSavegameData(savegameId);

                if (!data) {
                    return response.status(404).json({ error: 'Savegame not found' });
                }

                response.json(data);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        // Get ships for a savegame
        this.app.get('/api/savegames/:id/ships', (request, response) => {
            try {
                const savegameId = parseInt(request.params.id);
                const ships = this.db.getShips(savegameId);
                response.json(ships);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        // Get stations for a savegame
        this.app.get('/api/savegames/:id/stations', (request, response) => {
            try {
                const savegameId = parseInt(request.params.id);
                const stations = this.db.getStations(savegameId);
                response.json(stations);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        // Get blueprints for a savegame
        this.app.get('/api/savegames/:id/blueprints', (request, response) => {
            try {
                const savegameId = parseInt(request.params.id);
                const blueprints = this.db.getBlueprints(savegameId);
                response.json(blueprints);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        // Manually trigger savegame parsing
        this.app.post('/api/savegames/parse', async (request, response) => {
            try {
                const { filePath } = request.body;

                if (!filePath) {
                    return response.status(400).json({ error: 'filePath is required' });
                }

                if (!fs.existsSync(filePath)) {
                    return response.status(404).json({ error: 'File not found' });
                }

                const result = await this.savegameParser.parseSavegame(filePath);
                response.json(result);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        // Parse most recent savegame
        this.app.post('/api/savegames/parse-latest', async (request, response) => {
            try {
                if (!this.savegameWatcher) {
                    return response.status(400).json({ error: 'Savegame watcher not initialized' });
                }

                const result = await this.savegameWatcher.parseMostRecent();
                response.json(result);
            } catch (error) {
                response.status(500).json({ error: error.message });
            }
        });

        return this
    }

    /**
     * Output console messages in non-spammer style
     * @param message
     */
    outputMessage (message = '') {
        if (this.lastOutputMessage !== message) {
            console.log(message)
            this.lastOutputMessage = message;
        }

        return this
    }
}

const server = new Server(app, hostname, port)
server.outputMessage(chalk.green(`X4 External App Server v${version}`))
    .serve()
    .setApi()
    .startStaleWatchdog()
    .checkVersion()
    .outputMessage()
