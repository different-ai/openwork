"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";

export type CatalogIdentityTileSize = "sm" | "lg";

const tileSizeClasses: Record<CatalogIdentityTileSize, string> = {
  sm: "h-10 w-10 rounded-[11px] text-[15px]",
  lg: "h-12 w-12 rounded-[13px] text-[17px]",
};

const glyphSizeClasses: Record<CatalogIdentityTileSize, string> = {
  sm: "h-5 w-5",
  lg: "h-6 w-6",
};

/** First alphanumeric character, for catalogue entries with no logo. */
export function getCatalogMonogram(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "?").toUpperCase();
}

export type CatalogIdentityTileProps = {
  name: string;
  /** Real logo when the API has one. Marketplaces do; plugins do not. */
  logoUrl?: string | null;
  /** Marks an entry that ships with OpenWork rather than being added. */
  builtIn?: boolean;
  /** Glyph for built-in entries, which have no logo and no useful monogram. */
  builtInIcon?: LucideIcon;
  size?: CatalogIdentityTileSize;
};

/**
 * CatalogIdentityTile
 *
 * Identity for a marketplace or plugin: its logo when one exists, otherwise a
 * monogram on neutral grey. Same geometry as the icon tiles used elsewhere in
 * Den, so a catalogue entry looks like itself on every screen it appears on.
 */
export function CatalogIdentityTile({
  name,
  logoUrl,
  builtIn = false,
  builtInIcon: BuiltInIcon,
  size = "sm",
}: CatalogIdentityTileProps) {
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);
  const base = `flex shrink-0 items-center justify-center overflow-hidden ${tileSizeClasses[size]}`;

  if (logoUrl && erroredUrl !== logoUrl) {
    return (
      <span data-testid="catalog-identity-tile" className={`${base} border border-gray-100 bg-white`}>
        <img
          src={logoUrl}
          alt={`${name} logo`}
          onError={() => setErroredUrl(logoUrl)}
          className="h-full w-full object-contain p-1"
        />
      </span>
    );
  }

  if (builtIn && BuiltInIcon) {
    return (
      <span data-testid="catalog-identity-tile" className={`${base} bg-gray-900 text-white`}>
        <BuiltInIcon className={glyphSizeClasses[size]} aria-hidden />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      data-testid="catalog-identity-tile"
      className={`${base} bg-gray-100 font-semibold text-gray-500`}
    >
      {getCatalogMonogram(name)}
    </span>
  );
}
