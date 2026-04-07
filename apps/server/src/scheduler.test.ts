import { describe, expect, test } from "bun:test";

import type { ScheduledJob } from "./scheduler.js";
import { filterScheduledJobsForWorkdir } from "./scheduler.js";

function entry(name: string, workdir?: string) {
  return {
    job: {
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      schedule: "0 9 * * *",
      workdir,
      createdAt: "2026-04-07T00:00:00Z",
    } satisfies ScheduledJob,
  };
}

describe("filterScheduledJobsForWorkdir", () => {
  test("prefers exact workdir matches when present", () => {
    const filtered = filterScheduledJobsForWorkdir(
      [entry("Parent job", "/repo"), entry("Exact job", "/repo/app")],
      "/repo/app"
    );

    expect(filtered.map((item) => item.job.name)).toEqual(["Exact job"]);
  });

  test("falls back to related parent and child workdirs when exact matches are absent", () => {
    const filtered = filterScheduledJobsForWorkdir(
      [entry("Parent job", "/repo"), entry("Child job", "/repo/app/nested"), entry("Elsewhere", "/elsewhere")],
      "/repo/app"
    );

    expect(filtered.map((item) => item.job.name)).toEqual(["Parent job", "Child job"]);
  });
});
