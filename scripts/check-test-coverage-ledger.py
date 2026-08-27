#!/usr/bin/env python3
"""校验四组功能—测试覆盖账本的结构与最小可追溯信息。"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path


DEFAULT_LEDGER = Path("docs/plan/014_test-coverage-ledger.md")
REQUIRED_HEADINGS = (
    "## 当前状态",
    "## 目标与非目标",
    "## 四组边界",
    "## 行为覆盖账本",
    "## 实测基线",
    "## 已知缺口与下一步",
    "## 验收与限制",
)
REQUIRED_PHRASES = (
    "完整门禁实测",
    "外部适配器跳过项",
    "测试密度只作趋势哨兵，不设测试数量目标",
    "下一条最小补测候选",
)
GROUP_BY_PREFIX = {
    "CORE": "核心·智能调理",
    "CONTENT": "辅助·内容供给",
    "RECORD": "次要·症状管理",
    "SHELL": "次要·基础壳",
}
ROW_ID = re.compile(r"^KM-(CORE|CONTENT|RECORD|SHELL)-\d{2}$")
EVIDENCE_TEST = re.compile(r"`(src/tests/[^`]+\.test\.ts)`")
COMMAND_TEST = re.compile(r"dist/tests/([^`\s]+\.test\.js)")


def fail(messages: list[str]) -> int:
    for message in messages:
        print(f"✗ {message}")
    print(f"\n{len(messages)} 个错误。")
    return 1


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    ledger = root / DEFAULT_LEDGER
    if not ledger.is_file():
        return fail([f"缺少覆盖账本：{DEFAULT_LEDGER}"])

    text = ledger.read_text(encoding="utf-8")
    errors: list[str] = []
    for heading in REQUIRED_HEADINGS:
        if heading not in text:
            errors.append(f"缺少章节：{heading}")
    for phrase in REQUIRED_PHRASES:
        if phrase not in text:
            errors.append(f"缺少验收口径：{phrase}")

    rows: list[list[str]] = []
    for line in text.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and ROW_ID.fullmatch(cells[0]):
            rows.append(cells)

    if not rows:
        errors.append("行为覆盖账本没有可识别的数据行")
        return fail(errors)

    ids: set[str] = set()
    behaviors: set[str] = set()
    group_counts: Counter[str] = Counter()
    for cells in rows:
        if len(cells) != 7:
            errors.append(f"{cells[0]} 必须有 7 列，实际 {len(cells)} 列")
            continue

        row_id, group, behavior, evidence, level, command, gap = cells
        prefix = ROW_ID.fullmatch(row_id).group(1)  # type: ignore[union-attr]
        expected_group = GROUP_BY_PREFIX[prefix]
        if row_id in ids:
            errors.append(f"行为 ID 重复：{row_id}")
        ids.add(row_id)
        if behavior in behaviors:
            errors.append(f"可辨识行为重复登记：{behavior}")
        behaviors.add(behavior)
        if group != expected_group:
            errors.append(f"{row_id} 分组应为 `{expected_group}`，实际 `{group}`")
        group_counts[prefix] += 1
        if "src/tests/" not in evidence and "明确缺口" not in evidence:
            errors.append(f"{row_id} 缺少测试文件证据或明确缺口")
        evidence_tests = EVIDENCE_TEST.findall(evidence)
        for test_path in evidence_tests:
            if not (root / test_path).is_file():
                errors.append(f"{row_id} 测试证据不存在：{test_path}")
        if not level:
            errors.append(f"{row_id} 缺少测试层级")
        if "cd src &&" not in command:
            errors.append(f"{row_id} 最窄命令必须从 `src` 明确运行")
        if "npm run build" not in command or "node --test" not in command:
            errors.append(f"{row_id} 最窄命令必须包含构建和 Node 测试")
        expected_compiled_tests = {
            Path(test_path).name.removesuffix(".ts") + ".js"
            for test_path in evidence_tests
        }
        commanded_tests = set(COMMAND_TEST.findall(command))
        if expected_compiled_tests != commanded_tests:
            errors.append(
                f"{row_id} 命令与测试证据不一致："
                f"期望 {sorted(expected_compiled_tests)}，实际 {sorted(commanded_tests)}"
            )
        if not gap:
            errors.append(f"{row_id} 缺少已知缺口")

    for prefix, group in GROUP_BY_PREFIX.items():
        if group_counts[prefix] < 2:
            errors.append(f"{group} 至少登记 2 个可辨识行为")

    if errors:
        return fail(errors)
    print(f"✓ 覆盖账本通过：{len(rows)} 个行为，四组均可追溯且各不少于 2 项。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
