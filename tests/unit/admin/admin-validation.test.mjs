import assert from "node:assert/strict";
import test from "node:test";
import { approvedSyndromes, hasUnapprovedClinicalContent, parseMetadata, publishProblem, requiresClinicalApproval } from "../../../lib/admin/validation.ts";

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

test("鼻三线姜刮不能被正文偷偷改成普通刮痧", () => {
  const metadata = JSON.stringify({ methodCode: "nose_three_line_ginger_scrape", syndromeCodes: ["LUNG_QI_COLD"], risks: "风险", contraindications: "禁忌" });
  assert.equal(publishProblem("plan", { title: "普通刮痧方案", body: "沿鼻部进行普通刮痧", metadata }), "鼻三线姜刮不等同于普通刮痧，请修正方法名称和正文后再发布");
  assert.equal(publishProblem("plan", { title: "鼻三线姜刮", body: "鼻三线姜刮，不等同于普通刮痧", metadata }), null);
});

test("康复内容需要审核，但通过审核后不应被通用字段校验永久拦截", () => {
  const metadata = JSON.stringify({ risks: "有风险", contraindications: "有禁忌", syndromeCodes: ["LUNG_HEAT"] });
  assert.equal(requiresClinicalApproval("plan", { title: "方案", metadata: "{}" }), true);
  assert.equal(publishProblem("plan", { title: "方案", metadata }), null);
});

test("未经临床审核的康复操作不能借其它内容类型发布或索引", () => {
  const item = { title: "鼻部护理", body: "请进行鼻三线姜刮并按揉迎香", mediaId: "media_1", version: 1, metadata: "{}" };
  assert.equal(hasUnapprovedClinicalContent(item), true);
  assert.equal(requiresClinicalApproval("article", item), true);
  assert.equal(requiresClinicalApproval("video", item), true);
  assert.equal(requiresClinicalApproval("knowledge", { ...item, metadata: JSON.stringify({ indexedChunks: 1, indexedVersion: 1 }) }), true);
});

test("临床关键词覆盖摘要、来源和不可见分隔符", () => {
  assert.equal(hasUnapprovedClinicalContent({ title: "安全标题", summary: "鼻三线姜\u200b刮", body: "", source: "" }), true);
  assert.equal(hasUnapprovedClinicalContent({ title: "安全标题", summary: "普通鼻健康", body: "", source: "耳穴压豆资料" }), true);
  assert.equal(hasUnapprovedClinicalContent({ title: "安全标题", summary: "请吹大椎穴并揉按", body: "", source: "" }), true);
  assert.equal(requiresClinicalApproval("article", { title: "普通科普", body: "普通鼻健康" }), true);
});
