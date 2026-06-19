/** @jsxImportSource react */
import { File, FileCode, FileImage, FileSpreadsheet, FileText, FileType, Globe, Presentation } from "lucide-react";

import { cn } from "@/lib/utils";
import type { OpenTargetPreview } from "./open-target";

interface ArtifactIconProps {
  type: OpenTargetPreview;
  className?: string;
}

export function ArtifactIcon({ type, className }: ArtifactIconProps) {
  if (type === "browser") {
    return <Globe className={cn("size-3.5 shrink-0 text-sky-9", className)} />;
  }

  if (type === "markdown") {
    return <FileText className={cn("size-3.5 shrink-0 text-blue-9", className)} />;
  }

  if (type === "sheet") {
    return <FileSpreadsheet className={cn("size-3.5 shrink-0 text-green-9", className)} />;
  }

  if (type === "slides") {
    return <Presentation className={cn("size-3.5 shrink-0 text-amber-9", className)} />;
  }

  if (type === "image") {
    return <FileImage className={cn("size-3.5 shrink-0 text-violet-9", className)} />;
  }

  if (type === "pdf") {
    return <FileText className={cn("size-3.5 shrink-0 text-red-9", className)} />;
  }

  if (type === "html") {
    return <FileCode className={cn("size-3.5 shrink-0 text-orange-9", className)} />;
  }

  if (type === "text") {
    return <FileType className={cn("size-3.5 shrink-0 text-slate-9", className)} />;
  }

  return <File className={cn("size-3.5 shrink-0 text-slate-9", className)} />;
}
