import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(TEST_DIR, "../..");
const VINEXT_CLI = path.join(
  PROJECT_DIR,
  "node_modules/vinext/dist/cli.js",
);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务提前退出：${output.join("")}`);
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return response;
      }
    } catch {
      // 服务仍在启动。
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`等待服务启动超时：${output.join("")}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000),
    ),
  ]);
}

function completeInput(overrides = {}) {
  return {
    diagnosedAllergicRhinitis: "yes",
    safety: {
      respiratoryEmergency: "no",
      persistentHighFever: "no",
      severeNoseBleed: "no",
      unilateralFoulDischarge: "no",
      severeNeurologicalSymptoms: "no",
    },
    severity: {
      sleepAffected: "no",
      activityAffected: "no",
      workStudyAffected: "no",
      symptomTroublesome: "no",
    },
    syndrome: {
      thirst: "yes",
      fatigue: "no",
      limbsNotWarm: "no",
      fearWind: "no",
      coldIntolerance: "no",
    },
    ...overrides,
  };
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("完整服务通过 HTTP 跑通提取、评估、解释及安全降级路径", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(
    process.execPath,
    [VINEXT_CLI, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: ".wrangler/wrangler-e2e.log",
        DEEPSEEK_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    const pageResponse = await waitForServer(baseUrl, child, output);
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /抗敏先锋小程序首页/u);
    assert.match(pageHtml, /开始鼻健康问诊/u);
    assert.doesNotMatch(
      pageHtml,
      /目前是否有呼吸困难、喘不过气或口唇发紫/u,
    );
    assert.doesNotMatch(pageHtml, /开始安全问诊/u);

    const normal = await postJson(
      baseUrl,
      "/api/v1/agent/evaluate",
      completeInput(),
    );
    assert.equal(normal.response.status, 200);
    assert.equal(normal.body.data.assessment.status, "classified");
    assert.equal(normal.body.data.assessment.planStatus, "no_approved_plan");

    const eligibility = await postJson(
      baseUrl,
      "/api/v1/agent/evaluate",
      completeInput({ diagnosedAllergicRhinitis: "unknown" }),
    );
    assert.equal(eligibility.response.status, 200);
    assert.deepEqual(eligibility.body.data.assessment, {
      status: "referred",
      reason: "not_diagnosed_or_uncertain",
      nextQuestions: ["diagnosedAllergicRhinitis"],
      rulePackageVersion: "draft-local-v0",
    });

    const explanation = await postJson(
      baseUrl,
      "/api/v1/agent/explain",
      completeInput(),
    );
    assert.equal(explanation.response.status, 200);
    assert.equal(explanation.body.data.assessment.status, "classified");
    assert.match(
      explanation.body.data.explanation.summary,
      /尚未接入经审核知识库/u,
    );
    assert.deepEqual(explanation.body.data.model, {
      used: false,
      degradedReason: "no_approved_knowledge",
    });

    const conflict = await postJson(
      baseUrl,
      "/api/v1/agent/evaluate",
      completeInput({
        severity: {
          sleepAffected: "no",
          activityAffected: "yes",
          workStudyAffected: "no",
          symptomTroublesome: "no",
        },
        syndrome: {
          thirst: "yes",
          fatigue: "no",
          limbsNotWarm: "yes",
          fearWind: "no",
          coldIntolerance: "no",
        },
      }),
    );
    assert.equal(conflict.body.data.assessment.status, "conflict");
    assert.deepEqual(
      conflict.body.data.assessment.syndrome.matchedRuleIds,
      ["T1", "T5"],
    );

    const blocked = await postJson(
      baseUrl,
      "/api/v1/agent/evaluate",
      completeInput({
        safety: {
          respiratoryEmergency: "yes",
          persistentHighFever: "no",
          severeNoseBleed: "no",
          unilateralFoulDischarge: "no",
          severeNeurologicalSymptoms: "no",
        },
      }),
    );
    assert.equal(blocked.body.data.assessment.status, "blocked");

    const safetyCandidate = await postJson(
      baseUrl,
      "/api/v1/agent/extract",
      {
        text: "我现在呼吸困难，鼻血一直止不住",
      },
    );
    assert.equal(safetyCandidate.response.status, 200);
    assert.equal(
      safetyCandidate.body.data.safetyGate.status,
      "confirmation_required",
    );
    assert.deepEqual(safetyCandidate.body.data.candidates.safety, {
      respiratoryEmergency: "yes",
      severeNoseBleed: "yes",
    });
    assert.equal(safetyCandidate.body.data.model.used, false);

    const degraded = await postJson(baseUrl, "/api/v1/agent/extract", {
      text: "最近鼻子不舒服，晚上会影响睡觉",
    });
    assert.equal(degraded.response.status, 200);
    assert.deepEqual(degraded.body.data.model, {
      used: false,
      degradedReason: "model_not_configured",
    });
    assert.equal(degraded.body.data.requiresConfirmation, true);
  } finally {
    await stopServer(child);
  }
});
