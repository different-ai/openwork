import { t } from "@/i18n";
import type { TextComposerProps } from "@/react-app/kernel/text-composer-slot";

import { QuestionPanel } from "../../modals/question-modal";
import { ComposerFrame } from "./composer-frame";
import { ComposerSendButton } from "./composer-send-button";
import { LexicalPromptEditor } from "./editor";

const NO_MENTIONS = {};

export function TextComposer({ label, draft, onDraftChange, onSend, disabled, sending, question, topAccessory, status, sendLabel, onStop }: TextComposerProps) {
  const canSend = !disabled && !sending && !question && draft.trim().length > 0;
  const submit = () => { if (canSend) void onSend(); };

  return (
    <ComposerFrame topAccessory={<>
      {question ? <div data-composer-interaction="question"><QuestionPanel key={question.requestId} {...question} variant="composer" /></div> : null}
      {topAccessory}
    </>}>
      <div className="px-4 pt-3 pb-2">
        <LexicalPromptEditor
          value={draft}
          mentions={NO_MENTIONS}
          readOnly={sending}
          submitDisabled={false}
          ariaLabel={label}
          placeholder={label}
          onChange={onDraftChange}
          onSubmit={submit}
        />
        <div data-composer-toolbar className="mt-2 flex items-center justify-end gap-2">
          {status && <p role="status" className="me-auto text-xs text-dls-secondary">{status}</p>}
          <ComposerSendButton
            mode={sending ? "preparing" : onStop ? "stop" : "send"}
            label={!sending && onStop ? t("composer.stop") : sendLabel}
            disabled={sending || (!onStop && !canSend)}
            ready={canSend}
            onClick={onStop ? () => void onStop() : submit}
          />
        </div>
      </div>
    </ComposerFrame>
  );
}
