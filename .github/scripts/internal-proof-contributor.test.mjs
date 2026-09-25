import assert from "node:assert/strict";
import test from "node:test";
import { internalProofContributor } from "./internal-proof-contributor.mjs";

function fixture() {
  const repository = { id: 42, full_name: "internal/project", fork: false, owner: { type: "Organization" } };
  const pullRequest = {
    author_association: "MEMBER", user: { type: "User" },
    head: { repo: { ...repository } }, base: { repo: { ...repository } },
  };
  return { repository, pullRequest };
}

test("organization members and owners on repository branches qualify for automatic proof", () => {
  for (const association of ["MEMBER", "OWNER"]) {
    const f = fixture();
    f.pullRequest.author_association = association;
    assert.equal(internalProofContributor(f.pullRequest, f.repository), true);
  }
});

test("outside collaborators, contributors, bots, forks and incomplete identity keep reviewer approval", async t => {
  const scenarios = [
    ...["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "NONE", "MANNEQUIN", "", undefined]
      .map(association => [String(association), f => { f.pullRequest.author_association = association; }]),
    ["bot organization member", f => { f.pullRequest.user.type = "Bot"; }],
    ["missing user", f => { delete f.pullRequest.user; }],
    ["personal repository", f => { f.repository.owner.type = "User"; }],
    ["missing owner", f => { delete f.repository.owner; }],
    ["missing repository id", f => { delete f.repository.id; }],
    ["invalid repository id", f => { f.repository.id = 0; }],
    ["missing repository name", f => { delete f.repository.full_name; }],
    ["missing PR", f => { delete f.pullRequest; }],
    ["missing repository", f => { delete f.repository; }],
    ...["head", "base"].flatMap(side => [
      [`foreign ${side}`, f => { f.pullRequest[side].repo.id = 99; }],
      [`spoofed ${side} name`, f => { f.pullRequest[side].repo.full_name = "external/project"; }],
      [`fork ${side}`, f => { f.pullRequest[side].repo.fork = true; }],
      [`missing ${side} fork metadata`, f => { delete f.pullRequest[side].repo.fork; }],
      [`deleted ${side} repository`, f => { f.pullRequest[side].repo = null; }],
      [`missing ${side}`, f => { delete f.pullRequest[side]; }],
    ]),
  ];
  for (const [name, mutate] of scenarios) await t.test(name, () => {
    const f = fixture();
    mutate(f);
    assert.equal(internalProofContributor(f.pullRequest, f.repository), false);
  });
});
