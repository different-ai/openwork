#!/usr/bin/env node
import {
  getSlackReleaseMarkers,
  SLACK_RELEASE_PENDING_MARKER,
  SLACK_RELEASE_SENT_MARKER,
} from "./slack-release-markers.mjs";

export async function notifyRelease({ repository, tag, githubToken, slackToken, channel, request = fetch }) {
  if ([repository, tag, githubToken, slackToken, channel].some((value) => typeof value !== "string" || !value.trim())) {
    return { status: "skipped", reason: "missing-config" };
  }
  if (
    tag !== tag.trim() || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) ||
    repository !== repository.trim() || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repository) ||
    [".", ".."].includes(repository.split("/")[1]) ||
    channel !== channel.trim() || !/^[CG][A-Z0-9]+$/.test(channel)
  ) {
    throw new Error("Invalid release notification configuration.");
  }

  async function requestJson(url, options, timeout, operation) {
    try {
      const response = await request(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeout) });
      if (response.ok !== true) throw new Error();
      return await response.json();
    } catch {
      // Never surface provider bodies, headers, or transport errors containing credentials.
      throw new Error(`${operation} failed.`);
    }
  }

  const githubHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const releasesUrl = `https://api.github.com/repos/${repository}/releases`;
  const release = await requestJson(`${releasesUrl}/tags/${tag}`, {
    method: "GET",
    headers: githubHeaders,
  }, 15_000, "GitHub release lookup");
  if (
    !release || !Number.isSafeInteger(release.id) || release.id <= 0 ||
    typeof release.tag_name !== "string" || typeof release.draft !== "boolean" ||
    typeof release.prerelease !== "boolean" ||
    (release.published_at !== null && typeof release.published_at !== "string") ||
    (release.body !== null && typeof release.body !== "string")
  ) {
    throw new Error("Invalid GitHub release response.");
  }
  if (release.tag_name !== tag || release.draft || release.prerelease || !release.published_at) {
    return { status: "skipped", reason: "not-published-stable-release" };
  }

  const body = release.body ?? "";
  const markers = getSlackReleaseMarkers(body);
  if (markers.includes(SLACK_RELEASE_PENDING_MARKER)) {
    return { status: "pending", reason: "manual-reconciliation-required" };
  }
  if (markers.includes(SLACK_RELEASE_SENT_MARKER)) {
    return { status: "skipped", reason: "already-sent" };
  }

  async function updateBody(nextBody) {
    const updated = await requestJson(`${releasesUrl}/${release.id}`, {
      method: "PATCH",
      headers: { ...githubHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ body: nextBody }),
    }, 15_000, "GitHub notification marker update");
    if (updated?.id !== release.id || updated.body !== nextBody) {
      throw new Error("GitHub notification marker update was not confirmed.");
    }
  }

  // A durable prewrite suppresses retries even if Slack accepts a request whose response is lost.
  const pendingBody = `${body}${body ? "\n\n" : ""}${SLACK_RELEASE_PENDING_MARKER}`;
  await updateBody(pendingBody);
  const posted = await requestJson("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      text: `${repository} ${tag} is published. Generated release notes: https://github.com/${repository}/releases/tag/${tag}\nPublication is not approval for customer rollout.`,
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    }),
  }, 30_000, "Slack notification request");
  if (posted?.ok !== true || typeof posted.ts !== "string" || !posted.ts.trim() || posted.channel !== channel) {
    throw new Error("Slack notification was not confirmed; the release remains pending.");
  }
  await updateBody(pendingBody.replace(SLACK_RELEASE_PENDING_MARKER, SLACK_RELEASE_SENT_MARKER));
  return { status: "sent" };
}

if (import.meta.main) {
  try {
    const result = await notifyRelease({
      repository: process.env.GITHUB_REPOSITORY,
      tag: process.env.TAG,
      githubToken: process.env.GITHUB_TOKEN,
      slackToken: process.env.SLACK_BOT_TOKEN,
      channel: process.env.SLACK_RELEASE_CHANNEL_ID,
    });
    if (result.status === "pending") {
      console.warn("::warning::Slack release notification is pending; verify Slack and reconcile the release marker manually.");
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result));
    }
  } catch {
    console.warn("::warning::Slack release notification failed; verify Slack and reconcile any pending release marker before rerunning.");
    process.exitCode = 1;
  }
}
