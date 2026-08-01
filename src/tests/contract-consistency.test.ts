import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import { createKangminHttpServer } from "../http/server.js";

// 测试进程以本地开发模式启动：未配置 KANGMIN_ENCRYPTION_KEYS 时，
// 组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为 PlaintextEncryption
//（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";


const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli/kangmin.js");

/**
 * 契约一致性：CLI 与 HTTP 必须共享同一命令语义（架构 §10.3），
 * 稳定字段（ok/command/status/data/error.code/receipt.requestId）完全一致，
 * 只允许 meta.timestamp 和随时间变化的字段不同。
 */
test("同一命令经 CLI 与 HTTP 返回一致契约（成功路径）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-contract-"));
  const databasePath = join(directory, "records.sqlite");
  const application = createApplication(databasePath);
  const token =
    (await application.sessions.createDevelopmentSession("contract-patient")).token;

  const server = createKangminHttpServer(application);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") {
    assert.fail("HTTP server did not expose a TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const command = "record symptom add";
    const input = {
      localDate: "2026-07-29",
      nasalCongestion: 2,
      nasalItching: 1,
      sneezing: 3,
      runnyNose: 2,
      notes: "契约一致性检查",
      idempotencyKey: "contract-20260729"
    };

    const cliRun = spawnSync(
      process.execPath,
      [cli, "record", "symptom", "add",
        "--local-date", input.localDate,
        "--nasal-congestion", "2",
        "--nasal-itching", "1",
        "--sneezing", "3",
        "--runny-nose", "2",
        "--notes", input.notes,
        "--idempotency-key", input.idempotencyKey,
        "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          KANGMIN_DB_PATH: databasePath,
          KANGMIN_SESSION_TOKEN: token
        }
      }
    );
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliResult = JSON.parse(cliRun.stdout) as Record<string, unknown>;

    const httpResponse = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ command, input, requestId: "contract-http" })
    });
    assert.equal(httpResponse.status, 200);
    const httpResult = await httpResponse.json() as Record<string, unknown>;

    // 稳定字段逐一相等；时间戳允许毫秒级差异。
    assert.equal(cliResult.ok, httpResult.ok);
    assert.equal(cliResult.command, httpResult.command);
    assert.equal(cliResult.status, httpResult.status);
    assert.deepEqual(cliResult.error, httpResult.error);
    // receipt 结构一致：operationId 均为服务端生成，requestId 由调用方提供
    //（CLI 未暴露该参数故自生成，HTTP 显式传入），只比较形状。
    for (const result of [cliResult, httpResult]) {
      const receipt = (result as { receipt: Record<string, unknown> }).receipt;
      assert.equal(typeof receipt.operationId, "string");
      assert.equal(typeof receipt.requestId, "string");
      assert.notEqual(receipt.operationId, "");
    }
    const cliData = cliResult.data as Record<string, unknown>;
    const httpData = httpResult.data as Record<string, unknown>;
    const { createdAt: _cliCreated, updatedAt: _cliUpdated, ...cliStable } = cliData;
    const { createdAt: _httpCreated, updatedAt: _httpUpdated, ...httpStable } = httpData;
    assert.deepEqual(cliStable, httpStable);

    // 失败路径：缺少幂等键，两个适配器返回相同错误码。
    const badCli = spawnSync(
      process.execPath,
      [cli, "record", "symptom", "add",
        "--local-date", "2026-07-29",
        "--nasal-congestion", "1",
        "--nasal-itching", "0",
        "--sneezing", "0",
        "--runny-nose", "0",
        "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          KANGMIN_DB_PATH: databasePath,
          KANGMIN_SESSION_TOKEN: token
        }
      }
    );
    assert.equal(badCli.status, 7, badCli.stdout); // validation_failed → 7
    const badCliResult = JSON.parse(badCli.stdout) as {
      error: { code: string };
    };
    assert.equal(badCliResult.error.code, "validation_failed");

    const badHttp = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: "record symptom add",
        input: {
          localDate: "2026-07-29",
          nasalCongestion: 1,
          nasalItching: 0,
          sneezing: 0,
          runnyNose: 0
        }
      })
    });
    assert.equal(badHttp.status, 422); // validation_failed → 422
    const badHttpResult = await badHttp.json() as {
      error: { code: string };
    };
    assert.equal(badHttpResult.error.code, "validation_failed");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    application.close();
  }
});
