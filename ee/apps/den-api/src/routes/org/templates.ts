import { and, desc, eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, TempTemplateSharingTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { idParamSchema, orgIdParamSchema, parseTemplateJson } from "./shared.js"

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  templateData: z.unknown(),
})

const templateSchema = z.object({
  id: denTypeIdSchema("tempTemplateSharing"),
  organizationId: denTypeIdSchema("organization"),
  name: z.string(),
  templateData: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  creator: z.object({
    memberId: denTypeIdSchema("member"),
    userId: denTypeIdSchema("user"),
    role: z.string(),
    name: z.string().nullable(),
    email: z.string().email().nullable(),
    image: z.string().nullable().optional(),
  }).passthrough(),
}).meta({ ref: "Template" })

const templateResponseSchema = z.object({
  template: templateSchema,
}).meta({ ref: "TemplateResponse" })

const templateListResponseSchema = z.object({
  templates: z.array(templateSchema),
}).meta({ ref: "TemplateListResponse" })

type TemplateSharingId = typeof TempTemplateSharingTable.$inferSelect.id
const orgTemplateParamsSchema = orgIdParamSchema.extend(idParamSchema("templateId", "tempTemplateSharing").shape)

export function registerOrgTemplateRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:orgId/templates",
    describeRoute({
      tags: ["Templates"],
      summary: "Create shared template",
      description: "Stores a reusable shared template snapshot inside an organization.",
      responses: {
        201: jsonResponse("Template created successfully.", templateResponseSchema),
        400: jsonResponse("The template creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create templates.", unauthorizedSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(createTemplateSchema),
    async (c) => {
    const payload = c.get("organizationContext")
    const user = c.get("user")
    const input = c.req.valid("json")

    const templateId = createDenTypeId("tempTemplateSharing")
    const now = new Date()

    await db.insert(TempTemplateSharingTable).values({
      id: templateId,
      organizationId: payload.organization.id,
      creatorMemberId: payload.currentMember.id,
      creatorUserId: normalizeDenTypeId("user", user.id),
      name: input.name,
      templateJson: JSON.stringify(input.templateData),
      createdAt: now,
      updatedAt: now,
    })

    return c.json({
      template: {
        id: templateId,
        name: input.name,
        templateData: input.templateData,
        createdAt: now,
        updatedAt: now,
        organizationId: payload.organization.id,
        creator: {
          memberId: payload.currentMember.id,
          userId: user.id,
          role: payload.currentMember.role,
          name: user.name,
          email: user.email,
        },
      },
    }, 201)
    },
  )

  app.get(
    "/v1/orgs/:orgId/templates",
    describeRoute({
      tags: ["Templates"],
      summary: "List shared templates",
      description: "Lists the shared templates that belong to an organization, including creator metadata.",
      responses: {
        200: jsonResponse("Templates returned successfully.", templateListResponseSchema),
        400: jsonResponse("The template list path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list templates.", unauthorizedSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
    const payload = c.get("organizationContext")

    const templates = await db
      .select({
        template: {
          id: TempTemplateSharingTable.id,
          organizationId: TempTemplateSharingTable.organizationId,
          name: TempTemplateSharingTable.name,
          templateJson: TempTemplateSharingTable.templateJson,
          createdAt: TempTemplateSharingTable.createdAt,
          updatedAt: TempTemplateSharingTable.updatedAt,
        },
        creatorMember: {
          id: MemberTable.id,
          role: MemberTable.role,
        },
        creatorUser: {
          id: AuthUserTable.id,
          name: AuthUserTable.name,
          email: AuthUserTable.email,
          image: AuthUserTable.image,
        },
      })
      .from(TempTemplateSharingTable)
      .innerJoin(MemberTable, eq(TempTemplateSharingTable.creatorMemberId, MemberTable.id))
      .innerJoin(AuthUserTable, eq(TempTemplateSharingTable.creatorUserId, AuthUserTable.id))
      .where(eq(TempTemplateSharingTable.organizationId, payload.organization.id))
      .orderBy(desc(TempTemplateSharingTable.createdAt))

    return c.json({
      templates: templates.map((row) => ({
        id: row.template.id,
        organizationId: row.template.organizationId,
        name: row.template.name,
        templateData: parseTemplateJson(row.template.templateJson),
        createdAt: row.template.createdAt,
        updatedAt: row.template.updatedAt,
        creator: {
          memberId: row.creatorMember.id,
          role: row.creatorMember.role,
          userId: row.creatorUser.id,
          name: row.creatorUser.name,
          email: row.creatorUser.email,
          image: row.creatorUser.image,
        },
      })),
    })
    },
  )

  app.delete(
    "/v1/orgs/:orgId/templates/:templateId",
    describeRoute({
      tags: ["Templates"],
      summary: "Delete shared template",
      description: "Deletes a shared template when the caller is the template creator or a workspace owner.",
      responses: {
        204: emptyResponse("Template deleted successfully."),
        400: jsonResponse("The template deletion path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete templates.", unauthorizedSchema),
        403: jsonResponse("Only the template creator or a workspace owner can delete templates.", forbiddenSchema),
        404: jsonResponse("The template or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgTemplateParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
    const payload = c.get("organizationContext")

    const params = c.req.valid("param")
    let templateId: TemplateSharingId
    try {
      templateId = normalizeDenTypeId("tempTemplateSharing", params.templateId)
    } catch {
      return c.json({ error: "template_not_found" }, 404)
    }

    const templateRows = await db
      .select()
      .from(TempTemplateSharingTable)
      .where(and(eq(TempTemplateSharingTable.id, templateId), eq(TempTemplateSharingTable.organizationId, payload.organization.id)))
      .limit(1)

    const template = templateRows[0]
    if (!template) {
      return c.json({ error: "template_not_found" }, 404)
    }

    const isOwner = payload.currentMember.isOwner
    const isCreator = template.creatorMemberId === payload.currentMember.id
    if (!isOwner && !isCreator) {
      return c.json({
        error: "forbidden",
        message: "Only the template creator or a workspace owner can delete templates.",
      }, 403)
    }

    await db.delete(TempTemplateSharingTable).where(eq(TempTemplateSharingTable.id, template.id))
    return c.body(null, 204)
    },
  )
}
