import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import test from "node:test";

import { DeepSeekModelAdapter } from "../infrastructure/deepseek-model-adapter.js";
import { QwenPlanDialogueAdapter } from "../infrastructure/qwen-plan-dialogue-adapter.js";
import { DomainError } from "../kernel/errors.js";
import type { ClinicalVerdict } from "../modules/clinical-rules/contracts.js";
import {
  renderValidatedOutput,
  questionWithinApprovedPlan,
  renderGeneratedFollowUpOutput,
  renderGeneratedPlanOutput,
  systemNotice,
  validateGeneratedMedicalText,
  validateExplanationFields,
  CLINICAL_FREEZE_BLOCK
} from "../modules/agent/output-validation.js";

const BASE_URL = "http://model.test/v1";

/** fetch 替身：把模型输出包装成 chat/completions 响应包。 */
function stubModel(content: string, status = 200): typeof fetch {
  const body = { choices: [{ message: { content } }] };
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

/** fetch 替身：原始错误响应（非 2xx）。 */
function stubError(body: unknown, status: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

/** fetch 替身：永不返回，但尊重 AbortSignal（用于超时）。 */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
      // Node 22 的 AbortSignal.timeout 定时器不维持事件循环，信号可能
      // 永远不发；兜底真实定时器保证挂起请求最终按同样的中止语义失败。
      setTimeout(() => {
        reject(new DOMException("Aborted", "AbortError"));
      }, 100);
    })) as unknown as typeof fetch;
}

function adapterWith(
  fetchImpl: typeof fetch,
  options: { apiKey?: string; timeoutMs?: number } = {}
): DeepSeekModelAdapter {
  return new DeepSeekModelAdapter({
    apiKey: options.apiKey ?? "test-key",
    baseUrl: BASE_URL,
    timeoutMs: options.timeoutMs ?? 500,
    fetchImpl
  });
}

test("未配置 API key 时抛 provider_unavailable（绝不伪造回答）", async () => {
  const adapter = new DeepSeekModelAdapter({
    baseUrl: BASE_URL,
    fetchImpl: stubModel("[]")
  });
  await assert.rejects(
    () => adapter.extractCandidates({ message: "我口渴", askedQuestions: [], confirmedFacts: [] }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "provider_unavailable"
  );
  await assert.rejects(
    () => adapter.explain(classifiedVerdict(), "candidate"),
    (error: unknown) =>
      error instanceof DomainError && error.code === "provider_unavailable"
  );
});

test("千问方案对话端口：使用指定模型并只接收 answer JSON", async () => {
  let requestedModel: unknown;
  const adapter = new QwenPlanDialogueAdapter({
    apiKey: "test-qwen-key",
    model: "qwen3.7-flash",
    baseUrl: BASE_URL,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestedModel = body.model;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ answer: "通俗方案说明" }) } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });
  assert.equal(await adapter.generatePlan(classifiedPlanVerdict()), "通俗方案说明");
  assert.equal(requestedModel, "qwen3.7-flash");

  const unavailable = new QwenPlanDialogueAdapter({ baseUrl: BASE_URL });
  await assert.rejects(
    () => unavailable.generatePlan(classifiedPlanVerdict()),
    (error: unknown) =>
      error instanceof DomainError && error.code === "provider_unavailable"
  );
});

test("非法 JSON 响应：丢弃本次候选，不宽松解析", async () => {
  const adapter = adapterWith(stubModel("这不是 JSON"));
  const candidates = await adapter.extractCandidates({
    message: "我口渴",
    askedQuestions: [],
    confirmedFacts: []
  });
  assert.deepEqual(candidates, []);
});

test("JSON 数组含非法条目：只保留严格合法的候选，未知字段被丢弃", async () => {
  const adapter = adapterWith(
    stubModel(
      JSON.stringify([
        { fieldCode: "thirst", state: "yes", justification: "口渴" },
        { fieldCode: "made_up_field", state: "yes" },
        { fieldCode: "thirst", state: "maybe" },
        { fieldCode: "fatigue", state: "yes" },
        "garbage"
      ])
    )
  );
  const candidates = await adapter.extractCandidates({
    message: "我口渴且累",
    askedQuestions: [],
    confirmedFacts: []
  });
  assert.deepEqual(candidates, [
    { fieldCode: "thirst", state: "yes", justification: "口渴" },
    { fieldCode: "fatigue", state: "yes" }
  ]);
});

test("模型超时：返回空候选（结构化问答降级），规则结果仍有效", async () => {
  const adapter = adapterWith(hangingFetch(), { timeoutMs: 20 });
  const candidates = await adapter.extractCandidates({
    message: "我口渴",
    askedQuestions: [],
    confirmedFacts: []
  });
  assert.deepEqual(candidates, []);
});

test("非 2xx 响应：返回空候选，不伪造回答", async () => {
  const adapter = adapterWith(stubError({ error: "rate limited" }, 429));
  const candidates = await adapter.extractCandidates({
    message: "我口渴",
    askedQuestions: [],
    confirmedFacts: []
  });
  assert.deepEqual(candidates, []);
});

test("解释端口：多余键/类型不符被拒绝（返回 null → 固定模板回退）", async () => {
  const verdict = classifiedVerdict();
  const withExtraKey = adapterWith(
    stubModel(
      JSON.stringify({
        outcome: "classified",
        severityCode: "mild",
        syndromeCode: "LUNG_HEAT",
        matchedRuleIds: ["SEV-05", "T1"],
        message: null,
        acupoints: "迎香" // 越权新增穴位 → 拒绝
      })
    )
  );
  const rejected = await withExtraKey.explain(verdict, "approved");
  assert.equal(rejected, null);

  const wrongType = adapterWith(
    stubModel(
      JSON.stringify({
        outcome: 42,
        severityCode: null,
        syndromeCode: null,
        matchedRuleIds: [],
        message: null
      })
    )
  );
  assert.equal(await wrongType.explain(verdict, "approved"), null);

  const valid = adapterWith(
    stubModel(
      JSON.stringify({
        outcome: "classified",
        severityCode: "mild",
        syndromeCode: "LUNG_HEAT",
        matchedRuleIds: ["SEV-05", "T1"],
        message: null
      })
    )
  );
  const accepted = await valid.explain(verdict, "approved");
  assert.deepEqual(accepted, {
    outcome: "classified",
    severityCode: "mild",
    syndromeCode: "LUNG_HEAT",
    matchedRuleIds: ["SEV-05", "T1"],
    message: null
  });
});

function classifiedVerdict(): ClinicalVerdict {
  return {
    outcome: "classified",
    stage: "completed",
    severityCode: "mild",
    syndromeCode: "LUNG_HEAT",
    phaseCode: "acute",
    audience: "adult",
    nextQuestions: [],
    allQuestions: [],
    matchedRuleIds: ["SEV-05", "T1"],
    message: null,
    planId: null,
    planRevision: null,
    planBundle: null,
    rulePackageVersion: "clinical-rules-v2",
    rulePackageHash: "hash"
  };
}

function classifiedPlanVerdict(): ClinicalVerdict {
  const plan = {
    planId: "plan-yingxiang",
    planRevision: 1,
    name: "急性期迎香调理方案",
    method: "指腹擦迎香",
    steps: JSON.stringify(["指腹轻擦迎香，以皮肤温热为度"]),
    precautions: "皮肤破损时暂停操作。",
    videoResourceId: "video-yingxiang",
    attributes: {}
  };
  return {
    ...classifiedVerdict(),
    planId: plan.planId,
    planRevision: plan.planRevision,
    planBundle: { acute: plan, constitution: null }
  };
}

test("输出校验：模型字段与规则结果不一致即拒绝，一致才通过", () => {
  const verdict = classifiedVerdict();
  assert.equal(
    validateExplanationFields(
      { outcome: "blocked", severityCode: null, syndromeCode: null, matchedRuleIds: [], message: null },
      verdict
    ),
    null
  );
  assert.equal(
    validateExplanationFields(
      { outcome: "classified", severityCode: "moderate_severe", syndromeCode: "LUNG_HEAT", matchedRuleIds: ["SEV-05", "T1"], message: null },
      verdict
    ),
    null
  );
  assert.equal(
    validateExplanationFields(
      { outcome: "classified", severityCode: "mild", syndromeCode: "LUNG_HEAT", matchedRuleIds: ["SEV-05", "T1"], message: null },
      verdict
    )?.outcome,
    "classified"
  );
});

test("模板输出：candidate 规则包 classified 只渲染临床冻结阻断文案", () => {
  const verdict = classifiedVerdict();
  const output = renderValidatedOutput(verdict, "candidate", null);
  assert.equal(output.templateId, "clinical_freeze");
  assert.equal(output.content, CLINICAL_FREEZE_BLOCK);
  assert.ok(output.contentHash.length === 64);
});

test("自由文本医学校验：方案外穴位疗法和无依据数值拒绝，来源内细节可放行", () => {
  const verdict = classifiedPlanVerdict();
  const generatedPlan = renderGeneratedPlanOutput(
    "当前方案采用指腹擦迎香，以皮肤温热为度。",
    verdict
  );
  assert.ok(generatedPlan?.content.includes("【依据】急性期迎香调理方案"));
  assert.ok(generatedPlan?.content.includes("【已审核方案】"));
  assert.ok(generatedPlan?.content.includes("皮肤破损时暂停操作"));
  assert.equal(
    renderGeneratedPlanOutput("可以配合足三里按揉。", verdict),
    null
  );
  assert.equal(
    renderGeneratedPlanOutput("可以配合未登记的新奇穴。", verdict),
    null
  );
  assert.equal(
    renderGeneratedPlanOutput("可以增加艾灸。", verdict),
    null
  );
  assert.equal(
    renderGeneratedFollowUpOutput(
      "资料记载可向内上方斜刺迎香0.3寸。",
      verdict,
      [{
        knowledgeId: "manual-acupuncture",
        name: "原手册针刺段落",
        source: "客户资料",
        text: "迎香略向内上方斜刺或平刺，0.3～0.5寸。"
      }]
    ),
    null,
    "来源中存在但当前方案未允许的针刺操作仍须拒绝"
  );
  assert.equal(
    renderGeneratedPlanOutput("迎香每次按揉1分钟。", verdict),
    null
  );

  const sources = [{
    knowledgeId: "manual-yingxiang",
    name: "适宜技术手册·迎香",
    source: "客户授权测试资料",
    text: "迎香采用指腹轻擦1分钟。"
  }];
  assert.ok(
    renderGeneratedFollowUpOutput("资料记载可用指腹轻擦迎香1分钟。", verdict, sources)
      ?.content.includes("适宜技术手册·迎香")
  );
  assert.equal(questionWithinApprovedPlan("迎香具体在哪里？", verdict), true);
  assert.equal(questionWithinApprovedPlan("艾灸上火怎么办？", verdict), false);
  assert.equal(questionWithinApprovedPlan("新奇穴怎么找？", verdict), false);
});

test("自由文本医学校验：该穴等代词不被误判为新增穴位", () => {
  const verdict = classifiedPlanVerdict();
  const generated = "使用指腹轻擦该穴位，力度以局部产生温热感为宜。";
  assert.equal(validateGeneratedMedicalText(generated, verdict), generated);
});

test("方案模板：可选项称为方法，删除重复手法段，并在每个方法下放视频", () => {
  const plan = {
    planId: "plan-test",
    planRevision: 1,
    name: "寒热错杂调体方案（成人）",
    method: "肺俞穴按揉；风门穴按揉",
    steps: JSON.stringify(["肺俞穴按揉", "风门穴按揉"]),
    precautions: "以酸胀为度。",
    videoResourceId: null,
    attributes: {}
  };
  const output = renderValidatedOutput(
    {
      ...classifiedVerdict(),
      planBundle: { acute: plan, constitution: plan }
    },
    "approved",
    null
  );

  assert.ok(output.content.includes("方法（请选择其中一项）："));
  assert.ok(output.content.includes("1. 肺俞穴按揉\n【操作视频】"));
  assert.ok(output.content.includes("2. 风门穴按揉\n【操作视频】"));
  assert.equal(output.content.includes("手法："), false);
  assert.equal(output.content.includes("步骤："), false);
  assert.equal(
    output.content.split("视频暂未上传（医学审核后补充）。").length - 1,
    4
  );
});

test("模板输出：blocked/non_applicable/conflict/no_match 均为固定文案", () => {
  const blocked = renderValidatedOutput(
    {
      ...classifiedVerdict(),
      outcome: "blocked",
      stage: "safety",
      severityCode: null,
      syndromeCode: null,
      matchedRuleIds: ["SAF-01"],
      message: "请立即就医"
    },
    "candidate",
    null
  );
  assert.equal(blocked.templateId, "blocked");
  assert.equal(blocked.content, "请立即就医");

  const nonApplicable = renderValidatedOutput(
    {
      ...classifiedVerdict(),
      outcome: "non_applicable",
      stage: "applicability",
      severityCode: null,
      syndromeCode: null,
      matchedRuleIds: ["APP-01"],
      message: "请到正规医院明确诊断"
    },
    "candidate",
    null
  );
  assert.equal(nonApplicable.templateId, "non_applicable");
  assert.ok(nonApplicable.content.includes("明确诊断"));

  const conflict = renderValidatedOutput(
    {
      ...classifiedVerdict(),
      outcome: "conflict",
      stage: "syndrome",
      severityCode: "mild",
      syndromeCode: null,
      matchedRuleIds: ["TEST-A", "TEST-B"]
    },
    "candidate",
    null
  );
  assert.equal(conflict.templateId, "conflict");
  assert.ok(conflict.content.includes("不做猜测"));

  const noMatch = renderValidatedOutput(
    {
      ...classifiedVerdict(),
      outcome: "no_match",
      stage: "syndrome",
      syndromeCode: null,
      matchedRuleIds: []
    },
    "candidate",
    null
  );
  assert.equal(noMatch.templateId, "no_match");
  assert.ok(noMatch.content.includes("不做猜测"));
});

test("补问模板：问题来自规则内核，附字段标签，数量与裁决一致", () => {
  const output = renderValidatedOutput(
    {
      ...classifiedVerdict(),
      outcome: "need_more_information",
      stage: "safety",
      severityCode: null,
      syndromeCode: null,
      matchedRuleIds: [],
      nextQuestions: [
        { fieldCode: "urgent_help", prompt: "您是否现在呼吸困难、喘不上气、胸闷憋气，或口唇发紫？" },
        { fieldCode: "high_fever", prompt: "您是否体温超过 39℃ 持续 3 天不退，或伴有寒战？" }
      ]
    },
    "candidate",
    null
  );
  assert.equal(output.templateId, "questions");
  assert.ok(output.content.includes("急救"));
  assert.ok(output.content.includes("高热"));
  assert.ok(output.content.includes("为了继续评估"));
});

test("固定 system_notice：代码生成，不携带模型文本", () => {
  const notice = systemNotice("extraction_unavailable", "智能提取服务暂不可用");
  assert.equal(notice.templateId, "system_notice_extraction_unavailable");
  assert.equal(notice.content, "智能提取服务暂不可用");
});
