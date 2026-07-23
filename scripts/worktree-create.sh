#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <issue-number> <slug>" >&2
  exit 2
fi

issue_number="$1"
slug="$2"

if [[ ! "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Issue number must be numeric." >&2
  exit 2
fi

if [[ ! "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Slug must use lowercase letters, digits, and single hyphens." >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
branch_name="codex/issue-${issue_number}-${slug}"
worktree_path="${repo_root}/.worktrees/issue-${issue_number}-${slug}"
base_ref="${WORKTREE_BASE_REF:-origin/main}"

if [[ -e "$worktree_path" ]]; then
  echo "Worktree path already exists: $worktree_path" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/${branch_name}"; then
  echo "Local branch already exists: $branch_name" >&2
  exit 1
fi

if [[ "$base_ref" == "origin/main" ]]; then
  git fetch origin main
fi

if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
  echo "Base ref does not exist: $base_ref" >&2
  exit 1
fi

mkdir -p "${repo_root}/.worktrees"
git worktree add -b "$branch_name" "$worktree_path" "$base_ref"

echo "Created branch: $branch_name"
echo "Created worktree: $worktree_path"
echo "Base ref: $base_ref"
echo "Next: cd \"$worktree_path\" && npm ci"
