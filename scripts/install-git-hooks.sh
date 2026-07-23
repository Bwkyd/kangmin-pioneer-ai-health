#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
git -C "$repo_root" config core.hooksPath .githooks

echo "Installed repository Git hooks from .githooks/"
echo "Direct pushes to main are now blocked locally."
