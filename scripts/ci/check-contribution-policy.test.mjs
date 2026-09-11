import assert from "node:assert/strict"
import test from "node:test"

import {
  collectContributionPolicyInput,
  evaluateContributionPolicy,
  runContributionPolicy,
} from "./check-contribution-policy.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)

function commit(overrides = {}) {
  return {
    sha: HEAD_SHA,
    message: "Policy test\n\nSigned-off-by: Example Author <author@example.test>",
    author: { name: "Example Author", email: "author@example.test" },
    ...overrides,
  }
}

function input(overrides = {}) {
  return {
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    commitCount: 1,
    fileCount: 1,
    commits: [commit()],
    files: [{ filename: "packages/example.ts", previousFilename: null, status: "modified" }],
    ...overrides,
  }
}

test("signed non-EE commits pass", () => {
  assert.deepEqual(evaluateContributionPolicy(input()), {
    ok: true,
    dcoValid: true,
    eeChanged: false,
    sensitivePolicyChanged: false,
    errors: [],
  })
})

test("unsigned and bot-authored commits have no exemptions", () => {
  const result = evaluateContributionPolicy(input({
    commits: [commit({
      message: "Automated update",
      author: { name: "Example Bot", email: "bot@example.test" },
    })],
  }))
  assert.equal(result.ok, false)
  assert.match(result.errors.join(" "), /final trailer block/)
})

test("author sign-off must match exact commit author metadata", () => {
  const result = evaluateContributionPolicy(input({
    commits: [commit({ author: { name: "Different Author", email: "author@example.test" } })],
  }))
  assert.equal(result.ok, false)
  assert.match(result.errors.join(" "), /exact final-block sign-off/)
})

test("a body quotation is not accepted as a trailer block", () => {
  const result = evaluateContributionPolicy(input({
    commits: [commit({
      message: "Policy test\n\nQuoted example:\nSigned-off-by: Example Author <author@example.test>",
    })],
  }))
  assert.equal(result.ok, false)
  assert.match(result.errors.join(" "), /trailer block is malformed/)
})

test("every co-author needs a matching final-block sign-off", () => {
  const missing = evaluateContributionPolicy(input({
    commits: [commit({
      message: [
        "Policy test",
        "",
        "Co-authored-by: Example Coauthor <coauthor@example.test>",
        "Signed-off-by: Example Author <author@example.test>",
      ].join("\n"),
    })],
  }))
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join(" "), /co-author lacks/)

  const complete = evaluateContributionPolicy(input({
    commits: [commit({
      message: [
        "Policy test",
        "",
        "Co-authored-by: Example Coauthor <coauthor@example.test>",
        "Signed-off-by: Example Author <author@example.test>",
        "Signed-off-by: Example Coauthor <coauthor@example.test>",
      ].join("\n"),
    })],
  }))
  assert.equal(complete.ok, true)
})

test("missing, inconsistent, and ceiling counts fail closed", () => {
  for (const candidate of [
    input({ commitCount: undefined }),
    input({ commitCount: 2 }),
    input({ commitCount: 250 }),
    input({ fileCount: 3000 }),
  ]) {
    assert.equal(evaluateContributionPolicy(candidate).ok, false)
  }
})

test("every EE path is held even when untrusted signals claim verification", () => {
  for (const status of ["added", "modified", "removed"]) {
    const result = evaluateContributionPolicy(input({
      files: [{ filename: "ee/server.ts", previousFilename: null, status }],
      labels: ["legal:cla-verified", "legal:ip-verified"],
      checkboxes: { cla: true, commercialTerms: true },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.eeChanged, true)
    assert.match(result.errors.join(" "), /CLA verification not configured/)
  }
})

test("both sides of renames are checked, including apparent client JavaScript", () => {
  const intoEe = evaluateContributionPolicy(input({
    files: [{
      filename: "ee/client.js",
      previousFilename: "packages/client.js",
      status: "renamed",
    }],
  }))
  const outOfEe = evaluateContributionPolicy(input({
    files: [{
      filename: "packages/client.js",
      previousFilename: "ee/client.js",
      status: "renamed",
    }],
  }))
  assert.equal(intoEe.eeChanged, true)
  assert.equal(intoEe.ok, false)
  assert.equal(outOfEe.eeChanged, true)
  assert.equal(outOfEe.ok, false)
})

test("policy, license, and CODEOWNERS machinery is held without a named owner", () => {
  for (const filename of [
    "LICENSE",
    "legal/contribution-policy.md",
    ".github/CODEOWNERS",
    ".github/workflows/contribution-policy.yml",
    ".github/workflows/spoof.yml",
    "scripts/ci/check-contribution-policy.mjs",
  ]) {
    const result = evaluateContributionPolicy(input({
      files: [{ filename, previousFilename: null, status: "modified" }],
    }))
    assert.equal(result.sensitivePolicyChanged, true)
    assert.equal(result.ok, false)
  }
})

function livePull(overrides = {}) {
  return {
    number: 17,
    state: "open",
    commits: 1,
    changed_files: 1,
    base: { sha: BASE_SHA, ref: "dev", repo: { full_name: "example/repository" } },
    head: { sha: HEAD_SHA, ref: "topic", repo: { full_name: "fork/repository" } },
    ...overrides,
  }
}

function revision() {
  return {
    owner: "example",
    repo: "repository",
    repository: "example/repository",
    pullNumber: 17,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    baseRef: "dev",
    headRef: "topic",
    headRepository: "fork/repository",
  }
}

function githubDouble(pulls) {
  const listCommits = () => {}
  const listFiles = () => {}
  let read = 0
  return {
    rest: {
      pulls: {
        get: async () => ({ data: pulls[read++] }),
        listCommits,
        listFiles,
      },
    },
    paginate: async (method) => {
      if (method === listCommits) {
        return [{
          sha: HEAD_SHA,
          commit: {
            message: commit().message,
            author: commit().author,
          },
        }]
      }
      if (method === listFiles) {
        return [{ filename: "packages/example.ts", status: "modified" }]
      }
      throw new Error("unexpected endpoint")
    },
  }
}

test("collector returns complete commit and file metadata for a stable fork PR", async () => {
  const collected = await collectContributionPolicyInput({
    github: githubDouble([livePull(), livePull()]),
    revision: revision(),
  })
  assert.equal(collected.baseSha, BASE_SHA)
  assert.equal(collected.headSha, HEAD_SHA)
  assert.equal(collected.commitCount, 1)
  assert.equal(collected.commits.length, 1)
  assert.equal(collected.fileCount, 1)
  assert.equal(collected.files.length, 1)
  assert.equal(evaluateContributionPolicy(collected).ok, true)
})

test("collector rejects a revision that differs before pagination", async () => {
  const changed = livePull({
    base: { sha: "c".repeat(40), ref: "dev", repo: { full_name: "example/repository" } },
  })
  await assert.rejects(
    collectContributionPolicyInput({ github: githubDouble([changed]), revision: revision() }),
    /revision changed/,
  )
})

test("collector rejects a head race after full commit and file pagination", async () => {
  const changed = livePull({ head: { sha: "c".repeat(40), ref: "topic", repo: { full_name: "fork/repository" } } })
  await assert.rejects(
    collectContributionPolicyInput({ github: githubDouble([livePull(), changed]), revision: revision() }),
    /revision changed/,
  )
})

test("an older run cannot overwrite a newer head status", async () => {
  const listCommitStatusesForRef = () => {}
  let statusWrites = 0
  let staleNotices = 0
  const github = {
    rest: {
      repos: {
        listCommitStatusesForRef,
        createCommitStatus: async () => { statusWrites += 1 },
      },
    },
    paginate: async (method) => {
      assert.equal(method, listCommitStatusesForRef)
      return [{
        context: "contribution-policy-required",
        state: "success",
        target_url: "https://github.com/example/repository/actions/runs/11/attempts/1",
      }]
    },
  }
  const context = {
    eventName: "pull_request_target",
    sha: BASE_SHA,
    repo: { owner: "example", repo: "repository" },
    payload: {
      action: "synchronize",
      repository: { full_name: "example/repository" },
      pull_request: livePull(),
    },
  }
  const core = {
    notice: () => { staleNotices += 1 },
    setFailed: () => assert.fail("a safely stale run should not fail or publish"),
  }

  const result = await runContributionPolicy({
    github,
    context,
    core,
    eventSha: BASE_SHA,
    workflowSha: BASE_SHA,
    runId: "10",
    runAttempt: "1",
    serverUrl: "https://github.com",
  })
  assert.equal(result.stale, true)
  assert.equal(statusWrites, 0)
  assert.equal(staleNotices, 1)
})

function runContext() {
  return {
    eventName: "pull_request_target",
    sha: BASE_SHA,
    repo: { owner: "example", repo: "repository" },
    payload: {
      action: "synchronize",
      repository: { full_name: "example/repository" },
      pull_request: livePull(),
    },
  }
}

function apiCommit(overrides = {}) {
  const value = commit(overrides)
  return {
    sha: value.sha,
    commit: { message: value.message, author: value.author },
  }
}

function runGithubDouble({
  pullReads = [livePull(), livePull()],
  commits = [apiCommit()],
  files = [{ filename: "packages/example.ts", status: "modified" }],
  failPullRead = false,
  replacePending = false,
} = {}) {
  const listCommits = () => {}
  const listFiles = () => {}
  const listCommitStatusesForRef = () => {}
  const statusWrites = []
  const statuses = []
  let pullRead = 0
  let statusRead = 0
  const replacement = {
    context: "contribution-policy-required",
    state: "pending",
    target_url: "https://github.com/example/repository/actions/runs/99/attempts/1",
  }

  return {
    statusWrites,
    github: {
      rest: {
        pulls: {
          get: async () => {
            if (failPullRead) throw new Error("simulated API failure")
            return { data: pullReads[pullRead++] }
          },
          listCommits,
          listFiles,
        },
        repos: {
          listCommitStatusesForRef,
          createCommitStatus: async (status) => {
            statusWrites.push(status)
            statuses.unshift({
              context: status.context,
              state: status.state,
              target_url: status.target_url,
            })
          },
        },
      },
      paginate: async (method) => {
        if (method === listCommits) return commits
        if (method === listFiles) return files
        if (method === listCommitStatusesForRef) {
          statusRead += 1
          if (replacePending && statusRead === 2) return [replacement, ...statuses]
          return statuses
        }
        throw new Error("unexpected endpoint")
      },
    },
  }
}

function coreDouble() {
  const failures = []
  return {
    failures,
    core: {
      info: () => {},
      notice: () => {},
      setFailed: (message) => { failures.push(message) },
    },
  }
}

async function runWith(github, core, context = runContext()) {
  return runContributionPolicy({
    github,
    context,
    core,
    eventSha: BASE_SHA,
    workflowSha: BASE_SHA,
    runId: "20",
    runAttempt: "2",
    serverUrl: "https://github.com",
  })
}

test("full runner writes pending then success only to a signed non-EE head", async () => {
  const api = runGithubDouble()
  const log = coreDouble()
  const result = await runWith(api.github, log.core)

  assert.equal(result.ok, true)
  assert.deepEqual(api.statusWrites.map((status) => status.state), ["pending", "success"])
  assert.ok(api.statusWrites.every((status) => status.sha === HEAD_SHA))
  assert.ok(api.statusWrites.every((status) => status.sha !== BASE_SHA))
  assert.ok(api.statusWrites.every((status) => status.context === "contribution-policy-required"))
  assert.ok(api.statusWrites.every((status) => (
    status.target_url === "https://github.com/example/repository/actions/runs/20/attempts/2"
  )))
  assert.deepEqual(log.failures, [])
})

test("full runner writes pending then failure for signed EE despite claimed labels", async () => {
  const api = runGithubDouble({
    files: [{ filename: "ee/client.js", status: "modified" }],
  })
  const log = coreDouble()
  const context = runContext()
  context.payload.pull_request.labels = [
    { name: "legal:cla-verified" },
    { name: "legal:ip-verified" },
  ]
  const result = await runWith(api.github, log.core, context)

  assert.equal(result.ok, false)
  assert.equal(result.eeChanged, true)
  assert.deepEqual(api.statusWrites.map((status) => status.state), ["pending", "failure"])
  assert.ok(api.statusWrites.every((status) => status.sha === HEAD_SHA))
  assert.match(log.failures.join(" "), /CLA verification not configured/)
})

test("collector API failure after pending writes failure and never success", async () => {
  const api = runGithubDouble({ failPullRead: true })
  const log = coreDouble()
  const result = await runWith(api.github, log.core)

  assert.equal(result.ok, false)
  assert.deepEqual(api.statusWrites.map((status) => status.state), ["pending", "failure"])
  assert.equal(api.statusWrites.some((status) => status.state === "success"), false)
  assert.ok(api.statusWrites.every((status) => status.sha === HEAD_SHA))
  assert.match(log.failures.join(" "), /failed closed/)
})

test("a replaced final pending status prevents success publication", async () => {
  const api = runGithubDouble({ replacePending: true })
  const log = coreDouble()
  const result = await runWith(api.github, log.core)

  assert.equal(result.ok, false)
  assert.equal(result.stale, true)
  assert.deepEqual(api.statusWrites.map((status) => status.state), ["pending"])
  assert.match(log.failures.join(" "), /replaced/)
})

test("invalid event binding fails before any status write", async () => {
  const api = runGithubDouble()
  const log = coreDouble()
  const context = runContext()
  context.sha = "c".repeat(40)
  const result = await runWith(api.github, log.core, context)

  assert.equal(result.ok, false)
  assert.deepEqual(api.statusWrites, [])
  assert.match(log.failures.join(" "), /trusted event and status binding/)
})

test("full runner blocks paginated commit and file count mismatches", async () => {
  const cases = [
    runGithubDouble({
      pullReads: [livePull({ commits: 2 }), livePull({ commits: 2 })],
    }),
    runGithubDouble({
      pullReads: [livePull({ changed_files: 2 }), livePull({ changed_files: 2 })],
    }),
  ]

  for (const api of cases) {
    const log = coreDouble()
    const result = await runWith(api.github, log.core)
    assert.equal(result.ok, false)
    assert.deepEqual(api.statusWrites.map((status) => status.state), ["pending", "failure"])
    assert.equal(api.statusWrites.some((status) => status.state === "success"), false)
    assert.match(log.failures.join(" "), /truncated or inconsistent/)
  }
})
