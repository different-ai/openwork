export {
  checksumFileContents,
  digest,
  packApp,
  PACK_TOOL_NAME,
  PACK_TOOL_VERSION,
  type PackInput,
  type PackResult,
} from "./pack.js"

export { verifyPackage, type VerifiedPackage, type VerifyOptions, type VerifyResult } from "./verify.js"

export { extractVerifiedFiles, ExtractError, type ExtractOptions } from "./extract.js"

export { collectAppDirectory, CollectError, type CollectResult } from "./collect.js"

export {
  crc32,
  isSafeArchivePath,
  readZip,
  writeZip,
  ZipError,
  type ZipEntry,
  type ZipErrorCode,
  type ZipInputEntry,
  type ZipLimits,
} from "./zip.js"

export { main as runCli } from "./cli.js"
