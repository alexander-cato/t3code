#!/usr/bin/env bash
set -euo pipefail

upstream_commit="$1"
nightly_tag="$2"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Nightly sync requires a clean checkout." >&2
  exit 1
fi

before="$(git rev-parse HEAD)"
merge_status=0
git merge --no-commit --no-ff "$upstream_commit" || merge_status=$?
if [[ "$merge_status" -gt 1 ]]; then
  exit "$merge_status"
fi

# Keep the fork's automation, including paths upstream added or removed.
git restore --source="$before" --staged --worktree -- .github/workflows
conflicts="$(git diff --name-only --diff-filter=U)"
if [[ -n "$conflicts" ]]; then
  printf 'Resolve these source conflicts manually, then rerun nightly sync:\n%s\n' "$conflicts" >&2
  git merge --abort
  exit 1
fi

if git rev-parse --verify -q MERGE_HEAD >/dev/null; then
  git -c core.hooksPath=/dev/null commit -m "chore: sync upstream $nightly_tag (preserve fork workflows)"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Synced upstream `%s` into `fork/nightly`, preserving `.github/workflows/`.\n' "$nightly_tag" >> "$GITHUB_STEP_SUMMARY"
fi
