"use client";

import { ImageUp, Palette, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import {
  getManagedBrandAssetFromMetadata,
  parseOrganizationMetadata,
  type DenManagedBrandAsset,
} from "../../_lib/den-org";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";

const BRAND_ASSET_MAX_BYTES = 2 * 1024 * 1024;

type BrandAssetKind = "logo" | "icon";

type BrandAssetDraft = {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
};

async function createBrandAssetDraft(file: File, kind: BrandAssetKind): Promise<BrandAssetDraft> {
  if (file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("Use a PNG or JPEG image.");
  if (file.size > BRAND_ASSET_MAX_BYTES) throw new Error("Use an image under 2 MB.");

  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("OpenWork could not decode that image.");
  }

  const { width, height } = image;
  image.close();
  if (width > 4096 || height > 4096) throw new Error("Use an image no larger than 4096×4096 pixels.");
  if (kind === "icon") {
    if (width < 64 || height < 64) throw new Error("Use a square icon at least 64×64 pixels.");
    if (width !== height) throw new Error("Use a square image for the app icon.");
  } else {
    const aspectRatio = width / height;
    if (width < 128 || height < 32) throw new Error("Use a wordmark at least 128×32 pixels.");
    if (aspectRatio < 1.5 || aspectRatio > 8) throw new Error("Use a horizontal wordmark between 1.5:1 and 8:1.");
  }

  return { file, previewUrl: URL.createObjectURL(file), width, height };
}

function BrandAssetUploadField({
  kind,
  title,
  description,
  currentUrl,
  managedAsset,
  draft,
  clearPending,
  disabled,
  onSelect,
  onClear,
}: {
  kind: BrandAssetKind;
  title: string;
  description: string;
  currentUrl: string | null;
  managedAsset: DenManagedBrandAsset | null;
  draft: BrandAssetDraft | null;
  clearPending: boolean;
  disabled: boolean;
  onSelect: (file: File | null) => void;
  onClear: () => void;
}) {
  const inputId = `brand-${kind}-upload`;
  const previewUrl = draft?.previewUrl ?? (clearPending ? null : currentUrl);
  const dimensions = draft
    ? `${draft.width}×${draft.height}`
    : managedAsset
      ? `${managedAsset.width}×${managedAsset.height}`
      : null;

  return (
    <div className="grid min-w-0 gap-3 rounded-2xl border border-gray-200 bg-white p-4" data-testid={`brand-${kind}-asset-field`}>
      <div className="grid gap-1">
        <span className="text-[14px] font-medium text-gray-800">{title}</span>
        <span className="text-[11px] leading-5 text-gray-400">{description}</span>
      </div>
      <div className="flex min-h-28 items-center justify-center overflow-hidden rounded-xl border border-dashed border-gray-200 bg-gray-50 p-4">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={`${title} preview`}
            className={kind === "icon" ? "size-20 rounded-xl object-contain" : "max-h-20 max-w-full object-contain"}
            data-testid={`brand-${kind}-preview`}
          />
        ) : (
          <span className="text-center text-[12px] text-gray-400">Default OpenWork {kind}</span>
        )}
      </div>
      <div className="min-h-9 min-w-0 break-words text-[11px] leading-5 text-gray-500" data-testid={`brand-${kind}-status`}>
        {draft ? `Ready to upload: ${draft.file.name} · ${dimensions}` : null}
        {!draft && clearPending ? "Will restore the default after saving." : null}
        {!draft && !clearPending && managedAsset ? `Stored in this Den · ${dimensions} · version ${managedAsset.version.slice(0, 10)}` : null}
        {!draft && !clearPending && !managedAsset && currentUrl ? "Current hosted image (legacy URL). Upload a file to move it into this Den." : null}
        {!draft && !clearPending && !currentUrl ? "No custom image saved." : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <label
          htmlFor={inputId}
          className={[
            "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50",
            disabled ? "pointer-events-none opacity-60" : "",
          ].join(" ")}
        >
          <ImageUp size={13} aria-hidden="true" />
          {previewUrl ? "Replace image" : "Choose image"}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/png,image/jpeg"
          className="sr-only"
          disabled={disabled}
          onClick={(event) => { event.currentTarget.value = ""; }}
          onChange={(event) => onSelect(event.target.files?.item(0) ?? null)}
        />
        <DenButton type="button" variant="secondary" size="sm" icon={Trash2} disabled={disabled || !previewUrl} onClick={onClear}>
          Clear
        </DenButton>
      </div>
    </div>
  );
}

export function BrandAppearanceScreen() {
  const {
    activeOrg,
    orgContext,
    orgBusy,
    orgError,
    mutationBusy,
    runReauthableAction,
    updateOrganizationSettings,
  } = useOrgDashboard();
  const [appNameDraft, setAppNameDraft] = useState("");
  const [accentColorDraft, setAccentColorDraft] = useState("");
  const [logoDraft, setLogoDraft] = useState<BrandAssetDraft | null>(null);
  const [iconDraft, setIconDraft] = useState<BrandAssetDraft | null>(null);
  const [logoClearPending, setLogoClearPending] = useState(false);
  const [iconClearPending, setIconClearPending] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageSuccess, setPageSuccess] = useState<string | null>(null);

  const isOwner = orgContext?.currentMember.isOwner ?? false;
  const metadata = parseOrganizationMetadata(orgContext?.organization.metadata ?? null);
  const currentLogoUrl = typeof metadata?.brandLogoUrl === "string" ? metadata.brandLogoUrl : null;
  const currentIconUrl = typeof metadata?.brandIconUrl === "string" ? metadata.brandIconUrl : null;
  const currentLogoAsset = getManagedBrandAssetFromMetadata(orgContext?.organization.metadata ?? null, "logo");
  const currentIconAsset = getManagedBrandAssetFromMetadata(orgContext?.organization.metadata ?? null, "icon");
  const logoPreviewUrl = logoDraft?.previewUrl ?? (logoClearPending ? null : currentLogoUrl);
  const iconPreviewUrl = iconDraft?.previewUrl ?? (iconClearPending ? null : currentIconUrl);

  useEffect(() => {
    if (!orgContext) return;
    const nextMetadata = parseOrganizationMetadata(orgContext.organization.metadata);
    setAppNameDraft(typeof nextMetadata?.brandAppName === "string" ? nextMetadata.brandAppName : "");
    setAccentColorDraft(typeof nextMetadata?.brandAccentColor === "string" ? nextMetadata.brandAccentColor : "");
    setLogoDraft(null);
    setIconDraft(null);
    setLogoClearPending(false);
    setIconClearPending(false);
  }, [orgContext]);

  useEffect(() => () => {
    if (logoDraft) URL.revokeObjectURL(logoDraft.previewUrl);
  }, [logoDraft]);

  useEffect(() => () => {
    if (iconDraft) URL.revokeObjectURL(iconDraft.previewUrl);
  }, [iconDraft]);

  if (orgBusy && !orgContext) {
    return <div className="mx-auto max-w-[860px] p-8 text-[14px] text-gray-500">Loading brand appearance...</div>;
  }

  if (!activeOrg || !orgContext) {
    return <DenNotice message={orgError ?? "Brand appearance is not available right now."} className="m-8" />;
  }

  async function handleAssetSelection(kind: BrandAssetKind, file: File | null) {
    setPageError(null);
    if (!file) return;
    try {
      const draft = await createBrandAssetDraft(file, kind);
      if (kind === "logo") {
        setLogoDraft(draft);
        setLogoClearPending(false);
      } else {
        setIconDraft(draft);
        setIconClearPending(false);
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not validate that image.");
    }
  }

  function handleAssetClear(kind: BrandAssetKind) {
    setPageError(null);
    if (kind === "logo") {
      setLogoDraft(null);
      setLogoClearPending(true);
    } else {
      setIconDraft(null);
      setIconClearPending(true);
    }
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError(null);
    setPageSuccess(null);

    try {
      if (logoDraft || iconDraft) {
        setUploadBusy(true);
        await runReauthableAction("upload-brand-assets", async () => {
          const body = new FormData();
          if (logoDraft) body.set("logo", logoDraft.file);
          if (iconDraft) body.set("icon", iconDraft.file);
          const { response, payload } = await requestJson("/v1/org/brand-assets", { method: "POST", body }, 30000);
          if (!response.ok) throw getRequestError(payload, response, `Could not upload brand images (${response.status}).`);
        });
      }

      await updateOrganizationSettings({
        brandAppName: appNameDraft.trim() || null,
        brandAccentColor: accentColorDraft || null,
        ...(logoClearPending ? { brandLogoUrl: null } : {}),
        ...(iconClearPending ? { brandIconUrl: null } : {}),
      });
      setPageSuccess("Brand appearance updated.");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not update brand appearance.");
    } finally {
      setUploadBusy(false);
    }
  }

  const saveBusy = uploadBusy || mutationBusy === "update-organization-settings";

  return (
    <div data-testid="brand-appearance-screen">
      <DashboardPageTemplate
        icon={Palette}
        title="Brand appearance"
        description="Customize how your workspace appears across OpenWork."
        colors={["#F5F3FF", "#4C1D95", "#8B5CF6", "#DDD6FE"]}
      >
        {!orgContext.entitlements.desktopPolicies ? (
          <EnterprisePlanNotice feature="White-label brand appearance" />
        ) : (
          <form className="grid gap-6" onSubmit={handleSave}>
            {pageError ? <DenNotice message={pageError} /> : null}
            {pageSuccess ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-700">{pageSuccess}</div> : null}

            <DenCard size="spacious" className="grid gap-6">
              <div className="grid gap-2">
                <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-violet-500">Workspace brand</p>
                <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">Desktop identity</h2>
                <p className="text-[14px] text-gray-500">Preview your workspace name, wordmark, app icon, and accent color before saving.</p>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="grid gap-5">
                  <label className="grid gap-3">
                    <span className="text-[14px] font-medium text-gray-700">Application name</span>
                    <DenInput type="text" value={appNameDraft} onChange={(event) => setAppNameDraft(event.target.value)} placeholder="OpenWork" maxLength={64} disabled={!isOwner} />
                    <span className="text-[11px] text-gray-400">The signed application identity stays OpenWork.</span>
                  </label>

                  <label className="grid gap-3">
                    <span className="text-[14px] font-medium text-gray-700">Accent color</span>
                    <select value={accentColorDraft} onChange={(event) => setAccentColorDraft(event.target.value)} disabled={!isOwner} className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-[14px] text-gray-900 outline-none">
                      <option value="">Default (OpenWork)</option>
                      {["blue", "violet", "purple", "indigo", "iris", "crimson", "red", "ruby", "pink", "plum", "orange", "tomato", "gold", "green", "grass", "jade", "teal", "cyan", "sky"].map((color) => (
                        <option key={color} value={color}>{color[0].toUpperCase() + color.slice(1)}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-950 p-5 text-white">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/50">Preview</p>
                  <div className="mt-8 flex items-center gap-3">
                    {iconPreviewUrl ? <img src={iconPreviewUrl} alt="App icon preview" className="size-12 rounded-xl bg-white object-contain" /> : <div className="flex size-12 items-center justify-center rounded-xl bg-white text-[14px] font-semibold text-gray-950">OW</div>}
                    <div className="min-w-0">
                      {logoPreviewUrl ? <img src={logoPreviewUrl} alt="Wordmark preview" className="mb-1 max-h-7 max-w-40 object-contain object-left brightness-0 invert" /> : null}
                      <p className="truncate text-[15px] font-medium">{appNameDraft.trim() || "OpenWork"}</p>
                    </div>
                  </div>
                  <div className="mt-8 h-2 rounded-full bg-white/10"><div className="h-full w-2/3 rounded-full bg-violet-400" data-brand-accent={accentColorDraft || "default"} /></div>
                </div>
              </div>

              <div className="grid min-w-0 gap-5 lg:grid-cols-2">
                <BrandAssetUploadField kind="logo" title="Wordmark" description="Horizontal PNG or JPEG, 128×32 to 4096×4096, under 2 MB." currentUrl={currentLogoUrl} managedAsset={currentLogoAsset} draft={logoDraft} clearPending={logoClearPending} disabled={!isOwner || saveBusy} onSelect={(file) => void handleAssetSelection("logo", file)} onClear={() => handleAssetClear("logo")} />
                <BrandAssetUploadField kind="icon" title="Square app icon" description="Square PNG or JPEG, 64×64 to 4096×4096, under 2 MB." currentUrl={currentIconUrl} managedAsset={currentIconAsset} draft={iconDraft} clearPending={iconClearPending} disabled={!isOwner || saveBusy} onSelect={(file) => void handleAssetSelection("icon", file)} onClear={() => handleAssetClear("icon")} />
              </div>
            </DenCard>

            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-gray-500">{!isOwner ? "Only workspace owners can change brand appearance." : null}</p>
              {isOwner ? <DenButton type="submit" loading={saveBusy}>Save brand appearance</DenButton> : null}
            </div>
          </form>
        )}
      </DashboardPageTemplate>
    </div>
  );
}
