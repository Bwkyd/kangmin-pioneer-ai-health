import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import { KangminDatabase } from "@kangmin/database/sqlite/database";
import { SqliteContentReadRepository } from "@kangmin/database/sqlite/content-read-repository";
import { TestEnvironmentProvider } from "@kangmin/integrations/environment/test-environment-provider";
import type { CommandResult } from "@kangmin/core/kernel/result";
import type {
  BrowseSearchResults,
  CarePlanDetail,
  PublicContent
} from "@kangmin/core/content/browse/contracts";
import type { RulePackage } from "@kangmin/core/intelligence/clinical-rules/domain";
import { DRAFT_RULE_PACKAGE } from "@kangmin/core/intelligence/clinical-rules/rule-package";
import type { EnvironmentSnapshot, ForecastDay } from "@kangmin/core/content/environment/environment-ports";
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

/**
 * 种子：管理端已启用/草稿方案（评审 R2 P1 双门禁：agent_plans.status=
 * 'enabled' 是管理端/匹配门禁，患者可见还需临床规则包 approved）+
 * string[] 与非法 steps_json 格式（评审 R2 P2 契约兼容测试用）。
 */
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
              '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
             ('plan-string-steps', '管理端 string[] 步骤方案', 'LUNG_HEAT',
              '日常护理', '["生理盐水洗鼻","外出佩戴口罩"]',
              '注意事项', '风险提示', '禁忌', 'enabled', 1, 2,
              '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
             ('plan-bad-steps', '非法步骤格式方案', 'LUNG_HEAT', '日常护理',
              '{"step":1,"title":"不是数组"}',
              '', '', '', 'enabled', 1, 3,
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

/**
 * candidate 模拟包（评审 P1-12 同源语义）：方案浏览门禁由生效规则包状态
 * 派生——注入 candidate 模拟"未冻结"（浏览关闭），缺省为冻结包（放开）。
 */
function candidatePackage(): RulePackage {
  return {
    ...DRAFT_RULE_PACKAGE,
    version: "clinical-rules-test-candidate",
    status: "candidate"
  };
}

function fixture(
  options: { provider?: TestEnvironmentProvider; rulePackage?: RulePackage } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-browse-inc-"));
  const databasePath = join(directory, "content.sqlite");
  seedContent(databasePath);
  seedPlans(databasePath);
  const provider = options.provider ?? new TestEnvironmentProvider();
  return {
    databasePath,
    provider,
    application: createApplication(databasePath, {
      environmentProvider: provider,
      rulePackage: options.rulePackage
    })
  };
}

test("browse article/video show：返回来源与免责声明（§25.5 患者侧 9）", async () => {
  const { application } = fixture();
  try {
    const article = dataOf<PublicContent>(
      await application.execute({
        command: "browse article show",
        input: { id: "article-public" }
      })
    );
    assert.ok(article.source.length > 0);
    assert.equal(article.source, "已审核测试来源");
    assert.ok(article.disclaimer.length > 0);
    assert.ok(article.disclaimer.includes("不代替门诊诊断"));

    const video = dataOf<PublicContent>(
      await application.execute({
        command: "browse video show",
        input: { id: "video-public" }
      })
    );
    assert.ok(video.source.length > 0);
    assert.ok(video.disclaimer.length > 0);
    assert.ok(video.disclaimer.includes("不代替门诊诊断"));
  } finally {
    application.close();
  }
});

test("评审 R2 P1 双门禁：candidate 下方案浏览关闭（list 空、show resource_not_found、搜索不含方案）", async () => {
  // 同源派生（评审 P1-12）：注入 candidate 模拟未冻结，浏览门禁关闭。
  const { application } = fixture({ rulePackage: candidatePackage() });
  try {
    // 临床规则包未冻结（candidate）时，browse plan 患者可见门禁关闭：
    // 管理端启用（agent_plans.status='enabled'）的方案也绝不公开给
    // 匿名患者——candidate 包应关闭患者方案入口，患者无法经
    // browse plan show 拿到完整调理方案（含穴位/疗程文本）。
    const listed = dataOf<{ items: Array<{ id: string }> }>(
      await application.execute({ command: "browse plan list" })
    );
    assert.deepEqual(listed.items, []);

    // 即便方案已管理端启用，患者 show 也是 resource_not_found。
    const shown = await application.execute({
      command: "browse plan show",
      input: { id: "plan-published" }
    });
    assert.equal(errorCodeOf(shown), "resource_not_found");

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

    const searched = dataOf<BrowseSearchResults>(
      await application.execute({
        command: "browse search",
        input: { query: "护理" }
      })
    );
    // 跨类型搜索同样不出现任何方案（门禁关闭与已发布状态无关）。
    assert.deepEqual(searched.plans, []);
  } finally {
    application.close();
  }
});

test("方案双门禁与 steps 双格式（仓储级）：门禁关闭短路，打开后 string[]/对象数组都渲染", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-plan-gate-"));
  const databasePath = join(directory, "plans.sqlite");
  seedPlans(databasePath);
  const database = new KangminDatabase(databasePath);
  try {
    // 门禁关闭（默认，= candidate 组合根未注入 planBrowseEnabled）：
    // 策略性短路返回空/null，不触达存储。
    const closed = new SqliteContentReadRepository(database);
    assert.deepEqual(await closed.listPlans(), []);
    assert.equal(await closed.findPlan("plan-published"), null);
    assert.deepEqual(await closed.searchPlans("护理", 10), []);

    // 门禁打开（规则包 approved 后组合根注入 planBrowseEnabled: true）：
    // status='enabled' 才可见，draft 仍隐藏（管理端门禁独立生效）。
    const open = new SqliteContentReadRepository(database, {
      planBrowseEnabled: true
    });
    const listed = await open.listPlans();
    assert.deepEqual(
      listed.map((item) => item.id).sort(),
      ["plan-bad-steps", "plan-published", "plan-string-steps"]
    );

    // 对象数组格式（当前种子/浏览端格式）。
    const detail = await open.findPlan("plan-published");
    assert.ok(detail !== null);
    assert.equal(detail.name, "花粉季通用护理方案");
    assert.equal(detail.publishedRevision, 1);
    assert.equal(detail.steps.length, 2);
    assert.equal(detail.steps[0]?.step, 1);
    assert.equal(detail.steps[0]?.title, "生理盐水洗鼻");
    assert.equal(detail.steps[0]?.description, "早晚各一次");
    // 临床字段投影（issue-151）：precautions/risks/contraindications
    // 原样透出；无视频引用为 null。
    assert.equal(detail.precautions, "注意事项");
    assert.equal(detail.risks, "风险提示");
    assert.equal(detail.contraindications, "禁忌");
    assert.equal(detail.videoResourceId, null);

    // string[] 格式（管理端 AgentPlan.steps 历史契约）→ 按数组顺序
    // 映射为 {step: i+1, title}（评审 R2 P2：修复前稳定返回 steps:[]）。
    const stringSteps = await open.findPlan("plan-string-steps");
    assert.ok(stringSteps !== null);
    assert.deepEqual(stringSteps.steps, [
      { step: 1, title: "生理盐水洗鼻" },
      { step: 2, title: "外出佩戴口罩" }
    ]);

    // 非法 steps_json（非数组）→ 空列表，绝不宽松解析。
    const bad = await open.findPlan("plan-bad-steps");
    assert.ok(bad !== null);
    assert.deepEqual(bad.steps, []);

    assert.equal(await open.findPlan("plan-draft"), null);
    assert.deepEqual(
      (await open.searchPlans("护理", 10)).map((item) => item.id),
      ["plan-published"]
    );

    // 有视频引用的方案透出 videoResourceId（引用已发布视频内容）。
    database.connection.exec(`
      INSERT INTO content_items(
        id, kind, title, category, summary, source, status,
        patient_visible, version_valid, media_available, published_at,
        updated_at, revision
      ) VALUES ('video-for-plan', 'video', '方案视频', '居家护理', '摘要',
                '来源', 'published', 1, 1, 1,
                '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 1);
      INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, video_resource_id, status, revision,
        display_order, created_at, updated_at
      ) VALUES ('plan-with-video', '带视频方案', 'LUNG_HEAT', '日常护理',
                '["步骤一"]', '注意事项B', '风险提示B', '禁忌B',
                'video-for-plan', 'enabled', 1, 4,
                '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    `);
    const withVideo = await open.findPlan("plan-with-video");
    assert.ok(withVideo !== null);
    assert.equal(withVideo.videoResourceId, "video-for-plan");
    assert.equal(withVideo.precautions, "注意事项B");
    assert.equal(withVideo.risks, "风险提示B");
    assert.equal(withVideo.contraindications, "禁忌B");
  } finally {
    database.close();
  }
});

test("browse plan show 透出临床字段（服务层，门禁打开；issue-151）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-plan-fields-"));
  const databasePath = join(directory, "plans.sqlite");
  seedContent(databasePath);
  seedPlans(databasePath);
  // 患者可见门禁与规则包状态同源（评审 P1-12）：冻结包 approved 即放开，
  // 无需环境变量；验证命令层输出携带临床字段。
  const application = createApplication(databasePath, {
    environmentProvider: new TestEnvironmentProvider()
  });
  try {
    const shown = dataOf<CarePlanDetail>(
      await application.execute({
        command: "browse plan show",
        input: { id: "plan-published" }
      })
    );
    assert.equal(shown.id, "plan-published");
    assert.equal(shown.precautions, "注意事项");
    assert.equal(shown.risks, "风险提示");
    assert.equal(shown.contraindications, "禁忌");
    assert.equal(shown.videoResourceId, null);
  } finally {
    application.close();
  }
});

test("browse search 跨文章/视频/方案，只覆盖已发布（candidate 下方案门禁关闭）", async () => {
  // 同源派生：注入 candidate 模拟未冻结，搜索不含方案。
  const { application } = fixture({ rulePackage: candidatePackage() });
  try {
    const results = dataOf<BrowseSearchResults>(
      await application.execute({
        command: "browse search",
        input: { query: "护理" }
      })
    );
    // “鼻腔护理基础视频”（video-public）命中；“花粉季通用护理方案”
    // （plan-published）虽管理端启用，但规则包未冻结 → 患者搜索不可见。
    assert.deepEqual(results.videos.map((item) => item.id), ["video-public"]);
    assert.deepEqual(results.plans, []);
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
  // 同源派生：注入 candidate 模拟未冻结，验证门禁关闭下不要求会话。
  const { application } = fixture({ rulePackage: candidatePackage() });
  try {
    const list = dataOf<{ items: unknown[] }>(
      await application.execute({ command: "browse article list" })
    );
    assert.ok(list.items.length > 0);

    // candidate 下方案浏览门禁关闭：匿名/登录均返回空列表（门禁与
    // 会话无关，规则包 approved 后开放，见仓储级双门禁测试）。
    const plans = dataOf<{ items: unknown[] }>(
      await application.execute({ command: "browse plan list" })
    );
    assert.equal(plans.items.length, 0);

    const env = dataOf<EnvironmentSnapshot>(
      await application.execute({ command: "browse environment current" })
    );
    assert.equal(env.stale, false);
  } finally {
    application.close();
  }
});

test("读失败必须抛 storage_unavailable，不伪装成空列表", async () => {
  // 同源派生：注入 candidate，方案浏览门禁关闭（短路语义验证用）。
  const { application } = fixture({ rulePackage: candidatePackage() });
  application.close(); // 关闭底层连接后任何读取都是存储故障
  const list = await application.execute({ command: "browse article list" });
  assert.equal(errorCodeOf(list), "storage_unavailable");

  // 方案浏览门禁在 candidate 下关闭：策略性短路返回空列表，不触达
  // 存储（关闭门禁的确定响应，不是伪装成空数据）；门禁打开后的存储
  // 故障仍由 guard 映射 storage_unavailable（见仓储级测试）。
  const plans = await application.execute({ command: "browse plan list" });
  assert.equal(plans.ok, true);
  if (plans.ok) {
    assert.deepEqual(plans.data, { items: [] });
  }

  const env = await application.execute({
    command: "browse environment current"
  });
  assert.equal(errorCodeOf(env), "storage_unavailable");
});
