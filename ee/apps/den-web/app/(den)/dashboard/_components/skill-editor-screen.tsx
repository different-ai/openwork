"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { ArrowLeft, FileText } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { getPluginRoute, getPluginSkillRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useCreateSkill, useSkill, useUpdateSkill } from "./skill-data";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function SkillEditorScreen({ pluginId, skillId }: { pluginId: string; skillId?: string }) {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const skillQuery = useSkill(pluginId, skillId ?? "");
  const createSkill = useCreateSkill(pluginId);
  const updateSkill = useUpdateSkill(pluginId);
  const [loadedSkillId, setLoadedSkillId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const isEditing = Boolean(skillId);
  const mutation = isEditing ? updateSkill : createSkill;

  useEffect(() => {
    const skill = skillQuery.data;
    if (!skill || loadedSkillId === skill.id) return;
    setName(skill.name);
    setDescription(skill.description);
    setBody(skill.body);
    setLoadedSkillId(skill.id);
  }, [loadedSkillId, skillQuery.data]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = { name: name.trim(), description: description.trim(), body: body.trim() };
    if (!SKILL_NAME_PATTERN.test(draft.name) || draft.name.length > 64) {
      setValidationError("Name must use lowercase letters, numbers, and single hyphens only.");
      return;
    }
    if (!draft.description || draft.description.length > 1024) {
      setValidationError("Description is required and must be 1,024 characters or fewer.");
      return;
    }
    if (!draft.body) {
      setValidationError("Skill body is required.");
      return;
    }

    setValidationError(null);
    try {
      const saved = skillId
        ? await updateSkill.mutateAsync({ skillId, draft })
        : await createSkill.mutateAsync(draft);
      router.push(getPluginSkillRoute(orgSlug, pluginId, saved.id));
    } catch {
      // React Query exposes the request error in the form below.
    }
  }

  if (isEditing && (skillQuery.isLoading || loadedSkillId !== skillId)) {
    return <EditorMessage>Loading skill…</EditorMessage>;
  }

  if (isEditing && !skillQuery.data) {
    return (
      <EditorMessage error>
        {skillQuery.error instanceof Error ? skillQuery.error.message : "That skill could not be found."}
      </EditorMessage>
    );
  }

  const requestError = mutation.error instanceof Error ? mutation.error.message : null;

  return (
    <div className="mx-auto max-w-[820px] px-6 py-8 md:px-8">
      <Link
        href={isEditing && skillId ? getPluginSkillRoute(orgSlug, pluginId, skillId) : getPluginRoute(orgSlug, pluginId)}
        className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 transition hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to {isEditing ? "skill" : "plugin"}
      </Link>

      <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-6 md:p-8">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-gray-950">
              {isEditing ? `Edit ${skillQuery.data?.name ?? "skill"}` : "Create a skill"}
            </h1>
            <p className="mt-1 text-[14px] text-gray-500">Store the complete instructions agents should follow.</p>
          </div>
        </div>

        <form className="mt-8 space-y-5" onSubmit={(event) => void submit(event)}>
          <Field label="Name" hint="Lowercase kebab-case, such as customer-research.">
            <DenInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. customer-research"
              autoComplete="off"
              maxLength={64}
              required
            />
          </Field>
          <Field label="Description" hint="Explain when an agent should load this skill.">
            <DenInput
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="When should an agent use this skill?"
              maxLength={1024}
              required
            />
          </Field>
          <Field label="Skill body" hint="Markdown is stored and displayed in full.">
            <DenTextarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="# Instructions\n\nDescribe the complete workflow..."
              rows={16}
              className="font-mono leading-6"
              required
            />
          </Field>

          {validationError || requestError ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {validationError ?? requestError}
            </p>
          ) : null}

          <div className="flex justify-end gap-3 pt-2">
            <Link href={getPluginRoute(orgSlug, pluginId)} className="inline-flex h-10 items-center rounded-lg px-4 text-[13px] font-medium text-gray-600 hover:bg-gray-50">
              Cancel
            </Link>
            <DenButton type="submit" loading={mutation.isPending}>
              {isEditing ? "Save changes" : "Create skill"}
            </DenButton>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-gray-800">{label}</span>
      <span className="mb-2 ml-2 text-[12px] text-gray-400">{hint}</span>
      {children}
    </label>
  );
}

function EditorMessage({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className="mx-auto max-w-[820px] px-6 py-8 md:px-8">
      <div className={`rounded-2xl border px-5 py-8 text-[14px] ${error ? "border-red-200 bg-red-50 text-red-700" : "border-gray-100 bg-white text-gray-500"}`}>
        {children}
      </div>
    </div>
  );
}
