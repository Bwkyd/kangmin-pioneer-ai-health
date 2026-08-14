#!/usr/bin/env python3
"""校验项目自产插件清单和外部插件依赖清单。

用法：python3 scripts/check-manifests.py [项目根目录，默认 .]
退出码 0 表示通过，1 表示存在错误。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
ALLOWED = {
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
}
REQUIRED = {"$schema", "name"}
AUTHOR_FIELDS = {"name", "email", "url"}
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$")

errors: list[str] = []
notes: list[str] = []


def error(message: str) -> None:
    errors.append(message)


def load(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        error(
            f"{path.name}：不是合法 JSON——第 {exc.lineno} 行第 {exc.colno} 列，{exc.msg}"
        )
    except OSError as exc:
        error(f"{path.name}：无法读取——{exc}")
    return None


def check_plugin(path: Path) -> None:
    data = load(path)
    if data is None:
        return
    if not isinstance(data, dict):
        error(f"{path.name}：顶层必须是对象")
        return

    for field in sorted(REQUIRED - data.keys()):
        error(f"{path.name}：缺少必填字段 `{field}`")
    for field in sorted(data.keys() - ALLOWED):
        notes.append(
            f"{path.name}：未知顶层字段 `{field}` 会被客户端忽略，客户端专属数据应放入 extensions"
        )

    if data.get("$schema") not in (None, SCHEMA_ID):
        error(f"{path.name}：`$schema` 必须是 {SCHEMA_ID}")

    name = data.get("name")
    if name is not None:
        if not isinstance(name, str) or not name:
            error(f"{path.name}：`name` 必须是非空字符串")
        elif len(name) > 64:
            error(f"{path.name}：`name` 超过 64 个字符")
        elif "--" in name or ".." in name:
            error(f"{path.name}：`name` 不允许连续的 `--` 或 `..`")
        elif not NAME_RE.fullmatch(name):
            error(
                f"{path.name}：`name` 只允许小写字母、数字、`-`、`.`，且首尾为字母或数字"
            )

    author = data.get("author")
    if author is not None:
        if not isinstance(author, dict):
            error(f"{path.name}：`author` 必须是对象")
        else:
            for field in sorted(author.keys() - AUTHOR_FIELDS):
                error(f"{path.name}：`author` 多出字段 `{field}`")
            for field, value in author.items():
                if field in AUTHOR_FIELDS and not isinstance(value, str):
                    error(f"{path.name}：`author.{field}` 必须是字符串")

    for field in ("version", "description", "homepage", "repository", "license"):
        if field in data and not isinstance(data[field], str):
            error(f"{path.name}：`{field}` 必须是字符串")

    keywords = data.get("keywords")
    if keywords is not None and (
        not isinstance(keywords, list)
        or any(not isinstance(keyword, str) for keyword in keywords)
    ):
        error(f"{path.name}：`keywords` 必须是字符串数组")

    extensions = data.get("extensions")
    if extensions is not None and not isinstance(extensions, dict):
        error(f"{path.name}：`extensions` 必须是对象")


def check_42plugin(path: Path) -> None:
    data = load(path)
    if data is None:
        return
    if not isinstance(data, dict):
        error(f"{path.name}：顶层必须是对象")
        return

    plugins = data.get("plugins")
    if plugins is None:
        error(f"{path.name}：缺少 `plugins` 字段")
        return
    if not isinstance(plugins, list):
        error(f"{path.name}：`plugins` 必须是数组")
        return

    seen: set[str] = set()
    for index, item in enumerate(plugins):
        location = f"{path.name}：plugins[{index}]"
        if not isinstance(item, dict):
            error(f'{location} 必须是对象，形如 {{"source": "...", "version": "..."}}')
            continue
        source = item.get("source")
        if not isinstance(source, str) or not source:
            error(f"{location} 缺少 `source`")
            continue
        if source in seen:
            error(f"{location} `source` 重复：{source}")
        seen.add(source)
        version = item.get("version")
        if version is not None and not isinstance(version, str):
            error(f"{location} `version` 必须是字符串")


def check_layout(root: Path) -> None:
    skills = root / "skills"
    if skills.exists() and not skills.is_dir():
        error("skills 存在但不是目录")
        return
    if not skills.is_dir():
        return

    found = [
        directory.name
        for directory in sorted(skills.iterdir())
        if directory.is_dir() and (directory / "SKILL.md").is_file()
    ]
    stray = [
        directory.name
        for directory in sorted(skills.iterdir())
        if directory.is_dir()
        and not (directory / "SKILL.md").is_file()
        and not directory.name.startswith(".")
    ]
    for name in stray:
        notes.append(f"skills/{name}/ 缺少 SKILL.md，不会被识别为 skill")
    if found:
        notes.append(
            f"发现 {len(found)} 个 skill：{', '.join(found)}；它们共用根目录 plugin.json"
        )


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    checked = 0
    for name, checker in (
        ("plugin.json", check_plugin),
        ("42plugin.json", check_42plugin),
    ):
        path = root / name
        if path.exists():
            checker(path)
            checked += 1
        else:
            notes.append(f"{name} 不存在，跳过")

    check_layout(root)
    for note in notes:
        print(f"  · {note}")

    if errors:
        print()
        for item in errors:
            print(f"✗ {item}")
        print(f"\n{len(errors)} 个错误。")
        return 1

    print(f"\n✓ 全绿（校验 {checked} 份清单）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
