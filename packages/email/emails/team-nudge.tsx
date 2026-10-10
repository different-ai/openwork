import { TeamNudgeEmail, type TeamNudgeEmailProps } from "../src/templates/lifecycle-reminders"

export default function TeamNudgePreview(props: TeamNudgeEmailProps) {
  return <TeamNudgeEmail {...props} />
}

TeamNudgePreview.PreviewProps = {
  organizationName: "OpenWork Preview",
  membersLink: "https://app.openworklabs.com/dashboard/members",
  mcpUrl: "https://api.openworklabs.com/mcp/agent",
  mcpDocsLink: "https://openworklabs.com/docs/start-here/connect-openwork-mcp",
  unsubscribeLink: "https://api.openworklabs.com/v1/email/unsubscribe?email=ada%40example.com&token=preview",
} satisfies TeamNudgeEmailProps
