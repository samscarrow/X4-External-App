const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const XML_OPTIONS = {
    ignoreAttributes: false,
    attributeNamePrefix: '',
    trimValues: true
};

class ModuleStatsLoader {
    constructor() {
        this.catalogRoot = null;
        this.initialised = false;
        this.macroIndex = new Map();
        this.cache = new Map();
        this.parser = new XMLParser(XML_OPTIONS);
    }

    getStats(macroName) {
        if (!macroName) {
            return null;
        }

        if (this.cache.has(macroName)) {
            return this.cache.get(macroName);
        }

        this.buildIndex();

        const filePath = this.macroIndex.get(macroName);
        if (!filePath) {
            this.cache.set(macroName, null);
            return null;
        }

        try {
            const xml = fs.readFileSync(filePath, 'utf-8');
            const data = this.parser.parse(xml);
            const macro = data?.macros?.macro;
            if (!macro || !macro.properties) {
                this.cache.set(macroName, null);
                return null;
            }

            const properties = macro.properties;

            const workforceCapacity = this.extractWorkforceCapacity(properties);
            const storageEntries = this.extractStorageEntries(properties);

            const stats = {
                workforceCapacity,
                storageEntries
            };

            this.cache.set(macroName, stats);
            return stats;
        } catch (error) {
            this.cache.set(macroName, null);
            return null;
        }
    }

    extractWorkforceCapacity(properties) {
        const workforceNode = properties.workforce;
        if (!workforceNode) {
            return null;
        }

        if (Array.isArray(workforceNode)) {
            const total = workforceNode.reduce((sum, node) => {
                const value = this.parseNumber(node.capacity ?? node.max ?? node.value);
                return sum + (value || 0);
            }, 0);
            return total > 0 ? total : null;
        }

        const capacity = this.parseNumber(workforceNode.capacity ?? workforceNode.max ?? workforceNode.value);
        return capacity ?? null;
    }

    extractStorageEntries(properties) {
        const entries = [];

        const pushEntry = (node) => {
            if (!node) {
                return;
            }

            const capacity = this.parseNumber(node.max ?? node.capacity ?? node.value);
            if (!capacity || capacity <= 0) {
                return;
            }

            const tagString = node.tags || node.tag;
            const tags = typeof tagString === 'string'
                ? tagString.split(/\s+/).map(t => t.trim()).filter(Boolean)
                : [];

            entries.push({
                capacity,
                tags
            });
        };

        const cargoNode = properties.cargo;
        if (cargoNode) {
            if (Array.isArray(cargoNode)) {
                cargoNode.forEach(pushEntry);
            } else {
                pushEntry(cargoNode);
            }
        }

        const storageNode = properties.storage;
        if (storageNode) {
            if (Array.isArray(storageNode)) {
                storageNode.forEach(pushEntry);
            } else {
                pushEntry(storageNode);
            }
        }

        return entries;
    }

    parseNumber(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }

        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : null;
        }

        const str = String(value).trim();
        if (!str) {
            return null;
        }

        const parsed = Number(str);
        if (Number.isFinite(parsed)) {
            return parsed;
        }

        const intParsed = parseInt(str, 10);
        return Number.isFinite(intParsed) ? intParsed : null;
    }

    buildIndex() {
        if (this.initialised) {
            return;
        }

        this.initialised = true;

        const root = this.findCatalogRoot();
        if (!root) {
            return;
        }

        const namespaces = this.getCatalogNamespaces(root);
        for (const namespacePath of namespaces) {
            const structuresDir = path.join(namespacePath, 'assets', 'structures');
            if (!fs.existsSync(structuresDir)) {
                continue;
            }
            this.collectMacroFiles(structuresDir);
        }
    }

    findCatalogRoot() {
        if (this.catalogRoot !== null) {
            return this.catalogRoot;
        }

        const candidates = [
            path.resolve(__dirname, '..', '..', 'catalogs'),
            path.resolve(__dirname, '..', 'catalogs'),
            path.resolve(process.cwd(), '..', 'catalogs'),
            path.resolve(process.cwd(), 'catalogs')
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                this.catalogRoot = candidate;
                return candidate;
            }
        }

        this.catalogRoot = null;
        return null;
    }

    getCatalogNamespaces(root) {
        try {
            const namespaces = fs.readdirSync(root, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => path.join(root, entry.name));

            return namespaces;
        } catch (error) {
            return [];
        }
    }

    collectMacroFiles(baseDir) {
        const stack = [baseDir];

        while (stack.length > 0) {
            const currentDir = stack.pop();
            let entries;

            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch (error) {
                continue;
            }

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    stack.push(fullPath);
                    continue;
                }

                if (!entry.isFile()) {
                    continue;
                }

                if (!entry.name.endsWith('_macro.xml')) {
                    continue;
                }

                const macroName = entry.name.replace('.xml', '');
                if (!this.macroIndex.has(macroName)) {
                    this.macroIndex.set(macroName, fullPath);
                }
            }
        }
    }
}

module.exports = ModuleStatsLoader;
