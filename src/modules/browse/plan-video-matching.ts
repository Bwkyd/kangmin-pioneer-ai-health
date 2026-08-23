export interface PlanVideoCandidate {
  kind: string;
  title: string;
  category: string;
}

export interface PlanVideoMethodSlot {
  lineIndex: number;
  method: string;
}

interface MatchRule {
  method: string[];
  title: string[];
  rejectTitle?: string[];
}

const MATCH_RULES: MatchRule[] = [
  { method: ["肺俞", "点揉"], title: ["肺俞", "点揉", "不灸"] },
  { method: ["肺俞"], title: ["肺俞"], rejectTitle: ["点揉"] },
  { method: ["鼻三线"], title: ["鼻三线"] },
  { method: ["迎香"], title: ["迎香"] },
  { method: ["耳穴过敏区"], title: ["耳穴过敏区"] },
  { method: ["身柱"], title: ["身柱"] },
  { method: ["风门"], title: ["风门"] },
  { method: ["大椎"], title: ["大椎"] },
  { method: ["足三里"], title: ["足三里"] },
  { method: ["揉天枢", "摩腹"], title: ["揉天枢", "摩腹"] },
  { method: ["天枢"], title: ["天枢"] },
  { method: ["清肺经", "清大肠"], title: ["清肺经", "清大肠"] },
  { method: ["头面四大手法"], title: ["头面四大手法"] },
  { method: ["鼻炎手法"], title: ["鼻炎手法"] },
  { method: ["过敏手法"], title: ["过敏手法"] },
  { method: ["呼吸手法"], title: ["呼吸手法"] },
  { method: ["消化手法"], title: ["消化手法"] },
  { method: ["清热手法"], title: ["清热手法"] }
];

function normalized(value: string): string {
  return value.replace(/[\s·—–、，,：:()（）+]/gu, "").toLocaleLowerCase("zh-CN");
}

/**
 * 从固定方案模板识别每个【操作视频】所属的方法。兼容历史 CRLF、全角序号
 * 以及无步骤时的“方法：”回退，避免已有正文因轻微格式差异再次识别失败。
 */
export function planVideoMethodSlots(text: string): PlanVideoMethodSlot[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const slots: PlanVideoMethodSlot[] = [];
  let currentMethod = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    const numbered = line.match(/^\d+[.．、]\s*(.+)$/u);
    if (numbered?.[1]) currentMethod = numbered[1].trim();
    if (line === "方法：") currentMethod = (lines[index + 1] ?? "").trim();
    if (line === "【操作视频】" && currentMethod !== "") {
      slots.push({ lineIndex: index, method: currentMethod });
    }
  }
  return slots;
}

/** 按 truth 中的方法名匹配同一人群下已经发布的视频，不跨成人/儿童混用。 */
export function matchPlanVideo<T extends PlanVideoCandidate>(
  method: string,
  videos: readonly T[]
): T | null {
  const normalizedMethod = normalized(method);
  const audience = /(?:小儿|儿童)/u.test(method) ? "儿童" : "成人";
  const rule = MATCH_RULES.find((candidate) =>
    candidate.method.every((part) => normalizedMethod.includes(normalized(part)))
  );
  if (rule === undefined) return null;

  return videos.find((video) => {
    if (video.kind !== "video" || !video.category.includes(audience)) return false;
    const title = normalized(video.title);
    return rule.title.every((part) => title.includes(normalized(part))) &&
      !(rule.rejectTitle ?? []).some((part) => title.includes(normalized(part)));
  }) ?? null;
}
