const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', trimValues: true });

const asArray = (v) => {
    if (v === null || v === undefined) {
        return []; 
    }
    return Array.isArray(v) ? v : [v];
};

/** Count equipment macros of one kind, e.g. [{macro, count}]. */
function tally(items) {
    const counts = new Map();
    for (const it of asArray(items)) {
        if (!it?.macro) {
            continue; 
        }
        counts.set(it.macro, (counts.get(it.macro) || 0) + 1);
    }
    return [...counts].map(([macro, count]) => ({ macro, count }));
}

/**
 * Resolve the player's loadouts.xml from X4_SAVEGAME_PATH (…\<profile>\save → …\<profile>\loadouts.xml).
 */
function loadoutsFile(savegamePath = process.env.X4_SAVEGAME_PATH) {
    if (!savegamePath) {
        return null; 
    }
    return path.join(path.dirname(savegamePath), 'loadouts.xml');
}

/** Parse player-saved loadouts into a compact summary list. */
function loadLoadouts(file = loadoutsFile()) {
    if (!file || !fs.existsSync(file)) {
        return { file, loadouts: [] }; 
    }
    const doc = parser.parse(fs.readFileSync(file, 'utf8'));
    const entries = asArray(doc?.loadouts?.loadout);
    const loadouts = entries.map((lo) => {
        const m = lo.macros || {};
        return {
            id: lo.id,
            name: lo.name,
            description: lo.description || '',
            macro: lo.macro,
            engine: asArray(m.engine)[0]?.macro || null,
            weapons: tally(m.weapon),
            turrets: tally(m.turret),
            shields: tally(m.shield),
        };
    });
    return { file, modified: fs.statSync(file).mtime.toISOString(), loadouts };
}

module.exports = { loadLoadouts, loadoutsFile };
