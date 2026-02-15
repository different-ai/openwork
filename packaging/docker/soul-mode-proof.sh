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
# - basic "talking" context (seeded sessions + messages) to drive suggestions
# - self-improving memory (heartbeat writes back suggested improvements)
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
INTERVAL_SECONDS="${SOUL_PROOF_INTERVAL_SECONDS:-30}"

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
echo "[proof] interval: ${INTERVAL_SECONDS}s" >&2

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

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE
);
SQL

  t0="$(now_ms)"
  t1=$((t0 + 10))
  t2=$((t0 + 20))
  t3=$((t0 + 30))
  t4=$((t0 + 40))
  t5=$((t0 + 50))

  sqlite3 "$db" <<SQL
INSERT INTO project (id, worktree, vcs, sandboxes, time_created, time_updated)
VALUES ('proj_1', '/workspace', 'git', '[]', $t0, $t0);

-- Seed three "real" tasks + one baseline session.
INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
VALUES
  ('ses_img',  'proj_1', 'image-edit', '/workspace', 'Edit image: social hero crop', 'test', $t1, $t1),
  ('ses_blog', 'proj_1', 'blog-post',  '/workspace', 'Write blog: opencode-router + soul mode', 'test', $t2, $t2),
  ('ses_code', 'proj_1', 'debate',     '/workspace', 'Programming debate: scheduler seconds', 'test', $t3, $t3);

INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
VALUES
  ('ses_img',  'Crop assets/hero.png to 1200x630 and export WebP', 'pending', 'high', 1, $t1, $t1),
  ('ses_img',  'Strip metadata + optimize image size', 'pending', 'normal', 2, $t1, $t1),

  ('ses_blog', 'Draft an outline (H2s + key points)', 'pending', 'normal', 1, $t2, $t2),
  ('ses_blog', 'Write a first draft in Markdown with frontmatter', 'pending', 'normal', 2, $t2, $t2),
  ('ses_blog', 'Add one code snippet and a short CTA', 'pending', 'low', 3, $t2, $t2),

  ('ses_code', 'Debate seconds-level scheduling (cron vs interval vs platform timers)', 'pending', 'high', 1, $t3, $t3),
  ('ses_code', 'Pick an approach and implement with tests', 'pending', 'high', 2, $t3, $t3),
  ('ses_code', 'Write an ADR capturing tradeoffs and decision', 'pending', 'high', 3, $t3, $t3);

-- Messages store metadata; text lives in parts.
INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES
  ('msg_img_u1',  'ses_img',  $t1, $t1, '{"role":"user"}'),
  ('msg_img_a1',  'ses_img',  $t1+1, $t1+1, '{"role":"assistant"}'),
  ('msg_blog_u1', 'ses_blog', $t2, $t2, '{"role":"user"}'),
  ('msg_blog_a1', 'ses_blog', $t2+1, $t2+1, '{"role":"assistant"}'),
  ('msg_code_u1', 'ses_code', $t3, $t3, '{"role":"user"}'),
  ('msg_code_a1', 'ses_code', $t3+1, $t3+1, '{"role":"assistant"}'),
  ('msg_code_u2', 'ses_code', $t3+2, $t3+2, '{"role":"user"}'),
  ('msg_code_a2', 'ses_code', $t3+3, $t3+3, '{"role":"assistant"}');

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES
  ('prt_img_u1', 'msg_img_u1', 'ses_img', $t1, $t1,
    '{"type":"text","text":"Task: edit an image. Crop assets/hero.png to 1200x630 for social sharing, export WebP, keep text safe area. What is best: ImageMagick CLI or a Node sharp pipeline?"}'),

  ('prt_img_a1', 'msg_img_a1', 'ses_img', $t1+1, $t1+1,
    '{"type":"text","text":"Suggestion: use ImageMagick for quick local edits, and consider a repeatable workspace command (/image-ops) later. Example: magick assets/hero.png -resize 1200x630^ -gravity center -extent 1200x630 out/hero_1200x630.webp"}'),

  ('prt_img_a1_tool', 'msg_img_a1', 'ses_img', $t1+1, $t1+1,
    '{"type":"tool","tool":"bash","callID":"call_img_1","state":{"status":"completed","input":{"command":"magick assets/hero.png -resize 1200x630^ -gravity center -extent 1200x630 out/hero_1200x630.webp"},"output":"(simulated)"}}'),

  ('prt_blog_u1', 'msg_blog_u1', 'ses_blog', $t2, $t2,
    '{"type":"text","text":"Task: write a blog post announcing opencode-router naming and Soul Mode. Output must be Markdown with frontmatter, an outline, and a short CTA."}'),

  ('prt_blog_a1', 'msg_blog_a1', 'ses_blog', $t2+1, $t2+1,
    '{"type":"text","text":"Suggestion: create a /blog-draft command that scaffolds frontmatter + headings, then iterate. Keep a consistent voice and add one code snippet."}'),

  ('prt_code_u1', 'msg_code_u1', 'ses_code', $t3, $t3,
    '{"type":"text","text":"Complex programming debate: we want a heartbeat every 30 seconds, but cron is minute-granularity. How should scheduler support this across launchd/systemd? What are the tradeoffs? How do we keep runs non-interactive (no permission prompts)?"}'),

  ('prt_code_a1', 'msg_code_a1', 'ses_code', $t3+1, $t3+1,
    '{"type":"text","text":"Options: (A) keep cron and do two internal ticks (sleep 30) inside the heartbeat command. (B) add an interval mode to the supervisor (setInterval). (C) use platform timers (systemd OnUnitActiveSec, launchd StartInterval). Recommend: start with (A) + write an ADR so the decision is explicit."}'),

  ('prt_code_u2', 'msg_code_u2', 'ses_code', $t3+2, $t3+2,
    '{"type":"text","text":"If we add interval mode, how do we store it in job files? How do we test reliably? What about backwards compatibility?"}'),

  ('prt_code_a2', 'msg_code_a2', 'ses_code', $t3+3, $t3+3,
    '{"type":"text","text":"Do not overload cron syntax. Add an explicit runFormat or a separate interval field. For proof, keep cron as-is and test the 30s behavior via two-tick heartbeat output + JSONL log. Then revisit a first-class interval scheduler."}');
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
      if ! grep -Fq -- "$bullet" .opencode/soul.md; then
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
        if (inside && $0 ~ /^- \(none yet\)$/) next
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

  # Suggested improvements (derived from recent "talking")
  recent_text="$(sqlite3 -separator '\n' "$db" "SELECT json_extract(p.data, '$.text') FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = m.session_id WHERE s.directory = '$ws' AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created DESC LIMIT 60;" 2>/dev/null || true)"

  tmp_improve="/tmp/soul-improvements.txt"
  : > "$tmp_improve"

  if echo "$recent_text" | grep -qiE '(png|jpg|jpeg|webp|image|imagemagick|magick|crop|resize)'; then
    printf '%s\n' "- Suggestion: Add \`/image-ops\` command (ImageMagick) to crop/resize/export WebP consistently." >> "$tmp_improve"
  fi
  if echo "$recent_text" | grep -qiE '(blog|frontmatter|markdown|outline|draft)'; then
    printf '%s\n' "- Suggestion: Add \`/blog-draft\` command to scaffold Markdown frontmatter + headings for posts." >> "$tmp_improve"
  fi
  if echo "$recent_text" | grep -qiE '(debate|tradeoff|architecture|scheduler|cron|launchd|systemd|seconds)'; then
    printf '%s\n' "- Suggestion: Add \`/debate-to-adr\` command to convert long threads into an ADR + extracted TODOs." >> "$tmp_improve"
  fi
  if echo "$recent_text" | grep -qiE '(soul mode|heartbeat)'; then
    printf '%s\n' "- Suggestion: Allow narrow \`edit\` permission for \`.opencode/soul.md\` so scheduled heartbeats can improve memory safely." >> "$tmp_improve"
  fi

  # Persist new improvements into memory (Recurring chores / automations to consider)
  tmp_new_improve="/tmp/soul-new-improvements.txt"
  : > "$tmp_new_improve"
  if [ -s "$tmp_improve" ]; then
    while IFS= read -r bullet; do
      [ -n "$bullet" ] || continue
      if ! grep -Fq -- "$bullet" .opencode/soul.md; then
        printf '%s\n' "$bullet" >> "$tmp_new_improve"
      fi
    done < "$tmp_improve"
  fi

  if [ -s "$tmp_new_improve" ]; then
    awk -v newfile="$tmp_new_improve" '
      function printfile(f,   line) {
        while ((getline line < f) > 0) print line
        close(f)
      }
      {
        if ($0 ~ /^## Recurring chores \/ automations to consider$/) inside=1
        if (inside && $0 ~ /^- \(none yet\)$/) next
        print
      }
      END {
        if (inside) {
          printfile(newfile)
        }
      }
    ' .opencode/soul.md > .opencode/soul.md.next
    mv .opencode/soul.md.next .opencode/soul.md
  fi

  improvements_count="$(wc -l < "$tmp_improve" | tr -d ' ')"
  improvements_summary="$(cat "$tmp_improve" 2>/dev/null | tr '\n' ';' | sed 's/;*$//')"

  # Write heartbeat JSONL entry
  summary="sessions=$session_count open_todos=$open_todos skills=$skills_count improvements=$improvements_count"
  line="{\"ts\":\"$ts\",\"workspace\":\"$ws\",\"db_path\":\"$db\",\"session_count\":$session_count,\"open_todos\":$open_todos,\"skills_count\":$skills_count,\"improvements\":\"$(json_escape "$improvements_summary")\",\"recent_sessions\":\"$(json_escape "$recent_titles")\",\"summary\":\"$(json_escape "$summary")\"}"
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
  echo "Suggested improvements (this cycle):"
  if [ -s "$tmp_improve" ]; then
    cat "$tmp_improve" | sed 's/^/  /'
  else
    echo "  - (none detected)"
  fi
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
UPDATE todo SET status='completed', time_updated=$t_ms WHERE session_id='ses_img' AND position=1;
UPDATE todo SET status='completed', time_updated=$t_ms WHERE session_id='ses_blog' AND position=1;

INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
VALUES ('ses_impl', 'proj_1', 'implementation', '/workspace', 'Implement: soul commands + ADR', 'test', $t_ms, $t_ms);

INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
VALUES ('ses_impl', 'Create /debate-to-adr command and store ADRs in docs/adr/', 'pending', 'normal', 1, $t_ms, $t_ms);

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES
  ('msg_impl_u1', 'ses_impl', $t_ms, $t_ms, '{"role":"user"}'),
  ('msg_impl_a1', 'ses_impl', $t_ms+1, $t_ms+1, '{"role":"assistant"}');

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES
  ('prt_impl_u1', 'msg_impl_u1', 'ses_impl', $t_ms, $t_ms,
    '{"type":"text","text":"Follow-up: implement the chosen Soul Mode improvements. Start with /debate-to-adr and /image-ops commands."}'),
  ('prt_impl_a1', 'msg_impl_a1', 'ses_impl', $t_ms+1, $t_ms+1,
    '{"type":"text","text":"Plan: add commands, keep permissions minimal, then schedule heartbeats. Write an ADR for any behavior that changes defaults."}');
SQL
  echo "[debug] mutated opencode.db (completed 2 todos, added a new session + follow-up messages)"
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

  # Keep memory fresh on every heartbeat.
  if grep -q '^Last updated:' .opencode/soul.md; then
    sed -i "s/^Last updated: .*/Last updated: $ts/" .opencode/soul.md
  fi

  recent_text="$(sqlite3 -separator '\n' "$db" "SELECT json_extract(p.data, '$.text') FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = m.session_id WHERE s.directory = '$ws' AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created DESC LIMIT 60;" 2>/dev/null || true)"

  tmp_improve="/tmp/soul-improvements.txt"
  : > "$tmp_improve"

  if echo "$recent_text" | grep -qiE '(png|jpg|jpeg|webp|image|imagemagick|magick|crop|resize)'; then
    printf '%s\n' "- Suggestion: Add \`/image-ops\` command (ImageMagick) to crop/resize/export WebP consistently." >> "$tmp_improve"
  fi
  if echo "$recent_text" | grep -qiE '(blog|frontmatter|markdown|outline|draft)'; then
    printf '%s\n' "- Suggestion: Add \`/blog-draft\` command to scaffold Markdown frontmatter + headings for posts." >> "$tmp_improve"
  fi
  if echo "$recent_text" | grep -qiE '(debate|tradeoff|architecture|scheduler|cron|launchd|systemd|seconds)'; then
    printf '%s\n' "- Suggestion: Add \`/debate-to-adr\` command to convert long threads into an ADR + extracted TODOs." >> "$tmp_improve"
  fi
  if echo "$recent_text" | grep -qiE '(soul mode|heartbeat)'; then
    printf '%s\n' "- Suggestion: Allow narrow \`edit\` permission for \`.opencode/soul.md\` so scheduled heartbeats can improve memory safely." >> "$tmp_improve"
  fi

  tmp_new_improve="/tmp/soul-new-improvements.txt"
  : > "$tmp_new_improve"
  if [ -s "$tmp_improve" ]; then
    while IFS= read -r bullet; do
      [ -n "$bullet" ] || continue
      if ! grep -Fq -- "$bullet" .opencode/soul.md; then
        printf '%s\n' "$bullet" >> "$tmp_new_improve"
      fi
    done < "$tmp_improve"
  fi

  if [ -s "$tmp_new_improve" ]; then
    awk -v newfile="$tmp_new_improve" '
      function printfile(f,   line) {
        while ((getline line < f) > 0) print line
        close(f)
      }
      {
        if ($0 ~ /^## Recurring chores \/ automations to consider$/) inside=1
        if (inside && $0 ~ /^- \(none yet\)$/) next
        print
      }
      END {
        if (inside) {
          printfile(newfile)
        }
      }
    ' .opencode/soul.md > .opencode/soul.md.next
    mv .opencode/soul.md.next .opencode/soul.md
  fi

  improvements_count="$(wc -l < "$tmp_improve" | tr -d ' ')"
  improvements_summary="$(cat "$tmp_improve" 2>/dev/null | tr '\n' ';' | sed 's/;*$//')"

  summary="sessions=$session_count open_todos=$open_todos skills=$skills_count improvements=$improvements_count"
  line="{\"ts\":\"$ts\",\"workspace\":\"$ws\",\"db_path\":\"$db\",\"session_count\":$session_count,\"open_todos\":$open_todos,\"skills_count\":$skills_count,\"improvements\":\"$(json_escape "$improvements_summary")\",\"recent_sessions\":\"$(json_escape "$recent_titles")\",\"summary\":\"$(json_escape "$summary")\"}"
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
  echo "Loose ends (from memory):"
  read_section "Loose ends" | sed 's/^/  /'
  echo ""
  echo "Suggested improvements (this cycle):"
  if [ -s "$tmp_improve" ]; then
    cat "$tmp_improve" | sed 's/^/  /'
  else
    echo "  - (none detected)"
  fi
  echo ""
  echo "Recurring chores / automations (from memory):"
  read_section "Recurring chores / automations to consider" | sed 's/^/  /'
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
echo "[proof] sleep ${INTERVAL_SECONDS}s" >&2
sleep "$INTERVAL_SECONDS"

echo ""
echo "[proof] container run #2 (heartbeat reads persisted memory + db)" >&2
run_container "$(payload_tick_only)"

echo ""
echo "[proof] sleep ${INTERVAL_SECONDS}s" >&2
sleep "$INTERVAL_SECONDS"

echo ""
echo "[proof] container run #3 (heartbeat again, then show final artifacts)" >&2
run_container "$(payload_tick_only); echo ''; echo '[final] soul.md (top 40 lines)'; sed -n '1,40p' .opencode/soul.md; echo ''; echo '[final] heartbeat.jsonl (tail)'; tail -n 5 .opencode/soul/heartbeat.jsonl"

echo ""
echo "[proof] success" >&2
