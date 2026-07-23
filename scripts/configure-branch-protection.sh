#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
repo_name="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
config_path="${repo_root}/.github/main-branch-protection.json"

gh api \
  --method PUT \
  "repos/${repo_name}/branches/main/protection" \
  --input "$config_path"

echo "Configured main branch protection for ${repo_name}."
