/** @jsxImportSource react */
import { File, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileType, FileVideo, Globe, Presentation } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/artifacts";

interface ArtifactIconProps {
  className?: string;
  type: ArtifactType;
}

export function ArtifactIcon({ className, type }: ArtifactIconProps) {
  if (type === "website") {
    return <Globe className={cn("text-sky-9", className)} />;
  }

  if (type === "markdown") {
    return <FileText className={cn("text-blue-9", className)} />;
  }

  if (type === "sheet") {
    return <FileSpreadsheet className={cn("text-green-9", className)} />;
  }

  if (type === "slides") {
    return <Presentation className={cn("text-amber-9", className)} />;
  }

  if (type === "image") {
    return <FileImage className={cn("text-violet-9", className)} />;
  }

  if (type === "video") {
    return <FileVideo className={cn("text-pink-9", className)} />;
  }

  if (type === "audio") {
    return <FileAudio className={cn("text-purple-9", className)} />;
  }

  if (type === "pdf") {
    return <FileText className={cn("text-red-9", className)} />;
  }

  if (type === "html") {
    return <FileCode className={cn("text-orange-9", className)} />;
  }

  if (type === "text") {
    return <FileType className={cn("text-slate-9", className)} />;
  }

  return <File className={cn("text-slate-9", className)} />;
}
