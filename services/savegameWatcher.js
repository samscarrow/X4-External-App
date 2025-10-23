const chokidar = require('chokidar');
const path = require('path');
const chalk = require('chalk');

class SavegameWatcher {
    constructor(savegameParser, watchDirectory = null) {
        this.parser = savegameParser;
        this.watchDirectory = watchDirectory;
        this.watcher = null;
        this.parseQueue = new Set();
        this.isProcessing = false;
    }

    /**
     * Start watching the savegame directory
     */
    start(directory = null) {
        const watchDir = directory || this.watchDirectory;

        if (!watchDir) {
            console.log(chalk.yellow('No savegame directory specified for watching'));
            return this;
        }

        console.log(chalk.blue(`Starting savegame watcher for: ${watchDir}`));

        this.watcher = chokidar.watch(path.join(watchDir, '*.xml.gz'), {
            persistent: true,
            ignoreInitial: false, // Parse existing files on startup
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        this.watcher
            .on('add', (filePath) => this.onFileAdded(filePath))
            .on('change', (filePath) => this.onFileChanged(filePath))
            .on('error', (error) => console.error(chalk.red('Watcher error:'), error))
            .on('ready', () => console.log(chalk.green('✓ Savegame watcher is ready')));

        return this;
    }

    /**
     * Handle new savegame file
     */
    async onFileAdded(filePath) {
        console.log(chalk.cyan(`New savegame detected: ${path.basename(filePath)}`));
        await this.queueParse(filePath);
    }

    /**
     * Handle savegame file change
     */
    async onFileChanged(filePath) {
        console.log(chalk.cyan(`Savegame updated: ${path.basename(filePath)}`));
        await this.queueParse(filePath);
    }

    /**
     * Queue a savegame for parsing
     */
    async queueParse(filePath) {
        this.parseQueue.add(filePath);
        await this.processQueue();
    }

    /**
     * Process the parse queue
     */
    async processQueue() {
        if (this.isProcessing || this.parseQueue.size === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.parseQueue.size > 0) {
            const filePath = this.parseQueue.values().next().value;
            this.parseQueue.delete(filePath);

            try {
                await this.parser.parseSavegame(filePath);
            } catch (error) {
                console.error(chalk.red(`Failed to parse ${filePath}:`), error.message);
            }
        }

        this.isProcessing = false;
    }

    /**
     * Stop watching
     */
    stop() {
        if (this.watcher) {
            this.watcher.close();
            console.log(chalk.green('Savegame watcher stopped'));
        }
        return this;
    }

    /**
     * Manually trigger parsing of a specific file
     */
    async parseFile(filePath) {
        return await this.parser.parseSavegame(filePath);
    }

    /**
     * Parse the most recent savegame
     */
    async parseMostRecent() {
        if (!this.watchDirectory) {
            throw new Error('No watch directory configured');
        }
        return await this.parser.parseMostRecentSavegame(this.watchDirectory);
    }
}

module.exports = SavegameWatcher;
