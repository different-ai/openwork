/**
 * Type declarations for local-file-path.impl.js
 */

/**
 * Normalizes a local file path or file URI to a standard filesystem path.
 *
 * @param value - The file path or file URI to normalize
 * @returns The normalized filesystem path
 *
 * @example
 * normalizeLocalFilePath("file:///Users/test/file.txt") // Returns "/Users/test/file.txt"
 * normalizeLocalFilePath("/Users/test/file.txt") // Returns "/Users/test/file.txt"
 */
export function normalizeLocalFilePath(value: string): string;
