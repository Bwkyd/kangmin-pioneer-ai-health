export type GroupName = "consult" | "health" | "content" | "control";
export type GroupPriority = "core" | "secondary";
export type CapabilityStatus =
  | "planned"
  | "blocked_clinical"
  | "blocked_external"
  | "aggregate";

export type CommandGroup = {
  name: GroupName;
  priority: GroupPriority;
  summary: string;
};

export type Capability = {
  id: string;
  issue: number;
  group: GroupName | "multiple";
  command: string | null;
  status: CapabilityStatus;
  summary: string;
  blocker?: string;
  coveredBy?: string[];
};

export const commandGroups: CommandGroup[] = [
  {
    name: "consult",
    priority: "core",
    summary: "问诊、安全筛查、动态补问、结构化结果和获批方案",
  },
  {
    name: "health",
    priority: "core",
    summary: "健康档案、过敏原、症状量表、历史记录和花粉状态",
  },
  {
    name: "content",
    priority: "secondary",
    summary: "学一学、文章、视频及其发布生命周期",
  },
  {
    name: "control",
    priority: "secondary",
    summary: "临床候选、审批门禁、能力状态和审计",
  },
];

export const capabilities: Capability[] = [
  {
    id: "requirements-allergen-learning-articles",
    issue: 69,
    group: "multiple",
    command: null,
    status: "aggregate",
    summary: "过敏原记录、学一学视频和文章管理总览",
    coveredBy: ["health allergen", "content article", "content video"],
  },
  {
    id: "requirements-content-publishing",
    issue: 70,
    group: "content",
    command: null,
    status: "aggregate",
    summary: "用户科普入口和后台文章视频发布总览",
    coveredBy: ["content learn", "content article", "content video"],
  },
  {
    id: "requirements-clinical-safety",
    issue: 71,
    group: "multiple",
    command: null,
    status: "aggregate",
    summary: "鼻三线姜刮、证型方案和安全门禁总览",
    coveredBy: ["consult safety", "consult plan", "control candidate"],
  },
  {
    id: "common-ginger-scrape-plan",
    issue: 88,
    group: "control",
    command: "control candidate show common-ginger-scrape-plan",
    status: "blocked_clinical",
    summary: "五种证型共同候选：鼻三线姜刮与指腹擦迎香",
    blocker: "等待临床书面确认方法类型、共同适用范围和安全边界",
  },
  {
    id: "common-ear-seed-plan",
    issue: 89,
    group: "control",
    command: "control candidate show common-ear-seed-plan",
    status: "blocked_clinical",
    summary: "五种证型共同候选：耳穴压豆",
    blocker: "等待临床确认且不得复用刮痧安全规则",
  },
  {
    id: "lung-qi-deficiency-plan",
    issue: 90,
    group: "control",
    command: "control candidate show lung-qi-deficiency-plan",
    status: "blocked_clinical",
    summary: "肺气虚寒型补充穴位候选",
    blocker: "等待临床确认方法类型和方案内容",
  },
  {
    id: "moxibustion-hair-dryer-plan",
    issue: 91,
    group: "control",
    command: "control candidate show moxibustion-hair-dryer-plan",
    status: "blocked_clinical",
    summary: "艾灸和电吹风候选方案",
    blocker: "等待确认温度、距离、时长、适用人群和独立禁忌",
  },
  {
    id: "syndrome-base-plan-mapping",
    issue: 92,
    group: "control",
    command: "control candidate show syndrome-base-plan-mapping",
    status: "blocked_clinical",
    summary: "五种证型到基础方案的候选映射",
    blocker: "等待临床逐项确认；无方案必须与缺失数据区分",
  },
  {
    id: "ginger-scrape-naming",
    issue: 93,
    group: "control",
    command: "control candidate show ginger-scrape-naming",
    status: "blocked_clinical",
    summary: "鼻三线姜刮命名和独立方法类型",
    blocker: "等待确认路线命名以及是否使用独立安全筛查",
  },
  {
    id: "gua-sha-body-safety",
    issue: 94,
    group: "control",
    command: "control candidate show gua-sha-body-safety",
    status: "blocked_clinical",
    summary: "刮痧身体、皮肤和出血风险候选门禁",
    blocker: "规则未经临床确认不得发布",
  },
  {
    id: "gua-sha-rhinitis-safety",
    issue: 95,
    group: "control",
    command: "control candidate show gua-sha-rhinitis-safety",
    status: "blocked_clinical",
    summary: "刮痧鼻炎类型和时期候选门禁",
    blocker: "等待临床确认热性状态和严重发作边界",
  },
  {
    id: "gua-sha-fever-gate",
    issue: 96,
    group: "control",
    command: "control candidate show gua-sha-fever-gate",
    status: "blocked_clinical",
    summary: "刮痧前急性发热和 unknown 候选门禁",
    blocker: "当前只冻结先筛查后方案及 unknown fail-closed 流程",
  },
  {
    id: "independent-method-safety",
    issue: 97,
    group: "control",
    command: "control candidate show independent-method-safety",
    status: "blocked_clinical",
    summary: "刺激方法各自独立的候选安全规则",
    blocker: "各方法缺少独立临床批准规则",
  },
  {
    id: "highlighted-clinical-candidates",
    issue: 98,
    group: "control",
    command: "control candidate show highlighted-clinical-candidates",
    status: "blocked_clinical",
    summary: "兼症、调体、放血和儿童方案候选集",
    blocker: "审核前只能保留在内部候选区",
  },
  {
    id: "clinical-approval-gate",
    issue: 99,
    group: "control",
    command: "control approval status",
    status: "planned",
    summary: "临床候选内容的审批和发布门禁",
  },
  {
    id: "local-pollen-index",
    issue: 101,
    group: "health",
    command: "health pollen status",
    status: "blocked_external",
    summary: "地区花粉指数、等级和更新时间",
    blocker: "等待客户确认数据源、地区获取方式和更新频率",
  },
];

export function getGroup(name: string): CommandGroup | undefined {
  return commandGroups.find((group) => group.name === name);
}

export function getCapability(reference: string): Capability | undefined {
  const issue = Number(reference.replace(/^#/, ""));
  return capabilities.find(
    (capability) =>
      capability.id === reference ||
      (Number.isInteger(issue) && capability.issue === issue),
  );
}
