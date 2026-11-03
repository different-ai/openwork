#!/usr/bin/env bash
# No network or credentials: pscale is a shell mock for these safety tests.
set -euo pipefail
# shellcheck source=scripts/dry-run-branch-guard.sh
source "$(dirname "$0")/dry-run-branch-guard.sh"
export PLANETSCALE_ORG=example DATABASE=example SOURCE_BRANCH=main
protected=true
parent=main
copy_protected=false
delete_calls=0
still_exists=false
api_failure=false
list_failure=false
pscale() {
  if [[ "$1" == api ]]; then
    [[ "$api_failure" == false ]] || return 1
    if [[ "$2" == */main ]]; then
      printf '{"name":"main","deletion_protected":%s}\n' "$protected"
    else
      printf '{"name":"dry-run-123-1","parent_branch":"%s","deletion_protected":%s}\n' "$parent" "$copy_protected"
    fi
  elif [[ "$1 $2" == 'branch delete' ]]; then
    delete_calls=$((delete_calls+1))
  elif [[ "$1 $2" == 'branch list' ]]; then
    [[ "$list_failure" == false ]] || return 1
    if [[ "$still_exists" == true ]]; then
      echo '[{"name":"dry-run-123-1"}]'
    else
      echo '[{"name":"main"}]'
    fi
  else
    return 1
  fi
}
reject() {
  if "$@" >/dev/null 2>&1; then echo "FAILED: expected refusal"; exit 1; fi
}
for name in main check-super-admins dry-run-main dry-run-1 dry-run-1-1-extra ''; do
  reject delete_dry_run_branch "$name"
done
[[ "$delete_calls" == 0 ]]
protected=false
reject delete_dry_run_branch dry-run-123-1
protected=true
parent=other
reject delete_dry_run_branch dry-run-123-1
parent=main
copy_protected=true
reject delete_dry_run_branch dry-run-123-1
copy_protected=false
api_failure=true
reject delete_dry_run_branch dry-run-123-1
api_failure=false
[[ "$delete_calls" == 0 ]]
delete_dry_run_branch dry-run-123-1 >/dev/null
[[ "$delete_calls" == 1 ]]
still_exists=true
reject delete_dry_run_branch dry-run-123-1
still_exists=false
list_failure=true
reject delete_dry_run_branch dry-run-123-1
echo 'Passed: invalid names, unprotected source, wrong parent, protected copy, API errors, deletion and absence verification'
