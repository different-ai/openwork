#!/usr/bin/env bash
set -euo pipefail

# Soul Mode proof harness (Docker)
#
# This script is intentionally LLM-free.
# It demonstrates that the primitives we rely on for Soul Mode are viable:
# - workspace-local persistent memory file: .opencode/soul.md
# - heartbeat log: .opencode/soul/heartbeat.jsonl
# - session/todo context via a global OpenCode sqlite db living OUTSIDE the workspace
#   (simulated at $HOME/.local/share/opencode/opencode.db)
# - repeated heartbeats across process restarts (via Docker volumes)
#
# Usage (from openwork repo root):
#   packaging/docker/soul-mode-proof.sh

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

SUFFIX="${SOUL_PROOF_SUFFIX:-$(date +%s)-$$}"
# The official bash image is Alpine-based and keeps the harness simple.
IMAGE="${SOUL_PROOF_IMAGE:-bash:5.2}"

WS_VOL="openwork-soul-proof-ws-$SUFFIX"
DATA_VOL="openwork-soul-proof-data-$SUFFIX"

cleanup() {
  docker volume rm -f "$WS_VOL" "$DATA_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$WS_VOL" >/dev/null
docker volume create "$DATA_VOL" >/dev/null

run_container() {
  # shellcheck disable=SC2016
  docker run --rm \
    -v "$WS_VOL:/workspace" \
    -v "$DATA_VOL:/root/.local/share/opencode" \
    -w /workspace \
    "$IMAGE" \
    bash -lc "$1"
}

echo "[proof] volumes: $WS_VOL (workspace), $DATA_VOL (opencode data)" >&2
echo "[proof] image: $IMAGE" >&2

payload_bootstrap_and_tick() {
  cat <<'EOF'
set -eu

apk add --no-cache bash sqlite >/dev/null

cd /workspace
mkdir -p .opencode/soul .opencode/skills/example-soul-skill

if [ ! -f .opencode/soul.md ]; then
  cat > .opencode/soul.md <<'MEM'
# Soul Memory

Last updated: 1970-01-01T00:00:00Z

## Goals
- Ship a working Soul Mode bootstrap

## Preferences
- Keep check-ins short, actionable
- Prefer reversible changes

## Current focus
- Make scheduled heartbeats non-blocking

## Loose ends
- (none yet)

## Recurring chores / automations to consider
- (none yet)
MEM
fi

if [ ! -f .opencode/soul/heartbeat.jsonl ]; then
  : > .opencode/soul/heartbeat.jsonl
fi

# Optional: a tiny placeholder skill so the heartbeat can "see" skills.
if [ ! -f .opencode/skills/example-soul-skill/SKILL.md ]; then
  cat > .opencode/skills/example-soul-skill/SKILL.md <<'SKILL'
# Example Soul Skill

This is a placeholder skill file created by the proof harness.
SKILL
fi

db_dir="$HOME/.local/share/opencode"
db="$db_dir/opencode.db"
mkdir -p "$db_dir"

now_ms() {
  # ms since epoch without python/node
  echo "$(( $(date +%s) * 1000 ))"
}

if [ ! -f "$db" ]; then
  sqlite3 "$db" <<'SQL'
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  worktree TEXT NOT NULL,
  vcs TEXT,
  name TEXT,
  icon_url TEXT,
  icon_color TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_initialized INTEGER,
  sandboxes TEXT NOT NULL,
  commands TEXT
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  share_url TEXT,
  summary_additions INTEGER,
  summary_deletions INTEGER,
  summary_files INTEGER,
  summary_diffs TEXT,
  revert TEXT,
  permission TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_compacting INTEGER,
  time_archived INTEGER,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS todo (
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  position INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  PRIMARY KEY(session_id, position),
  FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE
);
SQL

  t0="$(now_ms)"
  sqlite3 "$db" <<SQL
INSERT INTO project (id, worktree, vcs, sandboxes, time_created, time_updated)
VALUES ('proj_1', '/workspace', 'git', '[]', $t0, $t0);

INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
VALUES
  ('ses_1', 'proj_1', 'first-run', '/workspace', 'New session - 2026-01-01T00:00:00.000Z', 'test', $t0, $t0),
  ('ses_2', 'proj_1', 'second-run', '/workspace', 'Fix soul bootstrap', 'test', $t0, $t0);

INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
VALUES
  ('ses_2', 'Make soul heartbeat non-blocking', 'pending', 'high', 1, $t0, $t0),
  ('ses_2', 'Verify sqlite db path permissions', 'pending', 'high', 2, $t0, $t0);
SQL
fi

json_escape() {
  # Minimal JSON escaping (quotes + backslashes + newlines)
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
}

read_section() {
  # read_section "Preferences" -> prints lines in that section (no headers)
  awk -v name="$1" '
    $0 ~ "^## "name"$" { inside=1; next }
    inside && $0 ~ /^## / { exit }
    inside { print }
  ' .opencode/soul.md
}

heartbeat() {
  ws="$(pwd)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  t_ms="$(now_ms)"

  session_count="$(sqlite3 "$db" "SELECT COUNT(1) FROM session WHERE directory = '$ws';" 2>/dev/null || echo 0)"
  open_todos="$(sqlite3 "$db" "SELECT COUNT(1) FROM todo t JOIN session s ON s.id = t.session_id WHERE s.directory = '$ws' AND t.status != 'completed';" 2>/dev/null || echo 0)"
  recent_titles="$(sqlite3 -separator ' | ' "$db" "SELECT title FROM session WHERE directory = '$ws' ORDER BY time_updated DESC LIMIT 3;" 2>/dev/null || true)"
  skills_count="$(ls -1 .opencode/skills 2>/dev/null | wc -l | tr -d ' ')"

  # Update Last updated in soul.md
  if grep -q '^Last updated:' .opencode/soul.md; then
    sed -i "s/^Last updated: .*/Last updated: $ts/" .opencode/soul.md
  fi

  # Self-improving memory: add any open todos as loose ends (dedup)
  tmp_new="/tmp/soul-new-loose.txt"
  : > "$tmp_new"
  sqlite3 -separator $'\t' "$db" "SELECT t.content FROM todo t JOIN session s ON s.id = t.session_id WHERE s.directory = '$ws' AND t.status != 'completed' ORDER BY t.time_updated DESC LIMIT 10;" \
    2>/dev/null | while IFS=$'\t' read -r content; do
      [ -n "$content" ] || continue
      bullet="- TODO: $content"
      if ! grep -Fq "$bullet" .opencode/soul.md; then
        printf '%s\n' "$bullet" >> "$tmp_new"
      fi
    done

  if [ -s "$tmp_new" ]; then
    awk -v newfile="$tmp_new" '
      function printfile(f,   line) {
        while ((getline line < f) > 0) print line
        close(f)
      }
      {
        if ($0 ~ /^## Loose ends$/) inside=1
        if (inside && !inserted && $0 ~ /^## Recurring chores/) {
          printfile(newfile)
          inserted=1
          inside=0
        }
        print
      }
      END {
        if (inside && !inserted) {
          printfile(newfile)
        }
      }
    ' .opencode/soul.md > .opencode/soul.md.next
    mv .opencode/soul.md.next .opencode/soul.md
  fi

  # Write heartbeat JSONL entry
  summary="sessions=$session_count open_todos=$open_todos skills=$skills_count"
  line="{\"ts\":\"$ts\",\"workspace\":\"$ws\",\"db_path\":\"$db\",\"session_count\":$session_count,\"open_todos\":$open_todos,\"skills_count\":$skills_count,\"recent_sessions\":\"$(json_escape "$recent_titles")\",\"summary\":\"$(json_escape "$summary")\"}"
  printf '%s\n' "$line" >> .opencode/soul/heartbeat.jsonl

  echo ""
  echo "Soul heartbeat @ $ts"
  echo "- Workspace: $ws"
  echo "- OpenCode DB: $db"
  echo "- Sessions: $session_count"
  echo "- Open todos: $open_todos"
  echo "- Recent sessions: ${recent_titles:-<none>}"
  echo "- Skills found: $skills_count"
  echo ""
  echo "Memory snapshot (Preferences):"
  read_section "Preferences" | sed 's/^/  /'
  echo ""
  echo "Loose ends (from memory):"
  read_section "Loose ends" | sed 's/^/  /'
  echo ""
  echo "Curiosity paths:"
  echo "- Curious about work: I will use the files you store in this worker ($ws) and highlight loose ends."
  echo "- Curious about topics: tell me 1-3 topics to track; I will check in on them in heartbeats."
  echo "- Curious about improvements: I will spot repeated chores and suggest skills + automations."
  echo ""

  echo "[jsonl] appended: $line"
}

heartbeat

echo ""
echo "[debug] heartbeat.jsonl lines: $(wc -l < .opencode/soul/heartbeat.jsonl | tr -d ' ')"

# Mutate db once during bootstrap so the next container run sees change.
if [ "${SOUL_PROOF_MUTATE_DB:-1}" = "1" ]; then
  sqlite3 "$db" <<SQL
UPDATE todo SET status='completed', time_updated=$t_ms WHERE session_id='ses_2' AND position=1;
INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
VALUES ('ses_3', 'proj_1', 'third-run', '/workspace', 'Ship Soul Mode proof', 'test', $t_ms, $t_ms);
INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
VALUES ('ses_3', 'Add curiosity paths to heartbeat output', 'pending', 'normal', 1, $t_ms, $t_ms);
SQL
  echo "[debug] mutated opencode.db (completed one todo, added a session + todo)"
fi
EOF
}

payload_tick_only() {
  cat <<'EOF'
set -eu

apk add --no-cache bash sqlite >/dev/null

cd /workspace

if [ ! -f .opencode/soul.md ]; then
  echo "missing .opencode/soul.md (expected bootstrap run first)" >&2
  exit 1
fi

db="$HOME/.local/share/opencode/opencode.db"
if [ ! -f "$db" ]; then
  echo "missing opencode db at $db (expected bootstrap run first)" >&2
  exit 1
fi

now_ms() { echo "$(( $(date +%s) * 1000 ))"; }

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
}

read_section() {
  awk -v name="$1" '
    $0 ~ "^## "name"$" { inside=1; next }
    inside && $0 ~ /^## / { exit }
    inside { print }
  ' .opencode/soul.md
}

heartbeat() {
  ws="$(pwd)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  session_count="$(sqlite3 "$db" "SELECT COUNT(1) FROM session WHERE directory = '$ws';" 2>/dev/null || echo 0)"
  open_todos="$(sqlite3 "$db" "SELECT COUNT(1) FROM todo t JOIN session s ON s.id = t.session_id WHERE s.directory = '$ws' AND t.status != 'completed';" 2>/dev/null || echo 0)"
  recent_titles="$(sqlite3 -separator ' | ' "$db" "SELECT title FROM session WHERE directory = '$ws' ORDER BY time_updated DESC LIMIT 3;" 2>/dev/null || true)"
  skills_count="$(ls -1 .opencode/skills 2>/dev/null | wc -l | tr -d ' ')"
  summary="sessions=$session_count open_todos=$open_todos skills=$skills_count"
  line="{\"ts\":\"$ts\",\"workspace\":\"$ws\",\"db_path\":\"$db\",\"session_count\":$session_count,\"open_todos\":$open_todos,\"skills_count\":$skills_count,\"recent_sessions\":\"$(json_escape "$recent_titles")\",\"summary\":\"$(json_escape "$summary")\"}"
  printf '%s\n' "$line" >> .opencode/soul/heartbeat.jsonl

  echo ""
  echo "Soul heartbeat @ $ts"
  echo "- Workspace: $ws"
  echo "- Sessions: $session_count"
  echo "- Open todos: $open_todos"
  echo "- Recent sessions: ${recent_titles:-<none>}"
  echo ""
  echo "Memory snapshot (Preferences):"
  read_section "Preferences" | sed 's/^/  /'
  echo ""
  echo "Curiosity paths:"
  echo "- Curious about work: I will use the files you store in this worker ($ws) and highlight loose ends."
  echo "- Curious about topics: tell me 1-3 topics to track; I will check in on them in heartbeats."
  echo "- Curious about improvements: I will spot repeated chores and suggest skills + automations."
  echo ""

  echo "[jsonl] appended: $line"
}

heartbeat

echo ""
echo "[debug] heartbeat.jsonl lines: $(wc -l < .opencode/soul/heartbeat.jsonl | tr -d ' ')"
EOF
}

echo ""
echo "[proof] container run #1 (bootstrap + heartbeat + db mutation)" >&2
run_container "$(payload_bootstrap_and_tick)"

echo ""
echo "[proof] sleep 30s" >&2
sleep 30

echo ""
echo "[proof] container run #2 (heartbeat reads persisted memory + db)" >&2
run_container "$(payload_tick_only)"

echo ""
echo "[proof] sleep 30s" >&2
sleep 30

echo ""
echo "[proof] container run #3 (heartbeat again, then show final artifacts)" >&2
run_container "$(payload_tick_only); echo ''; echo '[final] soul.md (top 40 lines)'; sed -n '1,40p' .opencode/soul.md; echo ''; echo '[final] heartbeat.jsonl (tail)'; tail -n 5 .opencode/soul/heartbeat.jsonl"

echo ""
echo "[proof] success" >&2
