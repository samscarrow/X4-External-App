import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTransactions, summarizeEvents } from "../lib/summaries.mjs";

const entries = [
    { entryid: 1, time: 100, money: 50000, partnername: "Argon Trade Station", eventtypename: "Trade" },
    { entryid: 2, time: 200, money: -20000, partnername: "Argon Wharf", eventtypename: "Repair" },
    { entryid: 3, time: 300, money: 120000, partnername: "Teladi Trade Station", eventtypename: "Trade" },
    { entryid: 4, time: 400, money: -500000, partnername: "Argon Shipyard", eventtypename: "Ship purchase" },
    { entryid: 5, time: 500, money: 8000, partnername: "Teladi Trade Station", eventtypename: "Trade" },
];

test("totals and default grouping by event_type", () => {
    const result = summarizeTransactions(entries);
    assert.equal(result.matched, 5);
    assert.equal(result.totals.income, 178000);
    assert.equal(result.totals.expenses, 520000);
    assert.equal(result.totals.net, -342000);
    const trade = result.groups.find((group) => group.event_type === "Trade");
    assert.equal(trade.count, 3);
    assert.equal(trade.net, 178000);
    // groups ranked by |net|: Ship purchase (500k) first
    assert.equal(result.groups[0].event_type, "Ship purchase");
});

test("direction, partner, and min_amount filters compose", () => {
    const result = summarizeTransactions(entries, {
        direction: "income",
        partner: "teladi",
        min_amount: 10000,
        group_by: "partner",
    });
    assert.equal(result.matched, 1);
    assert.equal(result.groups[0].partner, "Teladi Trade Station");
    assert.equal(result.totals.net, 120000);
});

test("newest limits before aggregation, time_range reflects filtered rows", () => {
    const result = summarizeTransactions(entries, { newest: 2 });
    assert.equal(result.matched, 2);
    assert.deepEqual(result.time_range, { from: 400, to: 500 });
});

test("in-game time bounds", () => {
    const result = summarizeTransactions(entries, { since_time: 200, until_time: 400 });
    assert.equal(result.matched, 3);
});

test("top truncates groups and reports the remainder", () => {
    const result = summarizeTransactions(entries, { group_by: "partner", top: 2 });
    assert.equal(result.groups.length, 2);
    assert.equal(result.groups_truncated, 2);
});

test("group_by none yields totals only", () => {
    const result = summarizeTransactions(entries, { group_by: "none" });
    assert.equal(result.groups.length, 0);
    assert.equal(result.totals.count, 5);
});

test("summarizeEvents digests counts, credit flow, and highlights", () => {
    const result = summarizeEvents([
        { id: 1, type: "credits_changed", severity: "notable", delta: 150000, created_at: "a" },
        { id: 2, type: "credits_changed", severity: "info", delta: -30000, created_at: "b" },
        { id: 3, type: "logbook_entries", severity: "urgent", count: 1, created_at: "c" },
        { id: 4, type: "active_mission_changed", severity: "notable", from: "A", to: "B", created_at: "d" },
    ]);
    assert.equal(result.event_count, 4);
    assert.equal(result.credits_net, 120000);
    assert.equal(result.by_severity.urgent, 1);
    assert.equal(result.urgent_events.length, 1);
    assert.deepEqual(result.mission_changes, [{ at: "d", from: "A", to: "B" }]);
});
