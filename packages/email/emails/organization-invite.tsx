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
  role: "admin",
} satisfies OrganizationInviteEmailProps
