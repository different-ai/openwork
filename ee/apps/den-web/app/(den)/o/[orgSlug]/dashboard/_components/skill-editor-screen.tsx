"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Upload } from "lucide-react";
import { DenButton } from "../../../../_components/ui/button";
import { DenInput } from "../../../../_components/ui/input";
import { DenSelect } from "../../../../_components/ui/select";
import { DenTextarea } from "../../../../_components/ui/textarea";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import {
  getSkillDetailRoute,
  getSkillHubsRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  buildSkillText,
  getSkillBodyText,
  parseSkillDraft,
  useOrgSkillLibrary,
} from "./skill-hub-data";

type SkillEditorMode = "manual" | "upload";
type SkillVisibility = "private" | "org" | "public";

export function SkillEditorScreen({ skillId }: { skillId?: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { orgId, orgSlug } = useOrgDashboard();
  const { skills, busy, error } = useOrgSkillLibrary(orgId);
  const skill = useMemo(
    () => (skillId ? skills.find((entry) => entry.id === skillId) ?? null : null),
    [skillId, skills],
  );
  const [mode, setMode] = useState<SkillEditorMode>("manual");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [details, setDetails] = useState("");
  const [visibility, setVisibility] = useState<SkillVisibility>("private");
  const [uploadedSkillText, setUploadedSkillText] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const assembledPreview =
    mode === "upload" && uploadedSkillText?.trim()
      ? uploadedSkillText
      : buildSkillText({ name, category: "", description, details });

  useEffect(() => {
    if (!skillId) {
      setName("");
      setDescription("");
      setDetails("");
      setVisibility("private");
      setUploadedSkillText(null);
      setUploadedFileName(null);
      setMode("manual");
      return;
    }

    if (!skill) return;

    const draft = parseSkillDraft(skill.skillText, {
      name: skill.title,
      description: skill.description,
    });
    setName(draft.name || skill.title);
    setDescription(draft.description || skill.description || "");
    setDetails(getSkillBodyText(skill.skillText, {
      name: skill.title,
      description: skill.description,
    }));
    setVisibility(
      skill.shared === "org" ? "org" : skill.shared === "public" ? "public" : "private",
    );
    setUploadedSkillText(null);
    setUploadedFileName(null);
    setMode("manual");
  }, [skill, skillId]);

  async function saveSkill() {
    if (!orgId) { setSaveError("Organization not found."); return; }
    if (!name.trim()) { setSaveError("Enter a skill name."); return; }

    const skillText =
      mode === "upload" && uploadedSkillText?.trim()
        ? uploadedSkillText
        : buildSkillText({ name, category: "", description, details });

    setSaving(true);
    setSaveError(null);
    try {
      const shared = visibility === "private" ? null : visibility;
      if (skillId) {
        const { response, payload } = await requestJson(
          `/v1/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}`,
          { method: "PATCH", body: JSON.stringify({ skillText, shared }) },
          12000,
        );
        if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to update skill (${response.status}).`));
        router.push(getSkillDetailRoute(orgSlug, skillId));
      } else {
        const { response, payload } = await requestJson(
          `/v1/orgs/${encodeURIComponent(orgId)}/skills`,
          { method: "POST", body: JSON.stringify({ skillText, shared }) },
          12000,
        );
        if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to create skill (${response.status}).`));
        const nextSkill =
          payload && typeof payload === "object" && "skill" in payload && payload.skill && typeof payload.skill === "object"
            ? (payload.skill as { id?: unknown })
            : null;
        const nextSkillId = typeof nextSkill?.id === "string" ? nextSkill.id : null;
        if (!nextSkillId) throw new Error("The skill was created, but no skill id was returned.");
        router.push(getSkillDetailRoute(orgSlug, nextSkillId));
      }
      router.refresh();
    } catch (nextError) {
      setSaveError(nextError instanceof Error ? nextError.message : "Could not save the skill.");
    } finally {
      setSaving(false);
    }
  }

  async function handleFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const draft = parseSkillDraft(text);
    setUploadedSkillText(text);
    setUploadedFileName(file.name);
    setName(draft.name || file.name.replace(/\.md$/i, ""));
    setDescription(draft.description);
    setDetails(getSkillBodyText(text));
    setMode("upload");
  }

  if (busy && skillId && !skill) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-gray-100 bg-white px-5 py-8 text-[13px] text-gray-400">
          Loading skill editor...
        </div>
      </div>
    );
  }

  if (skillId && !skill) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-[13px] text-red-600">
          {error ?? "That skill could not be found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">

      {/* Nav */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={skillId ? getSkillDetailRoute(orgSlug, skillId) : getSkillHubsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        <DenButton loading={saving} onClick={() => void saveSkill()}>
          {skillId ? "Save Skill" : "Create Skill"}
        </DenButton>
      </div>

      {/* Error */}
      {saveError ? (
        <div className="mb-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
          {saveError}
        </div>
      ) : null}

      <section className="rounded-2xl border border-gray-100 bg-white p-5 md:p-6">
        {/* Mode toggle */}
        <div className="mb-6 grid grid-cols-2 rounded-xl bg-gray-100/60 p-1 text-[13px] font-medium text-gray-500">
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={`rounded-lg px-4 py-2 transition ${mode === "manual" ? "bg-white text-gray-900 shadow-sm" : "hover:text-gray-700"}`}
          >
            Manual Entry
          </button>
          <button
            type="button"
            onClick={() => setMode("upload")}
            className={`rounded-lg px-4 py-2 transition ${mode === "upload" ? "bg-white text-gray-900 shadow-sm" : "hover:text-gray-700"}`}
          >
            Upload SKILL.md
          </button>
        </div>

        {/* Upload zone */}
        {mode === "upload" ? (
          <div className="mb-6 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-6 py-7 text-center">
            <p className="text-[14px] font-medium text-gray-900">Upload a SKILL.md file</p>
            <p className="mt-1.5 text-[13px] text-gray-400">
              We'll keep the markdown source and prefill the fields for review.
            </p>
            <DenButton
              variant="secondary"
              size="sm"
              icon={Upload}
              className="mt-4"
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadedFileName ? `Replace ${uploadedFileName}` : "Choose file"}
            </DenButton>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown"
              className="hidden"
              onChange={(event) => void handleFileSelection(event)}
            />
          </div>
        ) : null}

        {/* Two-column form layout */}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">

          {/* Fields */}
          <div className="grid gap-5">
            <label className="grid gap-2">
              <span className="text-[13px] font-medium text-gray-600">Skill Name</span>
              <DenInput
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <label className="grid gap-2">
              <span className="text-[13px] font-medium text-gray-600">Visibility</span>
              <DenSelect
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as SkillVisibility)}
              >
                <option value="private">Private</option>
                <option value="org">Org</option>
                <option value="public">Public</option>
              </DenSelect>
            </label>

            <label className="grid gap-2">
              <span className="text-[13px] font-medium text-gray-600">Short Description</span>
              <DenTextarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </label>

            <label className="grid gap-2">
              <span className="text-[13px] font-medium text-gray-600">
                Detailed Instructions{" "}
                <span className="font-normal text-gray-400">(Markdown)</span>
              </span>
              <DenTextarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                rows={16}
                className="font-mono text-[13px] leading-7"
              />
            </label>
          </div>

          {/* Preview aside */}
          <aside className="grid gap-3 self-start xl:sticky xl:top-8">
            <div className="rounded-xl border border-gray-100 bg-white p-4">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Markdown Preview
              </p>
              <div className="max-h-[480px] overflow-auto rounded-lg border border-gray-100 bg-gray-50 px-4 py-4">
                <pre className="whitespace-pre-wrap font-mono text-[12px] leading-6 text-gray-600">
                  {assembledPreview}
                </pre>
              </div>
            </div>

            {uploadedFileName ? (
              <div className="rounded-xl border border-gray-100 bg-white p-4">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Uploaded Source
                </p>
                <p className="text-[13px] font-medium text-gray-900">{uploadedFileName}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-gray-400">
                  Original markdown is preserved in upload mode.
                </p>
              </div>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  );
}
