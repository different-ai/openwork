import type { Transform } from "node:stream";
export const templateOrigins: Record<string, string>;
export function originReplacements(from?: Record<string, string>, to?: Record<string, string>): [string, string][];
export function replaceOrigins(value: string, pairs: [string, string][]): string;
export function originTransform(pairs: [string, string][]): Transform;
