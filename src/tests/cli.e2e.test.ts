import assert from "node:assert/strict";
import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createApplication } from "../app/application.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli/kangmin.js");

function run(
  args: string[],
  environment: Record<string, string>
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
}

test("真实 CLI 子进程跨重启持久化，JSON stdout 保持纯净", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-cli-"));
  const databasePath = join(directory, "records.sqlite");
  const bootstrap = createApplication(databasePath);
  const token = bootstrap.sessions.createDevelopmentSession("patient-cli").token;
  bootstrap.close();

  const environment = {
    KANGMIN_DB_PATH: databasePath,
    KANGMIN_SESSION_TOKEN: token
  };
  const add = run([
    "record", "symptom", "add",
    "--local-date", "2026-07-31",
    "--nasal-congestion", "2",
    "--nasal-itching", "1",
    "--sneezing", "3",
    "--runny-nose", "2",
    "--idempotency-key", "cli-20260731",
    "--json"
  ], environment);

  assert.equal(add.status, 0, add.stderr);
  assert.equal(add.stderr, "");
  assert.equal(add.stdout.trim().split("\n").length, 1);
  const created = JSON.parse(add.stdout) as {
    ok: boolean;
    data: { id: string; tnssTotal: number };
  };
  assert.equal(created.ok, true);
  assert.equal(created.data.tnssTotal, 8);

  const list = run(
    ["record", "symptom", "list", "--json"],
    environment
  );
  assert.equal(list.status, 0, list.stderr);
  const listed = JSON.parse(list.stdout) as {
    ok: boolean;
    data: { items: Array<{ id: string }> };
  };
  assert.equal(listed.data.items[0]?.id, created.data.id);

  const crossBootstrap = createApplication(databasePath);
  const otherToken =
    crossBootstrap.sessions.createDevelopmentSession("patient-other").token;
  crossBootstrap.close();
  const cross = run(
    ["record", "symptom", "show", created.data.id, "--json"],
    {
      KANGMIN_DB_PATH: databasePath,
      KANGMIN_SESSION_TOKEN: otherToken
    }
  );
  assert.equal(cross.status, 3);
  const denied = JSON.parse(cross.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(denied.error.code, "resource_not_found");
});

test("存储启动失败与空列表不同", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-storage-"));
  const result = run(
    ["record", "symptom", "list", "--json"],
    {
      KANGMIN_DB_PATH: directory,
      KANGMIN_SESSION_TOKEN: "not-used"
    }
  );
  assert.equal(result.status, 6);
  const body = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "storage_unavailable");
});
