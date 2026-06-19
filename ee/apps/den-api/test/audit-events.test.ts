import { expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  buildOrganizationAuditAlertLogLine,
  buildOrganizationAuditEvent,
  isOrganizationAuditAlertAction,
  ORGANIZATION_AUDIT_ACTIONS,
} from "../src/audit-events.js"

test("organization audit events normalize org ids and keep actor context", () => {
  const organizationId = createDenTypeId("organization")
  const actorUserId = createDenTypeId("user")

  const event = buildOrganizationAuditEvent({
    organizationId,
    actorUserId,
    action: ORGANIZATION_AUDIT_ACTIONS.apiKeyCreated,
    payload: {
      apiKeyId: "api-key-id",
      orgMembershipId: "member-id",
      name: "CI key",
      prefix: "den_",
    },
  })

  expect(event.id.startsWith("aev_")).toBe(true)
  expect(event.org_id).toBe(organizationId)
  expect(event.actor_user_id).toBe(actorUserId)
  expect(event.worker_id).toBe(null)
  expect(event.action).toBe("organization.api_key.created")
  expect(event.payload).toEqual({
    apiKeyId: "api-key-id",
    orgMembershipId: "member-id",
    name: "CI key",
    prefix: "den_",
  })
})

test("organization audit events allow empty payloads", () => {
  const event = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.apiKeyDeleted,
  })

  expect(event.action).toBe("organization.api_key.deleted")
  expect(event.payload).toBe(null)
})

test("organization audit events support member lifecycle actions", () => {
  const targetOrgMembershipId = createDenTypeId("member")
  const targetUserId = createDenTypeId("user")

  const event = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.memberRoleUpdated,
    payload: {
      targetOrgMembershipId,
      targetUserId,
      previousRole: "member",
      nextRole: "admin",
    },
  })

  expect(event.action).toBe("organization.member.role_updated")
  expect(event.payload).toEqual({
    targetOrgMembershipId,
    targetUserId,
    previousRole: "member",
    nextRole: "admin",
  })
})

test("organization audit events support invitation lifecycle actions", () => {
  const invitationId = createDenTypeId("invitation")
  const targetOrgMembershipId = createDenTypeId("member")

  expect(ORGANIZATION_AUDIT_ACTIONS.invitationRefreshed).toBe("organization.invitation.refreshed")
  expect(ORGANIZATION_AUDIT_ACTIONS.invitationCanceled).toBe("organization.invitation.canceled")

  const event = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.invitationCreated,
    payload: {
      invitationId,
      targetOrgMembershipId,
      targetEmail: "new-member@example.com",
      role: "member",
      expiresAt: "2026-06-20T00:00:00.000Z",
    },
  })

  expect(event.action).toBe("organization.invitation.created")
  expect(event.payload).toEqual({
    invitationId,
    targetOrgMembershipId,
    targetEmail: "new-member@example.com",
    role: "member",
    expiresAt: "2026-06-20T00:00:00.000Z",
  })
})

test("organization audit events support custom role lifecycle actions", () => {
  const organizationRoleId = createDenTypeId("organizationRole")

  expect(ORGANIZATION_AUDIT_ACTIONS.roleCreated).toBe("organization.role.created")
  expect(ORGANIZATION_AUDIT_ACTIONS.roleDeleted).toBe("organization.role.deleted")

  const event = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.roleUpdated,
    payload: {
      organizationRoleId,
      previousRole: "analyst",
      nextRole: "ops-analyst",
      roleRenamed: true,
      permissionChanged: true,
    },
  })

  expect(event.action).toBe("organization.role.updated")
  expect(event.payload).toEqual({
    organizationRoleId,
    previousRole: "analyst",
    nextRole: "ops-analyst",
    roleRenamed: true,
    permissionChanged: true,
  })
})

test("organization audit events support SCIM management actions", () => {
  const scimProviderId = createDenTypeId("scimProvider")

  const event = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.scimTokenRotated,
    payload: {
      scimProviderId,
      providerId: "openwork-scim-org_id",
    },
  })

  expect(event.action).toBe("organization.scim.token_rotated")
  expect(event.payload).toEqual({
    scimProviderId,
    providerId: "openwork-scim-org_id",
  })

  const reconciliationEvent = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.scimReconciliationRun,
    payload: {
      checked: 3,
      repaired: 1,
      failures: 0,
    },
  })

  expect(reconciliationEvent.action).toBe("organization.scim.reconciliation_run")
  expect(reconciliationEvent.payload).toEqual({
    checked: 3,
    repaired: 1,
    failures: 0,
  })
})

test("organization audit events support SSO management actions", () => {
  const ssoConnectionId = createDenTypeId("ssoConnection")

  const event = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.ssoConnectionRegistered,
    payload: {
      ssoConnectionId,
      providerId: "openwork-sso-org_id",
      kind: "saml",
      issuer: "https://idp.example.com",
      domain: "example.com",
    },
  })

  expect(event.action).toBe("organization.sso.connection_registered")
  expect(event.payload).toEqual({
    ssoConnectionId,
    providerId: "openwork-sso-org_id",
    kind: "saml",
    issuer: "https://idp.example.com",
    domain: "example.com",
  })
})

test("organization audit alerting covers sensitive access changes", () => {
  expect(isOrganizationAuditAlertAction(ORGANIZATION_AUDIT_ACTIONS.apiKeyCreated)).toBe(true)
  expect(isOrganizationAuditAlertAction(ORGANIZATION_AUDIT_ACTIONS.invitationCreated)).toBe(true)
  expect(isOrganizationAuditAlertAction(ORGANIZATION_AUDIT_ACTIONS.memberRoleUpdated)).toBe(true)
  expect(isOrganizationAuditAlertAction(ORGANIZATION_AUDIT_ACTIONS.roleUpdated)).toBe(true)
  expect(isOrganizationAuditAlertAction(ORGANIZATION_AUDIT_ACTIONS.scimTokenRotated)).toBe(true)
  expect(isOrganizationAuditAlertAction(ORGANIZATION_AUDIT_ACTIONS.ssoConnectionRegistered)).toBe(true)
  expect(isOrganizationAuditAlertAction(ORGANIZATION_AUDIT_ACTIONS.scimReconciliationRun)).toBe(false)
})

test("organization audit alert log line is structured and secret-free", () => {
  const event = buildOrganizationAuditEvent({
    organizationId: createDenTypeId("organization"),
    actorUserId: createDenTypeId("user"),
    action: ORGANIZATION_AUDIT_ACTIONS.ssoConnectionDeleted,
    payload: {
      ssoConnectionId: createDenTypeId("ssoConnection"),
      providerId: "openwork-sso-org_id",
      domain: "example.com",
    },
  })

  const logLine = buildOrganizationAuditAlertLogLine(event)
  expect(logLine.startsWith("[audit-alert] ")).toBe(true)
  expect(logLine).toContain("organization.sso.connection_deleted")
  expect(logLine).toContain(event.org_id)
  expect(logLine).not.toContain("secret")
  expect(logLine).not.toContain("token")
})
