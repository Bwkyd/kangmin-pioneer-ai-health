#!/usr/bin/env bash
# 2026-08-27 首诊保留入口。规则唯一正本在 scripts/evolution_guard.py，
# 存量基线唯一正本在 state/evolution-guard.json。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET="${1:-$PROJECT_ROOT}"

exec python3 "$PROJECT_ROOT/scripts/evolution-guard.py" "$TARGET"
