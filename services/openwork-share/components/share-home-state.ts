import type { PackageStatus, PackageStatusInput } from "./share-home-types";

export function getPreviewFilename(input: {
  selectedEntryCount: number;
  selectedEntryName?: string | null;
  hasPastedContent: boolean;
  manualName?: string | null;
}): string {
  const { selectedEntryCount, selectedEntryName, hasPastedContent, manualName } = input;

  if (manualName && manualName.trim()) return manualName.trim();
  if (selectedEntryCount === 1 && selectedEntryName) return selectedEntryName;
  if (selectedEntryCount > 1) return `${selectedEntryCount} files`;
  if (hasPastedContent) return "skill.md";
  return "skill.md";
}

export function getPackageStatus({ errorMessage, warnings, effectiveEntryCount }: PackageStatusInput): PackageStatus {
  if (errorMessage) {
    return {
      severity: "warn",
      label: errorMessage,
      items: [],
    };
  }

  if (!effectiveEntryCount) {
    return {
      severity: "neutral",
      label: "Upload a file or paste skill content below.",
      items: [],
    };
  }

  if (warnings.length) {
    return {
      severity: "info",
      label: "Review the notes before sharing.",
      items: warnings,
    };
  }

  return {
    severity: "neutral",
    label: "",
    items: [],
  };
}
