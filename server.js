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
const compression = require('compression');
const { version } = require("./package.json");

const isPackaged = !!process.pkg;
const runtimeDir = isPackaged ? path.dirname(process.execPath) : __dirname;
const devFilePath = path.join(runtimeDir, 'dev-data.json');

// Import savegame services
const DatabaseService = require('./services/database');
const SavegameParser = require('./services/savegameParser');
const SavegameWatcher = require('./services/savegameWatcher');

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Enable gzip compression for all responses
app.use(compression({
    threshold: 1024,  // Only compress responses larger than 1kb
    level: 6          // Compression level (1-9, 6 is default)
}));

// Add response caching headers
app.use((req, res, next) => {
    if (req.method === 'GET') {
        res.set('Cache-Control', 'public, max-age=5');
    }
    next();
});

class Server {
    dataObject = null;
    updatePending = false;
    lastOutputMessage = null;
    db = null;
    savegameParser = null;
    savegameWatcher = null;

    constructor (app, hostname, port) {
        this.app = app;
        this.hostname = hostname;
        this.port = port;

        // Performance optimization: Request queuing and debouncing
        this.updateQueue = [];
        this.lastProcessTime = 0;
        this.minProcessInterval = 2000;  // 2 seconds between processing
        this.lastFileWrite = 0;
        this.fileWriteInterval = 10000;  // 10 seconds between file writes

        // Initialize savegame services
        this.initializeSavegameServices();

        // Start queue processor
        this.startQueueProcessor();
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
     * Start the queue processor
     * Processes updates at controlled intervals
     */
    startQueueProcessor() {
        this.queueProcessorInterval = setInterval(() => {
            this.processQueuedUpdates();
        }, this.minProcessInterval);

        this.outputMessage(chalk.green('Queue processor started (debounce: 2s)'));
    }

    /**
     * Process queued updates in batch
     */
    processQueuedUpdates() {
        if (this.updateQueue.length === 0) return;

        const now = Date.now();

        // Check if enough time has passed since last process
        if (now - this.lastProcessTime < this.minProcessInterval) {
            return;
        }

        // Take the latest update (most recent data)
        const latestUpdate = this.updateQueue[this.updateQueue.length - 1];

        // Clear the queue
        const queueSize = this.updateQueue.length;
        this.updateQueue = [];

        // Update data object
        this.dataObject = latestUpdate;
        this.lastProcessTime = now;

        // Write to file only if enough time has passed
        if (!isPackaged && (now - this.lastFileWrite) >= this.fileWriteInterval) {
            this.writeDevDataFile();
            this.lastFileWrite = now;
        }

        this.outputMessage(chalk.gray(`Processed ${queueSize} queued update(s)`));
    }

    /**
     * Write dev data file (debounced)
     */
    writeDevDataFile() {
        if (!this.dataObject) return;

        try {
            fs.writeFileSync(devFilePath, JSON.stringify(this.dataObject, null, 2));
            this.outputMessage(chalk.gray(`Dev data written (debounced)`));
        } catch (e) {
            console.error(chalk.red(`Failed to write ${devFilePath}:`), e);
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
            if (!isPackaged && fs.existsSync(devFilePath)) {
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
         * Handle incoming data from X4 (OPTIMIZED)
         * Queues updates for batch processing instead of immediate processing
         */
        this.app.post('/api/data', (request, response) => {
            // Queue the update instead of processing immediately
            this.updateQueue.push(request.body);

            // Respond immediately (don't block on processing)
            response.status(200).json({
                status: 'queued',
                queue_size: this.updateQueue.length
            });
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
    .checkVersion()
    .outputMessage()
