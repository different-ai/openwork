"use client";

import type { ExternalMcpAuthType, ExternalMcpCredentialMode } from "./mcp-connections-data";

/**
 * Form controls shared by every surface that configures an MCP connection:
 * the Connectors page and the plugin editor. One set of options and copy
 * keeps a plugin-declared server from asking different authentication
 * questions than a connector added directly.
 */

export const MCP_OAUTH_REDIRECT_DOCS_URL = "https://openworklabs.com/docs/cloud/share-with-your-team/shared-mcp-connections#oauth-redirect-url";

export type SegmentedControlOption<TValue extends string> = {
  value: TValue;
  label: string;
};

export function SegmentedControl<TValue extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: SegmentedControlOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
  disabled?: boolean;
}) {
  const gridColumns = options.length === 2 ? "grid-cols-2" : "grid-cols-3";

  return (
    <div className={`grid ${gridColumns} gap-1 rounded-full border border-gray-200 bg-gray-50 p-1`} role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
            value === option.value
              ? "bg-white text-gray-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]"
              : "text-gray-500 hover:text-gray-900"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const AUTH_TYPE_OPTIONS: SegmentedControlOption<ExternalMcpAuthType>[] = [
  { value: "oauth", label: "OAuth" },
  { value: "apikey", label: "API key" },
  { value: "none", label: "None" },
];

export const CREDENTIAL_MODE_OPTIONS: SegmentedControlOption<ExternalMcpCredentialMode>[] = [
  { value: "per_member", label: "Individual accounts" },
  { value: "shared", label: "One org account" },
];

export function credentialModeDescription(credentialMode: ExternalMcpCredentialMode): string {
  return credentialMode === "per_member"
    ? "Each person signs in with their own account from Your Connections. Their AI acts as them, with their permissions."
    : "You sign in once with a single account — everyone granted access acts as it. Good for bot or service accounts.";
}
