import { CLOUD_CODING_MAX_CHANGED_FILES, CLOUD_CODING_MAX_FILE_BYTES, CLOUD_CODING_MAX_TOTAL_BYTES, type CloudCodingChangeSet } from "@openwork/types/den/cloud-coding"
import { assertBranchName, assertRepositoryPath, CloudCodingChangeRefusal, gitBlobSha, type PlannedFile } from "./git-objects.js"

export function planChangeSet(changeSet: CloudCodingChangeSet): { files: PlannedFile[]; contents: Map<string, Uint8Array> } {
  assertBranchName(changeSet.branch)
  if (Buffer.from(changeSet.branch).toString() !== changeSet.branch) throw new CloudCodingChangeRefusal("invalid_branch", "Choose a valid name for a new branch.")
  const tooLarge = () => new CloudCodingChangeRefusal("change_too_large", "This change is too large to push at once. Split it into smaller changes.")
  if (changeSet.files.length > CLOUD_CODING_MAX_CHANGED_FILES) throw tooLarge()
  const paths = new Set<string>()
  const files: PlannedFile[] = []
  const contents = new Map<string, Uint8Array>()
  let total = 0
  for (const file of changeSet.files) {
    assertRepositoryPath(file.path)
    if (Buffer.from(file.path).toString() !== file.path) throw new CloudCodingChangeRefusal("path_refused", "A changed file has an invalid path.")
    if (paths.has(file.path)) throw new CloudCodingChangeRefusal("path_refused", "A file is listed more than once in this change.")
    paths.add(file.path)
    if ("deleted" in file) {
      files.push(file)
      continue
    }
    if (file.contentBase64.length > Math.ceil(CLOUD_CODING_MAX_FILE_BYTES / 3) * 4) throw tooLarge()
    const bytes = Buffer.from(file.contentBase64, "base64")
    if (bytes.toString("base64") !== file.contentBase64) {
      throw new CloudCodingChangeRefusal("file_mode_refused", "A file could not be read. Send its contents as standard base64.")
    }
    total += bytes.length
    if (bytes.length > CLOUD_CODING_MAX_FILE_BYTES || total > CLOUD_CODING_MAX_TOTAL_BYTES) throw tooLarge()
    contents.set(file.path, bytes)
    files.push({ path: file.path, mode: file.mode, blobSha: gitBlobSha(bytes) })
  }
  return { files, contents }
}
