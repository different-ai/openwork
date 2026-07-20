function normalizedVersion(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function displayVersion(value: string) {
  return /^[a-f0-9]{7,64}$/i.test(value)
    ? `commit ${value.slice(0, 7).toLowerCase()}`
    : value
}

export function resolveDenServiceVersion(input: {
  configuredVersion?: string
  renderGitCommit?: string
}) {
  const configuredVersion = normalizedVersion(input.configuredVersion)
  if (configuredVersion && configuredVersion.toLowerCase() !== "dev") {
    return displayVersion(configuredVersion)
  }

  const renderGitCommit = normalizedVersion(input.renderGitCommit)
  if (renderGitCommit) {
    return displayVersion(renderGitCommit)
  }

  return "dev"
}
