#!/usr/bin/env node

/**
 * X4 Savegame Watcher Daemon
 *
 * Lightweight background process that monitors the X4 savegame directory
 * and automatically parses new/updated savegames into the SQLite database.
 *
 * This runs independently of the web server - just the core parsing functionality.
 */

const fs = require('fs');
const path = require('path');
const dotenvAbsolutePath = path.join(__dirname, '.env');
require('dotenv').config({ path: dotenvAbsolutePath });

const chalk = require('chalk');
const DatabaseService = require('./services/database');
const SavegameParser = require('./services/savegameParser');
const SavegameWatcher = require('./services/savegameWatcher');

class WatcherDaemon {
    constructor() {
        this.db = null;
        this.parser = null;
        this.watcher = null;
    }

    /**
     * Initialize the watcher daemon
     */
    async start() {
        console.log(chalk.cyan('X4 Savegame Watcher Daemon'));
        console.log(chalk.cyan('============================\n'));

        try {
            // Initialize database
            console.log(chalk.blue('Initializing database...'));
            this.db = new DatabaseService();
            this.db.init();
            console.log(chalk.green('✓ Database initialized\n'));

            // Initialize parser
            this.parser = new SavegameParser(this.db);

            // Check for savegame path
            const savegamePath = process.env.X4_SAVEGAME_PATH;
            if (!savegamePath) {
                console.error(chalk.red('ERROR: X4_SAVEGAME_PATH not set in .env file'));
                console.log(chalk.yellow('\nPlease set X4_SAVEGAME_PATH in .env to your savegame directory:'));
                console.log(chalk.yellow('Example: X4_SAVEGAME_PATH=C:\\Users\\YourName\\Documents\\Egosoft\\X4\\12345678\\save\n'));
                process.exit(1);
            }

            if (!fs.existsSync(savegamePath)) {
                console.error(chalk.red(`ERROR: Savegame path does not exist: ${savegamePath}`));
                console.log(chalk.yellow('\nPlease check X4_SAVEGAME_PATH in .env file\n'));
                process.exit(1);
            }

            // Initialize and start watcher
            console.log(chalk.blue(`Starting watcher for: ${savegamePath}`));
            this.watcher = new SavegameWatcher(this.parser, savegamePath);
            this.watcher.start();

            console.log(chalk.green('\n✓ Watcher daemon is running'));
            console.log(chalk.gray('Press Ctrl+C to stop\n'));

            // Handle graceful shutdown
            this.setupShutdownHandlers();

        } catch (error) {
            console.error(chalk.red('Failed to start watcher daemon:'), error);
            process.exit(1);
        }
    }

    /**
     * Set up graceful shutdown handlers
     */
    setupShutdownHandlers() {
        const shutdown = async () => {
            console.log(chalk.yellow('\n\nShutting down watcher daemon...'));

            if (this.watcher && this.watcher.watcher) {
                await this.watcher.stop();
            }

            if (this.db && this.db.db) {
                this.db.db.close();
            }

            console.log(chalk.green('✓ Shutdown complete\n'));
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }
}

// Start the daemon
const daemon = new WatcherDaemon();
daemon.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
});
