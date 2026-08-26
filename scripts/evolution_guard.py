#!/usr/bin/env python3
"""阻止目录宽度和代码文件长度越过已审计基线。"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any


ROOT_LABEL = "<root>"
COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class GuardResult:
    config_errors: tuple[str, ...]
    violations: tuple[str, ...]
    tracked_files: int = 0
    code_files: int = 0


def _positive_integer(value: Any, field: str, errors: list[str]) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        errors.append(f"{field} 必须是正整数")
        return None
    return value


def _string(value: Any, field: str, errors: list[str]) -> str | None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{field} 必须是非空字符串")
        return None
    return value.strip()


def _load_config(path: Path, today: date) -> tuple[dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, [f"缺少配置：{path}"]
    except (OSError, json.JSONDecodeError) as error:
        return None, [f"无法读取配置 {path}：{error}"]

    if not isinstance(raw, dict):
        return None, ["配置根必须是对象"]
    if raw.get("version") != 1:
        errors.append("version 必须为 1")

    limits = raw.get("limits")
    if not isinstance(limits, dict):
        errors.append("limits 必须是对象")
    else:
        _positive_integer(limits.get("directory_children"), "limits.directory_children", errors)
        _positive_integer(limits.get("file_lines"), "limits.file_lines", errors)

    scope = raw.get("scope")
    if not isinstance(scope, dict):
        errors.append("scope 必须是对象")
    else:
        extensions = scope.get("code_extensions")
        if not isinstance(extensions, list) or not extensions:
            errors.append("scope.code_extensions 必须是非空数组")
        elif any(not isinstance(item, str) or not item.startswith(".") for item in extensions):
            errors.append("scope.code_extensions 每项必须是以 . 开头的扩展名")

    baseline = raw.get("baseline")
    if not isinstance(baseline, dict):
        errors.append("baseline 必须是对象")
    else:
        for field in ("commit", "expires_on", "owner", "reason"):
            _string(baseline.get(field), f"baseline.{field}", errors)
        commit = baseline.get("commit")
        if isinstance(commit, str) and not COMMIT_SHA.fullmatch(commit):
            errors.append("baseline.commit 必须是 40 位小写 Git SHA")
        expires_on = baseline.get("expires_on")
        if isinstance(expires_on, str):
            try:
                expires = date.fromisoformat(expires_on)
                if today > expires:
                    errors.append(
                        f"baseline 已过期（{expires_on}，责任人 {baseline.get('owner', '未登记')}），"
                        "必须按当前事实复核，禁止自动延期"
                    )
            except ValueError:
                errors.append("baseline.expires_on 必须是 YYYY-MM-DD")

        for field in ("directory_widths", "file_lines"):
            values = baseline.get(field)
            if not isinstance(values, dict):
                errors.append(f"baseline.{field} 必须是对象")
                continue
            for key, value in values.items():
                _string(key, f"baseline.{field} 的路径", errors)
                _positive_integer(value, f"baseline.{field}.{key}", errors)

    return raw, errors


def _tracked_files(root: Path) -> tuple[list[str], str | None]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return [], f"git ls-files 失败：{result.stderr.strip()}"
    files = [line for line in result.stdout.splitlines() if line]
    if not files:
        return [], "没有入库文件；空检查不算通过"
    return files, None


def _directory_widths(files: list[str]) -> dict[str, int]:
    children: dict[str, set[str]] = {}
    for relative in files:
        parts = relative.split("/")
        for index in range(len(parts) - 1):
            parent = "/".join(parts[:index]) if index else ROOT_LABEL
            children.setdefault(parent, set()).add(parts[index])
    return {parent: len(names) for parent, names in children.items()}


def audit(
    root: Path,
    config_path: Path | None = None,
    *,
    today: date | None = None,
) -> GuardResult:
    root = root.resolve()
    current_date = today or date.today()
    path = (config_path or root / "state/evolution-guard.json").resolve()
    config, config_errors = _load_config(path, current_date)
    if config is None or config_errors:
        return GuardResult(tuple(config_errors), ())

    files, git_error = _tracked_files(root)
    if git_error is not None:
        return GuardResult((git_error,), ())

    limits = config["limits"]
    baseline = config["baseline"]
    width_limit = limits["directory_children"]
    line_limit = limits["file_lines"]
    width_baseline: dict[str, int] = baseline["directory_widths"]
    line_baseline: dict[str, int] = baseline["file_lines"]
    violations: list[str] = []

    widths = _directory_widths(files)
    for directory in sorted(set(widths) | set(width_baseline)):
        current = widths.get(directory, 0)
        saved = width_baseline.get(directory)
        if current > width_limit:
            if saved is None:
                violations.append(
                    f"[宽度] {directory} 有 {current} 个子目录（新目录上限 {width_limit}）"
                )
            elif current > saved:
                violations.append(
                    f"[宽度] {directory} 有 {current} 个子目录，超过存量基线 {saved}"
                )
            elif current < saved:
                violations.append(
                    f"[基线可收紧] {directory} 已从 {saved} 缩到 {current} 个子目录，"
                    f"可收紧到 {current}；"
                    "请同步收紧配置，禁止恢复旧额度"
                )
        elif saved is not None:
            violations.append(
                f"[基线可移除] {directory} 当前 {current} 个子目录，已不超过上限 {width_limit}"
            )

    extensions = set(config["scope"]["code_extensions"])
    code_files = [relative for relative in files if Path(relative).suffix in extensions]
    current_lines: dict[str, int] = {}
    for relative in code_files:
        source = root / relative
        if source.is_file():
            content = source.read_bytes()
            current_lines[relative] = content.count(b"\n") + int(
                bool(content) and not content.endswith(b"\n")
            )

    for relative in sorted(set(current_lines) | set(line_baseline)):
        current = current_lines.get(relative, 0)
        saved = line_baseline.get(relative)
        if current > line_limit:
            if saved is None:
                violations.append(
                    f"[行数] {relative} 为 {current} 行（新文件上限 {line_limit}）"
                )
            elif current > saved:
                violations.append(
                    f"[行数] {relative} 为 {current} 行，超过存量基线 {saved}"
                )
            elif current < saved:
                violations.append(
                    f"[基线可收紧] {relative} 已从 {saved} 缩到 {current} 行，"
                    f"可收紧到 {current}；"
                    "请同步收紧配置，禁止恢复旧额度"
                )
        elif saved is not None:
            violations.append(
                f"[基线可移除] {relative} 当前 {current} 行，已不超过上限 {line_limit}"
            )

    return GuardResult((), tuple(violations), len(files), len(code_files))


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", help="被检查的 Git 仓路径")
    parser.add_argument("--config", type=Path, help="配置路径，默认 state/evolution-guard.json")
    args = parser.parse_args(arguments)

    result = audit(Path(args.root), args.config)
    if result.config_errors:
        print("演化护栏无法执行：", file=sys.stderr)
        for error in result.config_errors:
            print(f"- {error}", file=sys.stderr)
        return 2
    if result.violations:
        print("演化护栏拦下退化：", file=sys.stderr)
        for violation in result.violations:
            print(f"- {violation}", file=sys.stderr)
        return 1

    print(
        f"演化护栏通过：检查 {result.tracked_files} 个入库文件、"
        f"{result.code_files} 个代码文件；存量宽度和长度均未回退。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
