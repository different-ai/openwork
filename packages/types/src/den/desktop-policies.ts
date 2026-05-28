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

export const desktopPolicyKeys = desktopPolicyDefinitions.map(
  (definition) => definition.id,
) as DesktopPolicyKey[];

export const desktopPolicyDefaults = Object.fromEntries(
  desktopPolicyDefinitions.map((definition) => [
    definition.id,
    definition.defaultValue,
  ]),
) as Required<DesktopPolicyValue>;

export const desktopConfigSchema = desktopPolicyValueSchema
  .extend({
    allowedDesktopVersions: z
      .array(z.string().trim().min(1).max(32))
      .optional(),
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

export function normalizeDesktopConfig(value: unknown): DesktopConfig {
  const policy = normalizeDesktopPolicyValue(value);
  const allowedDesktopVersions = normalizeAllowedDesktopVersions(
    (value as { allowedDesktopVersions?: unknown } | null)
      ?.allowedDesktopVersions,
  );

  return {
    ...policy,
    ...(allowedDesktopVersions !== undefined ? { allowedDesktopVersions } : {}),
  };
}
