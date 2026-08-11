import { describe, expect, test } from "bun:test"
import { FeishuHireClient } from "../src/capability-sources/feishu-hire-api.js"

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

describe("FeishuHireClient", () => {
  test("returns read-only recruiting summaries, strips sensitive fields, and creates candidate deep links", async () => {
    let tokenRequests = 0
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url.pathname.endsWith("/tenant_access_token/internal")) {
        tokenRequests += 1
        expect(init?.method).toBe("POST")
        expect(init?.body).toBe(JSON.stringify({ app_id: "cli_test", app_secret: "secret_test" }))
        return Response.json({ code: 0, tenant_access_token: "tenant-token", expire: 7200 })
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tenant-token")
      if (url.pathname === "/open-apis/hire/v1/jobs") {
        return Response.json({
          code: 0,
          data: {
            items: [{
              id: "job-1",
              title: "Product Designer",
              code: "DES-1",
              description: "Design products",
              requirement: "Portfolio",
              department: { zh_name: "设计" },
              recruitment_type: { en_name: "Experienced" },
              city: { en_name: "Shanghai" },
              head_count: 2,
              process_name: "Standard",
              update_timestamp: "1720000000",
            }],
            has_more: false,
          },
        })
      }
      if (url.pathname === "/open-apis/hire/v1/talents") {
        return Response.json({ code: 0, data: { items: [{
          id: "talent-1",
          basic_info: {
            name: "Lin",
            experience_years: 5,
            current_city: { en_name: "Shanghai" },
            mobile: "13800000000",
            email: "lin@example.com",
            birthday: "1990-01-01",
            gender: 1,
          },
          identification: { id_number: "sensitive-id" },
          address: "sensitive-address",
          marital_status: 1,
          top_degree: 5,
          education_list: [{ school: "Tongji", degree: 5, field_of_study: "Design" }],
          career_list: [{ company: "Acme", title: "Designer" }],
        }], has_more: false } })
      }
      if (url.pathname === "/open-apis/hire/v1/applications") {
        return Response.json({ code: 0, data: { items: ["application-1"], has_more: false } })
      }
      if (url.pathname === "/open-apis/hire/v1/applications/application-1") {
        return Response.json({ code: 0, data: { application: {
          talent_id: "talent-1",
          job_id: "job-1",
          stage: { id: "stage-1", zh_name: "面试", type: 2 },
          active_status: 1,
          create_time: "1710000000",
          modify_time: "1720000000",
        } } })
      }
      if (url.pathname === "/open-apis/hire/v2/talents/talent-1") {
        return Response.json({ code: 0, data: { talent: {
          id: "talent-1",
          basic_info: {
            name: "Lin",
            mobile: "13800000000",
            email: "lin@example.com",
            birthday: "1990-01-01",
          },
          identification: { id_number: "sensitive-id" },
          address: "sensitive-address",
        } } })
      }
      return Response.json({ code: 404 }, { status: 404 })
    }

    const client = new FeishuHireClient({
      appId: "cli_test",
      appSecret: "secret_test",
      serviceUrl: "https://acme.feishu.cn/hire",
    }, { fetch: fetcher })

    const [jobs, talents, applications] = await Promise.all([
      client.listJobs(),
      client.searchTalents({ keyword: "Lin" }),
      client.listApplications(),
    ])
    expect(jobs.jobs[0]?.title).toBe("Product Designer")
    expect(talents.talents[0]?.name).toBe("Lin")
    expect(applications.applications[0]?.candidateUrl).toBe("https://acme.feishu.cn/talent/talent-1?application_id=application-1")
    expect(applications.applications[0]?.candidate?.name).toBe("Lin")
    expect(tokenRequests).toBe(1)

    const serialized = JSON.stringify({ jobs, talents, applications })
    for (const sensitiveValue of [
      "13800000000",
      "lin@example.com",
      "1990-01-01",
      "sensitive-id",
      "sensitive-address",
      "cli_test",
      "secret_test",
      "tenant-token",
    ]) {
      expect(serialized).not.toContain(sensitiveValue)
    }
  })

  test("does not relay upstream error text that could echo credentials", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      code: 10003,
      msg: "invalid cli_sensitive secret_sensitive",
    })
    const client = new FeishuHireClient({
      appId: "cli_sensitive",
      appSecret: "secret_sensitive",
      serviceUrl: "https://acme.feishu.cn/hire",
    }, { fetch: fetcher })

    const message = await client.listJobs().then(
      () => "request unexpectedly succeeded",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )
    expect(message).toBe("Feishu Hire failed with code 10003.")
    expect(message).not.toContain("cli_sensitive")
    expect(message).not.toContain("secret_sensitive")
  })
})
