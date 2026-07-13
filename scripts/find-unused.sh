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
  "ee/apps/den-web/vercel.json"
  # Monorepo orchestration
  "turbo.json"
  # Build configs
  "apps/app/vite.config.ts"
  "apps/app/tailwind.config.ts"
  "apps/ui-demo/vite.config.ts"
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
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Helpers ─────────────────────────────────────────────────────────────────

# Return a review reason for paths that tools invoke by convention rather than
# through a source import. Case patterns are used instead of globstar so this
# stays compatible with macOS Bash 3.2.
entrypoint_convention_for() {
  local filepath="$1"
  case "$filepath" in
    .opencode/skills/*/scripts/*)
      echo "OpenCode skill script entrypoint convention"
      ;;
    evals/*|*/evals/*)
      echo "eval entrypoint convention"
      ;;
    test/*|*/test/*|tests/*|*/tests/*|__tests__/*|*/__tests__/*|*.test.*|*.spec.*)
      echo "test entrypoint convention"
      ;;
    bin/*|*/bin/*)
      echo "package binary entrypoint convention"
      ;;
    scripts/*|*/scripts/*)
      echo "script entrypoint convention"
      ;;
  esac
}

collect_package_json_files() {
  find "$OPENWORK_ROOT" -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*'
}

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
  # Also add package manifests (for scripts, bins, exports, and tool config).
  files="${files}${PACKAGE_JSON_FILES:-}"$'\n'
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

# Search package manifests separately so direct script/bin references get an
# explicit explanation instead of being folded into generic infra.
search_package_manifests() {
  local pattern="$1"
  [ -n "$PACKAGE_JSON_FILES" ] || return 0
  echo "$PACKAGE_JSON_FILES" | xargs grep -l "$pattern" 2>/dev/null || true
}

# Search sibling repo CI/CD and build scripts for an openwork-relative path.
# Only checks infra files (workflows, Dockerfiles, build scripts), NOT source code,
# since no sibling repo has an npm dependency on openwork packages.
search_sibling_ci() {
  local pattern="$1"
  local hits=""
  # The + expansion keeps an empty indexed array empty under Bash 3.2 + nounset.
  for repo in "${SIBLING_REPOS[@]+"${SIBLING_REPOS[@]}"}"; do
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
# Tests may inject captured output so classification can be verified offline.
if [ -n "${FIND_UNUSED_KNIP_OUTPUT_FILE:-}" ]; then
  if [ ! -f "$FIND_UNUSED_KNIP_OUTPUT_FILE" ]; then
    echo "Knip output fixture not found: $FIND_UNUSED_KNIP_OUTPUT_FILE" >&2
    exit 2
  fi
  KNIP_OUTPUT=$(<"$FIND_UNUSED_KNIP_OUTPUT_FILE")
else
  KNIP_OUTPUT=$(DATABASE_URL=mysql://fake:fake@localhost/fake npx knip --include files --no-progress --no-config-hints 2>&1 || true)
fi

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
  echo -e "${GREEN}Knip reported no unused-file candidates.${RESET}"
  exit 0
fi

echo -e "Knip reported ${BOLD}${#UNUSED_FILES[@]}${RESET} unused-file candidates. Cross-referencing...\n"

# ── Step 2: Build infra file list once ─────────────────────────────────────
echo -e "${DIM}  Indexing infra files...${RESET}" >&2
PACKAGE_JSON_FILES=$(collect_package_json_files)
INFRA_FILES=$(collect_infra_files)
INFRA_FILE_COUNT=$(echo "$INFRA_FILES" | wc -l | tr -d ' ')
echo -e "${DIM}  Found ${INFRA_FILE_COUNT} infra/config files to check against.${RESET}" >&2
if [ -n "$FACTORY_ROOT" ]; then
  echo -e "${DIM}  Checking ${#SIBLING_REPOS[@]} sibling repos CI/CD pipelines...${RESET}\n" >&2
else
  echo -e "${DIM}  No factory layout detected — skipping sibling repo checks.${RESET}\n" >&2
fi

# ── Step 3: Cross-reference each file ──────────────────────────────────────
# Parallel indexed arrays keep the result model compatible with macOS Bash 3.2.
# Each index corresponds to the same index in UNUSED_FILES.
FILE_STATUSES=()  # "candidate" | "package_manifest" | "infra" | "convention" | "routing" | "sibling_ci"
FILE_REFS=()
FILE_DATES=()

total=${#UNUSED_FILES[@]}
i=0
file_index=0

for filepath in "${UNUSED_FILES[@]}"; do
  i=$((i + 1))
  printf "\r${DIM}  [%d/%d] %s${RESET}%*s" "$i" "$total" "$filepath" 20 "" >&2

  name=$(basename "$filepath")
  stem="${name%.*}"
  status="candidate"
  refs=""

  # ── Check 1: Explicit package manifest references ──
  package_hits=$(search_package_manifests "$name")
  if [ -z "$package_hits" ]; then
    package_hits=$(search_package_manifests "$filepath")
  fi
  if [ -n "$package_hits" ]; then
    status="package_manifest"
    refs="$package_hits"
  fi

  # ── Check 2: Internal infra (CI, Docker, build scripts, configs, tsconfigs) ──
  if [ "$status" = "candidate" ]; then
    infra_hits=$(search_infra "$name")
    # Also try the relative path for more specific matches in CI workflows.
    if [ -z "$infra_hits" ]; then
      infra_hits=$(search_infra "$filepath")
    fi
  else
    infra_hits=""
  fi
  if [ -n "$infra_hits" ]; then
    status="infra"
    refs="$infra_hits"
  fi

  # ── Check 3: Convention-based usage ──
  if [ "$status" = "candidate" ]; then
    for pat in "${CONVENTION_PATTERNS[@]}"; do
      if [[ "$name" == *"$pat"* ]]; then
        status="convention"
        refs="used by convention ($pat)"
        break
      fi
    done
  fi

  if [ "$status" = "candidate" ]; then
    entrypoint_convention=$(entrypoint_convention_for "$filepath")
    if [ -n "$entrypoint_convention" ]; then
      status="convention"
      refs="$entrypoint_convention"
    fi
  fi

  # ── Check 4: File-based routing dirs ──
  if [ "$status" = "candidate" ]; then
    for dir in "${ROUTING_DIRS[@]}"; do
      if [[ "$filepath" == "$dir"* ]]; then
        status="routing"
        refs="file-based route ($dir)"
        break
      fi
    done
  fi

  # ── Check 5: Sibling repo CI/CD references ──
  # Only search by the openwork-relative path (precise) or unique filename.
  # Since no sibling repo has npm deps on openwork packages, we only check
  # CI/CD and build scripts for direct path references.
  if [ "$status" = "candidate" ]; then
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

  FILE_STATUSES[$file_index]="$status"
  FILE_REFS[$file_index]="$refs"
  FILE_DATES[$file_index]="$last_date"
  file_index=$((file_index + 1))
done

printf "\r%*s\r" 120 "" >&2

# ── Step 4: Split into two buckets, sort by date ──────────────────────────
candidate_entries=()
review_entries=()

file_index=0
for filepath in "${UNUSED_FILES[@]}"; do
  # Keep date and path first so sorting remains oldest-first, then path.
  entry="${FILE_DATES[$file_index]}|$filepath|$file_index"
  if [ "${FILE_STATUSES[$file_index]}" = "candidate" ]; then
    candidate_entries+=("$entry")
  else
    review_entries+=("$entry")
  fi
  file_index=$((file_index + 1))
done

candidate_sorted=()
if [ "${#candidate_entries[@]}" -gt 0 ]; then
  IFS=$'\n' candidate_sorted=($(printf '%s\n' "${candidate_entries[@]}" | sort))
  unset IFS
fi

review_sorted=()
if [ "${#review_entries[@]}" -gt 0 ]; then
  IFS=$'\n' review_sorted=($(printf '%s\n' "${review_entries[@]}" | sort))
  unset IFS
fi

candidate_count=${#candidate_sorted[@]}
review_count=${#review_sorted[@]}

# ── Step 5: Display ───────────────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${CYAN}${BOLD} CANDIDATES — no known entrypoint/config signal (${candidate_count})${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${DIM}  Knip found no imports and this audit found no known convention or${RESET}"
echo -e "${DIM}  config reference. This is an investigation queue, not a deletion verdict.${RESET}"
echo ""

if [ "$candidate_count" -eq 0 ]; then
  echo -e "  ${GREEN}None — every candidate matched a review signal.${RESET}"
else
  for entry in "${candidate_sorted[@]}"; do
    entry_index="${entry##*|}"
    dated_path="${entry%|*}"
    date="${dated_path%%|*}"
    filepath="${dated_path#*|}"
    short_date="${date%%T*}"
    echo -e "  ${CYAN}?${RESET} ${DIM}${short_date}${RESET}  ./$filepath:1"
  done
fi

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${YELLOW}${BOLD} REVIEW — known entrypoint/config signal (${review_count})${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${DIM}  Not imported, but matched a test/eval/script/route convention or an${RESET}"
echo -e "${DIM}  explicit manifest/config/CI reference. Prove the owner stale first.${RESET}"
echo ""

if [ "$review_count" -eq 0 ]; then
  echo -e "  ${GREEN}None.${RESET}"
else
  for entry in "${review_sorted[@]}"; do
    entry_index="${entry##*|}"
    dated_path="${entry%|*}"
    date="${dated_path%%|*}"
    filepath="${dated_path#*|}"
    status="${FILE_STATUSES[$entry_index]}"
    refs="${FILE_REFS[$entry_index]}"
    short_date="${date%%T*}"
    formatted_refs=$(format_refs "$refs")

    case "$status" in
      package_manifest)
        echo -e "  ${YELLOW}⚠${RESET} ${DIM}${short_date}${RESET}  ./$filepath:1"
        echo -e "    ${DIM}↳ package manifest: ${formatted_refs}${RESET}"
        ;;
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
echo -e "${BOLD}Summary:${RESET}  ${CYAN}${candidate_count} need investigation${RESET}  │  ${YELLOW}${review_count} have review signals${RESET}  │  ${#UNUSED_FILES[@]} total"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
