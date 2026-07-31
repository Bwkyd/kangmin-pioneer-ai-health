import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { TestEnvironmentProvider } from "../infrastructure/test-environment-provider.js";
import type { CommandResult } from "../kernel/result.js";
import type {
  BrowseSearchResults,
  CarePlanDetail
} from "../modules/browse/contracts.js";
import type { EnvironmentSnapshot, ForecastDay } from "../modules/environment/environment-ports.js";
import { seedContent } from "./content-fixture.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

function errorCodeOf(result: CommandResult): string {
  assert.equal(result.ok, false);
  if (result.ok) {
    return "";
  }
  return result.error.code;
}

/** 种子：已发布/未发布方案 + 环境快照。 */
function seedPlans(databasePath: string): void {
  const database = new KangminDatabase(databasePath);
  try {
    database.connection.exec(`
      INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, status, revision, display_order, created_at, updated_at
      )
      VALUES ('plan-published', '花粉季通用护理方案', 'LUNG_HEAT', '日常护理',
              '[{"step":1,"title":"生理盐水洗鼻","description":"早晚各一次"},{"step":2,"title":"外出佩戴口罩"}]',
              '注意事项', '风险提示', '禁忌', 'enabled', 1, 0,
              '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
             ('plan-draft', '未发布方案', 'LUNG_QI_COLD', '日常护理', '[]',
              '', '', '', 'draft', 1, 1,
              '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    `);
  } finally {
    database.close();
  }
}

/** 种子：一条已过期（expires_at 在过去）的环境快照。 */
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

function fixture(options: { provider?: TestEnvironmentProvider } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-browse-inc-"));
  const databasePath = join(directory, "content.sqlite");
  seedContent(databasePath);
  seedPlans(databasePath);
  const provider = options.provider ?? new TestEnvironmentProvider();
  return {
    databasePath,
    provider,
    application: createApplication(databasePath, {
      environmentProvider: provider
    })
  };
}

test("通用方案：已发布可见，未发布/草稿不可见，搜索只覆盖已发布", async () => {
  const { application } = fixture();
  try {
    const listed = dataOf<{ items: Array<{ id: string }> }>(
      await application.execute({ command: "browse plan list" })
    );
    assert.deepEqual(listed.items.map((item) => item.id), ["plan-published"]);

    const shown = dataOf<CarePlanDetail>(
      await application.execute({
        command: "browse plan show",
        input: { id: "plan-published" }
      })
    );
    assert.equal(shown.name, "花粉季通用护理方案");
    assert.equal(shown.publishedRevision, 1);
    assert.equal(shown.steps.length, 2);
    assert.equal(shown.steps[0]?.title, "生理盐水洗鼻");
    assert.match(shown.disclaimer ?? "", /本内容仅作健康科普和居家管理参考/u);

    const hidden = await application.execute({
      command: "browse plan show",
      input: { id: "plan-draft" }
    });
    assert.equal(errorCodeOf(hidden), "resource_not_found");

    const missing = await application.execute({
      command: "browse plan show",
      input: { id: "no-such-plan" }
    });
    assert.equal(errorCodeOf(missing), "resource_not_found");

    const leaked = dataOf<BrowseSearchResults>(
      await application.execute({
        command: "browse search",
        input: { query: "未发布" }
      })
    );
    // 跨类型搜索整体不出现未发布方案（也不出现草稿内容）。
    assert.deepEqual(leaked.articles, []);
    assert.deepEqual(leaked.videos, []);
    assert.deepEqual(leaked.plans, []);
  } finally {
    application.close();
  }
});

test("browse search 跨文章/视频/方案，只覆盖已发布", async () => {
  const { application } = fixture();
  try {
    const results = dataOf<BrowseSearchResults>(
      await application.execute({
        command: "browse search",
        input: { query: "护理" }
      })
    );
    // “鼻腔护理基础视频”（video-public）与“花粉季通用护理方案”（plan-published）。
    assert.deepEqual(results.videos.map((item) => item.id), ["video-public"]);
    assert.deepEqual(results.plans.map((item) => item.id), ["plan-published"]);
    assert.deepEqual(results.articles, []);

    const all = dataOf<BrowseSearchResults>(
      await application.execute({
        command: "browse search",
        input: { query: "鼻" }
      })
    );
    assert.deepEqual(all.articles.map((item) => item.id), ["article-public"]);
    assert.deepEqual(all.videos.map((item) => item.id), ["video-public"]);

    const empty = dataOf<BrowseSearchResults>(
      await application.execute({
        command: "browse search",
        input: { query: "草稿秘密" }
      })
    );
    assert.deepEqual(empty.articles, []);
    assert.deepEqual(empty.videos, []);
    assert.deepEqual(empty.plans, []);

    const longQuery = await application.execute({
      command: "browse search",
      input: { query: "x".repeat(201) }
    });
    assert.equal(errorCodeOf(longQuery), "validation_failed");
  } finally {
    application.close();
  }
});

test("列表分页：limit 默认 20、上限 100 截断、offset 生效", async () => {
  const { application } = fixture();
  try {
    const paged = dataOf<{ items: unknown[]; limit: number; offset: number }>(
      await application.execute({
        command: "browse article list",
        input: { limit: 1000 }
      })
    );
    assert.equal(paged.limit, 100); // 超出上限被截断
    assert.equal(paged.offset, 0);
    assert.deepEqual(paged.items.map((item) => (item as { id: string }).id), ["article-public"]);

    const beyond = dataOf<{ items: unknown[] }>(
      await application.execute({
        command: "browse video list",
        input: { offset: 5 }
      })
    );
    assert.deepEqual(beyond.items, []);

    const badLimit = await application.execute({
      command: "browse article list",
      input: { limit: 0 }
    });
    assert.equal(errorCodeOf(badLimit), "validation_failed");
  } finally {
    application.close();
  }
});

test("环境：无缓存时取数并落缓存；过期快照返回 stale 标记", async () => {
  const { application, databasePath } = fixture();
  try {
    const fresh = dataOf<EnvironmentSnapshot>(
      await application.execute({
        command: "browse environment current",
        input: { city: "成都" }
      })
    );
    assert.equal(fresh.stale, false);
    assert.equal(fresh.sourceLabel, "test-double");
    assert.equal(fresh.city, "成都");
    // 花粉风险必须是风险指数而非实测浓度。
    const pollen = JSON.parse(fresh.pollenRiskJson) as {
      riskIndex: number;
      scaleMax: number;
      note?: string;
    };
    assert.equal(typeof pollen.riskIndex, "number");
    assert.equal(pollen.scaleMax, 5);

    // 第二次 current 命中缓存，不再走 provider。
    const cached = dataOf<EnvironmentSnapshot>(
      await application.execute({
        command: "browse environment current",
        input: { city: "成都" }
      })
    );
    assert.equal(cached.stale, false);
    assert.equal(cached.fetchedAt, fresh.fetchedAt);
  } finally {
    application.close();
  }

  // 过期缓存：返回 stale 标记而不是重新抓取后谎称“刚刚更新”。
  const directory = mkdtempSync(join(tmpdir(), "kangmin-env-stale-"));
  const databasePath2 = join(directory, "env.sqlite");
  seedExpiredSnapshot(databasePath2);
  const staleApp = createApplication(databasePath2, {
    environmentProvider: new TestEnvironmentProvider()
  });
  try {
    const stale = dataOf<EnvironmentSnapshot>(
      await staleApp.execute({ command: "browse environment current" })
    );
    assert.equal(stale.stale, true);
    // 即便 provider 可用，过期缓存也不重新抓取。
    assert.equal(stale.observedAt, "2026-07-01T00:00:00.000Z");
  } finally {
    staleApp.close();
  }
});

test("环境：provider 不可用且无缓存 → provider_unavailable；过期缓存仍返回 stale", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-env-fail-"));
  const databasePath = join(directory, "env.sqlite");
  const provider = new TestEnvironmentProvider({ mode: "unavailable" });
  const application = createApplication(databasePath, {
    environmentProvider: provider
  });
  try {
    const unavailable = await application.execute({
      command: "browse environment current"
    });
    assert.equal(errorCodeOf(unavailable), "provider_unavailable");

    const timeout = await application.execute({
      command: "browse environment refresh"
    });
    assert.equal(errorCodeOf(timeout), "provider_unavailable");

    provider.setMode("timeout");
    const timedOut = await application.execute({
      command: "browse environment current"
    });
    assert.equal(errorCodeOf(timedOut), "provider_timeout");
  } finally {
    application.close();
  }

  // 有过期缓存时 provider 故障不阻断：仍返回 stale 快照。
  const directory2 = mkdtempSync(join(tmpdir(), "kangmin-env-stale-fail-"));
  const databasePath2 = join(directory2, "env.sqlite");
  seedExpiredSnapshot(databasePath2);
  const staleApp = createApplication(databasePath2, {
    environmentProvider: new TestEnvironmentProvider({ mode: "unavailable" })
  });
  try {
    const stale = dataOf<EnvironmentSnapshot>(
      await staleApp.execute({ command: "browse environment current" })
    );
    assert.equal(stale.stale, true);
  } finally {
    staleApp.close();
  }
});

test("环境：未知城市 → location_unavailable；refresh 显式重取；forecast 骨架", async () => {
  const { application, provider } = fixture();
  try {
    const unknown = await application.execute({
      command: "browse environment current",
      input: { city: "不存在的地方" }
    });
    assert.equal(errorCodeOf(unknown), "location_unavailable");

    const first = dataOf<EnvironmentSnapshot>(
      await application.execute({
        command: "browse environment refresh",
        input: { city: "成都" }
      })
    );
    assert.equal(first.stale, false);

    const again = dataOf<EnvironmentSnapshot>(
      await application.execute({
        command: "browse environment refresh",
        input: { city: "成都" }
      })
    );
    // refresh 总是重新抓取：fetchedAt 随时间推进（或至少不早于上次）。
    assert.ok(again.fetchedAt >= first.fetchedAt);

    const forecast = dataOf<{ items: ForecastDay[] }>(
      await application.execute({
        command: "browse environment forecast",
        input: { city: "成都", days: 3 }
      })
    );
    assert.equal(forecast.items.length, 3);
    assert.equal(forecast.items[0]?.isForecast, true);
    assert.equal(typeof forecast.items[0]?.date, "string");

    const badDays = await application.execute({
      command: "browse environment forecast",
      input: { city: "成都", days: 8 }
    });
    assert.equal(errorCodeOf(badDays), "validation_failed");

    const badCity = await application.execute({
      command: "browse environment current",
      input: { city: "" }
    });
    assert.equal(errorCodeOf(badCity), "validation_failed");
  } finally {
    application.close();
  }
});

test("环境快照不会自动写入患者暴露记录", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-env-norecord-"));
  const databasePath = join(directory, "env.sqlite");
  const app = createApplication(databasePath, {
    environmentProvider: new TestEnvironmentProvider()
  });
  try {
    await app.execute({
      command: "browse environment current",
      input: { city: "成都" }
    });
    const database = new KangminDatabase(databasePath);
    try {
      const rows = database.connection
        .prepare("SELECT COUNT(*) AS count FROM exposure_records")
        .get() as unknown as { count: number };
      assert.equal(rows.count, 0);
    } finally {
      database.close();
    }
  } finally {
    app.close();
  }
});

test("未登录可 browse：文章/方案/环境均不要求会话令牌", async () => {
  const { application } = fixture();
  try {
    const list = dataOf<{ items: unknown[] }>(
      await application.execute({ command: "browse article list" })
    );
    assert.ok(list.items.length > 0);

    const plans = dataOf<{ items: unknown[] }>(
      await application.execute({ command: "browse plan list" })
    );
    assert.ok(plans.items.length > 0);

    const env = dataOf<EnvironmentSnapshot>(
      await application.execute({ command: "browse environment current" })
    );
    assert.equal(env.stale, false);
  } finally {
    application.close();
  }
});

test("读失败必须抛 storage_unavailable，不伪装成空列表", async () => {
  const { application } = fixture();
  application.close(); // 关闭底层连接后任何读取都是存储故障
  const list = await application.execute({ command: "browse article list" });
  assert.equal(errorCodeOf(list), "storage_unavailable");

  const plans = await application.execute({ command: "browse plan list" });
  assert.equal(errorCodeOf(plans), "storage_unavailable");

  const env = await application.execute({
    command: "browse environment current"
  });
  assert.equal(errorCodeOf(env), "storage_unavailable");
});
