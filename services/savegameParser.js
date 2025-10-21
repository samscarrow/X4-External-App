const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const chalk = require('chalk');

class SavegameParser {
    constructor(databaseService) {
        this.db = databaseService;
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            parseAttributeValue: true,
            trimValues: true,
            numberParseOptions: {
                leadingZeros: false,
                hex: true,
                skipLike: /^0x/
            }
        });
    }

    /**
     * Parse a savegame file
     * @param {string} filePath - Path to the .xml.gz savegame file
     * @returns {Promise<Object>} Parsed savegame data
     */
    async parseSavegame(filePath) {
        try {
            console.log(chalk.blue(`Parsing savegame: ${path.basename(filePath)}`));

            // Read file stats
            const stats = fs.statSync(filePath);
            const filename = path.basename(filePath);

            // Read and decompress the file
            const compressed = fs.readFileSync(filePath);
            const xmlContent = await this.decompress(compressed);

            // Parse XML
            const parsed = this.parser.parse(xmlContent);

            // Extract relevant data
            const savegameData = this.extractSavegameData(parsed, filePath, filename, stats);

            // Store in database
            const savegameId = this.db.upsertSavegame(savegameData);

            // Extract and store ships
            const ships = this.extractShips(parsed);
            if (ships.length > 0) {
                this.db.insertShips(savegameId, ships);
            }

            // Extract and store stations
            const stations = this.extractStations(parsed);
            if (stations.length > 0) {
                this.db.insertStations(savegameId, stations);
            }

            // Extract and store blueprints
            const blueprints = this.extractBlueprints(parsed);
            if (blueprints.length > 0) {
                this.db.insertBlueprints(savegameId, blueprints);
            }

            console.log(chalk.green(`✓ Savegame parsed successfully: ${filename}`));
            console.log(chalk.gray(`  Ships: ${ships.length}, Stations: ${stations.length}, Blueprints: ${blueprints.length}`));

            return {
                savegameId,
                filename,
                summary: {
                    ships: ships.length,
                    stations: stations.length,
                    blueprints: blueprints.length,
                    player_name: savegameData.player_name,
                    player_money: savegameData.player_money
                }
            };
        } catch (error) {
            console.error(chalk.red(`Failed to parse savegame ${filePath}:`), error);
            throw error;
        }
    }

    /**
     * Decompress gzipped content
     */
    decompress(buffer) {
        return new Promise((resolve, reject) => {
            zlib.gunzip(buffer, (err, result) => {
                if (err) reject(err);
                else resolve(result.toString('utf-8'));
            });
        });
    }

    /**
     * Extract basic savegame metadata
     */
    extractSavegameData(parsed, filePath, filename, stats) {
        const savegame = parsed.savegame || {};
        const info = savegame.info || {};
        const player = savegame.player || {};

        return {
            filename,
            file_path: filePath,
            file_modified_at: stats.mtime.toISOString(),
            file_size: stats.size,
            player_name: player['@_name'] || 'Unknown',
            player_money: parseInt(player['@_money'] || 0),
            playtime_seconds: parseInt(info['@_playtime'] || 0),
            game_version: info['@_version'] || 'Unknown',
            metadata: {
                save_time: info['@_save'] || null,
                location: player['@_location'] || null,
                galaxy: savegame['@_galaxy'] || null
            }
        };
    }

    /**
     * Extract ships from savegame
     */
    extractShips(parsed) {
        const ships = [];

        try {
            // Navigate to ships in XML structure
            // X4 savegame structure varies, so we need to handle multiple paths
            const universe = parsed.savegame?.universe;
            if (!universe) return ships;

            // Find all components that are ships
            const components = this.findAllComponents(universe);

            for (const component of components) {
                const attrs = component['@_'] || {};

                // Check if it's a ship (has class 'ship')
                if (attrs.class === 'ship' || attrs.macro?.includes('ship')) {
                    ships.push({
                        ship_id: attrs.id || attrs.code || 'unknown',
                        ship_name: attrs.name || 'Unnamed Ship',
                        ship_class: attrs.class || 'ship',
                        ship_type: attrs.macro || 'unknown',
                        sector: attrs.sector || 'Unknown Sector',
                        hull_health: attrs.hull != null ? parseFloat(attrs.hull) : null,
                        shield_health: attrs.shield != null ? parseFloat(attrs.shield) : null,
                        commander: attrs.commander || null,
                        metadata: {
                            owner: attrs.owner,
                            purpose: attrs.purpose,
                            position: {
                                x: attrs.x,
                                y: attrs.y,
                                z: attrs.z
                            }
                        }
                    });
                }
            }
        } catch (error) {
            console.error(chalk.yellow('Warning: Failed to extract ships:'), error.message);
        }

        return ships;
    }

    /**
     * Extract stations from savegame
     */
    extractStations(parsed) {
        const stations = [];

        try {
            const universe = parsed.savegame?.universe;
            if (!universe) return stations;

            const components = this.findAllComponents(universe);

            for (const component of components) {
                const attrs = component['@_'] || {};

                // Check if it's a station
                if (attrs.class === 'station' || attrs.macro?.includes('station')) {
                    const modules = this.extractStationModules(component);
                    const inventory = this.extractStationInventory(component);

                    stations.push({
                        station_id: attrs.id || attrs.code || 'unknown',
                        station_name: attrs.name || 'Unnamed Station',
                        owner: attrs.owner || 'Unknown',
                        sector: attrs.sector || 'Unknown Sector',
                        position_x: parseFloat(attrs.x || 0),
                        position_y: parseFloat(attrs.y || 0),
                        position_z: parseFloat(attrs.z || 0),
                        total_storage: this.calculateTotalStorage(inventory),
                        total_workforce: parseInt(attrs.workforce || 0),
                        modules,
                        inventory,
                        metadata: {
                            race: attrs.race,
                            purpose: attrs.purpose
                        }
                    });
                }
            }
        } catch (error) {
            console.error(chalk.yellow('Warning: Failed to extract stations:'), error.message);
        }

        return stations;
    }

    /**
     * Extract station modules
     */
    extractStationModules(stationComponent) {
        const modules = [];

        try {
            const connections = stationComponent.connections?.connection;
            if (!connections) return modules;

            const connectionArray = Array.isArray(connections) ? connections : [connections];

            for (const conn of connectionArray) {
                const attrs = conn['@_'] || {};
                if (attrs.macro) {
                    modules.push({
                        module_macro: attrs.macro,
                        module_type: this.inferModuleType(attrs.macro),
                        quantity: 1,
                        metadata: {
                            connection: attrs.connection,
                            offset: {
                                x: attrs.offsetx,
                                y: attrs.offsety,
                                z: attrs.offsetz
                            }
                        }
                    });
                }
            }
        } catch (error) {
            // Silent fail - not critical
        }

        return modules;
    }

    /**
     * Extract station inventory
     */
    extractStationInventory(stationComponent) {
        const inventory = [];

        try {
            const storage = stationComponent.storage?.ware;
            if (!storage) return inventory;

            const wareArray = Array.isArray(storage) ? storage : [storage];

            for (const ware of wareArray) {
                const attrs = ware['@_'] || {};
                inventory.push({
                    ware: attrs.ware || 'unknown',
                    quantity: parseInt(attrs.amount || 0),
                    capacity: parseInt(attrs.capacity || 0),
                    price: parseFloat(attrs.price || 0),
                    metadata: {
                        buy: attrs.buy === 'true' || attrs.buy === '1',
                        sell: attrs.sell === 'true' || attrs.sell === '1'
                    }
                });
            }
        } catch (error) {
            // Silent fail
        }

        return inventory;
    }

    /**
     * Extract blueprints from savegame
     */
    extractBlueprints(parsed) {
        const blueprints = [];

        try {
            const player = parsed.savegame?.player;
            if (!player) return blueprints;

            // Blueprints might be stored in different locations depending on game version
            const bps = player.blueprints?.blueprint || player.research?.blueprint;
            if (!bps) return blueprints;

            const bpArray = Array.isArray(bps) ? bps : [bps];

            for (const bp of bpArray) {
                const attrs = bp['@_'] || {};
                blueprints.push({
                    blueprint_name: attrs.name || attrs.ware || 'unknown',
                    blueprint_type: attrs.type || 'ship',
                    is_owned: attrs.owned === 'true' || attrs.owned === '1',
                    metadata: {
                        race: attrs.race,
                        ware: attrs.ware
                    }
                });
            }
        } catch (error) {
            console.error(chalk.yellow('Warning: Failed to extract blueprints:'), error.message);
        }

        return blueprints;
    }

    /**
     * Recursively find all components in the universe
     */
    findAllComponents(obj, components = []) {
        if (!obj) return components;

        if (obj.component) {
            const compArray = Array.isArray(obj.component) ? obj.component : [obj.component];
            components.push(...compArray);

            // Recursively search nested components
            for (const comp of compArray) {
                if (comp.component) {
                    this.findAllComponents(comp, components);
                }
            }
        }

        // Search in nested objects
        for (const key in obj) {
            if (typeof obj[key] === 'object' && key !== 'component') {
                this.findAllComponents(obj[key], components);
            }
        }

        return components;
    }

    /**
     * Infer module type from macro name
     */
    inferModuleType(macro) {
        if (!macro) return 'unknown';

        const lower = macro.toLowerCase();

        if (lower.includes('production')) return 'production';
        if (lower.includes('storage')) return 'storage';
        if (lower.includes('habitation') || lower.includes('living')) return 'habitation';
        if (lower.includes('dock')) return 'dock';
        if (lower.includes('defense') || lower.includes('turret')) return 'defense';
        if (lower.includes('pier')) return 'pier';

        return 'other';
    }

    /**
     * Calculate total storage capacity
     */
    calculateTotalStorage(inventory) {
        return inventory.reduce((total, item) => total + (item.capacity || 0), 0);
    }

    /**
     * Find savegame files in a directory
     */
    findSavegameFiles(directory) {
        if (!fs.existsSync(directory)) {
            return [];
        }

        const files = fs.readdirSync(directory);
        return files
            .filter(file => file.endsWith('.xml.gz'))
            .map(file => path.join(directory, file))
            .map(filePath => ({
                path: filePath,
                stats: fs.statSync(filePath)
            }))
            .sort((a, b) => b.stats.mtime - a.stats.mtime); // Most recent first
    }

    /**
     * Parse the most recent savegame in a directory
     */
    async parseMostRecentSavegame(directory) {
        const savegames = this.findSavegameFiles(directory);

        if (savegames.length === 0) {
            throw new Error(`No savegame files found in ${directory}`);
        }

        return await this.parseSavegame(savegames[0].path);
    }
}

module.exports = SavegameParser;
