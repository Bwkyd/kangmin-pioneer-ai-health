import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runCli } from "../cli.mjs";
import { capabilities, commandGroups } from "../core/capabilities.mjs";

test("exposes exactly four groups with two core groups", () => {
  assert.deepEqual(
    commandGroups.map((group) => group.name),
    ["consult", "health", "content", "control"],
  );
  assert.deepEqual(
    commandGroups
      .filter((group) => group.priority === "core")
      .map((group) => group.name),
    ["consult", "health"],
  );
});

test("covers every scoped open customer issue", () => {
  const expectedIssues = [69, 70, 71, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 101];
  assert.deepEqual(
    capabilities.map((capability) => capability.issue),
    expectedIssues,
  );
  assert.equal(new Set(capabilities.map((capability) => capability.issue)).size, 16);
});

test("marks aggregate issues without inventing duplicate commands", () => {
  for (const issue of [69, 70, 71]) {
    const capability = capabilities.find((item) => item.issue === issue);
    assert.equal(capability?.status, "aggregate");
    assert.equal(capability?.command, null);
    assert.ok(capability?.coveredBy?.length);
  }
});

test("fails closed for clinical and external blockers", () => {
  const clinical = capabilities.filter(
    (capability) => capability.issue >= 88 && capability.issue <= 98,
  );
  assert.ok(
    clinical.every((capability) => capability.status === "blocked_clinical"),
  );
  assert.equal(
    capabilities.find((capability) => capability.issue === 101)?.status,
    "blocked_external",
  );
});

test("returns stable JSON on stdout", () => {
  const result = runCli(["control", "capability", "show", "94", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, undefined);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "control capability show");
  assert.equal(output.data.issue, 94);
  assert.equal(output.meta.schemaVersion, "1");
});

test("uses deterministic non-zero exit for blocked capability check", () => {
  const result = runCli(["control", "capability", "check", "--json"]);
  assert.equal(result.exitCode, 5);
  assert.equal(result.stderr, undefined);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.data.releaseReady, false);
  assert.ok(output.data.blocking.length > 0);
});

test("rejects a fifth top-level group", () => {
  const result = runCli(["admin", "status", "--json"]);
  assert.equal(result.exitCode, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.data.error.code, "UNKNOWN_GROUP");
});

test("runs through the executable entrypoint", () => {
  const result = spawnSync(
    process.execPath,
    ["src/cli.mjs", "--help"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /四组命令/);
  assert.match(result.stdout, /consult/);
  assert.equal(result.stderr, "");
});
