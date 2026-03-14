import type { PackageStatus, PackageStatusInput } from "./share-home-types";

export function getPreviewFilename(input: {
  selectedEntryCount: number;
  selectedEntryName?: string | null;
  hasPastedContent: boolean;
}): string {
  const { selectedEntryCount, selectedEntryName, hasPastedContent } = input;

  if (selectedEntryCount === 1 && selectedEntryName) return selectedEntryName;
  if (selectedEntryCount > 1) return `${selectedEntryCount} files`;
  if (hasPastedContent) return "clipboard.md";
  return "SKILL.md";
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
      label: "Upload one SKILL.md file or paste a skill below.",
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
    severity: "success",
    label: "Ready to share this skill.",
    items: [],
  };
}
