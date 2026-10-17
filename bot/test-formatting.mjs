import assert from "node:assert/strict";
import { countChangeLabel, money, numberLabel } from "./formatting.mjs";

assert.equal(money(119465920), "$119,465,920");
assert.equal(money(-27703430), "-$27,703,430");
assert.equal(money(-160236637), "-$160,236,637");
assert.equal(money(0), "$0");
assert.equal(money(null), "Not available");
assert.equal(numberLabel(1), "+1");
assert.equal(countChangeLabel(1, "star", "stars"), "+1 star");
assert.equal(countChangeLabel(-2, "star", "stars"), "-2 stars");
assert.equal(countChangeLabel(0, "employee", "employees"), "0 employees");
assert.equal(countChangeLabel(-1, "employee", "employees"), "-1 employee");
assert.equal(countChangeLabel(null, "employee", "employees"), "Not available");

console.log("PASS bot formatting: currency signs, metric units, singular/plural, and unavailable values.");
