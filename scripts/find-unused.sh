#!/usr/bin/env bash
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
OPENWORK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Detect whether we're inside a factory layout (../../.. has _repos/)
FACTORY_CANDIDATE="$(cd "$OPENWORK_ROOT/../../.." 2>/dev/null && pwd)"
if [ -d "$FACTORY_CANDIDATE/_repos" ]; then
  FACTORY_ROOT="$FACTORY_CANDIDATE"
else
  FACTORY_ROOT=""
fi

# All sibling repos to cross-reference against (empty when outside factory)
SIBLING_REPOS=()
if [ -n "$FACTORY_ROOT" ]; then
  for d in "$FACTORY_ROOT"/_repos/*/; do
    [ -d "$d" ] || continue
    [ "$(cd "$d" && pwd)" = "$OPENWORK_ROOT" ] && continue
    SIBLING_REPOS+=("$d")
  done
fi

# ── Internal infra: all build/config/CI files that may reference source ────
# These are files WITHIN openwork that knip can't trace but that use source files
# by convention, config, or build step.
INFRA_GLOBS=(
  # CI/CD
  ".github/workflows/*.yml"
  # Docker
  "packaging/docker/Dockerfile*"
  "packaging/docker/docker-compose*.yml"
  "ee/apps/den-worker-runtime/Dockerfile*"
  # Deployment
  "apps/app/vercel.json"
  "apps/share/vercel.json"
  "ee/apps/den-web/vercel.json"
  # Tauri
  "apps/desktop/src-tauri/tauri.conf.json"
  # Monorepo orchestration
  "turbo.json"
  # Build configs
  "apps/app/vite.config.ts"
  "apps/app/tailwind.config.ts"
  "apps/story-book/vite.config.ts"
  "apps/ui-demo/vite.config.ts"
  "apps/share/next.config.ts"
  "apps/share/playwright.config.ts"
  "ee/apps/den-web/next.config.js"
  "ee/apps/den-web/postcss.config.js"
  "ee/apps/den-web/tailwind.config.js"
  "ee/apps/landing/next.config.js"
  "ee/apps/landing/postcss.config.js"
  "ee/apps/landing/tailwind.config.js"
  "ee/packages/den-db/drizzle.config.ts"
  "ee/packages/den-db/tsup.config.ts"
  "ee/packages/utils/tsup.config.ts"
  "packages/ui/tsup.config.ts"
  # Build scripts (all)
  "scripts/*.mjs"
  "scripts/*.ts"
  "scripts/*.sh"
  "scripts/**/*.mjs"
  "scripts/**/*.ts"
  "scripts/**/*.sh"
  "apps/*/scripts/*.mjs"
  "apps/*/scripts/*.ts"
  "apps/*/scripts/*.sh"
  "ee/apps/*/scripts/*.mjs"
  "ee/apps/*/scripts/*.sh"
  # .opencode skills/commands that may invoke source
  ".opencode/skills/*/scripts/*.sh"
  ".opencode/skills/*/*.sh"
)

# Files used by convention (framework/tool magic), not imports
CONVENTION_PATTERNS=(
  "postinstall"
  "drizzle.config"
  "tauri-before-build"
  "tauri-before-dev"
)

# File-based routing directories — files here are entry points by convention
ROUTING_DIRS=(
  "apps/share/server/"
  "apps/share/app/"
  "ee/apps/den-web/app/"
  "ee/apps/landing/app/"
)

# Paths to ignore entirely
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
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Helpers ─────────────────────────────────────────────────────────────────

# Collect all internal infra files once
collect_infra_files() {
  local files=""
  for glob_pattern in "${INFRA_GLOBS[@]}"; do
    # Use find-based expansion to handle globs
    local matched
    matched=$(find "$OPENWORK_ROOT" -path "$OPENWORK_ROOT/$glob_pattern" 2>/dev/null || true)
    if [ -n "$matched" ]; then
      files="${files}${matched}"$'\n'
    fi
  done
  # Also add all package.json files (for script references)
  local pkg_jsons
  pkg_jsons=$(find "$OPENWORK_ROOT" -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*')
  files="${files}${pkg_jsons}"$'\n'
  # And all tsconfig*.json files (for path aliases / includes)
  local tsconfigs
  tsconfigs=$(find "$OPENWORK_ROOT" -name 'tsconfig*.json' -not -path '*/node_modules/*' -not -path '*/.git/*')
  files="${files}${tsconfigs}"$'\n'
  echo "$files" | sed '/^$/d' | sort -u
}

# Search infra files for a pattern
search_infra() {
  local pattern="$1"
  echo "$INFRA_FILES" | xargs grep -l "$pattern" 2>/dev/null || true
}

# Search sibling repo CI/CD and build scripts for an openwork-relative path.
# Only checks infra files (workflows, Dockerfiles, build scripts), NOT source code,
# since no sibling repo has an npm dependency on openwork packages.
search_sibling_ci() {
  local pattern="$1"
  local hits=""
  for repo in "${SIBLING_REPOS[@]}"; do
    for ci_dir in ".github/workflows" "packaging" "containers" "infra" ".circleci" "script" "scripts"; do
      [ -d "${repo}${ci_dir}" ] || continue
      local ci_hits
      ci_hits=$(grep -rl "$pattern" "${repo}${ci_dir}" 2>/dev/null || true)
      if [ -n "$ci_hits" ]; then
        hits="${hits}${ci_hits}"$'\n'
      fi
    done
    # Dockerfiles anywhere in the repo
    local docker_hits
    docker_hits=$(find "$repo" -name 'Dockerfile*' -not -path '*/node_modules/*' -not -path '*/.git/*' \
      -exec grep -l "$pattern" {} + 2>/dev/null || true)
    if [ -n "$docker_hits" ]; then
      hits="${hits}${docker_hits}"$'\n'
    fi
  done
  # Factory-level CI
  [ -n "$FACTORY_ROOT" ] && [ -d "$FACTORY_ROOT/.github" ] && {
    local factory_ci
    factory_ci=$(grep -rl "$pattern" "$FACTORY_ROOT/.github" 2>/dev/null || true)
    [ -n "$factory_ci" ] && hits="${hits}${factory_ci}"$'\n'
  }
  echo "$hits" | sed '/^$/d'
}

# Format refs: show short paths, max 3 entries
format_refs() {
  local refs="$1"
  local formatted=""
  local count=0
  local total
  total=$(echo "$refs" | grep -c '.' || true)

  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    count=$((count + 1))
    [ $count -gt 3 ] && continue

    local short="$ref"
    if [[ "$ref" == "$OPENWORK_ROOT/"* ]]; then
      short="${ref#"$OPENWORK_ROOT/"}"
    elif [[ "$ref" == *"/_repos/"* ]]; then
      short=$(echo "$ref" | sed "s|.*/_repos/||")
    elif [[ "$ref" == "$FACTORY_ROOT/"* ]]; then
      short="${ref#"$FACTORY_ROOT/"}"
    fi

    [ -n "$formatted" ] && formatted="${formatted}, "
    formatted="${formatted}${short}"
  done <<< "$refs"

  local remaining=$((total - 3))
  if [ "$remaining" -gt 0 ] 2>/dev/null; then
    formatted="${formatted} (+${remaining} more)"
  fi

  echo "$formatted"
}

# ── Step 1: Run knip ───────────────────────────────────────────────────────
cd "$OPENWORK_ROOT"
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

# ── Step 2: Build infra file list once ─────────────────────────────────────
echo -e "${DIM}  Indexing infra files...${RESET}" >&2
INFRA_FILES=$(collect_infra_files)
INFRA_FILE_COUNT=$(echo "$INFRA_FILES" | wc -l | tr -d ' ')
echo -e "${DIM}  Found ${INFRA_FILE_COUNT} infra/config files to check against.${RESET}" >&2
if [ -n "$FACTORY_ROOT" ]; then
  echo -e "${DIM}  Checking ${#SIBLING_REPOS[@]} sibling repos CI/CD pipelines...${RESET}\n" >&2
else
  echo -e "${DIM}  No factory layout detected — skipping sibling repo checks.${RESET}\n" >&2
fi

# ── Step 3: Cross-reference each file ──────────────────────────────────────
declare -A FILE_STATUS  # "safe" | "infra" | "convention" | "routing" | "sibling_ci"
declare -A FILE_REFS
declare -A FILE_DATES

total=${#UNUSED_FILES[@]}
i=0

for filepath in "${UNUSED_FILES[@]}"; do
  i=$((i + 1))
  printf "\r${DIM}  [%d/%d] %s${RESET}%*s" "$i" "$total" "$filepath" 20 "" >&2

  name=$(basename "$filepath")
  stem="${name%.*}"
  status="safe"
  refs=""

  # ── Check 1: Internal infra (CI, Docker, build scripts, configs, tsconfigs, package.jsons) ──
  infra_hits=$(search_infra "$name")
  # Also try the relative path for more specific matches in CI workflows
  if [ -z "$infra_hits" ]; then
    infra_hits=$(search_infra "$filepath")
  fi
  if [ -n "$infra_hits" ]; then
    status="infra"
    refs="$infra_hits"
  fi

  # ── Check 2: Convention-based usage ──
  if [ "$status" = "safe" ]; then
    for pat in "${CONVENTION_PATTERNS[@]}"; do
      if [[ "$name" == *"$pat"* ]]; then
        status="convention"
        refs="used by convention ($pat)"
        break
      fi
    done
  fi

  # ── Check 3: File-based routing dirs ──
  if [ "$status" = "safe" ]; then
    for dir in "${ROUTING_DIRS[@]}"; do
      if [[ "$filepath" == "$dir"* ]]; then
        status="routing"
        refs="file-based route ($dir)"
        break
      fi
    done
  fi

  # ── Check 4: Sibling repo CI/CD references ──
  # Only search by the openwork-relative path (precise) or unique filename.
  # Since no sibling repo has npm deps on openwork packages, we only check
  # CI/CD and build scripts for direct path references.
  if [ "$status" = "safe" ]; then
    sibling_hits=$(search_sibling_ci "$filepath")
    if [ -z "$sibling_hits" ]; then
      # Try filename only if it's specific enough (not a generic name)
      case "$stem" in
        index|utils|helpers|types|config|constants|schema|paths|extensions|sessions|\
        system|context|sync|state|card|server|client|app|lib|store|api|auth|data|\
        error|events|hooks|theme|styles|test|main|shared|common|base|core|model|\
        service|provider|route|router|handler|middleware|plugin|loader|init|setup|\
        health|status|log|logger|build|dev|start|run|layout|page|screen)
          ;; # skip generic names
        *)
          sibling_hits=$(search_sibling_ci "$name")
          ;;
      esac
    fi
    if [ -n "$sibling_hits" ]; then
      status="sibling_ci"
      refs="$sibling_hits"
    fi
  fi

  # Get last commit date
  last_date=$(git log -1 --format="%aI" -- "$filepath" 2>/dev/null || echo "unknown")

  FILE_STATUS["$filepath"]="$status"
  FILE_REFS["$filepath"]="$refs"
  FILE_DATES["$filepath"]="$last_date"
done

printf "\r%*s\r" 120 "" >&2

# ── Step 4: Split into two buckets, sort by date ──────────────────────────
safe_entries=()
flagged_entries=()

for filepath in "${UNUSED_FILES[@]}"; do
  entry="${FILE_DATES[$filepath]}|$filepath"
  if [ "${FILE_STATUS[$filepath]}" = "safe" ]; then
    safe_entries+=("$entry")
  else
    flagged_entries+=("$entry")
  fi
done

IFS=$'\n' safe_sorted=($(printf '%s\n' "${safe_entries[@]}" 2>/dev/null | sort)); unset IFS
IFS=$'\n' flagged_sorted=($(printf '%s\n' "${flagged_entries[@]}" 2>/dev/null | sort)); unset IFS

safe_count=${#safe_sorted[@]}
flagged_count=${#flagged_sorted[@]}

# ── Step 5: Display ───────────────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${RED}${BOLD} UNUSED — safe to remove (${safe_count})${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${DIM}  No imports in openwork source, no references in CI/CD, build${RESET}"
echo -e "${DIM}  scripts, configs, conventions, routing, or sibling repo pipelines.${RESET}"
echo ""

if [ "$safe_count" -eq 0 ]; then
  echo -e "  ${GREEN}None — all files have references somewhere.${RESET}"
else
  for entry in "${safe_sorted[@]}"; do
    date="${entry%%|*}"
    filepath="${entry#*|}"
    short_date="${date%%T*}"
    echo -e "  ${RED}✗${RESET} ${DIM}${short_date}${RESET}  ./$filepath:1"
  done
fi

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${YELLOW}${BOLD} REVIEW — referenced in infra/CI (${flagged_count})${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${DIM}  Not imported in source, but referenced by build/CI/config/routing.${RESET}"
echo -e "${DIM}  Verify the reference is real before removing.${RESET}"
echo ""

if [ "$flagged_count" -eq 0 ]; then
  echo -e "  ${GREEN}None.${RESET}"
else
  for entry in "${flagged_sorted[@]}"; do
    date="${entry%%|*}"
    filepath="${entry#*|}"
    status="${FILE_STATUS[$filepath]}"
    refs="${FILE_REFS[$filepath]}"
    short_date="${date%%T*}"
    formatted_refs=$(format_refs "$refs")

    case "$status" in
      infra)
        echo -e "  ${YELLOW}⚠${RESET} ${DIM}${short_date}${RESET}  ./$filepath:1"
        echo -e "    ${DIM}↳ ${formatted_refs}${RESET}"
        ;;
      convention)
        echo -e "  ${YELLOW}⚠${RESET} ${DIM}${short_date}${RESET}  ./$filepath:1"
        echo -e "    ${DIM}↳ ${refs}${RESET}"
        ;;
      routing)
        echo -e "  ${YELLOW}⚠${RESET} ${DIM}${short_date}${RESET}  ./$filepath:1"
        echo -e "    ${DIM}↳ ${refs}${RESET}"
        ;;
      sibling_ci)
        echo -e "  ${CYAN}⚠${RESET} ${DIM}${short_date}${RESET}  ./$filepath:1"
        echo -e "    ${DIM}↳ sibling CI: ${formatted_refs}${RESET}"
        ;;
    esac
  done
fi

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}Summary:${RESET}  ${RED}${safe_count} removable${RESET}  │  ${YELLOW}${flagged_count} need review${RESET}  │  ${#UNUSED_FILES[@]} total"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
