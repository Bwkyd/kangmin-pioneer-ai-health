import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { KangminDatabase } from "../infrastructure/database.js";
import { seedContent } from "./content-fixture.js";

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

interface JsonResult<T = unknown> {
  ok: boolean;
  command: string;
  data: T;
  error: { code: string; message: string };
}

function parseJson<T>(result: SpawnSyncReturns<string>): JsonResult<T> {
  return JSON.parse(result.stdout) as JsonResult<T>;
}

function seedPlans(databasePath: string): void {
  const database = new KangminDatabase(databasePath);
  try {
    database.connection.exec(`
      INSERT INTO agent_care_plans(id, name, current_revision, enabled_revision, published_revision, revision)
      VALUES ('plan-published', '花粉季通用护理方案', 1, 1, 1, 1),
             ('plan-draft', '未发布方案', 1, NULL, NULL, 1);
      INSERT INTO agent_care_plan_revisions(plan_id, revision, name, summary, steps_json, disclaimer, created_by_admin_id)
      VALUES ('plan-published', 1, '花粉季通用护理方案', '适用于花粉季的居家护理',
              '[{"step":1,"title":"生理盐水洗鼻","description":"早晚各一次"},{"step":2,"title":"外出佩戴口罩"}]',
              '仅供参考，不代替医疗建议', 'admin-1'),
             ('plan-draft', 1, '未发布方案', '未发布摘要', '[]', NULL, 'admin-1');
    `);
  } finally {
    database.close();
  }
}

function seedExpiredSnapshot(databasePath: string): void {
  const database = new KangminDatabase(databasePath);
  try {
    database.connection.exec(`
      INSERT INTO environment_snapshots(
        id, provider, cache_key, city, weather_json, air_quality_json,
        pollen_risk_json, observed_at, fetched_at, expires_at, source_label
      ) VALUES (
        'snap-expired', 'test-double', '成都', '成都',
        '{"condition":"多云"}', '{"aqi":58}',
        '{"riskIndex":3,"scaleMax":5}',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:30:00.000Z', 'test-double'
      );
    `);
  } finally {
    database.close();
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-browse-cli-"));
  const databasePath = join(directory, "content.sqlite");
  seedContent(databasePath);
  seedPlans(databasePath);
  return { directory, databasePath };
}

test("未登录真实 CLI：browse 全部只读命令成功执行", () => {
  const { databasePath } = fixture();
  const environment = { KANGMIN_DB_PATH: databasePath }; // 无 KANGMIN_SESSION_TOKEN

  const list = run(["browse", "article", "list", "--json"], environment);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stderr, "");
  const listBody = parseJson<{ items: Array<{ id: string }> }>(list);
  assert.equal(listBody.ok, true);
  assert.deepEqual(listBody.data.items.map((item) => item.id), ["article-public"]);

  const plans = run(["browse", "plan", "list", "--json"], environment);
  assert.equal(plans.status, 0, plans.stderr);
  const plansBody = parseJson<{ items: Array<{ id: string }> }>(plans);
  assert.deepEqual(plansBody.data.items.map((item) => item.id), ["plan-published"]);

  const planShow = run(
    ["browse", "plan", "show", "plan-published", "--json"],
    environment
  );
  assert.equal(planShow.status, 0, planShow.stderr);
  const planBody = parseJson<{ name: string; steps: unknown[] }>(planShow);
  assert.equal(planBody.data.name, "花粉季通用护理方案");
  assert.equal(planBody.data.steps.length, 2);

  const hiddenPlan = run(
    ["browse", "plan", "show", "plan-draft", "--json"],
    environment
  );
  assert.equal(hiddenPlan.status, 3);
  assert.equal(parseJson(hiddenPlan).error.code, "resource_not_found");

  const search = run(
    ["browse", "search", "护理", "--json"],
    environment
  );
  assert.equal(search.status, 0, search.stderr);
  const searchBody = parseJson<{
    videos: Array<{ id: string }>;
    plans: Array<{ id: string }>;
  }>(search);
  assert.deepEqual(searchBody.data.videos.map((item) => item.id), ["video-public"]);
  assert.deepEqual(searchBody.data.plans.map((item) => item.id), ["plan-published"]);

  const home = run(["browse", "--json"], environment);
  assert.equal(home.status, 0, home.stderr);
  const homeBody = parseJson<{ articles: unknown[]; categories: unknown }>(home);
  assert.ok(homeBody.data.articles.length > 0);

  const paginated = run(
    ["browse", "article", "list", "--limit", "5", "--offset", "0", "--json"],
    environment
  );
  assert.equal(paginated.status, 0, paginated.stderr);
  const paginatedBody = parseJson<{ items: unknown[]; limit: number }>(paginated);
  assert.equal(paginatedBody.data.limit, 5);
});

test("真实 CLI 环境命令：current 固定数据、未知城市、provider 不可用、过期 stale", () => {
  const { databasePath } = fixture();

  const current = run(
    ["browse", "environment", "current", "--city", "成都", "--json"],
    { KANGMIN_DB_PATH: databasePath }
  );
  assert.equal(current.status, 0, current.stderr);
  const currentBody = parseJson<{
    stale: boolean;
    city: string;
    pollenRiskJson: string;
    sourceLabel: string;
  }>(current);
  assert.equal(currentBody.data.stale, false);
  assert.equal(currentBody.data.city, "成都");
  assert.equal(currentBody.data.sourceLabel, "test-double");
  const pollen = JSON.parse(currentBody.data.pollenRiskJson) as {
    riskIndex: number;
    scaleMax: number;
  };
  assert.equal(typeof pollen.riskIndex, "number");
  assert.equal(pollen.scaleMax, 5);

  const unknownCity = run(
    ["browse", "environment", "current", "--city", "不存在的地方", "--json"],
    { KANGMIN_DB_PATH: databasePath }
  );
  assert.equal(unknownCity.status, 6);
  assert.equal(parseJson(unknownCity).error.code, "location_unavailable");

  const forecast = run(
    ["browse", "environment", "forecast", "--days", "2", "--json"],
    { KANGMIN_DB_PATH: databasePath }
  );
  assert.equal(forecast.status, 0, forecast.stderr);
  const forecastBody = parseJson<{ items: Array<{ isForecast: boolean }> }>(forecast);
  assert.equal(forecastBody.data.items.length, 2);
  assert.equal(forecastBody.data.items[0]?.isForecast, true);

  // provider 故障必须在无缓存的新库上验证：上面的 current 已把成都写入缓存，
  // 命中新鲜缓存时不会触达 provider。
  const freshDirectory = mkdtempSync(join(tmpdir(), "kangmin-browse-cli-fail-"));
  const freshDatabasePath = join(freshDirectory, "content.sqlite");
  seedContent(freshDatabasePath);
  const unavailable = run(
    ["browse", "environment", "current", "--json"],
    { KANGMIN_DB_PATH: freshDatabasePath, KANGMIN_ENV_PROVIDER_MODE: "unavailable" }
  );
  assert.equal(unavailable.status, 6);
  assert.equal(parseJson(unavailable).error.code, "provider_unavailable");

  const timeout = run(
    ["browse", "environment", "refresh", "--json"],
    { KANGMIN_DB_PATH: freshDatabasePath, KANGMIN_ENV_PROVIDER_MODE: "timeout" }
  );
  assert.equal(timeout.status, 6);
  assert.equal(parseJson(timeout).error.code, "provider_timeout");
});

test("真实 CLI：过期缓存返回 stale 标记，参数错误退出码正确", () => {
  const { databasePath } = fixture();
  seedExpiredSnapshot(databasePath);

  const stale = run(
    ["browse", "environment", "current", "--json"],
    { KANGMIN_DB_PATH: databasePath }
  );
  assert.equal(stale.status, 0, stale.stderr);
  const staleBody = parseJson<{ stale: boolean; observedAt: string }>(stale);
  assert.equal(staleBody.data.stale, true);
  assert.equal(staleBody.data.observedAt, "2026-07-01T00:00:00.000Z");

  const missingQuery = run(["browse", "search", "--json"], { KANGMIN_DB_PATH: databasePath });
  assert.equal(missingQuery.status, 2);
  assert.equal(parseJson(missingQuery).error.code, "command_invalid");

  const badLimit = run(
    ["browse", "article", "list", "--limit", "0", "--json"],
    { KANGMIN_DB_PATH: databasePath }
  );
  assert.equal(badLimit.status, 7);
  assert.equal(parseJson(badLimit).error.code, "validation_failed");
});

test("真实 CLI：存储不可用与空数据不同，browse 抛 storage_unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-browse-storage-"));
  const result = run(
    ["browse", "article", "list", "--json"],
    { KANGMIN_DB_PATH: directory } // 指向目录而非文件 → 启动即存储故障
  );
  assert.equal(result.status, 6);
  const body = parseJson(result);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "storage_unavailable");
});
