import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
    classifyLogbookEntry,
    classifyCredits,
    classifyRelation,
    EventDiffer,
} = require("../../utils/eventClassifier.js");

test("logbook classification: combat urgent, money notable, else info", () => {
    assert.equal(classifyLogbookEntry({ title: "Ship under attack", text: "" }), "urgent");
    assert.equal(classifyLogbookEntry({ title: "Trade", text: "", money: 250000 }), "notable");
    assert.equal(classifyLogbookEntry({ title: "Trade", text: "", highlighted: true }), "notable");
    assert.equal(classifyLogbookEntry({ title: "Trade", text: "", money: 500 }), "info");
});

test("credits classification: big loss urgent, big delta notable", () => {
    assert.equal(classifyCredits(-2000000), "urgent");
    assert.equal(classifyCredits(2000000), "notable");
    assert.equal(classifyCredits(-150000), "notable");
    assert.equal(classifyCredits(500), "info");
});

test("relation classification: dropping while negative is urgent", () => {
    assert.equal(classifyRelation(2, -3), "urgent");
    assert.equal(classifyRelation(-3, -8), "urgent");
    assert.equal(classifyRelation(-3, 4), "notable");
    assert.equal(classifyRelation(4, 8), "notable");
});

const snapshot = (credits, logbook = [], mission = "Patrol") => ({
    playerProfile: { credits },
    activeMission: { name: mission },
    missionOffers: [],
    logbook,
    factions: [],
});

test("differ: baseline emits nothing, changes emit typed events", () => {
    const differ = new EventDiffer();
    assert.deepEqual(differ.diff(snapshot(1000)), []);

    const events = differ.diff(snapshot(200000, [{ id: 1, time: 5, title: "Under attack", text: "" }], "Defend"));
    const types = events.map((event) => event.type).sort();
    assert.deepEqual(types, ["active_mission_changed", "credits_changed", "logbook_entries"]);
    assert.equal(events.find((event) => event.type === "credits_changed").severity, "notable");
    assert.equal(events.find((event) => event.type === "logbook_entries").severity, "urgent");
});

test("differ: re-sent accumulated logbook entries never re-fire", () => {
    const differ = new EventDiffer();
    const logbook = [{ id: 1, time: 5, title: "Trade", text: "" }];
    differ.diff(snapshot(1000, logbook));
    assert.deepEqual(differ.diff(snapshot(1000, logbook)), []);
});

test("differ: offline and online transitions", () => {
    const differ = new EventDiffer();
    differ.diff(snapshot(1000));
    const offline = differ.diff(null);
    assert.deepEqual(offline.map((event) => event.type), ["game_offline"]);
    assert.deepEqual(differ.diff(null), []); // no repeat while stale
    const online = differ.diff(snapshot(1000));
    assert.deepEqual(online.map((event) => event.type), ["game_online"]);
});

test("differ: savegame_parsed on id change only", () => {
    const differ = new EventDiffer();
    differ.diff(snapshot(1000), { id: 3, filename: "save_003.xml.gz" });
    assert.deepEqual(differ.diff(snapshot(1000), { id: 3, filename: "save_003.xml.gz" }), []);
    const events = differ.diff(snapshot(1000), { id: 4, filename: "save_004.xml.gz" });
    assert.equal(events[0].type, "savegame_parsed");
    assert.equal(events[0].savegame_id, 4);
});

test("fleet diff: lost, added, hull crossings, uncrewed, idle", () => {
    const d = new EventDiffer();
    const base = () => ({ playerProfile: { credits: 1 }, logbook: [], factions: [] });
    const ship = (o) => ({ idcode: "AAA-1", name: "Alpha", size: "M", purpose: "fight", hull: 100, shield: 100,
        sector: "X", order: "Patrol", has_captain: true, ...o });

    // first sweep initialises silently
    assert.deepEqual(d.diff({ ...base(), fleet: [ship({}), ship({ idcode: "BBB-2", name: "Beta" })] }), []);
    // empty sweep is ignored, not treated as total loss
    assert.deepEqual(d.diff({ ...base(), fleet: [] }), []);

    let ev = d.diff({ ...base(), fleet: [ship({ hull: 40 }), ship({ idcode: "BBB-2", name: "Beta" }), ship({ idcode: "CCC-3", name: "Gamma" })] });
    assert.deepEqual(ev.map((e) => [e.type, e.severity]), [["ship_hull_critical", "notable"], ["ship_added", "notable"]]);

    ev = d.diff({ ...base(), fleet: [ship({ hull: 10, order: "", has_captain: false }), ship({ idcode: "CCC-3", name: "Gamma" })] });
    assert.deepEqual(ev.map((e) => e.type), ["ship_hull_critical", "ship_uncrewed", "ship_idle", "ship_lost"]);
    assert.equal(ev[0].severity, "urgent");
    assert.equal(ev[3].idcode, "BBB-2");
    assert.equal(ev[2].last_order, "Patrol");

    // repairs do not fire; same bucket does not re-fire
    assert.deepEqual(d.diff({ ...base(), fleet: [ship({ hull: 12, order: "", has_captain: false }), ship({ idcode: "CCC-3", name: "Gamma" })] }), []);
    assert.deepEqual(d.diff({ ...base(), fleet: [ship({ hull: 90, order: "", has_captain: false }), ship({ idcode: "CCC-3", name: "Gamma" })] }), []);
});
