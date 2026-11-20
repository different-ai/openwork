/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { extractOfficeText, OfficeSizeLimitError, type OfficeOutline } from "@openwork/workbook";

import { t } from "@/i18n";

import { OfficePreviewLoading, PreviewError } from "./preview";

type OfficeFormat = OfficeOutline["kind"];

const bufferIds = new WeakMap<ArrayBuffer, number>();
let nextBufferId = 0;
function bufferId(bytes: ArrayBuffer): number {
  const existing = bufferIds.get(bytes);
  if (existing !== undefined) return existing;
  const id = nextBufferId++;
  bufferIds.set(bytes, id);
  return id;
}

export function ArtifactOfficePreview({ format, bytes }: { format: OfficeFormat; bytes: ArrayBuffer }) {
  const { data: result, error, isPending } = useQuery({
    queryKey: ["artifact-office-outline", format, bufferId(bytes)],
    queryFn: () => extractOfficeText(format, new Uint8Array(bytes), { format: "outline" }),
    networkMode: "always",
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  if (isPending) return <OfficePreviewLoading />;
  if (error || !result) return <PreviewError message={t(error instanceof OfficeSizeLimitError ? "artifact.office_too_large" : "artifact.office_unreadable")} role="status" />;

  return (
    <div className="h-full space-y-3 overflow-auto p-4 text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
      <p className="text-muted-foreground">{t("artifact.office_text_only")}</p>
      {result.truncated ? <p className="text-muted-foreground" role="status">{t("artifact.office_truncated")}</p> : null}
      {result.kind === "pptx" && result.slides.length > 0 ? (
        <ol role="list" className="space-y-3">
          {result.slides.map(({ title, bullets }, index) => (
            <li key={index} className="space-y-1 rounded-lg border border-border p-3">
              <p className="text-xs font-medium tabular-nums text-muted-foreground">{t("artifact.office_slide", { number: index + 1 })}</p>
              {title ? <h4 className="whitespace-pre-line font-semibold">{title}</h4> : null}
              {bullets.length > 0 ? (
                <ul className="list-disc space-y-1 ps-4">
                  {bullets.map((bullet, lineIndex) => <li key={lineIndex} className="whitespace-pre-wrap">{bullet}</li>)}
                </ul>
              ) : !title ? <p className="text-muted-foreground">{t("artifact.office_empty_slide")}</p> : null}
            </li>
          ))}
        </ol>
      ) : result.kind === "docx" && result.paragraphs.length > 0 ? (
        <div className="space-y-2 whitespace-pre-wrap">
          {result.paragraphs.map(({ text, heading }, index) => heading
            ? <h4 key={index} className="font-semibold">{text}</h4>
            : <p key={index}>{text}</p>)}
        </div>
      ) : <p className="text-muted-foreground">{t("artifact.office_empty")}</p>}
    </div>
  );
}
