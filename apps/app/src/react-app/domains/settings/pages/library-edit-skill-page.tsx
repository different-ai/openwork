/** @jsxImportSource react */
import { useState } from "react";
import { Info, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "../../../../i18n";
import { TextInput } from "../../../design-system/text-input";
import type { LibraryEditableSkill } from "../use-library-cloud";
import { libraryFieldClass } from "./add-library-item-page";
import { LibraryPage } from "./library-page";

export type LibrarySkillDraft = { name: string; description: string; instructions: string };

/**
 * Changing a skill the member made. When others have it, saving changes it for
 * them too, so the page names who and offers a private copy instead.
 */
export function LibraryEditSkillPage(props: {
  skill: LibraryEditableSkill;
  /** e.g. "Support", or null when only the member has it. */
  audienceName: string | null;
  audiencePeople: number;
  onCancel: () => void;
  onSave: (draft: LibrarySkillDraft) => Promise<void>;
  onSaveCopy: (draft: LibrarySkillDraft) => Promise<void>;
}) {
  const [name, setName] = useState(props.skill.name);
  const [description, setDescription] = useState(props.skill.description);
  const [instructions, setInstructions] = useState(props.skill.instructions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shared = props.audienceName !== null;
  const draft = { name: name.trim(), description: description.trim(), instructions: instructions.trim() };
  const unchanged = draft.name === props.skill.name.trim()
    && draft.description === props.skill.description.trim()
    && draft.instructions === props.skill.instructions.trim();

  const run = async (save: (draft: LibrarySkillDraft) => Promise<void>) => {
    if (!draft.name || !draft.description || !draft.instructions) {
      setError(t("extensions.edit_skill_incomplete"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await save(draft);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.trim() ? cause.message : t("common.something_went_wrong"));
      setBusy(false);
    }
  };

  return (
    <LibraryPage
      title={t("extensions.edit_title", { name: props.skill.name })}
      crumbs={[{ label: props.skill.name }]}
      testId="library-edit-page"
      backDisabled={busy}
      onBack={props.onCancel}
      footerNote={t("extensions.edit_undo_note")}
      actions={(
        <>
          <Button variant="outline" disabled={busy} onClick={props.onCancel}>{t("common.cancel")}</Button>
          <Button disabled={busy || unchanged} onClick={() => void run(props.onSave)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {shared ? t("extensions.edit_save_for_everyone") : t("extensions.edit_save")}
          </Button>
        </>
      )}
    >
      <TextInput
        label={t("extensions.add_name_label")}
        value={name}
        disabled={busy}
        maxLength={64}
        className={libraryFieldClass}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <TextInput
        label={t("extensions.add_skill_when_label")}
        value={description}
        disabled={busy}
        maxLength={1024}
        className={libraryFieldClass}
        onChange={(event) => setDescription(event.currentTarget.value)}
      />
      <label className="block">
        <div className="mb-1 text-sm font-medium text-dls-text">{t("extensions.add_skill_what_label")}</div>
        <Textarea
          value={instructions}
          disabled={busy}
          rows={6}
          className={`min-h-32 leading-6 ${libraryFieldClass}`}
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
      </label>
      {shared ? (
        <div data-testid="library-edit-shared-note" className="flex items-start gap-2 rounded-lg bg-dls-hover px-3.5 py-3 text-[13px] text-dls-secondary">
          <Info size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-dls-text">
              {t("extensions.edit_shared_title", { audience: props.audienceName ?? "", count: String(props.audiencePeople) })}
            </p>
            <p>{t("extensions.edit_shared_body")}</p>
            <p>
              {t("extensions.edit_shared_copy_prompt")}{" "}
              <button
                type="button"
                disabled={busy}
                className="font-medium text-dls-text underline underline-offset-4"
                onClick={() => void run(props.onSaveCopy)}
              >
                {t("extensions.edit_save_copy")}
              </button>
            </p>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[13px] text-red-11">{error}</p> : null}
    </LibraryPage>
  );
}
