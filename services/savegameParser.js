const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const sax = require('sax');
const chalk = require('chalk');
const ModuleStatsLoader = require('./moduleStatsLoader');

const DECIMAL_REGEX = /^-?\d+(\.\d+)?$/;

function normalizeAttributeValue(value) {
    if (value === undefined || value === null) {
        return value;
    }

    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();

    if (trimmed === '') {
        return trimmed;
    }

    if (trimmed === 'true') {
        return true;
    }

    if (trimmed === 'false') {
        return false;
    }

    if (DECIMAL_REGEX.test(trimmed)) {
        return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
    }

    return value;
}

function parseFloatSafe(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const num = parseFloat(value);
    return Number.isFinite(num) ? num : null;
}

function parseIntSafe(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const num = parseInt(value, 10);
    return Number.isNaN(num) ? null : num;
}

function buildMetadata(attrs, excludeKeys = []) {
    const metadata = {};

    for (const [key, value] of Object.entries(attrs)) {
        if (excludeKeys.includes(key)) {
            continue;
        }

        const normalized = normalizeAttributeValue(value);
        if (normalized !== undefined) {
            metadata[key] = normalized;
        }
    }

    return metadata;
}

function inferModuleTypeFromMacro(macro, fallback = 'other') {
    if (!macro || typeof macro !== 'string') {
        return fallback;
    }

    const lower = macro.toLowerCase();

    if (lower.includes('storage') || lower.includes('warehouse') || lower.includes('_cont')) {
        return 'storage';
    }

    if (lower.includes('prod') || lower.includes('factory') || lower.includes('refinery') || lower.includes('processing')) {
        return 'production';
    }

    if (lower.includes('dock') || lower.includes('pier') || lower.includes('launch') || lower.includes('station_pla_dock')) {
        return 'dock';
    }

    if (lower.includes('defence') || lower.includes('defense') || lower.includes('def_') || lower.includes('defence') || lower.includes('defplatform')) {
        return 'defence';
    }

    if (lower.includes('hab') || lower.includes('workforce') || lower.includes('residence') || lower.includes('crew') || lower.includes('dorm')) {
        return 'habitation';
    }

    if (lower.includes('research') || lower.includes('lab')) {
        return 'research';
    }

    if (lower.includes('buildmodule') || lower.includes('struct_') || lower.includes('connection')) {
        return 'structural';
    }

    return fallback;
}

class SavegameParser {
    constructor(databaseService) {
        this.db = databaseService;
        this.moduleStatsLoader = new ModuleStatsLoader();
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
                    },
                    resetFlags: {
                        ships: false,
                        stations: false,
                        blueprints: false
                    },
                    tagStack: [],
                    context: {
                        constructionDepth: 0,
                        sequenceDepth: 0
                    },
                    componentStack: [],
                    moduleStack: [],
                    currentStation: null
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
                const updateCurrentStationReference = () => {
                    for (let i = state.componentStack.length - 1; i >= 0; i--) {
                        const context = state.componentStack[i];
                        if (context.kind === 'station') {
                            state.currentStation = context.data;
                            return;
                        }
                    }

                    state.currentStation = null;
                };

                const flushShips = () => {
                    if (!state.savegameId || state.batches.ships.length === 0) {
                        return;
                    }

                    this.db.insertShips(state.savegameId, state.batches.ships, {
                        reset: !state.resetFlags.ships
                    });
                    state.resetFlags.ships = true;
                    state.batches.ships = [];
                };

                const flushStations = () => {
                    if (!state.savegameId || state.batches.stations.length === 0) {
                        return;
                    }

                    this.db.insertStations(state.savegameId, state.batches.stations, {
                        reset: !state.resetFlags.stations
                    });
                    state.resetFlags.stations = true;
                    state.batches.stations = [];
                };

                const flushBlueprints = () => {
                    if (!state.savegameId || state.batches.blueprints.length === 0) {
                        return;
                    }

                    this.db.insertBlueprints(state.savegameId, state.batches.blueprints, {
                        reset: !state.resetFlags.blueprints
                    });
                    state.resetFlags.blueprints = true;
                    state.batches.blueprints = [];
                };

                const applyModuleStats = (moduleObj, station) => {
                    if (!this.moduleStatsLoader) {
                        return;
                    }

                    const stats = this.moduleStatsLoader.getStats(moduleObj.module_macro);
                    if (!stats) {
                        return;
                    }

                    if (stats.workforceCapacity && moduleObj._workforceCapacity == null) {
                        moduleObj._workforceCapacity = stats.workforceCapacity;
                        moduleObj.metadata = moduleObj.metadata || {};
                        moduleObj.metadata.workforce = moduleObj.metadata.workforce || {};

                        if (moduleObj.metadata.workforce.capacity == null) {
                            moduleObj.metadata.workforce.capacity = stats.workforceCapacity;
                        }
                    }

                    if (stats.storageEntries && stats.storageEntries.length) {
                        moduleObj._storageEntries = stats.storageEntries.map((entry) => ({
                            capacity: entry.capacity,
                            tags: Array.isArray(entry.tags) ? [...entry.tags] : []
                        }));

                        moduleObj.metadata = moduleObj.metadata || {};
                        if (!moduleObj.metadata.storage) {
                            moduleObj.metadata.storage = moduleObj._storageEntries;
                        }
                    }
                };

                parser.on('opentag', (node) => {
                    const tag = node.name;
                    const attrs = node.attributes || {};
                    const parentTag = state.tagStack.length > 0 ? state.tagStack[state.tagStack.length - 1] : null;
                    state.tagStack.push(tag);

                    if (tag === 'construction' && state.currentStation) {
                        if (state.context.constructionDepth === 0) {
                            const constructionMetadata = buildMetadata(attrs);
                            if (Object.keys(constructionMetadata).length) {
                                if (!state.currentStation.metadata.construction) {
                                    state.currentStation.metadata.construction = [];
                                }
                                state.currentStation.metadata.construction.push(constructionMetadata);
                            }
                        }
                        state.context.constructionDepth++;
                    }

                    if (tag === 'sequence' && state.context.constructionDepth > 0) {
                        state.context.sequenceDepth++;
                    }

                    if (tag === 'info') {
                        state.savegameInfo.playtime_seconds = parseInt(attrs.playtime || 0, 10);
                        state.savegameInfo.game_version = attrs.version || 'Unknown';
                        state.savegameInfo.metadata.save_time = attrs.save || null;
                        console.log(chalk.gray(`  Found info element`));
                        return;
                    }

                    if (tag === 'player') {
                        state.savegameInfo.player_name = attrs.name || 'Unknown';
                        state.savegameInfo.player_money = parseInt(attrs.money || 0, 10);
                        state.savegameInfo.metadata.location = attrs.location || null;

                        if (!state.savegameId) {
                            state.savegameId = this.db.upsertSavegame(state.savegameInfo);
                            console.log(chalk.gray(`  Created DB entry with ID: ${state.savegameId}`));
                        }
                        return;
                    }

                    if (tag === 'component') {
                        const componentClass = attrs.class || '';
                        const macro = attrs.macro || '';
                        const isShip = componentClass === 'ship' || macro.includes('ship');
                        const isStation = componentClass === 'station' || macro.includes('station');

                        if (isShip) {
                            const ship = {
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
                            };

                            state.componentStack.push({ kind: 'ship', data: ship });
                            return;
                        }

                        if (isStation) {
                            const baseMetadata = {
                                race: attrs.race,
                                purpose: attrs.purpose
                            };

                            const extraMetadata = buildMetadata(attrs, [
                                'id',
                                'code',
                                'name',
                                'owner',
                                'faction',
                                'sector',
                                'zone',
                                'system',
                                'cluster',
                                'class',
                                'x',
                                'y',
                                'z',
                                'workforce'
                            ]);

                            const stationMetadata = Object.fromEntries(
                                Object.entries({ ...baseMetadata, ...extraMetadata })
                                    .filter(([, value]) => value !== undefined && value !== null)
                            );

                            const workforceFromAttr = parseIntSafe(attrs.workforce) ?? parseIntSafe(attrs.workforcemax) ?? 0;

                            const station = {
                                station_id: attrs.id || attrs.code || 'unknown',
                                station_name: attrs.name || 'Unnamed Station',
                                owner: attrs.owner || attrs.faction || 'Unknown',
                                sector: attrs.sector || attrs.zone || attrs.system || 'Unknown Sector',
                                position_x: parseFloatSafe(attrs.x) ?? 0,
                                position_y: parseFloatSafe(attrs.y) ?? 0,
                                position_z: parseFloatSafe(attrs.z) ?? 0,
                                total_storage: 0,
                                total_workforce: workforceFromAttr || 0,
                                modules: [],
                                inventory: [],
                                metadata: Object.keys(stationMetadata).length ? stationMetadata : {}
                            };

                            station._workforceCapacityFromModules = 0;
                            station._inventoryCapacity = 0;
                            station._storageCapacityFromModules = 0;
                            station._storageByTag = {};

                            state.componentStack.push({ kind: 'station', data: station });
                            state.context.constructionDepth = 0;
                            state.context.sequenceDepth = 0;
                            state.currentStation = station;
                            return;
                        }

                        state.componentStack.push({ kind: 'component', data: null });
                        return;
                    }

                    if (tag === 'module' && state.currentStation) {
                        const quantity = parseIntSafe(attrs.count) ?? parseIntSafe(attrs.quantity) ?? 1;
                        const moduleMacro = attrs.macro || attrs.internalname || attrs.id || attrs.ref || 'unknown';
                        const metadata = buildMetadata(attrs, ['macro', 'type', 'category', 'count', 'quantity']);
                        const moduleType = attrs.type || attrs.category || inferModuleTypeFromMacro(moduleMacro);

                        const module = {
                            module_macro: moduleMacro,
                            module_type: moduleType,
                            quantity: quantity > 0 ? quantity : 1,
                            metadata: metadata
                        };

                        module._workforceCapacity = parseIntSafe(attrs.workforcecapacity) ?? parseIntSafe(attrs.workforce);
                        module._workforceEmployed = parseIntSafe(attrs.workforceactive) ?? null;

                        applyModuleStats(module, state.currentStation);

                        state.moduleStack.push({ module, station: state.currentStation, tag: 'module' });
                        return;
                    }

                    if (
                        tag === 'entry' &&
                        state.currentStation &&
                        state.context.constructionDepth > 0 &&
                        state.context.sequenceDepth > 0 &&
                        attrs.macro
                    ) {
                        const quantity = parseIntSafe(attrs.count) ?? parseIntSafe(attrs.quantity) ?? 1;
                        const moduleMacro = attrs.macro;
                        const metadata = buildMetadata(attrs, ['macro', 'type', 'category', 'count', 'quantity']);
                        const moduleType = attrs.type || attrs.category || inferModuleTypeFromMacro(moduleMacro);

                        const module = {
                            module_macro: moduleMacro,
                            module_type: moduleType,
                            quantity: quantity > 0 ? quantity : 1,
                            metadata: metadata
                        };

                        module._workforceCapacity = parseIntSafe(attrs.workforcecapacity) ?? parseIntSafe(attrs.workforce);
                        module._workforceEmployed = parseIntSafe(attrs.workforceactive) ?? null;

                        applyModuleStats(module, state.currentStation);

                        state.moduleStack.push({ module, station: state.currentStation, tag: 'entry' });
                        return;
                    }

                    if (tag === 'workforce') {
                        if (state.moduleStack.length > 0) {
                            const ctx = state.moduleStack[state.moduleStack.length - 1];
                            const capacity = parseIntSafe(attrs.capacity) ?? parseIntSafe(attrs.max);
                            const employed = parseIntSafe(attrs.employed) ?? parseIntSafe(attrs.current) ?? parseIntSafe(attrs.active);

                            if (!ctx.module.metadata.workforce) {
                                ctx.module.metadata.workforce = {};
                            }

                            if (capacity !== null) {
                                ctx.module.metadata.workforce.capacity = capacity;
                                ctx.module._workforceCapacity = capacity;
                            }

                            if (employed !== null) {
                                ctx.module.metadata.workforce.employed = employed;
                                ctx.module._workforceEmployed = employed;
                            }
                        } else if (state.currentStation) {
                            const capacity = parseIntSafe(attrs.capacity) ?? parseIntSafe(attrs.max);
                            const employed = parseIntSafe(attrs.employed) ?? parseIntSafe(attrs.current) ?? parseIntSafe(attrs.active);

                            if (!state.currentStation.metadata.workforce) {
                                state.currentStation.metadata.workforce = {};
                            }

                            if (capacity !== null) {
                                state.currentStation.metadata.workforce.capacity = capacity;
                            }

                            if (employed !== null) {
                                state.currentStation.metadata.workforce.employed = employed;
                            }
                        }

                        return;
                    }

                    if (tag === 'blueprint') {
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

                        if (state.batches.blueprints.length >= BATCH_SIZE && state.savegameId) {
                            flushBlueprints();
                        }

                        return;
                    }

                    if (state.currentStation) {
                        const station = state.currentStation;

                        if (state.moduleStack.length > 0) {
                            const ctx = state.moduleStack[state.moduleStack.length - 1];
                            const childMetadata = buildMetadata(attrs);

                            if (tag === 'offset' || tag === 'rotation') {
                                if (Object.keys(childMetadata).length) {
                                    ctx.module.metadata[tag] = childMetadata;
                                }
                                return;
                            }

                            if (tag === 'connection') {
                                if (Object.keys(childMetadata).length) {
                                    if (!ctx.module.metadata.connections) {
                                        ctx.module.metadata.connections = [];
                                    }
                                    ctx.module.metadata.connections.push(childMetadata);
                                }
                                return;
                            }

                            if (Object.keys(childMetadata).length) {
                                if (!ctx.module.metadata.children) {
                                    ctx.module.metadata.children = [];
                                }
                                ctx.module.metadata.children.push({ tag, attrs: childMetadata });
                            }

                            return;
                        }

                        if (tag === 'ware') {
                            const validParents = parentTag ? parentTag.toLowerCase() : null;
                            const isInventoryContext = validParents === 'cargo' || validParents === 'wares' || validParents === 'supply';

                            if (!isInventoryContext) {
                                return;
                            }

                            const quantity = parseIntSafe(attrs.amount) ?? parseIntSafe(attrs.quantity);
                            const capacity = parseIntSafe(attrs.capacity) ?? parseIntSafe(attrs.max) ?? parseIntSafe(attrs.storage);
                            const price = parseIntSafe(attrs.price) ?? parseFloatSafe(attrs.price) ?? 0;

                            const metadata = buildMetadata(attrs, ['ware', 'amount', 'quantity', 'capacity', 'max', 'storage', 'price']);

                            if (quantity !== null || capacity !== null || Object.keys(metadata).length) {
                                const item = {
                                    ware: attrs.ware,
                                    quantity: quantity ?? 0,
                                    capacity: capacity ?? 0,
                                    price: price || 0
                                };

                                if (Object.keys(metadata).length) {
                                    item.metadata = metadata;
                                }

                                station.inventory.push(item);

                                if (capacity) {
                                    station._inventoryCapacity = (station._inventoryCapacity || 0) + capacity;
                                }
                            }

                            return;
                        }

                        if ((tag === 'storage' || tag === 'cargo') && attrs.capacity) {
                            const capacity = parseIntSafe(attrs.capacity) ?? parseIntSafe(attrs.max);
                            if (capacity) {
                                station._inventoryCapacity = (station._inventoryCapacity || 0) + capacity;
                            }
                        }
                    }
                });

                parser.on('closetag', (tag) => {
                    state.tagStack.pop();

                    if (tag === 'module' || tag === 'entry') {
                        let ctx = null;

                        for (let i = state.moduleStack.length - 1; i >= 0; i--) {
                            if (state.moduleStack[i].tag === tag) {
                                ctx = state.moduleStack.splice(i, 1)[0];
                                break;
                            }
                        }

                        if (!ctx) {
                            return;
                        }

                        const station = ctx.station;
                        const module = ctx.module;

                        if (!station) {
                            return;
                        }

                        if (!module.metadata || Object.keys(module.metadata).length === 0) {
                            module.metadata = {};
                        }

                        if (ctx.tag === 'entry') {
                            module.metadata.source = module.metadata.source || 'construction_entry';
                        }

                        const workforceCapacity = module._workforceCapacity ?? (module.metadata.workforce ? module.metadata.workforce.capacity : null);
                        const workforceEmployed = module._workforceEmployed ?? (module.metadata.workforce ? module.metadata.workforce.employed : null);

                        if (workforceCapacity !== null) {
                            station._workforceCapacityFromModules = (station._workforceCapacityFromModules || 0) + workforceCapacity;
                            module.metadata.workforce = module.metadata.workforce || {};
                            module.metadata.workforce.capacity = workforceCapacity;
                        }

                        if (workforceEmployed !== null) {
                            module.metadata.workforce = module.metadata.workforce || {};
                            module.metadata.workforce.employed = workforceEmployed;
                        }

                        const storageEntries = module._storageEntries;
                        if (Array.isArray(storageEntries) && storageEntries.length > 0) {
                            const moduleStorage = storageEntries.reduce((sum, entry) => sum + (entry.capacity || 0), 0);
                            if (moduleStorage > 0) {
                                station._storageCapacityFromModules = (station._storageCapacityFromModules || 0) + moduleStorage;
                                station._storageByTag = station._storageByTag || {};

                                storageEntries.forEach((entry) => {
                                    const capacity = entry.capacity || 0;
                                    if (!capacity) {
                                        return;
                                    }

                                    if (entry.tags && entry.tags.length > 0) {
                                        entry.tags.forEach((tag) => {
                                            station._storageByTag[tag] = (station._storageByTag[tag] || 0) + capacity;
                                        });
                                    } else {
                                        station._storageByTag.unclassified = (station._storageByTag.unclassified || 0) + capacity;
                                    }
                                });
                            }
                        }

                        delete module._workforceCapacity;
                        delete module._workforceEmployed;
                        delete module._storageEntries;

                        station.modules.push(module);
                        return;
                    }

                    if (tag === 'component') {
                        const context = state.componentStack.pop();
                        if (!context) {
                            return;
                        }

                        if (context.kind === 'ship') {
                            state.batches.ships.push(context.data);
                            state.counters.ships++;

                            if (state.batches.ships.length >= BATCH_SIZE && state.savegameId) {
                                flushShips();
                                console.log(chalk.gray(`  Ships: ${state.counters.ships} (batch written)`));
                            }
                        } else if (context.kind === 'station') {
                            const station = context.data;

                            const computedStorage = station.inventory.reduce((sum, item) => sum + (item.capacity || 0), 0);
                            const storageFromModules = station._storageCapacityFromModules || 0;
                            const totalStorage = storageFromModules || station._inventoryCapacity || computedStorage;
                            station.total_storage = totalStorage || station.total_storage || 0;
                            delete station._inventoryCapacity;
                            delete station._storageCapacityFromModules;

                            const computedWorkforce = station.modules.reduce((sum, module) => {
                                const capacity = module.metadata && module.metadata.workforce ? module.metadata.workforce.capacity : null;
                                return sum + (capacity || 0);
                            }, 0);
                            const totalWorkforce = station._workforceCapacityFromModules || computedWorkforce;
                            if (totalWorkforce) {
                                station.total_workforce = totalWorkforce;
                            }
                            delete station._workforceCapacityFromModules;

                            station.inventory = station.inventory.map((item) => {
                                if (item.metadata && Object.keys(item.metadata).length === 0) {
                                    const clone = { ...item };
                                    delete clone.metadata;
                                    return clone;
                                }
                                return item;
                            });

                            if (storageFromModules > 0) {
                                station.metadata = station.metadata || {};
                                station.metadata.storage_summary = {
                                    total_capacity: storageFromModules,
                                    by_tag: station._storageByTag || {}
                                };
                            }
                            delete station._storageByTag;

                            state.batches.stations.push(station);
                            state.counters.stations++;

                            if (state.batches.stations.length >= BATCH_SIZE && state.savegameId) {
                                flushStations();
                                console.log(chalk.gray(`  Stations: ${state.counters.stations} (batch written)`));
                            }
                        }

                        updateCurrentStationReference();
                        return;
                    }

                    if (tag === 'sequence' && state.context.sequenceDepth > 0) {
                        state.context.sequenceDepth--;
                        return;
                    }

                    if (tag === 'construction' && state.context.constructionDepth > 0) {
                        state.context.constructionDepth--;
                        if (state.context.constructionDepth === 0) {
                            state.context.sequenceDepth = 0;
                        }
                        return;
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
                        flushShips();
                        flushStations();
                        flushBlueprints();

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
