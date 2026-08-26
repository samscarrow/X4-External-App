import test from "node:test";
import assert from "node:assert/strict";
import {
    loadEncyclopedia,
    searchEncyclopedia,
    getEncyclopediaEntry,
    productionChain,
} from "../lib/encyclopedia.mjs";

const bundle = loadEncyclopedia();

test("bundle has all categories populated", () => {
    for (const category of ["ships", "wares", "modules", "equipment", "factions", "races"]) {
        assert.ok(bundle[category].length > 0, `${category} empty`);
    }
});

test("search ships by name substring", () => {
    const result = searchEncyclopedia(bundle, "ships", { query: "behemoth" });
    assert.ok(result.matched >= 1);
    assert.ok(result.results[0].name.includes("Behemoth"));
    assert.equal(result.results[0].type, "Destroyer");
});

test("search with composed filters: large argon fight ships", () => {
    const result = searchEncyclopedia(bundle, "ships", { size: "Large", purpose: "Fight", race: "argon" });
    assert.ok(result.matched >= 1);
    for (const ship of result.results) {
        assert.equal(ship.size, "Large");
        assert.equal(ship.purpose, "Fight");
    }
});

test("search modules by type filter and limit", () => {
    const result = searchEncyclopedia(bundle, "modules", { type: "Production", limit: 5 });
    assert.equal(result.returned, 5);
    assert.ok(result.matched > 5);
    assert.ok(result.results.every((module) => module.type === "Production"));
});

test("entry lookup by id and by name, ware used_in summarized", () => {
    const byId = getEncyclopediaEntry(bundle, "wares", "hullparts");
    assert.equal(byId.name, "Hull Parts");
    assert.ok(byId.used_in.count > 100);
    assert.ok(byId.used_in.sample.length <= 15);

    const byName = getEncyclopediaEntry(bundle, "ships", "Behemoth Vanguard");
    assert.equal(byName.id, "ship_arg_l_destroyer_01_a");
    assert.ok(byName.hull > 0);

    assert.equal(getEncyclopediaEntry(bundle, "wares", "definitely-not-a-ware"), null);
});

test("production chain expands to raw resources with scaled totals", () => {
    const chain = productionChain(bundle, "hullparts", { amount: 100 });
    assert.equal(chain.ware, "hullparts");
    assert.ok(chain.tree.inputs.length > 0);
    assert.ok(chain.totals.length > 0);
    const energy = chain.totals.find((entry) => entry.ware === "energycells");
    assert.ok(energy && energy.amount > 0);
    // a chain input that is itself produced should appear expanded in the tree
    const produced = chain.tree.inputs.find((node) => node.inputs);
    assert.ok(produced, "expected at least one intermediate input with its own inputs");
});

test("production chain resolves by name and respects method preference", () => {
    const chain = productionChain(bundle, "Hull Parts", { amount: 1, method: "teladi" });
    assert.equal(chain.ware, "hullparts");
    assert.equal(chain.tree.method, "teladi");
});
