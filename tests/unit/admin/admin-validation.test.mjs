import assert from "node:assert/strict";
import test from "node:test";
import { approvedSyndromes, parseMetadata, publishProblem } from "../../../lib/admin/validation.ts";

test("metadata only accepts approved fixed syndrome codes", () => {
  const result = parseMetadata({
    risks: "  操作后不适应停止  ",
    contraindications: "鼻出血时禁用",
    syndromeCodes: ["LUNG_HEAT", "MODEL_INVENTED_SYNDROME", 1],
  });
  assert.deepEqual(result.syndromeCodes, ["LUNG_HEAT"]);
  assert.equal(result.risks, "操作后不适应停止");
  assert.equal(approvedSyndromes.size, 5);
  assert.deepEqual([...approvedSyndromes], ["LUNG_HEAT", "LUNG_QI_COLD", "SPLEEN_QI_DEF", "KIDNEY_YANG_DEF", "MIXED_COLD_HEAT"]);
});

test("article cannot publish without body", () => {
  assert.equal(publishProblem("article", { title: "标题", body: "" }), "文章正文不能为空");
});

test("knowledge requires source and completed index", () => {
  assert.equal(publishProblem("knowledge", { title: "来源", mediaId: null, metadata: "{}" }), "知识资料发布前必须上传来源文件");
  assert.equal(publishProblem("knowledge", { title: "来源", mediaId: "media_1", metadata: "{}" }), "知识资料必须先完成当前版本索引");
  assert.equal(publishProblem("knowledge", { title: "来源", version: 2, mediaId: "media_1", metadata: "{\"indexedChunks\":2,\"indexedVersion\":1}" }), "知识资料必须先完成当前版本索引");
  assert.equal(publishProblem("knowledge", { title: "来源", version: 2, mediaId: "media_1", metadata: "{\"indexedChunks\":2,\"indexedVersion\":2}" }), null);
});

test("plan publication stays blocked until the clinical approval workflow exists", () => {
  const metadata = JSON.stringify({ risks: "有风险", contraindications: "有禁忌", syndromeCodes: ["LUNG_HEAT"] });
  assert.match(publishProblem("plan", { title: "方案", metadata: "{}" }), /临床审核/);
  assert.match(publishProblem("plan", { title: "方案", metadata }), /禁止发布/);
});
