import assert from "node:assert/strict"
import { test } from "node:test"
import { vertexPublisherBase } from "./inference-egress.ts"

const publishers: ("google" | "anthropic")[] = ["google", "anthropic"]

for (const [location, host] of [
  ["eu", "aiplatform.eu.rep.googleapis.com"],
  ["us", "aiplatform.us.rep.googleapis.com"],
  ["global", "aiplatform.googleapis.com"],
  ["europe-west4", "europe-west4-aiplatform.googleapis.com"],
]) {
  for (const publisher of publishers) {
    test(`Vertex ${publisher} uses the correct host and location for ${location}`, () => {
      for (const project of ["example-project", "123456789012"]) {
        assert.equal(vertexPublisherBase({ project, location }, publisher),
          `https://${host}/v1/projects/${project}/locations/${location}/publishers/${publisher}`)
      }
    })
  }
}

test("Vertex destinations still reject invalid projects and locations", () => {
  for (const location of [undefined, null, 1, "", "EU", "europe", "eu1.example.com", "eu/locations/global", "eu?x=1", "eu#fragment", "eu\n"]) {
    assert.equal(vertexPublisherBase({ project: "example-project", location }, "google"), null)
  }
  for (const project of [undefined, null, 1, "", "short", "UPPERCASE", "bad/project", "12345", "1".repeat(21), "a".repeat(64), "project-"]) {
    assert.equal(vertexPublisherBase({ project, location: "eu" }, "anthropic"), null)
  }
})
