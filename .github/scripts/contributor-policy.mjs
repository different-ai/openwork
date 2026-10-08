// Shared by the trusted fork screen and /test authorization. No PR code runs.
export function isFork(pr) {
  return !pr?.head?.repo || pr.head.repo.full_name !== pr.base?.repo?.full_name || pr.head.repo.fork === true;
}

const REVIEW_MACHINERY = /^(\.github\/|\.opencode\/|opencode\.jsonc?$|warden\.toml$|\.warden\/|\.agents\/skills\/|\.claude\/skills\/)/;

export function machineryFiles(files) {
  return files
    .flatMap((file) => [file.filename, file.previous_filename])
    .filter((name) => typeof name === "string" && REVIEW_MACHINERY.test(name));
}
