#!/usr/bin/env bash
set -euo pipefail

upstream_commit="$1"
nightly_tag="$2"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Nightly sync requires a clean checkout." >&2
  exit 1
fi

before="$(git rev-parse HEAD)"
cleanup_merge() {
  if git rev-parse --verify -q MERGE_HEAD >/dev/null; then
    git -c core.hooksPath=/dev/null merge --abort
  fi
}
trap cleanup_merge EXIT

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
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if git rev-parse --verify -q MERGE_HEAD >/dev/null; then
  tree="$(git write-tree)"
  synced="$(node "$script_dir/create-nightly-sync-commit.cjs" "$before" "$upstream_commit" "$tree" "$nightly_tag")"
  cleanup_merge
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'changed=true\nsha=%s\nbase=%s\n' "$synced" "$before" >> "$GITHUB_OUTPUT"
  fi
  echo "Prepared verified nightly sync commit $synced; fork/nightly has not been updated."
else
  if [[ "${VERIFY_SYNC_SIGNING:-}" == true ]]; then
    tree="$(git rev-parse "$before^{tree}")"
    proof="$(node "$script_dir/create-nightly-sync-commit.cjs" "$before" "$upstream_commit" "$tree" "$nightly_tag")"
    echo "Verified GitHub bot signing with unreferenced commit $proof; no refs were updated."
  fi
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'changed=false\n' >> "$GITHUB_OUTPUT"
  fi
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Prepared upstream `%s` for `fork/nightly`, preserving `.github/workflows/`; publication requires verified commit validation.\n' "$nightly_tag" >> "$GITHUB_STEP_SUMMARY"
fi
