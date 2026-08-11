import type { Hono } from "hono"
import { contextStorage, getContext } from "hono/context-storage"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { FeishuHireClient, type FeishuHireCredentials } from "../../capability-sources/feishu-hire-api.js"
import { listNativeProviderUsableEntries, resolveDefaultNativeProviderCredentialId } from "../../capability-sources/native-provider-connections.js"
import { getOrgOAuthClient } from "../../capability-sources/oauth-credentials.js"
import { env } from "../../env.js"
import { orgMemberRoute, queryValidator } from "../../middleware/index.js"
import { jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { listTeamsForMember } from "../../orgs.js"
import { readInternalCapabilityConnectorId } from "../../session.js"
import type { OrgRouteVariables } from "./shared.js"

const nullableString = z.string().nullable()
const nullableNumber = z.number().nullable()

const educationSchema = z.object({
  school: nullableString,
  degree: nullableNumber,
  fieldOfStudy: nullableString,
  startTime: nullableString,
  endTime: nullableString,
}).strict()

const careerSchema = z.object({
  company: nullableString,
  title: nullableString,
  startTime: nullableString,
  endTime: nullableString,
}).strict()

const talentSchema = z.object({
  id: nullableString,
  name: nullableString,
  experienceYears: nullableNumber,
  currentCity: nullableString,
  isOnboarded: z.boolean().nullable(),
  topDegree: nullableNumber,
  education: z.array(educationSchema),
  career: z.array(careerSchema),
}).strict()

const jobSchema = z.object({
  id: nullableString,
  title: nullableString,
  code: nullableString,
  description: nullableString,
  requirement: nullableString,
  department: nullableString,
  recruitmentType: nullableString,
  city: nullableString,
  headCount: nullableNumber,
  processName: nullableString,
  updatedAt: nullableString,
}).strict()

const jobsResponseSchema = z.object({
  jobs: z.array(jobSchema),
  hasMore: z.boolean(),
  pageToken: nullableString,
}).strict().meta({ ref: "FeishuHireJobsResponse" })

const talentsResponseSchema = z.object({
  talents: z.array(talentSchema),
  hasMore: z.boolean(),
  pageToken: nullableString,
  privacy: z.string(),
}).strict().meta({ ref: "FeishuHireTalentsResponse" })

const applicationsResponseSchema = z.object({
  applications: z.array(z.object({
    id: z.string(),
    jobId: nullableString,
    talentId: nullableString,
    candidate: talentSchema.nullable(),
    stage: z.object({
      id: nullableString,
      name: nullableString,
      type: nullableNumber,
    }).strict(),
    active: z.boolean(),
    createdAt: nullableString,
    updatedAt: nullableString,
    candidateUrl: nullableString,
  }).strict()),
  hasMore: z.boolean(),
  pageToken: nullableString,
  privacy: z.string(),
}).strict().meta({ ref: "FeishuHireApplicationsResponse" })

const listQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(20).default(10).describe("Maximum records to return, capped at 20."),
  pageToken: z.string().trim().min(1).max(512).optional().describe("Pagination token returned by the previous request."),
}).strict()

const talentsQuerySchema = listQuerySchema.extend({
  keyword: z.string().trim().min(1).max(200).optional().describe("Optional candidate keyword accepted by Feishu Hire."),
}).strict()

const applicationsQuerySchema = listQuerySchema.extend({
  processId: z.string().trim().min(1).max(256).optional(),
  stageId: z.string().trim().min(1).max(256).optional(),
  talentId: z.string().trim().min(1).max(256).optional(),
  jobId: z.string().trim().min(1).max(256).optional(),
  activeStatus: z.enum(["1", "2", "3"]).optional(),
  updateStartTime: z.string().trim().min(1).max(64).optional(),
  updateEndTime: z.string().trim().min(1).max(64).optional(),
}).strict()

const needsConnectionSchema = z.object({
  error: z.literal("needs_connection"),
  message: z.string(),
}).strict().meta({ ref: "FeishuHireNeedsConnectionError" })

const upstreamErrorSchema = z.object({
  error: z.literal("feishu_hire_error"),
  message: z.string(),
}).strict().meta({ ref: "FeishuHireUpstreamError" })

async function feishuHireCredentials(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}): Promise<FeishuHireCredentials | null> {
  const teamIds = (await listTeamsForMember({
    organizationId: input.organizationId,
    memberId: input.orgMembershipId,
  })).map((team) => team.id)
  const requestedConnectorId = readInternalCapabilityConnectorId(getContext().req.raw.headers)
  let credentialProviderId: string | null
  if (requestedConnectorId) {
    const entries = await listNativeProviderUsableEntries({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      teamIds,
    })
    const selected = entries.find((entry) => entry.id === requestedConnectorId)
    credentialProviderId = selected?.nativeProviderKey === "feishu-hire" ? selected.id : null
  } else {
    credentialProviderId = await resolveDefaultNativeProviderCredentialId({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      nativeProviderKey: "feishu-hire",
      teamIds,
    })
  }
  if (!credentialProviderId) return null

  const client = await getOrgOAuthClient(input.organizationId, credentialProviderId)
  const serviceUrl = client?.extra?.serviceUrl
  if (!client?.clientId || !client.clientSecret || typeof serviceUrl !== "string") return null
  return { appId: client.clientId, appSecret: client.clientSecret, serviceUrl }
}

async function clientForContext(context: NonNullable<OrgRouteVariables["organizationContext"]>): Promise<FeishuHireClient | null> {
  const credentials = await feishuHireCredentials({
    organizationId: context.organization.id,
    orgMembershipId: context.currentMember.id,
  })
  return credentials ? new FeishuHireClient(credentials, { apiBaseUrl: env.feishuHireApiBaseUrl }) : null
}

function upstreamFailure(error: unknown) {
  return {
    error: "feishu_hire_error" as const,
    message: error instanceof Error ? error.message : "Feishu Hire could not complete the request.",
  }
}

export function registerFeishuHireRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.use("/v1/capabilities/feishu-hire/*", contextStorage())

  app.get(
    "/v1/capabilities/feishu-hire/jobs",
    describeRoute({
      tags: ["Capability Sources"],
      operationId: "feishu-hireJobs",
      summary: "List read-only Feishu Hire jobs",
      description: "Lists recruiting jobs from the organization-managed Feishu Hire tenant. This capability is read-only.",
      responses: {
        200: jsonResponse("Feishu Hire jobs returned.", jobsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("Feishu Hire is not configured for the calling member.", needsConnectionSchema),
        502: jsonResponse("Feishu Hire rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(listQuerySchema),
    async (c) => {
      const client = await clientForContext(c.get("organizationContext"))
      if (!client) return c.json({ error: "needs_connection", message: "Ask an organization admin to configure and grant access to Feishu Hire." }, 409)
      try {
        return c.json(await client.listJobs(c.req.valid("query")), 200)
      } catch (error) {
        return c.json(upstreamFailure(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/feishu-hire/talents",
    describeRoute({
      tags: ["Capability Sources"],
      operationId: "feishu-hireTalents",
      summary: "Search read-only Feishu Hire talent summaries",
      description: "Searches recruiting-relevant candidate summaries. Contact details, government identity fields, addresses, birth dates, gender, and marital status are always omitted. This capability is read-only.",
      responses: {
        200: jsonResponse("Sanitized Feishu Hire talents returned.", talentsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("Feishu Hire is not configured for the calling member.", needsConnectionSchema),
        502: jsonResponse("Feishu Hire rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(talentsQuerySchema),
    async (c) => {
      const client = await clientForContext(c.get("organizationContext"))
      if (!client) return c.json({ error: "needs_connection", message: "Ask an organization admin to configure and grant access to Feishu Hire." }, 409)
      try {
        return c.json(await client.searchTalents(c.req.valid("query")), 200)
      } catch (error) {
        return c.json(upstreamFailure(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/feishu-hire/applications",
    describeRoute({
      tags: ["Capability Sources"],
      operationId: "feishu-hireApplications",
      summary: "List read-only Feishu Hire applications",
      description: "Lists applications with sanitized candidate summaries and deep links back to Feishu Hire. Sensitive candidate fields are never returned. This capability is read-only.",
      responses: {
        200: jsonResponse("Sanitized Feishu Hire applications returned.", applicationsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("Feishu Hire is not configured for the calling member.", needsConnectionSchema),
        502: jsonResponse("Feishu Hire rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(applicationsQuerySchema),
    async (c) => {
      const client = await clientForContext(c.get("organizationContext"))
      if (!client) return c.json({ error: "needs_connection", message: "Ask an organization admin to configure and grant access to Feishu Hire." }, 409)
      try {
        return c.json(await client.listApplications(c.req.valid("query")), 200)
      } catch (error) {
        return c.json(upstreamFailure(error), 502)
      }
    },
  )
}
