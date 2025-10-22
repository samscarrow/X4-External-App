const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const sax = require('sax');
const chalk = require('chalk');

class SavegameParser {
    constructor(databaseService) {
        this.db = databaseService;
    }

    /**
     * Parse a savegame file using true streaming SAX parser
     * @param {string} filePath - Path to the .xml.gz savegame file
     * @returns {Promise<Object>} Parsed savegame data
     */
    async parseSavegame(filePath) {
        return new Promise((resolve, reject) => {
            try {
                console.log(chalk.blue(`Parsing savegame: ${path.basename(filePath)}`));

                const stats = fs.statSync(filePath);
                const filename = path.basename(filePath);

                // State for parsing
                const state = {
                    savegameInfo: {
                        filename,
                        file_path: filePath,
                        file_modified_at: stats.mtime.toISOString(),
                        file_size: stats.size,
                        player_name: 'Unknown',
                        player_money: 0,
                        playtime_seconds: 0,
                        game_version: 'Unknown',
                        metadata: {}
                    },
                    savegameId: null,
                    counters: {
                        ships: 0,
                        stations: 0,
                        blueprints: 0
                    },
                    batches: {
                        ships: [],
                        stations: [],
                        blueprints: []
                    }
                };

                const BATCH_SIZE = 500;

                // Create SAX parser (strict mode, no buffering)
                const parser = sax.createStream(true, {
                    trim: true,
                    normalize: true,
                    lowercase: false
                });

                // Add destroy method for Node.js v24 compatibility
                if (!parser.destroy) {
                    parser.destroy = function(err) {
                        if (this._readableState) {
                            this._readableState.destroyed = true;
                        }
                        if (err) {
                            this.emit('error', err);
                        }
                        this.emit('close');
                    };
                }

                // Create streaming pipeline
                const fileStream = fs.createReadStream(filePath);
                const gunzip = zlib.createGunzip();

                console.log(chalk.gray(`  Starting SAX stream parse...`));

                // Handle SAX events
                parser.on('opentag', (node) => {
                    const tag = node.name;
                    const attrs = node.attributes;

                    // Capture info
                    if (tag === 'info') {
                        state.savegameInfo.playtime_seconds = parseInt(attrs.playtime || 0);
                        state.savegameInfo.game_version = attrs.version || 'Unknown';
                        state.savegameInfo.metadata.save_time = attrs.save || null;
                        console.log(chalk.gray(`  Found info element`));
                    }

                    // Capture player
                    else if (tag === 'player') {
                        state.savegameInfo.player_name = attrs.name || 'Unknown';
                        state.savegameInfo.player_money = parseInt(attrs.money || 0);
                        state.savegameInfo.metadata.location = attrs.location || null;

                        // Create DB entry immediately
                        if (!state.savegameId) {
                            state.savegameId = this.db.upsertSavegame(state.savegameInfo);
                            console.log(chalk.gray(`  Created DB entry with ID: ${state.savegameId}`));
                        }
                    }

                    // Capture components (ships/stations)
                    else if (tag === 'component') {
                        const componentClass = attrs.class;
                        const macro = attrs.macro || '';

                        // Ship
                        if (componentClass === 'ship' || macro.includes('ship')) {
                            state.batches.ships.push({
                                ship_id: attrs.id || attrs.code || 'unknown',
                                ship_name: attrs.name || 'Unnamed Ship',
                                ship_class: componentClass || 'ship',
                                ship_type: macro || 'unknown',
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

                            state.counters.ships++;

                            // Batch write
                            if (state.batches.ships.length >= BATCH_SIZE && state.savegameId) {
                                this.db.insertShips(state.savegameId, state.batches.ships);
                                console.log(chalk.gray(`  Ships: ${state.counters.ships} (batch written)`));
                                state.batches.ships = [];
                            }
                        }

                        // Station (simplified - no nested data to avoid memory issues)
                        else if (componentClass === 'station' || macro.includes('station')) {
                            state.batches.stations.push({
                                station_id: attrs.id || attrs.code || 'unknown',
                                station_name: attrs.name || 'Unnamed Station',
                                owner: attrs.owner || 'Unknown',
                                sector: attrs.sector || 'Unknown Sector',
                                position_x: parseFloat(attrs.x || 0),
                                position_y: parseFloat(attrs.y || 0),
                                position_z: parseFloat(attrs.z || 0),
                                total_storage: 0,
                                total_workforce: parseInt(attrs.workforce || 0),
                                modules: [],
                                inventory: [],
                                metadata: {
                                    race: attrs.race,
                                    purpose: attrs.purpose
                                }
                            });

                            state.counters.stations++;

                            // Batch write
                            if (state.batches.stations.length >= BATCH_SIZE && state.savegameId) {
                                this.db.insertStations(state.savegameId, state.batches.stations);
                                console.log(chalk.gray(`  Stations: ${state.counters.stations} (batch written)`));
                                state.batches.stations = [];
                            }
                        }
                    }

                    // Blueprints
                    else if (tag === 'blueprint') {
                        state.batches.blueprints.push({
                            blueprint_name: attrs.name || attrs.ware || 'unknown',
                            blueprint_type: attrs.type || 'ship',
                            is_owned: attrs.owned === 'true' || attrs.owned === '1',
                            metadata: {
                                race: attrs.race,
                                ware: attrs.ware
                            }
                        });

                        state.counters.blueprints++;

                        // Batch write
                        if (state.batches.blueprints.length >= BATCH_SIZE && state.savegameId) {
                            this.db.insertBlueprints(state.savegameId, state.batches.blueprints);
                            state.batches.blueprints = [];
                        }
                    }
                });

                parser.on('error', (err) => {
                    console.error(chalk.red(`SAX parsing error:`), err);
                    // Clean up streams
                    fileStream.destroy();
                    gunzip.destroy();
                    reject(err);
                });

                parser.on('end', () => {
                    console.log(chalk.gray(`  Stream ended, writing final batches...`));
                    try {
                        // Ensure DB entry exists
                        if (!state.savegameId) {
                            state.savegameId = this.db.upsertSavegame(state.savegameInfo);
                        }

                        // Write remaining batches
                        if (state.batches.ships.length > 0) {
                            this.db.insertShips(state.savegameId, state.batches.ships);
                        }
                        if (state.batches.stations.length > 0) {
                            this.db.insertStations(state.savegameId, state.batches.stations);
                        }
                        if (state.batches.blueprints.length > 0) {
                            this.db.insertBlueprints(state.savegameId, state.batches.blueprints);
                        }

                        console.log(chalk.green(`✓ Savegame parsed successfully: ${filename}`));
                        console.log(chalk.gray(`  Ships: ${state.counters.ships}, Stations: ${state.counters.stations}, Blueprints: ${state.counters.blueprints}`));

                        resolve({
                            savegameId: state.savegameId,
                            filename,
                            summary: {
                                ships: state.counters.ships,
                                stations: state.counters.stations,
                                blueprints: state.counters.blueprints,
                                player_name: state.savegameInfo.player_name,
                                player_money: state.savegameInfo.player_money
                            }
                        });
                    } catch (dbError) {
                        console.error(chalk.red(`Database error:`), dbError);
                        reject(dbError);
                    }
                });

                // Handle stream errors
                fileStream.on('error', (err) => {
                    console.error(chalk.red(`File stream error:`), err);
                    gunzip.destroy();
                    parser.destroy();
                    reject(err);
                });

                gunzip.on('error', (err) => {
                    console.error(chalk.red(`Gunzip error:`), err);
                    fileStream.destroy();
                    parser.destroy();
                    reject(err);
                });

                // Start the pipeline
                fileStream.pipe(gunzip).pipe(parser);

            } catch (error) {
                console.error(chalk.red(`Failed to parse savegame ${filePath}:`), error);
                reject(error);
            }
        });
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
            .sort((a, b) => b.stats.mtime - a.stats.mtime);
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
