/**
 * Build the encyclopedia JSON bundle from the samscarrow/x4 repo's static
 * game-data TypeScript files (src/app/shared/services/data).
 *
 * Usage:  node scripts/build-encyclopedia.mjs [path-to-x4-repo]
 * Output: data/encyclopedia.json (committed - regenerate when the x4 repo's
 *         data changes)
 *
 * The data files are machine-generated and uniform: object/array literals
 * plus simple string enums and static classes. They are transformed to plain
 * JS (imports stripped, enums/classes to object literals) and evaluated in a
 * VM in dependency order; cross-entity object references (race, owners,
 * ware group) are slimmed to ids for a compact bundle.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const x4Repo = process.argv[2] ?? path.join(__dirname, "..", "..", "..", "x4");
const dataDir = path.join(x4Repo, "src", "app", "shared", "services", "data");
const outFile = path.join(__dirname, "..", "data", "encyclopedia.json");

if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}\nPass the x4 repo path: node scripts/build-encyclopedia.mjs /path/to/x4`);
    process.exit(1);
}

// Dependency order (later files reference earlier ones)
const FILES = [
    "size-data", "ship-type-data", "ship-purpose-data", "transport-data",
    "effects-data", "production-method-data", "cargo-types-data",
    "turret-type-data", "equipment-class-data", "equipment-type-data",
    "module-types-data", "race-data", "ware-groups-data", "factions-data",
    "wares-data", "workers-data", "ships-data", "modules-data", "equipment-data",
];

function tsToJs(source) {
    const out = [];
    let block = null; // 'enum' | 'class'
    let depth = 0;    // brace depth inside the current block
    const braceDelta = (line) =>
        (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;

    for (const raw of source.split("\n")) {
        let line = raw;
        if (/^\s*import\s/.test(line) || /^\/\* tslint/.test(line)) continue;

        const enumMatch = line.match(/^\s*export enum (\w+) {/);
        const classMatch = line.match(/^\s*export class (\w+) {/);
        if (enumMatch) { block = "enum"; depth = 1; out.push(`const ${enumMatch[1]} = {`); continue; }
        if (classMatch) { block = "class"; depth = 1; out.push(`const ${classMatch[1]} = {`); continue; }

        if (block) {
            if (depth + braceDelta(line) === 0) {
                out.push("};");
                block = null;
                continue;
            }
            depth += braceDelta(line);
            if (block === "enum") {
                line = line.replace(/^(\s*)(\w+)\s*=\s*/, "$1$2: ");
            } else {
                line = line
                    .replace(/^(\s*)static\s+(?:readonly\s+)?(\w+)\s*=\s*/, "$1$2: ")
                    .replace(/;\s*$/, ",");
            }
            out.push(line);
            continue;
        }

        out.push(line
            .replace(/^export const /, "const ")
            // strip simple parameter type annotations, e.g. get(method: string)
            .replace(/\((\w+): \w+\)/, "($1)"));
    }
    return out.join("\n");
}

const program = FILES
    .map((name) => tsToJs(fs.readFileSync(path.join(dataDir, `${name}.ts`), "utf8"))
        // several files use a private `const entities` - namespace it per file
        .replace(/\bentities\b/g, `entities_${name.replaceAll("-", "_")}`))
    .join("\n\n") +
    "\n;({ Ships, AllWares, AllModules, Equipments, Factions, Races, WareGroups, Workers })";

const raw = vm.runInNewContext(program, {}, { timeout: 30000 });

/* ------------------------------------------------------------------ slimming */

const idOf = (value) => (value && typeof value === "object" && value.id ? value.id : value);

function slimEntity(entity) {
    const slim = { ...entity };
    for (const key of ["race", "makerRace", "group", "faction"]) {
        if (slim[key] != null) slim[key] = idOf(slim[key]);
    }
    for (const key of ["owners", "races"]) {
        if (Array.isArray(slim[key])) slim[key] = slim[key].map(idOf);
    }
    delete slim.icon;
    delete slim.version;
    return slim;
}

const stripAll = (aggregate) =>
    Object.values(aggregate).filter((value) => value && typeof value === "object" && value.id);

const encyclopedia = {
    source: "samscarrow/x4 static game database",
    ships: raw.Ships.map(slimEntity),
    wares: raw.AllWares.map(slimEntity),
    modules: raw.AllModules.map(slimEntity),
    equipment: raw.Equipments.map(slimEntity),
    factions: stripAll(raw.Factions).map((faction) => {
        const slim = slimEntity(faction);
        delete slim.licenses;
        return { ...slim, license_count: faction.licenses?.length ?? 0 };
    }),
    races: stripAll(raw.Races).map(slimEntity),
    ware_groups: stripAll(raw.WareGroups).map(slimEntity),
};

/* ------------------------------------------------- reverse index: used_in */

const consumers = new Map(); // ware id -> [{category, id, name}]
function indexProduction(category, entities) {
    for (const entity of entities) {
        for (const recipe of entity.production ?? []) {
            for (const input of recipe.wares ?? []) {
                if (!consumers.has(input.ware)) consumers.set(input.ware, []);
                const list = consumers.get(input.ware);
                if (!list.some((ref) => ref.id === entity.id)) {
                    list.push({ category, id: entity.id, name: entity.name });
                }
            }
        }
    }
}
indexProduction("wares", encyclopedia.wares);
indexProduction("modules", encyclopedia.modules);
indexProduction("equipment", encyclopedia.equipment);

for (const ware of encyclopedia.wares) {
    ware.used_in = consumers.get(ware.id) ?? [];
}

/* --------------------------------------------------------------------- emit */

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(encyclopedia));

const counts = Object.fromEntries(
    Object.entries(encyclopedia)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, value.length])
);
console.log(`Wrote ${outFile} (${Math.round(fs.statSync(outFile).size / 1024)} KB)`);
console.log(JSON.stringify(counts));
