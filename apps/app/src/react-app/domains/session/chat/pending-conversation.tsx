import { Message, MessageContent } from "@/components/ui/message";
import { TaskRecovery } from "@/components/chat/task-recovery";
import { presentOpencodeSessionError } from "../sync/session-error";
import { persistableComposerDraftText } from "../surface/composer-state-store";
import { resolvePastedTextPlaceholders } from "../surface/composer/pasted-text";
import { retryPendingConversation, type PendingConversation } from "./pending-conversation-store";
import { NewTaskComposer, type NewTaskComposerContext } from "./new-task-composer";

const noop = () => {};

export function PendingConversationView({ conversation, composer }: { conversation: PendingConversation; composer: NewTaskComposerContext | null }) {
  const failed = conversation.phase === "creation-failed";
  const text = persistableComposerDraftText(resolvePastedTextPlaceholders(conversation.submitted.draft, conversation.submitted.pasteParts));
  const error = failed ? presentOpencodeSessionError(conversation.error, "Couldn’t send your message") : null;
  return <div className="flex h-full min-h-0 flex-col" data-pending-conversation={conversation.id}>
    <div className="relative min-h-0 flex-1">
      <div className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain touch-pan-y px-3 pb-4 pt-4 sm:px-5">
        <div className="mx-auto w-full max-w-[720px]">
          <Message className="mx-auto flex w-full max-w-3xl flex-col items-end gap-2 px-2 md:px-10" data-message-role="user">
            <MessageContent className="bg-muted text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 leading-6 sm:max-w-[75%] !select-text not-prose">
              <span className="whitespace-pre-wrap">{text}</span>
              {conversation.submitted.attachments.map((attachment) => <div key={attachment.id} className="text-xs text-muted-foreground">{attachment.name}</div>)}
            </MessageContent>
          </Message>
          {failed ? <TaskRecovery state="failed"
            title="Couldn’t send your message"
            technicalDetails={error?.technicalDetails}
            retryLabel="Retry sending"
            onRetry={() => { void retryPendingConversation(conversation.id); }}
          /> : null}
        </div>
      </div>
    </div>
    <div className="shrink-0 px-0 pb-2 pt-2 max-lg:pb-0" inert>
      {/* Keep the ordinary dock visible without giving a local identity to a
          session API or letting this read-only shell reclaim the source draft. */}
      <NewTaskComposer draft="" onDraftChange={noop} onRunTask={noop} busy flush={false}
        context={composer ? { ...composer, draftOwnerKey: undefined, draftScope: null,
          draftSessionId: undefined, destination: undefined, client: null, workspaceId: null } : null} />
    </div>
  </div>;
}
