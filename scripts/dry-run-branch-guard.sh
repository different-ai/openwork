#!/usr/bin/env bash
# Sourced by prod-data-dry-run.yml and den-db-migration-test.yml. Only raw API
# reads preserve the deletion_protected field across installed pscale CLI
# versions.
#
# COPY_BRANCH_PATTERN picks which copy names a workflow may touch. It defaults
# to the dry-run names; it is a guard against mistakes, not a security boundary.

assert_dry_run_name() {
  local pattern="${COPY_BRANCH_PATTERN:-^dry-run-[0-9]+-[0-9]+$}"
  if [[ -z "$1" ]] || [[ ! "$1" =~ $pattern ]] || [[ "$1" == "$SOURCE_BRANCH" ]]; then
    echo "::error::Refusing to act on a branch outside the copy pattern $pattern" >&2
    return 1
  fi
}

assert_source_protected() {
  local source
  source="$(pscale api "organizations/$PLANETSCALE_ORG/databases/$DATABASE/branches/$SOURCE_BRANCH")" || return 1
  if ! printf '%s' "$source" | jq -e --arg name "$SOURCE_BRANCH" '.name == $name and .deletion_protected == true' > /dev/null; then
    echo "::error::Source branch deletion protection is not verified. Refusing to create credentials or delete any branch." >&2
    return 1
  fi
}

assert_copy_branch() {
  local name="$1" copy
  assert_dry_run_name "$name" || return 1
  copy="$(pscale api "organizations/$PLANETSCALE_ORG/databases/$DATABASE/branches/$name")" || return 1
  if ! printf '%s' "$copy" | jq -e --arg name "$name" --arg parent "$SOURCE_BRANCH" \
    '.name == $name and .parent_branch == $parent and .deletion_protected == false' > /dev/null; then
    echo "::error::Target is not the expected unprotected dry-run copy. Refusing access or deletion." >&2
    return 1
  fi
}

delete_dry_run_branch() {
  local name="$1" branches
  assert_dry_run_name "$name" || return 1
  assert_source_protected || return 1
  assert_copy_branch "$name" || return 1
  pscale branch delete "$DATABASE" "$name" --org "$PLANETSCALE_ORG" --force || {
    echo "::error::Could not delete $name. A database administrator must remove this production-data copy in PlanetScale." >&2
    return 1
  }
  branches="$(pscale branch list "$DATABASE" --org "$PLANETSCALE_ORG" --format json)" || return 1
  if printf '%s' "$branches" | jq -e --arg name "$name" 'any(.[]; .name == $name)' > /dev/null; then
    echo "::error::Deletion was not confirmed; $name still exists." >&2
    return 1
  fi
  echo "Deleted $name (absence verified)"
}
