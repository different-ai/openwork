#!/usr/bin/env bash
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
INFRA_PATHS=(
  .github/workflows/
  packaging/docker/
  turbo.json
  apps/app/vercel.json
  apps/share/vercel.json
  ee/apps/den-web/vercel.json
  apps/desktop/src-tauri/tauri.conf.json
)

# Globs for package.json scripts across all workspaces
PACKAGE_JSONS=$(find . -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*')

# Files that are used by convention (framework/tool magic), not imports
CONVENTION_PATTERNS=(
  "postinstall"
  "drizzle.config"
  "tauri-before-build"
  "tauri-before-dev"
)

# File-based routing directories — files here are entry points by convention
ROUTING_DIRS=(
  "apps/share/server/"
  "ee/apps/den-web/app/"
  "ee/apps/landing/app/api/"
)

# Paths to ignore entirely (scripts, dev tools, etc.)
IGNORE_PREFIXES=(
  "apps/app/scripts/"
  "apps/desktop/scripts/"
  "apps/orchestrator/scripts/"
  "scripts/stats"
)

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Step 1: Run knip ───────────────────────────────────────────────────────
echo -e "${BOLD}Running knip to detect unused files...${RESET}"
KNIP_OUTPUT=$(DATABASE_URL=mysql://fake:fake@localhost/fake npx knip --include files --no-progress --no-config-hints 2>&1 || true)

UNUSED_FILES=()
while IFS= read -r line; do
  trimmed=$(echo "$line" | sed 's/[[:space:]]*$//')
  [ -z "$trimmed" ] && continue
  [[ "$trimmed" == Unused* ]] && continue
  [[ "$trimmed" == npm* ]] && continue
  [ -f "$trimmed" ] || continue
  skip=false
  for prefix in "${IGNORE_PREFIXES[@]}"; do
    if [[ "$trimmed" == "$prefix"* ]]; then
      skip=true
      break
    fi
  done
  $skip || UNUSED_FILES+=("$trimmed")
done <<< "$KNIP_OUTPUT"

if [ ${#UNUSED_FILES[@]} -eq 0 ]; then
  echo -e "${GREEN}No unused files detected by knip.${RESET}"
  exit 0
fi

echo -e "Found ${BOLD}${#UNUSED_FILES[@]}${RESET} unused files. Cross-referencing...\n"

# ── Step 2: Cross-reference each file ──────────────────────────────────────
declare -A FILE_STATUS  # "safe" | "ci" | "convention" | "routing"
declare -A FILE_REFS
declare -A FILE_DATES

for filepath in "${UNUSED_FILES[@]}"; do
  name=$(basename "$filepath")
  status="safe"
  refs=""

  # Check CI/infra configs
  existing_paths=()
  for p in "${INFRA_PATHS[@]}"; do
    [ -e "$p" ] && existing_paths+=("$p")
  done
  if [ ${#existing_paths[@]} -gt 0 ]; then
    ci_hits=$(grep -rl "$name" "${existing_paths[@]}" 2>/dev/null || true)
    if [ -n "$ci_hits" ]; then
      status="ci"
      refs="$ci_hits"
    fi
  fi

  # Check package.json scripts
  if [ "$status" = "safe" ]; then
    pkg_hits=$(echo "$PACKAGE_JSONS" | xargs grep -l "$name" 2>/dev/null || true)
    if [ -n "$pkg_hits" ]; then
      status="ci"
      refs="$pkg_hits"
    fi
  fi

  # Check convention-based usage
  if [ "$status" = "safe" ]; then
    for pat in "${CONVENTION_PATTERNS[@]}"; do
      if [[ "$name" == *"$pat"* ]]; then
        status="convention"
        refs="used by convention ($pat)"
        break
      fi
    done
  fi

  # Check file-based routing dirs
  if [ "$status" = "safe" ]; then
    for dir in "${ROUTING_DIRS[@]}"; do
      if [[ "$filepath" == "$dir"* ]]; then
        status="routing"
        refs="file-based route ($dir)"
        break
      fi
    done
  fi

  # Get last commit date
  last_date=$(git log -1 --format="%aI" -- "$filepath" 2>/dev/null || echo "unknown")

  FILE_STATUS["$filepath"]="$status"
  FILE_REFS["$filepath"]="$refs"
  FILE_DATES["$filepath"]="$last_date"
done

# ── Step 3: Sort by date and display ───────────────────────────────────────
sorted_files=()
while IFS= read -r line; do
  sorted_files+=("$line")
done < <(
  for filepath in "${UNUSED_FILES[@]}"; do
    echo "${FILE_DATES[$filepath]}|$filepath"
  done | sort
)

safe_count=0
flagged_count=0

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD} UNUSED FILES (oldest first)${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

for entry in "${sorted_files[@]}"; do
  date="${entry%%|*}"
  filepath="${entry#*|}"
  status="${FILE_STATUS[$filepath]}"
  refs="${FILE_REFS[$filepath]}"
  short_date="${date%%T*}"

  case "$status" in
    safe)
      echo -e "${RED}  ✗ ${RESET}${DIM}${short_date}${RESET}  ./$filepath:1"
      safe_count=$((safe_count + 1))
      ;;
    ci)
      echo -e "${YELLOW}  ⚠ ${RESET}${DIM}${short_date}${RESET}  ./$filepath:1"
      echo -e "    ${DIM}→ referenced in: $(echo "$refs" | tr '\n' ', ' | sed 's/,$//')${RESET}"
      flagged_count=$((flagged_count + 1))
      ;;
    convention)
      echo -e "${YELLOW}  ⚠ ${RESET}${DIM}${short_date}${RESET}  ./$filepath:1"
      echo -e "    ${DIM}→ $refs${RESET}"
      flagged_count=$((flagged_count + 1))
      ;;
    routing)
      echo -e "${YELLOW}  ⚠ ${RESET}${DIM}${short_date}${RESET}  ./$filepath:1"
      echo -e "    ${DIM}→ $refs${RESET}"
      flagged_count=$((flagged_count + 1))
      ;;
  esac
done

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e ""
echo -e "${BOLD}Legend:${RESET}"
echo -e "  ${RED}✗${RESET}  Likely safe to remove (no references found)"
echo -e "  ${YELLOW}⚠${RESET}  Review before removing (referenced in CI/infra/convention/routing)"
echo -e ""
echo -e "${BOLD}Summary:${RESET}  ${RED}${safe_count} likely removable${RESET}  │  ${YELLOW}${flagged_count} need review${RESET}  │  ${#UNUSED_FILES[@]} total"
