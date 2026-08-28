#!/usr/bin/env python3
"""检查 kangmin 目录协议中可机械验证的结构和链接。"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from evolution_guard import audit as audit_evolution_guard


REQUIRED_FILES = (
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    ".42cog/intent.md",
    ".42cog/real.md",
    ".42cog/cog.md",
    ".42cog/meta.md",
    "specs/README.md",
    "specs/style/README.md",
    ".codex/config.toml",
    ".codex/README.md",
    ".agents/README.md",
    ".agents/skills/km-review/SKILL.md",
    "skills/km-review/SKILL.md",
    "skills/km-review/agents/openai.yaml",
    "vault/raw/README.md",
    "resources/README.md",
    "plugin.json",
    "42plugin.json",
    "scripts/README.md",
    "scripts/check-manifests.py",
    "scripts/check-tools.sh",
    "scripts/evolution-guard.py",
    "scripts/evolution_guard.py",
    "scripts/test-evolution-guard.py",
    "state/evolution-guard.json",
    ".claude/workflows/README.md",
    ".claude/workflows/km-review.js",
    "state/board.md",
    "state/changelog.md",
    "state/memory/MEMORY.md",
    "docs/plan/README.md",
    "docs/research/README.md",
    "docs/reviews/README.md",
    "docs/experiments/README.md",
    "meta/kangmin_directory-protocol.md",
)

REQUIRED_DIRECTORIES = (
    ".42cog",
    ".codex",
    ".agents/skills",
    "specs/style",
    "src",
    "legacy",
    "state/memory",
    "meta",
    "vault/truth",
    "vault/style",
    "docs/plan",
    "docs/reviews",
    "docs/research",
    "docs/experiments",
    "docs/product",
    "docs/changes",
    "skills",
    "scripts",
)

PRIVATE_REQUIRED_FILES = {
    "vault/raw/README.md",
}

PRIVATE_REQUIRED_DIRECTORIES = {
    "vault/truth",
    "vault/style",
}

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
    "scripts/README.md",
    "specs/README.md",
    "specs/style/README.md",
    ".codex/README.md",
    ".agents/README.md",
    ".claude/workflows/README.md",
    "vault/README.md",
    "vault/truth/README.md",
)

DATED_DIRECTORY = re.compile(r"^\d{8}-[a-z0-9][a-z0-9-]*$")
BUILD_DIRECTORY = re.compile(r"^\d{8}-\d{6}$")
MEMORY_FILE = re.compile(r"^\d{8}-[a-z0-9][a-z0-9-]*\.md$")
NUMBERED_DOCUMENT = re.compile(r"^(\d{3})_[a-z0-9][a-z0-9-]*\.md$")
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")


def check_required(
    root: Path,
    errors: list[str],
    *,
    allow_missing_private: bool = False,
) -> None:
    for relative in REQUIRED_FILES:
        path = root / relative
        if not path.is_file():
            if allow_missing_private and relative in PRIVATE_REQUIRED_FILES:
                continue
            errors.append(f"缺少必需文件：{relative}")
        elif path.stat().st_size == 0:
            errors.append(f"必需文件为空：{relative}")

    for relative in REQUIRED_DIRECTORIES:
        if not (root / relative).is_dir():
            if allow_missing_private and relative in PRIVATE_REQUIRED_DIRECTORIES:
                continue
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


def check_navigation_links(
    root: Path,
    errors: list[str],
    *,
    allow_missing_private: bool = False,
) -> None:
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
                try:
                    resolved.relative_to(root / "vault")
                except ValueError:
                    is_missing_private = False
                else:
                    is_missing_private = True
                if allow_missing_private and is_missing_private:
                    continue
                errors.append(f"导航链接失效：{relative} -> {target}")


def check_document_numbers(root: Path, errors: list[str]) -> None:
    """按 docs 分类检查编号；changes 的 arch/ops/fix 各自独立编号。"""
    categories = {
        category: (root / "docs" / category,)
        for category in ("plan", "reviews", "research")
    }
    categories["changes"] = tuple(
        root / "docs" / "changes" / change_type
        for change_type in ("arch", "ops", "fix")
    )

    for category, category_roots in categories.items():
        for category_root in category_roots:
            if not category_root.exists():
                continue
            documents: dict[int, list[Path]] = {}
            for document in sorted(category_root.rglob("*.md")):
                match = NUMBERED_DOCUMENT.fullmatch(document.name)
                if match is None:
                    continue
                number = int(match.group(1))
                documents.setdefault(number, []).append(document.relative_to(root))

            label = category_root.relative_to(root)
            for number, paths in sorted(documents.items()):
                if len(paths) > 1:
                    joined = "、".join(str(path) for path in paths)
                    errors.append(
                        f"{label} 分类编号重复：{number:03d} -> {joined}"
                    )

            if not documents:
                continue
            expected = set(range(1, max(documents) + 1))
            missing = sorted(expected - set(documents))
            if missing:
                errors.append(
                    f"{label} 分类编号不连续，缺少："
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


def check_codex_entrypoints(root: Path, errors: list[str]) -> None:
    config = root / ".codex/config.toml"
    if config.is_file():
        text = config.read_text(encoding="utf-8")
        if 'project_doc_fallback_filenames = ["CLAUDE.md"]' not in text:
            errors.append(".codex/config.toml 必须把 CLAUDE.md 设为 AGENTS.md 缺失时的兼容回退")

    discovered = root / ".agents/skills/km-review"
    canonical = root / "skills/km-review"
    if discovered.exists() and not discovered.is_symlink():
        errors.append(".agents/skills/km-review 必须是指向 skills/km-review 的符号链接，禁止维护副本")
    elif discovered.is_symlink() and discovered.resolve() != canonical.resolve():
        errors.append(".agents/skills/km-review 符号链接目标错误")


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


def check_evolution_guard(root: Path, errors: list[str]) -> None:
    """复用独立护栏的唯一实现，避免同一条结构规则出现两种口径。"""
    result = audit_evolution_guard(root)
    errors.extend(f"演化护栏配置错误：{error}" for error in result.config_errors)
    errors.extend(f"演化护栏：{violation}" for violation in result.violations)


def main() -> int:
    arguments = sys.argv[1:]
    allow_missing_private = "--allow-missing-private" in arguments
    root_argument = next(
        (argument for argument in arguments if not argument.startswith("--")),
        ".",
    )
    root = Path(root_argument).resolve()
    errors: list[str] = []

    check_required(root, errors, allow_missing_private=allow_missing_private)
    check_dated_directory(root, "_work", DATED_DIRECTORY, errors)
    check_dated_directory(root, "_archive", DATED_DIRECTORY, errors)
    check_dated_directory(root, "_build", BUILD_DIRECTORY, errors)
    check_memory(root, errors)
    check_document_numbers(root, errors)
    check_navigation_links(
        root,
        errors,
        allow_missing_private=allow_missing_private,
    )
    check_agents_claude_sync(root, errors)
    check_codex_entrypoints(root, errors)
    check_removed_paths(root, errors)
    check_evolution_guard(root, errors)

    if errors:
        print("目录结构检查失败：", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("目录结构检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
