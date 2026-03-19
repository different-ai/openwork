import { normalizeLocalFilePath as normalizeLocalFilePathImpl } from "./local-file-path.impl.js";

export const normalizeLocalFilePath = (value: string): string =>
  normalizeLocalFilePathImpl(value) as string;
