import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/application.js";
import { createKangminHttpServer } from "../http/server.js";

test("HTTP 适配器使用同一应用服务并执行真实身份和持久化", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-http-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const token = application.sessions.createDevelopmentSession("patient-http").token;
  const server = createKangminHttpServer(application);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") {
    return;
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          command: "record symptom add",
          requestId: "http-e2e",
          input: {
            localDate: "2026-07-30",
            nasalCongestion: 1,
            nasalItching: 1,
            sneezing: 2,
            runnyNose: 0,
            idempotencyKey: "http-20260730"
          }
        })
      }
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      data: { tnssTotal: number; revision: number };
      meta: { requestId: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.tnssTotal, 4);
    assert.equal(body.data.revision, 1);
    assert.equal(body.meta.requestId, "http-e2e");

    const unauthenticated = await fetch(
      `http://127.0.0.1:${address.port}/v1/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "record symptom list" })
      }
    );
    assert.equal(unauthenticated.status, 401);
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
