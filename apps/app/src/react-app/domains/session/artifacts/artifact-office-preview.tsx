/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { extractOfficeText, OfficeSizeLimitError, type OfficeOutline } from "@openwork/workbook";

import { t } from "@/i18n";

import { OfficePreviewLoading, PreviewError } from "./preview";

type OfficeFormat = OfficeOutline["kind"];
type Result = OfficeOutline | "too-large" | "unreadable";

export function ArtifactOfficePreview({ format, bytes }: { format: OfficeFormat; bytes: ArrayBuffer }) {
  const [loaded, setLoaded] = useState<{ format: OfficeFormat; bytes: ArrayBuffer; result: Result } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const finish = (result: Result) => {
      if (!cancelled) setLoaded({ format, bytes, result });
    };
    void extractOfficeText(format, new Uint8Array(bytes), { format: "outline" }).then(
      finish,
      (error: unknown) => finish(error instanceof OfficeSizeLimitError ? "too-large" : "unreadable"),
    );
    return () => { cancelled = true; };
  }, [format, bytes]);

  const result = loaded?.bytes === bytes && loaded.format === format ? loaded.result : null;
  if (!result) return <OfficePreviewLoading />;
  if (result === "too-large") return <PreviewError message={t("artifact.office_too_large")} role="status" />;
  if (result === "unreadable") return <PreviewError message={t("artifact.office_unreadable")} role="status" />;

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
