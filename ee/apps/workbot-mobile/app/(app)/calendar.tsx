import { WorkbotChatProvider } from "@openwork-ee/workbot-client/hooks"
import { WorkbotCalendarScreen } from "../../src/calendar/screen"
import { useMe } from "../../src/me"

/** Workbot's Calendar: the person's Automations next to their meetings. */
export default function Calendar() {
  const me = useMe()
  return (
    <WorkbotChatProvider value={null}>
      <WorkbotCalendarScreen me={me} />
    </WorkbotChatProvider>
  )
}
