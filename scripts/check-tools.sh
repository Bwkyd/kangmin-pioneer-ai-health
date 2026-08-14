#!/usr/bin/env bash
# kangmin · 抗敏先锋 AI 鼻健康管理系统 · 工具就绪检查
# 只看不装；安装命令只供作者确认后手工执行。
set -uo pipefail

MIRRORS=0
[ "${1:-}" = "--mirrors" ] && MIRRORS=1

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) OS=win ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }
MISSING=""

check() {
  local cmd="$1" what="$2" how_mac="$3" how_linux="$4" how_win="$5"
  if have "$cmd"; then
    printf '  ✓ %-10s %s\n' "$cmd" "$what"
  else
    local how
    case "$OS" in
      mac) how="$how_mac" ;;
      linux) how="$how_linux" ;;
      *) how="$how_win" ;;
    esac
    printf '  ✗ %-10s %-28s → %s\n' "$cmd" "$what" "$how"
    MISSING="$MISSING $cmd"
  fi
}

echo "▸ 项目运行与检查"
check git "版本控制" "brew install git" "使用系统包管理器安装 git" "scoop install git"
check node "Node.js 运行时（项目要求 22.13.0）" "brew install node@22" "安装 Node.js 22" "scoop install nodejs-lts"
check npm "依赖安装与项目门禁" "随 Node.js 安装" "随 Node.js 安装" "随 Node.js 安装"
check python3 "目录和清单检查" "brew install python" "多数发行版自带" "scoop install python"
check rg "快速全文检索" "brew install ripgrep" "使用系统包管理器安装 ripgrep" "scoop install ripgrep"

echo
echo "▸ 仓库与安全辅助"
check jq "命令行处理 JSON" "brew install jq" "使用系统包管理器安装 jq" "scoop install jq"
check gitleaks "提交前扫描密钥" "brew install gitleaks" "从官方 releases 安装" "scoop install gitleaks"
check gh "GitHub 命令行入口" "brew install gh" "见 cli.github.com" "scoop install gh"

echo
echo "▸ 异质评审入口（可选）"
have codex && printf '  ✓ %-10s %s\n' codex "OpenAI Codex" || printf '  – %-10s %s\n' codex "未安装"
have opencode && printf '  ✓ %-10s %s\n' opencode "OpenCode" || printf '  – %-10s %s\n' opencode "未安装"
have codewhale && printf '  ✓ %-10s %s\n' codewhale "CodeWhale" || printf '  – %-10s %s\n' codewhale "未安装"

echo
if [ -n "$MISSING" ]; then
  echo "▸ 缺少：$MISSING"
  echo "  只从官方或可信来源安装；先核对包名和维护状态。"
else
  echo "▸ 必需工具已齐。"
fi

if [ "$MIRRORS" = 1 ]; then
  cat <<'EOF'

▸ 国内镜像（官方源不可用时再采用）

  npm      npm config set registry https://registry.npmmirror.com
  PyPI     pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
  Homebrew 按清华大学或中国科学技术大学镜像站的当前说明配置

只使用 HTTPS，并保留恢复官方源的方法；镜像地址使用前重新核验。
EOF
fi

exit 0
