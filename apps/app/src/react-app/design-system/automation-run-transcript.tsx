import type { UIMessage } from "ai"

import { RemoteTranscriptView } from "./readonly-transcript-view"

export function AutomationRunTranscript({ scope, messages, running = false, waiting = false }: {
  scope: string
  messages: UIMessage[]
  running?: boolean
  waiting?: boolean
}) {
  return (
    <div className="min-w-0" data-automation-run-transcript>
      <RemoteTranscriptView
        threadKey={`automation:${scope}`}
        messages={messages}
        running={running}
        waiting={waiting}
        showThinking={false}
        developerMode={false}
      />
    </div>
  )
}
