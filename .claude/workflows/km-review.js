// kangmin · 抗敏先锋 AI 鼻健康管理系统 · 多视角自检
// Claude Code Dynamic workflows 专属语法；换工具时保留分工，不照搬路径和语法。
// 本项目主要使用 Codex；Codex 主入口是 $km-review，正本在 skills/km-review/SKILL.md。

export const meta = {
  name: 'km-review',
  description: '从患者可懂性、工程事实与医学安全三个互异视角评审，再按 P0–P3 汇总',
  phases: [
    { title: '分头审', detail: '每个视角只检查自己负责的问题' },
    { title: '收清单', detail: '合并去重并按风险等级排序' },
  ],
}

const LENSES = [
  {
    key: '患者',
    prompt: '你是普通鼻炎患者。只检查是否听得懂、是否知道下一步、是否看到内部协议或被误导为诊断。',
  },
  {
    key: '工程',
    prompt: '你是资深工程师。只检查事实、调用链、状态一致性、失败路径和验证证据，不裁决文风。',
  },
  {
    key: '医学安全',
    prompt: '你只检查是否越过 truth：模型自行辨证、编造穴位疗法细节、替代诊断或作疗效承诺。',
  },
]

const TARGET = args?.target || 'src/'

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          where: { type: 'string', description: '文件与行号，不贴全文' },
          what: { type: 'string' },
          why: { type: 'string', description: '说明为什么是事实、逻辑、安全或合规问题' },
        },
        required: ['level', 'where', 'what', 'why'],
      },
    },
  },
  required: ['findings'],
}

phase('分头审')
const rounds = await parallel(
  LENSES.map((lens) => () =>
    agent(
      `${lens.prompt}\n\n审查目标：${TARGET}\n\n` +
        '逐条给出等级、文件与行号、问题和理由。找不到就明确说找不到，不要凑数。',
      { label: `审:${lens.key}`, phase: '分头审', schema: FINDINGS },
    ),
  ),
)

phase('收清单')
const all = rounds.filter(Boolean).flatMap((round) => round.findings)
const order = { P0: 0, P1: 1, P2: 2, P3: 3 }
all.sort((left, right) => order[left.level] - order[right.level])

log(
  `${all.length} 条：P0 ${all.filter((item) => item.level === 'P0').length} · ` +
    `P1 ${all.filter((item) => item.level === 'P1').length} · ` +
    `P2 ${all.filter((item) => item.level === 'P2').length} · ` +
    `P3 ${all.filter((item) => item.level === 'P3').length}`,
)

return {
  findings: all,
  收工判据: 'P0 / P1 / P2 修复为零，P3 由作者按成本和收益决定。',
}
