function isPathKey(key) {
  return key.toUpperCase() === "PATH";
}

/** @param {NodeJS.ProcessEnv} env @param {NodeJS.Platform} platform */
function normalizePathEnv(env, platform) {
  if (platform !== "win32") return env;
  const normalized = { ...env };
  // Node passes only the first lexicographically sorted alias to Windows children.
  const aliases = Object.keys(env).filter(isPathKey).sort();
  for (const key of aliases) delete normalized[key];
  if (aliases.length > 0) normalized.PATH = env[aliases[0]];
  return normalized;
}

/** @param {NodeJS.Platform} platform @param {...NodeJS.ProcessEnv} layers */
export function mergeRuntimeEnv(platform, ...layers) {
  // Normalize each layer before merging so a saved alias cannot defeat an
  // inherited PATH (or an explicit caller override) at child-process launch.
  return Object.assign({}, ...layers.map(layer => normalizePathEnv(layer, platform)));
}

export function reconcileInjectedUserEnv({
  processEnv,
  inheritedEnv,
  userEnv,
  previouslyInjectedKeys = new Set(),
  platform = process.platform,
}) {
  userEnv = normalizePathEnv(userEnv, platform);
  inheritedEnv = normalizePathEnv(inheritedEnv, platform);
  previouslyInjectedKeys = new Set(
    [...previouslyInjectedKeys].map(key => platform === "win32" && isPathKey(key) ? "PATH" : key),
  );
  const clearPathAliases = (key) => {
    if (platform !== "win32" || key !== "PATH") return;
    for (const alias of Object.keys(processEnv).filter(isPathKey)) delete processEnv[alias];
  };

  for (const key of previouslyInjectedKeys) {
    const inheritedPath = platform === "win32" && key === "PATH"
      && Object.prototype.hasOwnProperty.call(inheritedEnv, key);
    if (Object.prototype.hasOwnProperty.call(userEnv, key) && !inheritedPath) continue;
    clearPathAliases(key);
    if (Object.prototype.hasOwnProperty.call(inheritedEnv, key)) {
      processEnv[key] = inheritedEnv[key];
    } else {
      delete processEnv[key];
    }
  }

  for (const [key, value] of Object.entries(userEnv)) {
    if (Object.prototype.hasOwnProperty.call(inheritedEnv, key)) continue;
    clearPathAliases(key);
    processEnv[key] = value;
  }

  return new Set(
    Object.keys(userEnv).filter(
      (key) => !Object.prototype.hasOwnProperty.call(inheritedEnv, key),
    ),
  );
}
