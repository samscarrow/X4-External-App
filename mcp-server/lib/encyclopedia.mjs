/**
 * Encyclopedia lookups over the static game-data bundle extracted from the
 * samscarrow/x4 repo (data/encyclopedia.json, built by
 * scripts/build-encyclopedia.mjs). Pure functions over a loaded bundle so
 * they are testable; loadEncyclopedia() memoizes the disk read.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE = path.join(
    path.dirname(fileURLToPath(import.meta.url)), "..", "data", "encyclopedia.json"
);

export const CATEGORIES = ["ships", "wares", "modules", "equipment", "factions", "races", "ware_groups"];

let cached = null;
export function loadEncyclopedia(file = DATA_FILE) {
    if (cached) return cached;
    if (!fs.existsSync(file)) {
        throw new Error(
            `Encyclopedia bundle not found at ${file}. ` +
            `Generate it with: node scripts/build-encyclopedia.mjs /path/to/x4-repo`
        );
    }
    cached = JSON.parse(fs.readFileSync(file, "utf8"));
    return cached;
}

const contains = (haystack, needle) =>
    typeof haystack === "string" && haystack.toLowerCase().includes(needle.toLowerCase());

const matchesField = (value, wanted) =>
    value != null && String(value).toLowerCase() === String(wanted).toLowerCase();

// Compact row per category so search results stay token-cheap
function compactRow(category, entity) {
    switch (category) {
        case "ships":
            return {
                id: entity.id, name: entity.name, type: entity.type, size: entity.size,
                purpose: entity.purpose, race: entity.race, hull: entity.hull, crew: entity.people,
            };
        case "wares":
            return {
                id: entity.id, name: entity.name, group: entity.group, transport: entity.transport,
                volume: entity.volume, price: entity.price, used_in_count: entity.used_in?.length ?? 0,
            };
        case "modules":
            return {
                id: entity.id, name: entity.name, type: entity.type,
                race: entity.makerRace, price_avg: entity.price?.avg,
            };
        case "equipment":
            return {
                id: entity.id, name: entity.name, type: entity.type,
                class: entity.equipmentClass, size: entity.size, price_avg: entity.price?.avg,
            };
        default:
            return { id: entity.id, name: entity.name, race: entity.race };
    }
}

/**
 * Search a category. query is a substring match on name/id; the remaining
 * filters are case-insensitive exact matches where the field applies:
 * size, type, purpose, race (race or makerRace), group, class.
 */
export function searchEncyclopedia(bundle, category, { query, size, type, purpose, race, group, class: klass, limit = 15 } = {}) {
    const entities = bundle[category] ?? [];
    const matched = entities.filter((entity) => {
        if (query && !(contains(entity.name, query) || contains(entity.id, query))) return false;
        if (size && !matchesField(entity.size, size)) return false;
        if (type && !matchesField(entity.type, type)) return false;
        if (purpose && !matchesField(entity.purpose, purpose)) return false;
        if (race && !(matchesField(entity.race, race) || matchesField(entity.makerRace, race))) return false;
        if (group && !matchesField(entity.group, group)) return false;
        if (klass && !matchesField(entity.equipmentClass, klass)) return false;
        return true;
    });
    return {
        category,
        matched: matched.length,
        returned: Math.min(matched.length, limit),
        results: matched.slice(0, limit).map((entity) => compactRow(category, entity)),
    };
}

/**
 * Full record by id (exact) or unique/best name match. Ware used_in lists are
 * summarized to keep responses readable.
 */
export function getEncyclopediaEntry(bundle, category, idOrName) {
    const entities = bundle[category] ?? [];
    const entity =
        entities.find((candidate) => candidate.id === idOrName) ??
        entities.find((candidate) => candidate.name?.toLowerCase() === idOrName.toLowerCase()) ??
        entities.find((candidate) => contains(candidate.name, idOrName));
    if (!entity) return null;
    if (category === "wares" && Array.isArray(entity.used_in)) {
        return {
            ...entity,
            used_in: {
                count: entity.used_in.length,
                sample: entity.used_in.slice(0, 15),
            },
        };
    }
    return entity;
}

/**
 * Recursive production chain for a ware: what it takes to produce `amount`
 * units, expanding intermediate wares down to raw resources. Returns the
 * recipe tree plus flattened totals per ware.
 */
export function productionChain(bundle, wareIdOrName, { amount = 1, method = "default", max_depth = 10 } = {}) {
    const waresById = new Map(bundle.wares.map((ware) => [ware.id, ware]));
    const root =
        waresById.get(wareIdOrName) ??
        bundle.wares.find((ware) => contains(ware.name, wareIdOrName));
    if (!root) return null;

    const totals = new Map();
    const addTotal = (id, name, qty, raw) => {
        const entry = totals.get(id) ?? { ware: id, name, amount: 0, raw };
        entry.amount += qty;
        totals.set(id, entry);
    };

    function expand(ware, qty, depth, seen) {
        const recipes = ware.production ?? [];
        const recipe =
            recipes.find((candidate) => candidate.method === method) ??
            recipes.find((candidate) => candidate.method === "default") ??
            recipes[0];
        const inputs = recipe?.wares ?? [];
        const isRaw = inputs.length === 0;
        const node = {
            ware: ware.id,
            name: ware.name,
            amount: Math.ceil(qty),
            ...(recipe ? { method: recipe.method, batch: { time_s: recipe.time, amount: recipe.amount } } : {}),
            ...(isRaw ? { raw: true } : {}),
        };
        if (isRaw || depth >= max_depth || seen.has(ware.id)) {
            if (seen.has(ware.id)) node.cycle = true;
            return node;
        }
        node.inputs = inputs.map((input) => {
            const perUnit = input.amount / recipe.amount;
            const needed = perUnit * qty;
            const child = waresById.get(input.ware);
            if (!child) {
                addTotal(input.ware, input.ware, needed, true);
                return { ware: input.ware, amount: Math.ceil(needed), raw: true };
            }
            addTotal(child.id, child.name, needed, (child.production ?? []).every((r) => (r.wares ?? []).length === 0));
            return expand(child, needed, depth + 1, new Set([...seen, ware.id]));
        });
        return node;
    }

    const tree = expand(root, amount, 0, new Set());
    return {
        ware: root.id,
        name: root.name,
        amount,
        method_preference: method,
        tree,
        totals: [...totals.values()]
            .map((entry) => ({ ...entry, amount: Math.ceil(entry.amount) }))
            .sort((a, b) => b.amount - a.amount),
    };
}
