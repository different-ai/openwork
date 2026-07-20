import { z } from "zod";

type DesktopPolicyDefinitionEntry = {
  id: string;
  name: string;
  description: string;
  userNotice: string;
  defaultValue: boolean;
};

// Canonical desktop policy catalog.
//
// To add a new desktop policy item:
// 1. Add a matching entry to `desktopPolicyDefinitions` below.
// 2. Choose a safe `defaultValue` for orgs with missing/older policy data.
// 3. Wire desktop app behavior to read the key through the desktop config hooks.
// 4. If the key affects Den web editing copy, update the `name`, `description`,
//    and `userNotice` here rather than duplicating that copy elsewhere.
// 5. Do not manually edit `desktopPolicyValueSchema`; it is generated from the
//    IDs in this definition list.
//
// Policy booleans usually use allow-style names. For every policy item,
// `false` means the feature is restricted/disabled; `true` or an omitted value
// means the app should not block the feature locally unless a default/effective
// policy calculation supplies `false`.
export const desktopPolicyDefinitions = [
  {
    id: "allowCustomProviders",
    name: "Custom providers",
    description:
      "Allow users to add and use models that are not deployed through OpenWork Cloud.",
    userNotice:
      "Your organization administrator has disabled adding custom providers.",
    defaultValue: true,
  },
  {
    id: "allowZenModel",
    name: "Enable OpenCode Zen Models",
    description: "Allow users to use the built in models provided by OpenCode.",
    userNotice: "Your administrator has disabled access to OpenCode Models.",
    defaultValue: true,
  },
  {
    id: "allowMultipleWorkspaces",
    name: "Multiple workspaces",
    description:
      "Allow users to create or configure more than one workspace on their machine.",
    userNotice:
      "Your organization administrator has restricted access to adding additional workspaces.",
    defaultValue: true,
  },
  {
    id: "allowControlSettings",
    name: "Control Settings",
    description: "Allow users to access and change the desktop app settings.",
    userNotice:
      "Your organization administrator has disabled changing desktop app settings.",
    defaultValue: true,
  },
  {
    id: "allowManageExtensions",
    name: "Manage Extensions",
    description: "Allow users to install and manage extensions locally.",
    userNotice:
      "Your organization administrator has disabled local extension management.",
    defaultValue: true,
  },
  {
    id: "allowBuiltInExtensions",
    name: "Built-in Extensions",
    description:
      "Allow users to see and use OpenWork's built-in extensions, including browser, image, and local-provider extensions.",
    userNotice:
      "Your organization administrator has disabled built-in OpenWork extensions.",
    defaultValue: true,
  },
  {
    id: "allowAlphaUpdates",
    name: "Alpha updates",
    description:
      "Allow users to opt into experimental Alpha desktop updates.",
    userNotice:
      "Your organization administrator has disabled Alpha desktop updates.",
    defaultValue: true,
  },
  {
    id: "showWelcomePage",
    name: "Welcome Page",
    description: "Show the Getting Started page to new users.",
    userNotice:
      "Your organization administrator has disabled the Getting Started page.",
    defaultValue: true,
  },
] as const satisfies readonly DesktopPolicyDefinitionEntry[];

export type DesktopPolicyKey = (typeof desktopPolicyDefinitions)[number]["id"];
export type DesktopPolicyDefinition = Omit<DesktopPolicyDefinitionEntry, "id"> & {
  id: DesktopPolicyKey;
};

const desktopPolicyValueShape = Object.fromEntries(
  desktopPolicyDefinitions.map((definition) => [
    definition.id,
    z.boolean().optional(),
  ]),
) as { [key in DesktopPolicyKey]: z.ZodOptional<z.ZodBoolean> };

export const desktopPolicyValueSchema = z
  .object(desktopPolicyValueShape)
  .meta({ ref: "DenDesktopPolicyValue" });

export type DesktopPolicyValue = z.infer<typeof desktopPolicyValueSchema>;

export const onboardingPromptsSchema = z
  .array(z.string().trim().min(1).max(500))
  .min(2)
  .max(3);

export const onboardingPromptDescriptionsSchema = z
  .array(z.string().trim().max(120))
  .min(2)
  .max(3);

export type OnboardingPromptConfig = {
  onboardingPrompts: string[];
  onboardingPromptDescriptions?: string[];
};

export const desktopPolicyDocumentSchema = desktopPolicyValueSchema
  .extend({
    onboardingPrompts: onboardingPromptsSchema.optional(),
    onboardingPromptDescriptions: onboardingPromptDescriptionsSchema.optional(),
  })
  .meta({ ref: "DenDesktopPolicyDocument" });

export const desktopPolicyDocumentWriteSchema = desktopPolicyValueSchema
  .extend({
    onboardingPrompts: onboardingPromptsSchema.nullable().optional(),
    onboardingPromptDescriptions: onboardingPromptDescriptionsSchema
      .nullable()
      .optional(),
  })
  .meta({ ref: "DenDesktopPolicyDocumentWrite" });

export type DesktopPolicyDocument = z.infer<typeof desktopPolicyDocumentSchema>;
export type DesktopPolicyDocumentWrite = z.infer<
  typeof desktopPolicyDocumentWriteSchema
>;
export type DefaultDesktopPolicyDocument = Required<DesktopPolicyValue> & {
  onboardingPrompts?: string[];
  onboardingPromptDescriptions?: string[];
};

export const desktopPolicyKeys = desktopPolicyDefinitions.map(
  (definition) => definition.id,
) as DesktopPolicyKey[];

export const desktopPolicyDefaults = Object.fromEntries(
  desktopPolicyDefinitions.map((definition) => [
    definition.id,
    definition.defaultValue,
  ]),
) as Required<DesktopPolicyValue>;

// ---------------------------------------------------------------------------
// Radix color families that can be used as a brand accent.
// ---------------------------------------------------------------------------
export const brandAccentColorValues = [
  "blue",
  "crimson",
  "cyan",
  "gold",
  "grass",
  "green",
  "indigo",
  "iris",
  "jade",
  "lime",
  "mint",
  "orange",
  "pink",
  "plum",
  "purple",
  "red",
  "ruby",
  "sky",
  "teal",
  "tomato",
  "violet",
  "yellow",
] as const;

export type BrandAccentColor = (typeof brandAccentColorValues)[number];

export const desktopConfigSchema = desktopPolicyValueSchema
  .extend({
    allowedDesktopVersions: z
      .array(z.string().trim().min(1).max(32))
      .optional(),
    brandAppName: z.string().trim().min(1).max(64).optional(),
    brandLogoUrl: z.string().url().max(2048).optional(),
    brandIconUrl: z.string().url().max(2048).optional(),
    brandAccentColor: z.enum(brandAccentColorValues).optional(),
    connectEnabled: z.boolean().optional(),
    onboardingPrompts: onboardingPromptsSchema.optional(),
    onboardingPromptDescriptions: onboardingPromptDescriptionsSchema.optional(),
  })
  .meta({ ref: "DenDesktopConfig" });

export type DesktopConfig = z.infer<typeof desktopConfigSchema>;

function normalizeDesktopVersionString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    normalized,
  )
    ? normalized
    : null;
}

function normalizeAllowedDesktopVersions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return [
    ...new Set(
      value
        .map((entry) => normalizeDesktopVersionString(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeOnboardingPrompts(value: unknown): string[] | undefined {
  const parsed = onboardingPromptsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeOnboardingPromptDescriptions(
  value: unknown,
  promptCount?: number,
): string[] | undefined {
  const parsed = onboardingPromptDescriptionsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (promptCount !== undefined && parsed.data.length !== promptCount) {
    return undefined;
  }
  return parsed.data.some((description) => description.length > 0)
    ? parsed.data
    : undefined;
}

export function normalizeOnboardingPromptConfig(
  value: unknown,
): OnboardingPromptConfig | undefined {
  const raw = isRecord(value) ? value : null;
  const onboardingPrompts = normalizeOnboardingPrompts(raw?.onboardingPrompts);
  if (onboardingPrompts === undefined) return undefined;

  const onboardingPromptDescriptions = normalizeOnboardingPromptDescriptions(
    raw?.onboardingPromptDescriptions,
    onboardingPrompts.length,
  );

  return {
    onboardingPrompts,
    ...(onboardingPromptDescriptions !== undefined
      ? { onboardingPromptDescriptions }
      : {}),
  };
}

export function normalizeDesktopPolicyValue(
  value: unknown,
): DesktopPolicyValue {
  const parsed = desktopPolicyValueSchema.safeParse(value);
  if (parsed.success) {
    return Object.fromEntries(
      desktopPolicyKeys.flatMap((key) =>
        typeof parsed.data[key] === "boolean"
          ? [[key, parsed.data[key]] as const]
          : [],
      ),
    ) as DesktopPolicyValue;
  }

  return {};
}

export function normalizeDefaultDesktopPolicyValue(
  value: unknown,
): Required<DesktopPolicyValue> {
  const normalized = normalizeDesktopPolicyValue(value);
  return Object.fromEntries(
    desktopPolicyDefinitions.map((definition) => [
      definition.id,
      normalized[definition.id] ?? definition.defaultValue,
    ]),
  ) as Required<DesktopPolicyValue>;
}

export function normalizeDesktopPolicyDocument(
  value: unknown,
): DesktopPolicyDocument {
  const policy = normalizeDesktopPolicyValue(value);
  const onboardingPromptConfig = normalizeOnboardingPromptConfig(value);

  return {
    ...policy,
    ...(onboardingPromptConfig !== undefined ? onboardingPromptConfig : {}),
  };
}

export function normalizeDesktopPolicyDocumentWrite(
  value: unknown,
): DesktopPolicyDocumentWrite {
  const policy = normalizeDesktopPolicyValue(value);
  const raw = isRecord(value) ? value : null;
  const rawPrompts = raw?.onboardingPrompts;
  const rawDescriptions = raw?.onboardingPromptDescriptions;
  const onboardingPrompts = normalizeOnboardingPrompts(rawPrompts);
  const onboardingPromptDescriptions = normalizeOnboardingPromptDescriptions(
    rawDescriptions,
    onboardingPrompts?.length,
  );

  return {
    ...policy,
    ...(rawPrompts === null
      ? { onboardingPrompts: null, onboardingPromptDescriptions: null }
      : onboardingPrompts !== undefined
        ? { onboardingPrompts }
        : {}),
    ...(rawPrompts !== null && rawDescriptions === null
      ? { onboardingPromptDescriptions: null }
      : onboardingPromptDescriptions !== undefined
        ? { onboardingPromptDescriptions }
        : {}),
  };
}

export function resolveDesktopPolicyDocumentWrite(input: {
  value: unknown;
  existingPolicy?: unknown;
  isDefault?: boolean;
  preserveExistingOnboardingPrompts?: boolean;
}): DesktopPolicyDocument {
  const write = normalizeDesktopPolicyDocumentWrite(input.value);
  const policy = input.isDefault === true
    ? normalizeDefaultDesktopPolicyValue(write)
    : normalizeDesktopPolicyValue(write);
  const existingDocument = input.preserveExistingOnboardingPrompts === true
    ? normalizeDesktopPolicyDocument(input.existingPolicy ?? {})
    : undefined;
  const onboardingPrompts = Array.isArray(write.onboardingPrompts)
    ? write.onboardingPrompts
    : write.onboardingPrompts === undefined &&
        input.preserveExistingOnboardingPrompts === true
      ? existingDocument?.onboardingPrompts
      : undefined;
  const onboardingPromptDescriptions = onboardingPrompts === undefined
    ? undefined
    : Array.isArray(write.onboardingPromptDescriptions)
      ? normalizeOnboardingPromptDescriptions(
          write.onboardingPromptDescriptions,
          onboardingPrompts.length,
        )
      : write.onboardingPromptDescriptions === undefined &&
          write.onboardingPrompts === undefined &&
          input.preserveExistingOnboardingPrompts === true
        ? normalizeOnboardingPromptDescriptions(
            existingDocument?.onboardingPromptDescriptions,
            onboardingPrompts.length,
          )
        : undefined;

  return {
    ...policy,
    ...(onboardingPrompts !== undefined ? { onboardingPrompts } : {}),
    ...(onboardingPromptDescriptions !== undefined
      ? { onboardingPromptDescriptions }
      : {}),
  };
}

export function normalizeDefaultDesktopPolicyDocument(
  value: unknown,
): DefaultDesktopPolicyDocument {
  const policy = normalizeDefaultDesktopPolicyValue(value);
  const onboardingPromptConfig = normalizeOnboardingPromptConfig(value);

  return {
    ...policy,
    ...(onboardingPromptConfig !== undefined ? onboardingPromptConfig : {}),
  };
}

export function allDesktopPolicies(
  value: boolean,
): Required<DesktopPolicyValue> {
  return Object.fromEntries(
    desktopPolicyDefinitions.map((definition) => [definition.id, value]),
  ) as Required<DesktopPolicyValue>;
}

export function calculateEffectiveDesktopPolicy(input: {
  orgPolicyCount: number;
  defaultPolicy?: DesktopPolicyValue | null;
  assignedPolicies: DesktopPolicyValue[];
}): Required<DesktopPolicyValue> {
  if (input.orgPolicyCount === 0) {
    return allDesktopPolicies(true);
  }

  const calculated = allDesktopPolicies(false);
  const policies = [
    normalizeDefaultDesktopPolicyValue(input.defaultPolicy ?? {}),
    ...input.assignedPolicies.map((policy) =>
      normalizeDesktopPolicyValue(policy),
    ),
  ];

  for (const policy of policies) {
    for (const key of desktopPolicyKeys) {
      if (policy[key] === true) {
        calculated[key] = true;
      }
    }
  }

  return calculated;
}

export type DesktopPolicyPromptCandidate = {
  id: string;
  priority: number;
  createdAt: Date | string | number | null;
  policy: unknown;
};

function getCreatedAtTime(value: Date | string | number | null) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function comparePromptCandidates(
  left: DesktopPolicyPromptCandidate,
  right: DesktopPolicyPromptCandidate,
) {
  if (left.priority !== right.priority) return right.priority - left.priority;

  const leftCreatedAt = getCreatedAtTime(left.createdAt);
  const rightCreatedAt = getCreatedAtTime(right.createdAt);
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;

  return left.id.localeCompare(right.id);
}

export function selectEffectiveOnboardingPrompts(input: {
  defaultPolicy?: unknown;
  assignedPolicies: DesktopPolicyPromptCandidate[];
}): string[] | undefined {
  return selectEffectiveOnboardingPromptConfig(input)?.onboardingPrompts;
}

export function selectEffectiveOnboardingPromptConfig(input: {
  defaultPolicy?: unknown;
  assignedPolicies: DesktopPolicyPromptCandidate[];
}): OnboardingPromptConfig | undefined {
  const candidatesById = new Map<string, DesktopPolicyPromptCandidate>();
  for (const candidate of input.assignedPolicies) {
    if (!candidatesById.has(candidate.id)) {
      candidatesById.set(candidate.id, candidate);
    }
  }

  const targetedCandidates = [...candidatesById.values()]
    .filter(
      (candidate) =>
        normalizeOnboardingPromptConfig(candidate.policy) !== undefined,
    )
    .sort(comparePromptCandidates);
  const targetedConfig = targetedCandidates[0]
    ? normalizeOnboardingPromptConfig(targetedCandidates[0].policy)
    : undefined;

  return (
    targetedConfig ??
    normalizeOnboardingPromptConfig(input.defaultPolicy ?? {})
  );
}

function normalizeBrandUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    new URL(trimmed);
    return trimmed.slice(0, 2048);
  } catch {
    return undefined;
  }
}

function normalizeBrandAppName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 64) : undefined;
}

function normalizeBrandAccentColor(value: unknown): BrandAccentColor | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return brandAccentColorValues.find((color) => color === trimmed);
}

export function normalizeDesktopConfig(value: unknown): DesktopConfig {
  const policy = normalizeDesktopPolicyValue(value);
  const raw = isRecord(value) ? value : null;
  const allowedDesktopVersions = normalizeAllowedDesktopVersions(
    raw?.allowedDesktopVersions,
  );
  const brandAppName = normalizeBrandAppName(raw?.brandAppName);
  const brandLogoUrl = normalizeBrandUrl(raw?.brandLogoUrl);
  const brandIconUrl = normalizeBrandUrl(raw?.brandIconUrl);
  const brandAccentColor = normalizeBrandAccentColor(raw?.brandAccentColor);
  const connectEnabled =
    typeof raw?.connectEnabled === "boolean" ? raw.connectEnabled : undefined;
  const onboardingPromptConfig = normalizeOnboardingPromptConfig(raw);

  return {
    ...policy,
    ...(allowedDesktopVersions !== undefined ? { allowedDesktopVersions } : {}),
    ...(brandAppName !== undefined ? { brandAppName } : {}),
    ...(brandLogoUrl !== undefined ? { brandLogoUrl } : {}),
    ...(brandIconUrl !== undefined ? { brandIconUrl } : {}),
    ...(brandAccentColor !== undefined ? { brandAccentColor } : {}),
    ...(connectEnabled !== undefined ? { connectEnabled } : {}),
    ...(onboardingPromptConfig !== undefined ? onboardingPromptConfig : {}),
  };
}
