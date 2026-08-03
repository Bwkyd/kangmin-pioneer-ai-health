import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { exitCodeForCode } from "../kernel/errors.js";
import type { CommandResult } from "../kernel/result.js";
import type { BrowseHome } from "../modules/browse/contracts.js";
import type { EnvironmentSnapshot } from "../modules/environment/environment-ports.js";
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

/** 临时覆盖环境变量（回调结束后恢复原值，含"未设置"状态）。 */
async function withEnvironment(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function freshDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-gates-"));
  return join(directory, "gates.sqlite");
}

/** 种子：一条管理端已启用方案 + 一条草稿方案（门禁开关测试用）。 */
function seedPlans(databasePath: string): void {
  const database = new KangminDatabase(databasePath);
  try {
    database.connection.exec(`
      INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, status, revision, display_order, created_at, updated_at
      )
      VALUES ('plan-published', '花粉季通用护理方案', 'LUNG_HEAT', '日常护理',
              '[{"step":1,"title":"生理盐水洗鼻","description":"早晚各一次"}]',
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

test("环境门禁：staging 下默认 Provider fail-closed，环境命令抛 provider_unavailable（退出码 6）", async () => {
  await withEnvironment(
    { KANGMIN_APP_ENV: undefined, KANGMIN_ALLOW_DEV_SESSION: undefined },
    async () => {
      // staging 下明文开发降级失效：注入明文端口只为绕过启动门禁，
      // 专注于验证环境 Provider 门禁本身。
      const application = createApplication(freshDatabasePath(), {
        appEnvironment: "staging",
        encryption: new PlaintextEncryption()
      });
      try {
        const current = await application.execute({
          command: "browse environment current"
        });
        assert.equal(errorCodeOf(current), "provider_unavailable");
        assert.equal(exitCodeForCode("provider_unavailable"), 6);

        const forecast = await application.execute({
          command: "browse environment forecast"
        });
        assert.equal(errorCodeOf(forecast), "provider_unavailable");

        const refresh = await application.execute({
          command: "browse environment refresh"
        });
        assert.equal(errorCodeOf(refresh), "provider_unavailable");
      } finally {
        application.close();
      }
    }
  );
});

test("环境门禁：staging 下 KANGMIN_ALLOW_DEV_SESSION=1 不放开（与加密降级同一 fail-closed 语义）", async () => {
  await withEnvironment(
    { KANGMIN_ALLOW_DEV_SESSION: "1" },
    async () => {
      const application = createApplication(freshDatabasePath(), {
        appEnvironment: "staging",
        encryption: new PlaintextEncryption()
      });
      try {
        const current = await application.execute({
          command: "browse environment current"
        });
        assert.equal(errorCodeOf(current), "provider_unavailable");
      } finally {
        application.close();
      }
    }
  );
});

test("环境门禁：production 与未设 APP_ENV 且未显式开发降级同样 fail-closed", async () => {
  const production = createApplication(freshDatabasePath(), {
    appEnvironment: "production",
    encryption: new PlaintextEncryption()
  });
  try {
    const current = await production.execute({
      command: "browse environment current"
    });
    assert.equal(errorCodeOf(current), "provider_unavailable");
  } finally {
    production.close();
  }

  // CLI 路径未设 KANGMIN_APP_ENV（environment=process.env）：
  // 未显式 ALLOW_DEV_SESSION 时同样拒绝，不返回测试桩假数据。
  await withEnvironment(
    { KANGMIN_APP_ENV: undefined, KANGMIN_ALLOW_DEV_SESSION: undefined },
    async () => {
      const application = createApplication(freshDatabasePath(), {
        encryption: new PlaintextEncryption()
      });
      try {
        const current = await application.execute({
          command: "browse environment current"
        });
        assert.equal(errorCodeOf(current), "provider_unavailable");
      } finally {
        application.close();
      }
    }
  );
});

test("环境门禁：local 下行为不变，测试替身返回固定快照", async () => {
  const application = createApplication(freshDatabasePath(), {
    appEnvironment: "local"
  });
  try {
    const current = dataOf<EnvironmentSnapshot>(
      await application.execute({ command: "browse environment current" })
    );
    assert.equal(current.sourceLabel, "test-double");
    assert.equal(current.city, "成都");
    assert.equal(current.stale, false);
  } finally {
    application.close();
  }
});

test("环境门禁：未设 APP_ENV + 显式 KANGMIN_ALLOW_DEV_SESSION=1 → 可用（兼容既有 CLI e2e）", async () => {
  await withEnvironment(
    { KANGMIN_APP_ENV: undefined, KANGMIN_ALLOW_DEV_SESSION: "1" },
    async () => {
      const application = createApplication(freshDatabasePath());
      try {
        const current = dataOf<EnvironmentSnapshot>(
          await application.execute({ command: "browse environment current" })
        );
        assert.equal(current.sourceLabel, "test-double");
      } finally {
        application.close();
      }
    }
  );
});

test("方案开关：KANGMIN_PLAN_BROWSE_ENABLED=1 且有 enabled 方案 → plan list 返回真实数据", async () => {
  await withEnvironment(
    {
      KANGMIN_PLAN_BROWSE_ENABLED: "1",
      KANGMIN_APP_ENV: undefined,
      KANGMIN_ALLOW_DEV_SESSION: "1"
    },
    async () => {
      const databasePath = freshDatabasePath();
      seedPlans(databasePath);
      const application = createApplication(databasePath);
      try {
        const listed = dataOf<{ items: Array<{ id: string; name: string }> }>(
          await application.execute({ command: "browse plan list" })
        );
        // 管理端门禁独立生效：status='draft' 的方案仍不可见。
        assert.deepEqual(
          listed.items.map((item) => item.id),
          ["plan-published"]
        );
        assert.equal(listed.items[0]?.name, "花粉季通用护理方案");

        const shown = dataOf<{ id: string; steps: unknown[] }>(
          await application.execute({
            command: "browse plan show",
            input: { id: "plan-published" }
          })
        );
        assert.equal(shown.id, "plan-published");
        assert.equal(shown.steps.length, 1);

        const searched = dataOf<{ plans: Array<{ id: string }> }>(
          await application.execute({
            command: "browse search",
            input: { query: "护理" }
          })
        );
        assert.deepEqual(
          searched.plans.map((item) => item.id),
          ["plan-published"]
        );
      } finally {
        application.close();
      }
    }
  );
});

test("方案开关：默认关闭（未设 KANGMIN_PLAN_BROWSE_ENABLED）时维持空列表", async () => {
  await withEnvironment(
    {
      KANGMIN_PLAN_BROWSE_ENABLED: undefined,
      KANGMIN_APP_ENV: undefined,
      KANGMIN_ALLOW_DEV_SESSION: "1"
    },
    async () => {
      const databasePath = freshDatabasePath();
      seedPlans(databasePath);
      const application = createApplication(databasePath);
      try {
        const listed = dataOf<{ items: unknown[] }>(
          await application.execute({ command: "browse plan list" })
        );
        assert.deepEqual(listed.items, []);
      } finally {
        application.close();
      }
    }
  );
});

test("browse 首页环境区块三态：ok（--location 命中）/ no_location（未指定）/ unavailable（门禁拒绝，不拖垮首页）", async () => {
  // ok + no_location：开发降级环境下测试替身可取数。
  await withEnvironment(
    { KANGMIN_APP_ENV: undefined, KANGMIN_ALLOW_DEV_SESSION: "1" },
    async () => {
      const databasePath = freshDatabasePath();
      seedContent(databasePath);
      const application = createApplication(databasePath);
      try {
        const home = dataOf<BrowseHome>(
          await application.execute({
            command: "browse",
            input: { location: "成都" }
          })
        );
        assert.ok(home.articles.length > 0);
        assert.equal(home.environment.status, "ok");
        if (home.environment.status === "ok") {
          assert.equal(home.environment.current.city, "成都");
          assert.equal(home.environment.current.sourceLabel, "test-double");
        }

        const noLocation = dataOf<BrowseHome>(
          await application.execute({ command: "browse" })
        );
        assert.deepEqual(noLocation.environment, { status: "no_location" });
        assert.ok(noLocation.articles.length > 0);

        const invalid = await application.execute({
          command: "browse",
          input: { location: "" }
        });
        assert.equal(errorCodeOf(invalid), "validation_failed");
      } finally {
        application.close();
      }
    }
  );

  // unavailable：staging 下门禁拒绝，首页其余区块不受影响。
  const stagingPath = freshDatabasePath();
  seedContent(stagingPath);
  const staging = createApplication(stagingPath, {
    appEnvironment: "staging",
    encryption: new PlaintextEncryption()
  });
  try {
    const home = dataOf<BrowseHome>(
      await staging.execute({
        command: "browse",
        input: { location: "成都" }
      })
    );
    assert.ok(home.articles.length > 0);
    assert.deepEqual(home.environment, {
      status: "unavailable",
      code: "provider_unavailable"
    });
  } finally {
    staging.close();
  }
});
