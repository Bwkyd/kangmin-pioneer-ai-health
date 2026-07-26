import assert from "node:assert/strict";
import test from "node:test";
import { clinicalCandidateDefinition } from "../../../lib/admin/clinical-candidates.ts";
import { approvedSyndromes, clinicalCandidateApprovalProblem, clinicalCandidateContentProblem, clinicalCandidateProblem, hasUnapprovedClinicalContent, parseMetadata, publishProblem, requiresClinicalApproval } from "../../../lib/admin/validation.ts";

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

test("视频分类维度只接受症状、证型或通用三种受控值", () => {
  assert.equal(parseMetadata({ topicType: "symptom" }, "video").videoTopicType, "symptom");
  assert.equal(parseMetadata({ topicType: "syndrome" }, "video").videoTopicType, "syndrome");
  assert.equal(parseMetadata({ topicType: "invented" }, "video").videoTopicType, null);
  assert.equal(parseMetadata({ topicType: "symptom" }, "article").videoTopicType, null);
});

test("视频选择分类维度后必须填写具体分类", () => {
  assert.equal(publishProblem("video", { title: "操作视频", category: "未分类", mediaId: "media_1", metadata: JSON.stringify({ topicType: "symptom" }) }), "视频选择分类维度后必须填写具体分类");
  assert.equal(publishProblem("video", { title: "鼻塞视频", category: "鼻塞", mediaId: "media_1", metadata: JSON.stringify({ topicType: "symptom" }) }), null);
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
  const metadata = JSON.stringify({ methodCode: "nose_three_line_ginger_scrape", routeCodes: ["yintang_shenting"], syndromeCodes: ["LUNG_QI_COLD"], risks: "风险", contraindications: "禁忌" });
  assert.equal(publishProblem("plan", { title: "普通刮痧方案", body: "沿鼻部进行普通刮痧", metadata }), "鼻三线姜刮不等同于普通刮痧，请修正方法名称和正文后再发布");
  assert.equal(publishProblem("plan", { title: "鼻三线姜刮", body: "鼻三线姜刮，不等同于普通刮痧", metadata }), null);
  assert.equal(publishProblem("plan", { title: "鼻三线姜刮", body: "姜刮步骤说明", metadata }), "正文中的姜刮必须使用统一名称“鼻三线姜刮”");
  assert.equal(publishProblem("plan", { title: "鼻三线姜刮", body: "安全说明", stepsText: "步骤：普通刮痧", metadata }), "鼻三线姜刮不等同于普通刮痧，请修正方法名称和正文后再发布");
  assert.equal(publishProblem("plan", { title: "穴位按摩", summary: "鼻三线姜刮", body: "安全说明", metadata: JSON.stringify({ methodCode: "acupoint_massage" }) }), "正文中的鼻三线姜刮与受控方法不一致，请修正后再发布");
});

test("姜刮方法和路线结构使用共享受控目录", () => {
  const metadata = parseMetadata({ methodCode: "nose_three_line_ginger_scrape", routeCodes: ["yintang_shenting", "fengchi_jianjing"] }, "video");
  assert.equal(metadata.methodLabel, "鼻三线姜刮");
  assert.deepEqual(metadata.routes, [
    { code: "yintang_shenting", label: "印堂-神庭", points: ["印堂", "神庭"] },
    { code: "fengchi_jianjing", label: "风池-肩井", points: ["风池", "肩井"] },
  ]);
  assert.equal(publishProblem("video", { title: "鼻三线姜刮护理视频", mediaId: "video_1", metadata: JSON.stringify({ methodCode: "nose_three_line_ginger_scrape", routeCodes: ["fengchi_jianjing"] }) }), null);
  assert.equal(publishProblem("video", { title: "普通刮痧护理视频", mediaId: "video_1", metadata: JSON.stringify({ methodCode: "nose_three_line_ginger_scrape", routeCodes: ["fengchi_jianjing"] }) }), "鼻三线姜刮不等同于普通刮痧，请修正方法名称和正文后再发布");
  assert.equal(publishProblem("video", { title: "姜刮护理视频", mediaId: "video_1", metadata: "{}" }), "正文中的鼻三线姜刮与受控方法不一致，请修正后再发布");
});

test("临床候选穴位只接受与方法绑定的受控结构，并保留顺序关系", () => {
  const ear = parseMetadata({ methodCode: "ear_acupressure", pointGroupCodes: ["ear_shenmen_subcortex_lung_fengxi"] }, "plan");
  assert.deepEqual(ear.pointGroups, [{ code: "ear_shenmen_subcortex_lung_fengxi", label: "神门-皮质下-肺-风溪", methodCode: "ear_acupressure", points: ["神门", "皮质下", "肺", "风溪"], relation: "按此顺序记录" }]);
  assert.equal(clinicalCandidateContentProblem("shared_ear_acupressure", JSON.stringify({ methodCode: "ear_acupressure", pointGroupCodes: ["ear_shenmen_subcortex_lung_fengxi"], syndromeCodes: ["LUNG_QI_COLD", "SPLEEN_QI_DEF", "KIDNEY_YANG_DEF", "LUNG_HEAT", "MIXED_COLD_HEAT"] }), "plan"), null);
  assert.match(clinicalCandidateContentProblem("shared_ear_acupressure", JSON.stringify({ methodCode: "acupoint_massage", pointGroupCodes: ["fengchi_fengmen_feishu_lieque_plus_taiyuan"] }), "plan") ?? "", /必须选择受控方法/u);
  assert.match(clinicalCandidateContentProblem("lung_qi_cold_acupoint_supplement", JSON.stringify({ methodCode: "acupoint_massage" }), "plan") ?? "", /必须保存受控穴位结构/u);
});

test("普通刮痧是独立的方法类型，不能借用姜刮名称", () => {
  assert.equal(publishProblem("video", { title: "刮痧护理视频", mediaId: "video_1", metadata: JSON.stringify({ methodCode: "gua_sha" }) }), "普通刮痧方案必须绑定 #94–#96 刮痧安全门禁候选，临床确认前不可发布");
  assert.equal(publishProblem("video", { title: "刮痧护理视频", mediaId: "video_1", clinicalCandidateKind: "gua_sha_safety_gate", metadata: JSON.stringify({ methodCode: "gua_sha" }) }), null);
  assert.equal(publishProblem("video", { title: "鼻三线姜刮护理视频", mediaId: "video_1", metadata: JSON.stringify({ methodCode: "gua_sha" }) }), "刮痧方案标题必须使用统一方法名称");
  assert.match(clinicalCandidateContentProblem("gua_sha_safety_gate", JSON.stringify({ methodCode: "nose_three_line_ginger_scrape" }), "video") ?? "", /必须选择受控方法/u);
  assert.equal(clinicalCandidateContentProblem("gua_sha_safety_gate", JSON.stringify({ methodCode: "gua_sha" }), "video"), null);
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

test("临床候选必须可独立识别来源和版本差异", () => {
  assert.equal(clinicalCandidateProblem("bloodletting", "新增放血步骤", "客户资料 v2"), null);
  assert.equal(clinicalCandidateProblem("bloodletting", "", "客户资料 v2"), "临床候选必须填写本版本相对上一版本的变更差异");
  assert.equal(clinicalCandidateProblem("bloodletting", "新增放血步骤", ""), "临床候选必须填写来源或依据");
  assert.equal(clinicalCandidateProblem("invented", "差异", "来源"), "临床候选类别无效，请从受控选项中选择");
  assert.equal(clinicalCandidateProblem("", "差异", "来源"), "填写变更差异前必须先选择临床候选类别");
});

test("基础映射候选覆盖五种证型但不成为正式规则", () => {
  const candidate = clinicalCandidateDefinition("base_syndrome_mapping");
  assert.deepEqual(candidate?.syndromeCodes, ["LUNG_QI_COLD", "SPLEEN_QI_DEF", "KIDNEY_YANG_DEF", "LUNG_HEAT", "MIXED_COLD_HEAT"]);
  assert.equal(candidate?.issue, 92);
  const missing = JSON.stringify({ syndromePlanMappings: [
    { syndromeCode: "LUNG_QI_COLD", status: "missing" },
    { syndromeCode: "SPLEEN_QI_DEF", status: "no_plan" },
    { syndromeCode: "KIDNEY_YANG_DEF", status: "missing" },
    { syndromeCode: "LUNG_HEAT", status: "no_plan" },
    { syndromeCode: "MIXED_COLD_HEAT", status: "missing" },
  ] });
  assert.equal(clinicalCandidateContentProblem("base_syndrome_mapping", missing, "plan"), null);
  assert.match(clinicalCandidateApprovalProblem("base_syndrome_mapping", missing, "plan") ?? "", /资料缺失/u);
  const mapped = JSON.stringify({ syndromePlanMappings: [
    { syndromeCode: "LUNG_QI_COLD", status: "mapped", planId: "plan-1", planVersion: 2 },
    { syndromeCode: "SPLEEN_QI_DEF", status: "no_plan" },
    { syndromeCode: "KIDNEY_YANG_DEF", status: "no_plan" },
    { syndromeCode: "LUNG_HEAT", status: "no_plan" },
    { syndromeCode: "MIXED_COLD_HEAT", status: "no_plan" },
  ] });
  assert.equal(clinicalCandidateContentProblem("base_syndrome_mapping", mapped, "plan"), null);
  assert.equal(clinicalCandidateApprovalProblem("base_syndrome_mapping", mapped, "plan"), null);
  assert.equal(clinicalCandidateContentProblem("base_syndrome_mapping", JSON.stringify({ syndromePlanMappings: [] }), "plan"), "五种证型基础方案映射必须逐项保存 mapped、no_plan 或 missing 状态");
});
