import {
  OrganizationInviteEmail,
  type OrganizationInviteEmailProps,
} from "../src/templates/organization-invite"

export default function OrganizationInvitePreview(props: OrganizationInviteEmailProps) {
  return <OrganizationInviteEmail {...props} />
}

OrganizationInvitePreview.PreviewProps = {
  inviteLink: "https://app.openworklabs.com/join-org?invite=invitation_preview",
  invitedByName: "Ada Lovelace",
  invitedByEmail: "ada@example.com",
  organizationName: "OpenWork Preview",
  role: "member",
  inviteeEmail: "grace@example.com",
  gettingStartedUrl: "https://openworklabs.com/docs/cloud/team-quickstart",
  supportEmail: "team@openworklabs.com",
  reportAbuseUrl: "mailto:team@openworklabs.com?subject=Report%20an%20OpenWork%20invitation",
  footerLines: ["© 2026 Different AI. All rights reserved.", "openworklabs.com"],
} satisfies OrganizationInviteEmailProps
