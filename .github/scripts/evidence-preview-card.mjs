export const cardMarker = "<!-- openwork-evidence-preview:v1 -->";

function reportLink(value, reviewUrl) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === new URL(reviewUrl).origin
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/r\/[a-f0-9]{32}$/.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}

export function previousPreview(body, reviewUrl) {
  const raw = /<!-- openwork-evidence-report:(\{[^\n]+\}) -->/.exec(body ?? "");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw[1]);
    const url = reportLink(value.url, reviewUrl);
    return url && /^[a-f0-9]{40}$/.test(value.sha) && Number.isFinite(Date.parse(value.publishedAt))
      ? { url, sha: value.sha, publishedAt: new Date(value.publishedAt).toISOString() } : undefined;
  } catch { return undefined; }
}

export function renderPreviewCard({ repo, sha, status, conclusion, title, reportUrl, logUrl, previous, now = new Date().toISOString() }) {
  const commit = `[\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha})`;
  const ready = Boolean(reportUrl);
  const label = ready ? (conclusion === "success" ? "🟢 Ready · evidence passed" : "🔴 Ready · evidence needs attention")
    : status !== "completed" ? "🟡 Updating evidence"
      : conclusion === "neutral" ? "⚪ No new preview" : "🔴 Preview unavailable";
  const preview = ready ? `**[Open preview](${reportUrl})**` : `[View run](${logUrl})`;
  const updated = now.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const report = ready ? { sha, url: reportUrl, publishedAt: now } : previous;
  const lines = [cardMarker, "### OpenWork evidence", "", "| Status | Commit | Preview | Updated |", "| --- | --- | --- | --- |",
    `| ${label} | ${commit} | ${preview} | ${updated} |`, ""];
  if (ready) lines.push(`[Run details](${logUrl}) · Open the preview to inspect evidence and sandbox options.`);
  else {
    lines.push(status === "completed" ? title : "A preview for this commit is being prepared.");
    if (previous) lines.push("", `**Previous evidence — out of date:** [Open report for \`${previous.sha.slice(0, 7)}\`](${previous.url}). It does not verify the current run.`);
  }
  if (report) lines.push("", `<!-- openwork-evidence-report:${JSON.stringify(report)} -->`);
  return lines.join("\n");
}

/** Update only our authenticated bot comment, preserving other bots and manual evidence. */
export async function updatePreviewCard(input, api, current) {
  const root = `repos/${input.repo}`;
  let comment;
  for (let page = 1; page <= 10; page++) {
    const comments = await api(`${root}/issues/${input.pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error("Invalid evidence comment history");
    comment ??= comments.find(item => item.user?.login === "github-actions[bot]" && item.user?.type === "Bot"
      && Number.isSafeInteger(item.id) && item.id > 0 && item.body?.startsWith(cardMarker));
    if (comments.length < 100) break;
    if (page === 10) throw new Error("Evidence comment history exceeds safe bound");
  }
  if (!await current()) return;
  const body = renderPreviewCard({ ...input, previous: previousPreview(comment?.body, input.reviewUrl) });
  if (comment) return api(`${root}/issues/comments/${comment.id}`, "PATCH", { body });
  return api(`${root}/issues/${input.pr}/comments`, "POST", { body });
}
