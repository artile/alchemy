import * as assert from "node:assert/strict";
import { test } from "node:test";
import { domainRules, layoutRules, serverRules, strictRules } from "../src/configs.ts";
import { rules } from "../src/index.ts";

const names = (config: Record<string, unknown>) =>
  Object.keys(config).map((id) => id.replace(/^alchemy-domain\//, ""));

test("every config entry names a rule of the plugin", () => {
  for (const name of [
    ...names(domainRules),
    ...names(layoutRules),
    ...names(serverRules),
    ...names(strictRules),
  ]) {
    assert.ok(name in rules, `${name} is not a rule`);
  }
});

test("every rule is in exactly one of domainRules, layoutRules and strictRules", () => {
  const all = [...names(domainRules), ...names(layoutRules), ...names(strictRules)];
  assert.deepEqual([...all].sort(), Object.keys(rules).sort());
  assert.equal(new Set(all).size, all.length);
});

test("domain rules are errors; layout rules only warn", () => {
  assert.deepEqual(new Set(Object.values(domainRules)), new Set(["error"]));
  assert.deepEqual(new Set(Object.values(layoutRules)), new Set(["warn"]));
});

test("strict rules only warn", () => {
  assert.deepEqual(new Set(Object.values(strictRules)), new Set(["warn"]));
});
