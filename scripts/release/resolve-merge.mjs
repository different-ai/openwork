#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const TAG = /^v\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const eventName = process.env.GITHUB_EVENT_NAME;
const repository = process.env.GITHUB_REPOSITORY;
const appLogin = process.env.RELEASE_APP_LOGIN;

if (!/^[A-Za-z0-9-]+\[bot\]$/.test(appLogin)) {
  throw new Error("Required repository variable RELEASE_APP_LOGIN is missing or invalid.");
}

function validatePullRequest(pullRequest, tag) {
  const branch = `release/${tag}`;
  if (!pullRequest.merged_at && !pullRequest.merged) throw new Error("Release pull request is not merged.");
  if (pullRequest.user?.login !== appLogin) throw new Error(`Release PR author must be ${appLogin}.`);
  if (pullRequest.head?.repo?.full_name !== repository || pullRequest.head?.ref !== branch) {
    throw new Error("Release PR head repository or branch is not trusted.");
  }
  if (pullRequest.base?.ref !== "dev") throw new Error("Release PR base must be dev.");
  const mergeSha = pullRequest.merge_commit_sha;
  if (!SHA.test(mergeSha)) throw new Error("Release PR merge commit SHA is invalid.");
  if (!/^\d+$/.test(String(pullRequest.number))) throw new Error("Release PR number is invalid.");
  const expectedUrl = `https://github.com/${repository}/pull/${pullRequest.number}`;
  if (pullRequest.html_url !== expectedUrl) throw new Error("Release PR URL is invalid.");
  return {
    prNumber: String(pullRequest.number),
    tag,
    branch,
    mergeSha,
    prUrl: pullRequest.html_url,
  };
}

let resolved;
if (eventName === "pull_request_target") {
  const branch = event.pull_request?.head?.ref ?? "";
  const tag = branch.startsWith("release/") ? branch.slice("release/".length) : "";
  if (!TAG.test(tag)) throw new Error(`Release PR branch is invalid: ${branch}`);
  resolved = validatePullRequest(event.pull_request, tag);
} else if (eventName === "workflow_dispatch") {
  const inputTag = process.env.INPUT_TAG;
  const tag = inputTag.startsWith("v") ? inputTag : `v${inputTag}`;
  if (!TAG.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  const pages = JSON.parse(readFileSync(process.env.RELEASE_PR_CANDIDATES_PATH, "utf8"));
  const candidates = pages.flat().filter((pullRequest) =>
    pullRequest.merged_at
    && pullRequest.user?.login === appLogin
    && pullRequest.head?.repo?.full_name === repository
    && pullRequest.head?.ref === `release/${tag}`
    && pullRequest.base?.ref === "dev");
  if (candidates.length !== 1) throw new Error(`Expected one trusted merged release PR for ${tag}, found ${candidates.length}.`);
  resolved = validatePullRequest(candidates[0], tag);
} else {
  throw new Error(`Unsupported continuation event: ${eventName}`);
}

for (const [key, value] of Object.entries({
  pr_number: resolved.prNumber,
  tag: resolved.tag,
  branch: resolved.branch,
  merge_sha: resolved.mergeSha,
  pr_url: resolved.prUrl,
})) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
