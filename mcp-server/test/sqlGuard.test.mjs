import test from "node:test";
import assert from "node:assert/strict";
import { assertReadOnlySql } from "../lib/sqlGuard.mjs";

test("allows SELECT and WITH, with comments and trailing semicolon", () => {
    assert.ok(assertReadOnlySql("SELECT * FROM ships"));
    assert.ok(assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x"));
    assert.ok(assertReadOnlySql("-- note\nSELECT 1;"));
    assert.ok(assertReadOnlySql("/* block */ select 1"));
});

test("rejects writes and multiple statements", () => {
    assert.throws(() => assertReadOnlySql("DELETE FROM ships"));
    assert.throws(() => assertReadOnlySql("UPDATE ships SET hull_health = 0"));
    assert.throws(() => assertReadOnlySql("SELECT 1; DROP TABLE ships"));
    assert.throws(() => assertReadOnlySql("PRAGMA journal_mode = DELETE"));
});
