import type { PublicContent } from "./discover";

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

/** 按 truth 中的方法名匹配同一人群下已经发布的视频，不跨成人/儿童混用。 */
export function matchPlanVideo(method: string, videos: PublicContent[]): PublicContent | null {
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
