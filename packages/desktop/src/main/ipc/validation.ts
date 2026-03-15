import path from "node:path";

type StringValidationOptions = {
  label: string;
};

type PathValidationOptions = StringValidationOptions & {
  allowRelative?: boolean;
};

type UrlValidationOptions = StringValidationOptions & {
  protocols?: readonly string[];
};

function requireNonEmptyString(value: string, options: StringValidationOptions) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${options.label} is required`);
  }
  if (trimmed.includes("\0")) {
    throw new Error(`${options.label} must not contain null bytes`);
  }
  return trimmed;
}

export function validatePathInput(value: string, options: PathValidationOptions) {
  const trimmed = requireNonEmptyString(value, options);
  const normalized = path.normalize(trimmed);

  if (!options.allowRelative && !path.isAbsolute(normalized)) {
    throw new Error(`${options.label} must be an absolute path`);
  }

  return normalized;
}

export function validateUrlInput(value: string, options: UrlValidationOptions) {
  const trimmed = requireNonEmptyString(value, options);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${options.label} must be a valid URL`);
  }

  const protocols = options.protocols ?? ["http:", "https:"];
  if (protocols.length > 0 && !protocols.includes(parsed.protocol)) {
    throw new Error(`${options.label} must use one of: ${protocols.join(", ")}`);
  }

  return parsed.toString();
}

export function validateWorkspaceId(value: string) {
  const trimmed = requireNonEmptyString(value, { label: "workspaceId" });
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new Error("workspaceId must contain only letters, numbers, '.', '_', ':', or '-'");
  }
  return trimmed;
}

export function validateServerName(value: string) {
  const trimmed = requireNonEmptyString(value, { label: "serverName" });
  if (trimmed.startsWith("-")) {
    throw new Error("serverName must not start with '-'");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error("serverName must be alphanumeric with '-' or '_'");
  }
  return trimmed;
}

export function validateOptionalPathInput(value: string | null | undefined, options: PathValidationOptions) {
  if (value == null) {
    return null;
  }

  return validatePathInput(value, options);
}

export function validateOptionalUrlInput(value: string | null | undefined, options: UrlValidationOptions) {
  if (value == null) {
    return null;
  }

  return validateUrlInput(value, options);
}
