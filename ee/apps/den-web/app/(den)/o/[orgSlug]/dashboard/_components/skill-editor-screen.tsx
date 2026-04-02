"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Upload } from "lucide-react";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import {
  getSkillDetailRoute,
  getSkillHubsRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  buildSkillText,
  parseSkillDraft,
  skillCategoryOptions,
  useOrgSkillLibrary,
} from "./skill-hub-data";

type SkillEditorMode = "manual" | "upload";
type SkillVisibility = "private" | "org" | "public";

export function SkillEditorScreen({ skillId }: { skillId?: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { orgId, orgSlug } = useOrgDashboard();
  const { skills, busy, error } = useOrgSkillLibrary(orgId);
  const skill = useMemo(() => (skillId ? skills.find((entry) => entry.id === skillId) ?? null : null), [skillId, skills]);
  const [mode, setMode] = useState<SkillEditorMode>("manual");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Engineering");
  const [description, setDescription] = useState("");
  const [details, setDetails] = useState("");
  const [visibility, setVisibility] = useState<SkillVisibility>("private");
  const [uploadedSkillText, setUploadedSkillText] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const assembledPreview = mode === "upload" && uploadedSkillText?.trim()
    ? uploadedSkillText
    : buildSkillText({ name, category, description, details });

  useEffect(() => {
    if (!skillId) {
      setName("");
      setCategory("Engineering");
      setDescription("");
      setDetails("");
      setVisibility("private");
      setUploadedSkillText(null);
      setUploadedFileName(null);
      setMode("manual");
      return;
    }

    if (!skill) {
      return;
    }

    const draft = parseSkillDraft(skill.skillText, {
      name: skill.title,
      description: skill.description,
    });
    setName(draft.name || skill.title);
    setCategory(draft.category || "Engineering");
    setDescription(draft.description || skill.description || "");
    setDetails(draft.details || skill.skillText);
    setVisibility(skill.shared === "org" ? "org" : skill.shared === "public" ? "public" : "private");
    setUploadedSkillText(null);
    setUploadedFileName(null);
    setMode("manual");
  }, [skill, skillId]);

  async function saveSkill() {
    if (!orgId) {
      setSaveError("Organization not found.");
      return;
    }

    if (!name.trim()) {
      setSaveError("Enter a skill name.");
      return;
    }

    const skillText = mode === "upload" && uploadedSkillText?.trim()
      ? uploadedSkillText
      : buildSkillText({ name, category, description, details });

    setSaving(true);
    setSaveError(null);
    try {
      const shared = visibility === "private" ? null : visibility;
      if (skillId) {
        const { response, payload } = await requestJson(
          `/v1/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ skillText, shared }),
          },
          12000,
        );

        if (!response.ok) {
          throw new Error(getErrorMessage(payload, `Failed to update skill (${response.status}).`));
        }

        router.push(getSkillDetailRoute(orgSlug, skillId));
      } else {
        const { response, payload } = await requestJson(
          `/v1/orgs/${encodeURIComponent(orgId)}/skills`,
          {
            method: "POST",
            body: JSON.stringify({ skillText, shared }),
          },
          12000,
        );

        if (!response.ok) {
          throw new Error(getErrorMessage(payload, `Failed to create skill (${response.status}).`));
        }

        const nextSkill = payload && typeof payload === "object" && payload && "skill" in payload && payload.skill && typeof payload.skill === "object"
          ? payload.skill as { id?: unknown }
          : null;
        const nextSkillId = typeof nextSkill?.id === "string" ? nextSkill.id : null;
        if (!nextSkillId) {
          throw new Error("The skill was created, but no skill id was returned.");
        }

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
    if (!file) {
      return;
    }

    const text = await file.text();
    const draft = parseSkillDraft(text);
    setUploadedSkillText(text);
    setUploadedFileName(file.name);
    setName(draft.name || file.name.replace(/\.md$/i, ""));
    setCategory(draft.category || "Engineering");
    setDescription(draft.description);
    setDetails(draft.details || text);
    setMode("upload");
  }

  if (busy && skillId && !skill) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading skill editor...
        </div>
      </div>
    );
  }

  if (skillId && !skill) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[15px] text-red-700">
          {error ?? "That skill could not be found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
      <div className="mb-8 flex flex-col gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">
          {skillId ? "Update skill" : "Add a new skill"}
        </p>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h1 className="text-[34px] font-semibold tracking-[-0.07em] text-gray-950">
              {skillId ? name || "Edit skill" : "Create a reusable skill"}
            </h1>
            <p className="mt-3 max-w-[720px] text-[16px] leading-8 text-gray-500">
              Write the skill manually or upload a `SKILL.md`, then review the generated markdown before saving it to the org library.
            </p>
          </div>

          <div className="flex flex-wrap gap-3 text-[13px] font-medium text-gray-600">
            <span className="rounded-full border border-gray-200 bg-white px-4 py-2">{category}</span>
            <span className="rounded-full border border-gray-200 bg-white px-4 py-2">{visibility === "private" ? "Private" : visibility === "org" ? "Org" : "Public"}</span>
            <span className="rounded-full border border-gray-200 bg-white px-4 py-2">{mode === "upload" ? "Upload mode" : "Manual mode"}</span>
          </div>
        </div>
      </div>

      <div className="mb-8 flex items-center justify-between gap-4">
        <Link
          href={skillId ? getSkillDetailRoute(orgSlug, skillId) : getSkillHubsRoute(orgSlug)}
          className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900"
        >
          <ArrowLeft className="h-5 w-5" />
          Back
        </Link>

        <button
          type="button"
          onClick={() => void saveSkill()}
          disabled={saving}
          className="inline-flex h-14 items-center justify-center rounded-full bg-[#0f172a] px-8 text-[15px] font-medium text-white transition hover:bg-[#111c33] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : skillId ? "Save Skill" : "Create Skill"}
        </button>
      </div>

      {saveError ? (
        <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
          {saveError}
        </div>
      ) : null}

      <section className="rounded-[36px] border border-gray-200 bg-white p-4 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)] md:p-8">
        <div className="mb-8 grid grid-cols-2 rounded-[28px] bg-[#f8fafc] p-1 text-center text-[15px] font-medium text-gray-500">
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={`rounded-[22px] px-4 py-4 transition ${mode === "manual" ? "bg-white text-gray-950 shadow-sm" : "hover:text-gray-700"}`}
          >
            Manual Entry
          </button>
          <button
            type="button"
            onClick={() => setMode("upload")}
            className={`rounded-[22px] px-4 py-4 transition ${mode === "upload" ? "bg-white text-gray-950 shadow-sm" : "hover:text-gray-700"}`}
          >
            Upload SKILL.md
          </button>
        </div>

        {mode === "upload" ? (
          <div className="mb-8 rounded-[28px] border border-dashed border-gray-200 bg-[#f8fafc] px-6 py-8 text-center">
            <p className="text-[16px] font-medium text-gray-900">Upload a SKILL.md file</p>
            <p className="mt-2 text-[14px] text-gray-500">
              We will keep the markdown source and also prefill the editor fields for review.
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-5 inline-flex h-12 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-[14px] font-medium text-gray-800 transition hover:border-gray-300 hover:text-gray-950"
            >
              <Upload className="h-4 w-4" />
              {uploadedFileName ? `Replace ${uploadedFileName}` : "Choose file"}
            </button>
            <input ref={fileInputRef} type="file" accept=".md,text/markdown" className="hidden" onChange={(event) => void handleFileSelection(event)} />
          </div>
        ) : null}

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid gap-8">
          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Skill Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-16 rounded-[22px] border border-gray-200 bg-[#f8fafc] px-5 text-[16px] text-gray-950 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
            />
          </label>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">Category</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="h-16 rounded-[22px] border border-gray-200 bg-[#f8fafc] px-5 text-[16px] text-gray-950 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
              >
                {skillCategoryOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">Visibility</span>
              <select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as SkillVisibility)}
                className="h-16 rounded-[22px] border border-gray-200 bg-[#f8fafc] px-5 text-[16px] text-gray-950 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
              >
                <option value="private">Private</option>
                <option value="org">Org</option>
                <option value="public">Public</option>
              </select>
            </label>
          </div>

          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Short Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="min-h-[120px] rounded-[22px] border border-gray-200 bg-[#f8fafc] px-5 py-4 text-[16px] leading-7 text-gray-950 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
            />
          </label>

          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Detailed Instructions (Markdown)</span>
            <textarea
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              rows={16}
              className="min-h-[420px] rounded-[22px] border border-gray-200 bg-[#f8fafc] px-5 py-4 font-mono text-[15px] leading-8 text-gray-950 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
            />
          </label>
          </div>

          <aside className="grid gap-4 self-start xl:sticky xl:top-8">
            <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Markdown preview</p>
              <div className="mt-4 max-h-[540px] overflow-auto rounded-[22px] border border-gray-200 bg-[#f8fafc] px-4 py-4">
                <pre className="whitespace-pre-wrap font-mono text-[13px] leading-7 text-gray-700">{assembledPreview}</pre>
              </div>
            </div>

            {uploadedFileName ? (
              <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
                <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Uploaded source</p>
                <p className="mt-3 text-[16px] font-medium tracking-[-0.03em] text-gray-950">{uploadedFileName}</p>
                <p className="mt-2 text-[14px] leading-7 text-gray-500">The original markdown stays intact in upload mode unless you switch back to manual entry.</p>
              </div>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  );
}
