import assert from "node:assert/strict";
import test from "node:test";

import {
  matchPlanVideo,
  planVideoMethodSlots,
  type PlanVideoCandidate
} from "../modules/browse/plan-video-matching.js";

const CASES = [
  ["鼻三线姜刮（抗敏要穴之姜行通窍）", "抗敏要穴之姜行通窍——鼻三线姜刮", "成人快速通窍"],
  ["迎香穴指腹擦（抗敏要穴之迎香穴）", "抗敏要穴之迎香穴（指腹擦迎香）", "成人快速通窍"],
  ["肺俞穴按揉（抗敏要穴之补肺固表）", "抗敏要穴之补肺固表——肺俞穴按揉", "成人调体方案"],
  ["肺俞穴点揉（抗敏要穴之补肺固表，不灸）", "抗敏要穴之补肺固表——肺俞穴点揉（不灸）", "成人调体方案"],
  ["耳穴过敏区按压（抗敏要穴之息风止敏）", "抗敏要穴之息风止敏——耳穴过敏区按压", "成人调体方案"],
  ["身柱穴按揉（抗敏要穴之通阳固本）", "抗敏要穴之通阳固本——身柱穴按揉", "成人调体方案"],
  ["风门穴按揉（抗敏要穴之固守风关）", "抗敏要穴之固守风关——风门穴按揉", "成人调体方案"],
  ["大椎穴按揉（抗敏要穴之阳中之阳）", "抗敏要穴之阳中之阳——大椎穴按揉", "成人调体方案"],
  ["足三里穴按揉（抗敏要穴之健脾补虚）", "抗敏要穴之健脾补虚——足三里穴按揉", "成人调体方案"],
  ["天枢穴按揉（抗敏要穴之健脾益气）", "抗敏要穴之健脾益气——天枢穴按揉", "成人调体方案"],
  ["鼻炎手法（小儿）", "小儿鼻炎手法", "儿童快速通窍"],
  ["头面四大手法（小儿）", "小儿头面四大手法", "儿童快速通窍"],
  ["过敏手法（小儿）", "小儿过敏手法", "儿童调体方案"],
  ["呼吸手法（小儿）", "小儿呼吸手法", "儿童调体方案"],
  ["清肺经、清大肠（小儿）", "小儿清肺经、清大肠", "儿童调体方案"],
  ["揉天枢、摩腹（小儿）", "小儿揉天枢、摩腹", "儿童调体方案"],
  ["消化手法（小儿）", "小儿消化手法", "儿童调体方案"],
  ["清热手法（小儿）", "小儿清热手法", "儿童调体方案"]
] as const;

function video(title: string, category: string): PlanVideoCandidate & { id: string } {
  return { id: `${category}:${title}`, kind: "video", title, category };
}

test("最终方案 18 种方法逐项命中对应成人或儿童视频", () => {
  const catalog = CASES.map(([, title, category]) => video(title, category));
  for (const [method, title] of CASES) {
    assert.equal(matchPlanVideo(method, catalog)?.title, title, method);
  }
});

test("相近标题不误配：成人儿童隔离，肺俞按揉与点揉不灸隔离", () => {
  const catalog = [
    video("小儿迎香穴操作", "儿童快速通窍"),
    video("肺俞穴点揉（不灸）", "成人调体方案"),
    video("肺俞穴按揉", "成人调体方案"),
    video("成人鼻炎手法", "成人快速通窍"),
    video("小儿鼻炎手法", "儿童快速通窍")
  ];
  assert.equal(matchPlanVideo("迎香穴指腹擦", catalog), null);
  assert.equal(matchPlanVideo("肺俞穴按揉", catalog)?.title, "肺俞穴按揉");
  assert.equal(matchPlanVideo("肺俞穴点揉（不灸）", catalog)?.title, "肺俞穴点揉（不灸）");
  assert.equal(matchPlanVideo("鼻炎手法（小儿）", catalog)?.title, "小儿鼻炎手法");
  assert.equal(matchPlanVideo("未知方法", catalog), null);
  assert.equal(matchPlanVideo("迎香穴指腹擦", [{ ...catalog[0]!, kind: "article", category: "成人快速通窍" }]), null);
});

test("方案视频槽兼容 CRLF、空白、全角序号和方法回退格式", () => {
  const text = [
    "1． 肺俞穴按揉  ",
    "  【操作视频】  ",
    "视频暂未上传（医学审核后补充）。",
    "2、风门穴按揉",
    "【操作视频】",
    "方法：",
    "迎香穴指腹擦",
    "【操作视频】"
  ].join("\r\n");
  assert.deepEqual(planVideoMethodSlots(text), [
    { lineIndex: 1, method: "肺俞穴按揉" },
    { lineIndex: 4, method: "风门穴按揉" },
    { lineIndex: 7, method: "迎香穴指腹擦" }
  ]);
});
