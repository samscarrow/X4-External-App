const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

class DatabaseService {
    constructor(dbPath = null) {
        const isPackaged = !!process.pkg;
        const runtimeDir = isPackaged ? path.dirname(process.execPath) : __dirname;

        // Create data directory if it doesn't exist
        const dataDir = path.join(runtimeDir, '..', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.dbPath = dbPath || path.join(dataDir, 'x4_savegame.db');
        this.db = null;
    }

    /**
     * Initialize database connection and create tables
     */
    init() {
        try {
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('foreign_keys = ON');
            this.createTables();
            console.log(chalk.green(`Database initialized at ${this.dbPath}`));
            return this;
        } catch (error) {
            console.error(chalk.red('Failed to initialize database:'), error);
            throw error;
        }
    }

    /**
     * Create database tables
     */
    createTables() {
        // Savegames table - stores metadata about parsed savegames
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS savegames (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL UNIQUE,
                file_path TEXT NOT NULL,
                parsed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                file_modified_at DATETIME,
                file_size INTEGER,
                player_name TEXT,
                player_money INTEGER,
                playtime_seconds INTEGER,
                game_version TEXT,
                metadata TEXT
            )
        `);

        // Ships table - stores player ships from savegame
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                savegame_id INTEGER NOT NULL,
                ship_id TEXT NOT NULL,
                ship_name TEXT,
                ship_class TEXT,
                ship_type TEXT,
                sector TEXT,
                hull_health REAL,
                shield_health REAL,
                commander TEXT,
                metadata TEXT,
                FOREIGN KEY (savegame_id) REFERENCES savegames(id) ON DELETE CASCADE
            )
        `);

        // Stations table - stores player stations from savegame
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS stations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                savegame_id INTEGER NOT NULL,
                station_id TEXT NOT NULL,
                station_name TEXT,
                owner TEXT,
                sector TEXT,
                position_x REAL,
                position_y REAL,
                position_z REAL,
                total_storage INTEGER,
                total_workforce INTEGER,
                metadata TEXT,
                FOREIGN KEY (savegame_id) REFERENCES savegames(id) ON DELETE CASCADE
            )
        `);

        // Station modules table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS station_modules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                station_db_id INTEGER NOT NULL,
                module_macro TEXT,
                module_type TEXT,
                quantity INTEGER DEFAULT 1,
                metadata TEXT,
                FOREIGN KEY (station_db_id) REFERENCES stations(id) ON DELETE CASCADE
            )
        `);

        // Inventory table - stores ware inventory from stations
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                station_db_id INTEGER NOT NULL,
                ware TEXT NOT NULL,
                quantity INTEGER,
                capacity INTEGER,
                price REAL,
                metadata TEXT,
                FOREIGN KEY (station_db_id) REFERENCES stations(id) ON DELETE CASCADE
            )
        `);

        // Blueprints table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS blueprints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                savegame_id INTEGER NOT NULL,
                blueprint_name TEXT NOT NULL,
                blueprint_type TEXT,
                is_owned BOOLEAN DEFAULT 0,
                metadata TEXT,
                FOREIGN KEY (savegame_id) REFERENCES savegames(id) ON DELETE CASCADE
            )
        `);

        // Create indexes
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ships_savegame ON ships(savegame_id);
            CREATE INDEX IF NOT EXISTS idx_stations_savegame ON stations(savegame_id);
            CREATE INDEX IF NOT EXISTS idx_modules_station ON station_modules(station_db_id);
            CREATE INDEX IF NOT EXISTS idx_inventory_station ON inventory(station_db_id);
            CREATE INDEX IF NOT EXISTS idx_blueprints_savegame ON blueprints(savegame_id);
        `);
    }

    /**
     * Insert or update savegame metadata
     */
    upsertSavegame(savegameData) {
        const transaction = this.db.transaction((data) => {
            // Check if savegame already exists
            const existing = this.getSavegameByFilename(data.filename);

            if (existing) {
                // Delete old ships, stations, blueprints (CASCADE will handle related modules and inventory)
                this.db.prepare('DELETE FROM ships WHERE savegame_id = ?').run(existing.id);
                this.db.prepare('DELETE FROM stations WHERE savegame_id = ?').run(existing.id);
                this.db.prepare('DELETE FROM blueprints WHERE savegame_id = ?').run(existing.id);
            }

            const stmt = this.db.prepare(`
                INSERT INTO savegames (filename, file_path, file_modified_at, file_size,
                                      player_name, player_money, playtime_seconds, game_version, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(filename) DO UPDATE SET
                    parsed_at = CURRENT_TIMESTAMP,
                    file_modified_at = excluded.file_modified_at,
                    file_size = excluded.file_size,
                    player_name = excluded.player_name,
                    player_money = excluded.player_money,
                    playtime_seconds = excluded.playtime_seconds,
                    game_version = excluded.game_version,
                    metadata = excluded.metadata
                RETURNING id
            `);

            const result = stmt.get(
                data.filename,
                data.file_path,
                data.file_modified_at,
                data.file_size,
                data.player_name,
                data.player_money,
                data.playtime_seconds,
                data.game_version,
                JSON.stringify(data.metadata || {})
            );

            return result.id;
        });

        return transaction(savegameData);
    }

    /**
     * Get savegame by filename
     */
    getSavegameByFilename(filename) {
        const stmt = this.db.prepare('SELECT * FROM savegames WHERE filename = ?');
        return stmt.get(filename);
    }

    /**
     * Get all savegames
     */
    getAllSavegames() {
        const stmt = this.db.prepare('SELECT * FROM savegames ORDER BY parsed_at DESC');
        return stmt.all();
    }

    /**
     * Get latest savegame
     */
    getLatestSavegame() {
        const stmt = this.db.prepare('SELECT * FROM savegames ORDER BY file_modified_at DESC LIMIT 1');
        return stmt.get();
    }

    /**
     * Insert ships for a savegame
     */
    insertShips(savegameId, ships, options = {}) {
        const { reset = true } = options;

        if (!Array.isArray(ships) || ships.length === 0) {
            return;
        }

        if (reset) {
            const deleteStmt = this.db.prepare('DELETE FROM ships WHERE savegame_id = ?');
            deleteStmt.run(savegameId);
        }

        const insertStmt = this.db.prepare(`
            INSERT INTO ships (savegame_id, ship_id, ship_name, ship_class, ship_type,
                              sector, hull_health, shield_health, commander, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((ships) => {
            for (const ship of ships) {
                insertStmt.run(
                    savegameId,
                    ship.ship_id,
                    ship.ship_name,
                    ship.ship_class,
                    ship.ship_type,
                    ship.sector,
                    ship.hull_health,
                    ship.shield_health,
                    ship.commander,
                    JSON.stringify(ship.metadata || {})
                );
            }
        });

        insertMany(ships);
    }

    /**
     * Insert stations for a savegame
     */
    insertStations(savegameId, stations, options = {}) {
        const { reset = true } = options;

        if (!Array.isArray(stations) || stations.length === 0) {
            return;
        }

        if (reset) {
            const deleteStmt = this.db.prepare('DELETE FROM stations WHERE savegame_id = ?');
            deleteStmt.run(savegameId);
        }

        const insertStmt = this.db.prepare(`
            INSERT INTO stations (savegame_id, station_id, station_name, owner, sector,
                                 position_x, position_y, position_z, total_storage,
                                 total_workforce, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((stations) => {
            for (const station of stations) {
                const result = insertStmt.run(
                    savegameId,
                    station.station_id,
                    station.station_name,
                    station.owner,
                    station.sector,
                    station.position_x,
                    station.position_y,
                    station.position_z,
                    station.total_storage,
                    station.total_workforce,
                    JSON.stringify(station.metadata || {})
                );

                // Insert station modules if they exist
                if (station.modules && station.modules.length > 0) {
                    this.insertStationModules(result.lastInsertRowid, station.modules);
                }

                // Insert inventory if it exists
                if (station.inventory && station.inventory.length > 0) {
                    this.insertInventory(result.lastInsertRowid, station.inventory);
                }
            }
        });

        insertMany(stations);
    }

    /**
     * Insert station modules
     */
    insertStationModules(stationDbId, modules) {
        const insertStmt = this.db.prepare(`
            INSERT INTO station_modules (station_db_id, module_macro, module_type, quantity, metadata)
            VALUES (?, ?, ?, ?, ?)
        `);

        for (const module of modules) {
            insertStmt.run(
                stationDbId,
                module.module_macro,
                module.module_type,
                module.quantity || 1,
                JSON.stringify(module.metadata || {})
            );
        }
    }

    /**
     * Insert inventory items
     */
    insertInventory(stationDbId, inventory) {
        const insertStmt = this.db.prepare(`
            INSERT INTO inventory (station_db_id, ware, quantity, capacity, price, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const item of inventory) {
            insertStmt.run(
                stationDbId,
                item.ware,
                item.quantity || 0,
                item.capacity || 0,
                item.price || 0,
                JSON.stringify(item.metadata || {})
            );
        }
    }

    /**
     * Insert blueprints for a savegame
     */
    insertBlueprints(savegameId, blueprints, options = {}) {
        const { reset = true } = options;

        if (!Array.isArray(blueprints) || blueprints.length === 0) {
            return;
        }

        if (reset) {
            const deleteStmt = this.db.prepare('DELETE FROM blueprints WHERE savegame_id = ?');
            deleteStmt.run(savegameId);
        }

        const insertStmt = this.db.prepare(`
            INSERT INTO blueprints (savegame_id, blueprint_name, blueprint_type, is_owned, metadata)
            VALUES (?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((blueprints) => {
            for (const bp of blueprints) {
                insertStmt.run(
                    savegameId,
                    bp.blueprint_name,
                    bp.blueprint_type,
                    bp.is_owned ? 1 : 0,
                    JSON.stringify(bp.metadata || {})
                );
            }
        });

        insertMany(blueprints);
    }

    /**
     * Get ships for a savegame
     */
    getShips(savegameId) {
        const stmt = this.db.prepare('SELECT * FROM ships WHERE savegame_id = ? ORDER BY ship_name');
        return stmt.all(savegameId);
    }

    /**
     * Get stations for a savegame
     */
    getStations(savegameId) {
        const stmt = this.db.prepare('SELECT * FROM stations WHERE savegame_id = ? ORDER BY station_name');
        const stations = stmt.all(savegameId);

        // Enrich with modules and inventory
        for (const station of stations) {
            station.modules = this.getStationModules(station.id);
            station.inventory = this.getStationInventory(station.id);
        }

        return stations;
    }

    /**
     * Get station modules
     */
    getStationModules(stationDbId) {
        const stmt = this.db.prepare('SELECT * FROM station_modules WHERE station_db_id = ?');
        return stmt.all(stationDbId);
    }

    /**
     * Get station inventory
     */
    getStationInventory(stationDbId) {
        const stmt = this.db.prepare('SELECT * FROM inventory WHERE station_db_id = ?');
        return stmt.all(stationDbId);
    }

    /**
     * Get blueprints for a savegame
     */
    getBlueprints(savegameId) {
        const stmt = this.db.prepare('SELECT * FROM blueprints WHERE savegame_id = ? ORDER BY blueprint_name');
        return stmt.all(savegameId);
    }

    /**
     * Get complete savegame data with all related entities
     */
    getSavegameData(savegameId) {
        const savegame = this.db.prepare('SELECT * FROM savegames WHERE id = ?').get(savegameId);

        if (!savegame) {
            return null;
        }

        return {
            ...savegame,
            metadata: JSON.parse(savegame.metadata || '{}'),
            ships: this.getShips(savegameId),
            stations: this.getStations(savegameId),
            blueprints: this.getBlueprints(savegameId)
        };
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            console.log(chalk.green('Database connection closed'));
        }
    }
}

module.exports = DatabaseService;
