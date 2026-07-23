#!/usr/bin/env bash
set -euo pipefail

target="${1:-.}"
target_root="$(git -C "$target" rev-parse --show-toplevel)"
branch_name="$(git -C "$target_root" branch --show-current)"

echo "worktree=$target_root"
echo "branch=$branch_name"
echo
echo "[status]"
git -C "$target_root" status --short
echo
echo "[ahead/behind origin/main]"
git -C "$target_root" rev-list --left-right --count origin/main...HEAD
echo
echo "[commits unique to branch]"
git -C "$target_root" log --oneline origin/main..HEAD
echo
echo "[worktree registry]"
git -C "$target_root" worktree list --porcelain

if command -v gh >/dev/null 2>&1; then
  echo
  echo "[pull request]"
  gh pr view "$branch_name" --json number,state,isDraft,mergeStateStatus,url 2>/dev/null || echo "No pull request found for $branch_name"
fi

echo
echo "Audit only: no worktree or branch was deleted."
