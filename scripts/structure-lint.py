#!/usr/bin/env python3
"""检查 kangmin 目录协议中可机械验证的结构和链接。"""

from __future__ import annotations

import re
import sys
from pathlib import Path


REQUIRED_FILES = (
    "AGENTS.md",
    "CLAUDE.md",
    "state/board.md",
    "state/changelog.md",
    "state/memory/MEMORY.md",
    "meta/kangmin_directory-protocol.md",
)

REQUIRED_DIRECTORIES = (
    "src",
    "legacy",
    "state/memory",
    "meta",
    "vault/truth",
    "vault/style",
    "docs/plan",
    "docs/reviews",
    "docs/research",
    "docs/product",
    "docs/changes",
    "skills",
    "scripts",
)

NAVIGATION_FILES = (
    "AGENTS.md",
    "README.md",
    "docs/README.md",
    "docs/plan/README.md",
    "docs/reviews/README.md",
    "docs/research/README.md",
    "docs/product/README.md",
    "docs/changes/README.md",
    "meta/kangmin_directory-protocol.md",
    "state/memory/MEMORY.md",
    "skills/README.md",
    "vault/README.md",
    "vault/truth/README.md",
)

DATED_DIRECTORY = re.compile(r"^\d{8}-[a-z0-9][a-z0-9-]*$")
BUILD_DIRECTORY = re.compile(r"^\d{8}-\d{6}$")
MEMORY_FILE = re.compile(r"^\d{8}-[a-z0-9][a-z0-9-]*\.md$")
NUMBERED_DOCUMENT = re.compile(r"^(\d{3})_[a-z0-9][a-z0-9-]*\.md$")
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")


def check_required(root: Path, errors: list[str]) -> None:
    for relative in REQUIRED_FILES:
        path = root / relative
        if not path.is_file():
            errors.append(f"缺少必需文件：{relative}")
        elif path.stat().st_size == 0:
            errors.append(f"必需文件为空：{relative}")

    for relative in REQUIRED_DIRECTORIES:
        if not (root / relative).is_dir():
            errors.append(f"缺少必需目录：{relative}/")


def check_dated_directory(
    root: Path, relative: str, pattern: re.Pattern[str], errors: list[str]
) -> None:
    directory = root / relative
    if not directory.exists():
        return

    for entry in sorted(directory.iterdir()):
        if entry.name == ".DS_Store":
            continue
        if not entry.is_dir():
            errors.append(f"{relative}/ 不允许裸文件：{entry.name}")
        elif not pattern.fullmatch(entry.name):
            errors.append(f"{relative}/ 子目录命名不合规：{entry.name}")


def check_memory(root: Path, errors: list[str]) -> None:
    directory = root / "state/memory"
    if not directory.exists():
        return

    for entry in sorted(directory.iterdir()):
        if entry.name in {"MEMORY.md", ".DS_Store"}:
            continue
        if not entry.is_file() or not MEMORY_FILE.fullmatch(entry.name):
            errors.append(f"state/memory/ 条目命名不合规：{entry.name}")


def check_navigation_links(root: Path, errors: list[str]) -> None:
    for relative in NAVIGATION_FILES:
        document = root / relative
        if not document.is_file():
            continue

        for target in MARKDOWN_LINK.findall(document.read_text(encoding="utf-8")):
            target = target.strip().strip("<>").split("#", 1)[0]
            if not target or target.startswith(("http://", "https://", "mailto:", "/")):
                continue
            resolved = (document.parent / target).resolve()
            if not resolved.exists():
                errors.append(f"导航链接失效：{relative} -> {target}")


def check_document_numbers(root: Path, errors: list[str]) -> None:
    """plan/reviews/research/changes 各自在分类内从 001 连续编号。"""
    for category in ("plan", "reviews", "research", "changes"):
        category_root = root / "docs" / category
        if not category_root.exists():
            continue
        documents: dict[int, list[Path]] = {}
        for document in sorted(category_root.rglob("*.md")):
            match = NUMBERED_DOCUMENT.fullmatch(document.name)
            if match is None:
                continue
            number = int(match.group(1))
            documents.setdefault(number, []).append(document.relative_to(root))

        for number, paths in sorted(documents.items()):
            if len(paths) > 1:
                joined = "、".join(str(path) for path in paths)
                errors.append(
                    f"docs/{category} 分类编号重复：{number:03d} -> {joined}"
                )

        if not documents:
            continue
        expected = set(range(1, max(documents) + 1))
        missing = sorted(expected - set(documents))
        if missing:
            errors.append(
                f"docs/{category} 分类编号不连续，缺少："
                + "、".join(f"{number:03d}" for number in missing)
            )


def check_agents_claude_sync(root: Path, errors: list[str]) -> None:
    agents = root / "AGENTS.md"
    claude = root / "CLAUDE.md"
    if not agents.is_file() or not claude.is_file():
        return
    body_agents = agents.read_text(encoding="utf-8").split("\n", 1)[1]
    body_claude = claude.read_text(encoding="utf-8").split("\n", 1)[1]
    if body_agents != body_claude:
        errors.append("AGENTS.md 与 CLAUDE.md 除首行标题外不一致，请同步修改")


def check_removed_paths(root: Path, errors: list[str]) -> None:
    for relative in ("vault/business",):
        if (root / relative).exists():
            errors.append(f"已废弃目录仍存在：{relative}/")

    checks = {
        "docs/README.md": ("docs/meetings", "客户资料/", "计划和进行中事项不写入 board"),
        "meta/kangmin_directory-protocol.md": ("docs/客户资料", "scripts/structure‑lint.py"),
        "src/modules/clinical-rules/rule-package.ts": ("docs/客户资料",),
    }
    for relative, removed in checks.items():
        path = root / relative
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for value in removed:
            if value in text:
                errors.append(f"已废弃路径或规则残留：{relative} -> {value}")


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors: list[str] = []

    check_required(root, errors)
    check_dated_directory(root, "_work", DATED_DIRECTORY, errors)
    check_dated_directory(root, "_archive", DATED_DIRECTORY, errors)
    check_dated_directory(root, "_build", BUILD_DIRECTORY, errors)
    check_memory(root, errors)
    check_document_numbers(root, errors)
    check_navigation_links(root, errors)
    check_agents_claude_sync(root, errors)
    check_removed_paths(root, errors)

    if errors:
        print("目录结构检查失败：", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("目录结构检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
