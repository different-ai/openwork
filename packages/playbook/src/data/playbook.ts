export type StoryId = "live-access" | "public-links" | "field-anatomy";

export type ShareField = {
  id: string;
  label: string;
  value: string;
  hint: string;
  secret?: boolean;
};

export const shareFields: ShareField[] = [
  {
    id: "invite-link",
    label: "OpenWork invite link",
    value: "openwork://connect?worker=http%3A%2F%2F10.99.1.89%3A8787%2Fw%2Fws_28030047d3a5&token=ow_owner_5b83ae82f716",
    hint: "One link that prefills the worker URL and owner token for permission prompts.",
    secret: true,
  },
  {
    id: "worker-url",
    label: "OpenWork worker URL",
    value: "http://10.99.1.89:8787/w/ws_28030047d3a5",
    hint: "Use on phones or laptops connecting to this worker.",
  },
  {
    id: "owner-token",
    label: "Owner token",
    value: "ow_owner_5b83ae82f7168be28ef77d01c7d4b965",
    hint: "Use on phones or laptops connecting to this worker.",
    secret: true,
  },
  {
    id: "collaborator-token",
    label: "Collaborator token",
    value: "ow_collab_08fd88ffebfd35e73f37e8bb5418a3c1",
    hint: "Routine remote access when you do not need owner-only actions.",
    secret: true,
  },
];

export const stories: { id: StoryId; label: string; eyebrow: string; description: string }[] = [
  {
    id: "live-access",
    label: "Live access modal",
    eyebrow: "Primary story",
    description: "The main share-worker surface with trust warning, segmented tabs, and secret handling.",
  },
  {
    id: "public-links",
    label: "Public links cards",
    eyebrow: "Secondary states",
    description: "Packaging and publishing cards in the same operational shell language as the app.",
  },
  {
    id: "field-anatomy",
    label: "Field anatomy",
    eyebrow: "Primitive pieces",
    description: "Credential rows, helper text, and action affordances broken out for iteration.",
  },
];

export const playbookNotes = [
  "Uses the app Radix color tokens from `packages/app`.",
  "Keeps the bright, operational shell instead of marketing gradients.",
  "Breaks complex modal behavior into stories and smaller primitives.",
];

export const surfaceRecipe = [
  {
    title: "Shell",
    body: "Rounded paper card with low-contrast border and a wide shadow.",
  },
  {
    title: "Tabs",
    body: "Selected state uses fill + edge definition, never text weight alone.",
  },
  {
    title: "Fields",
    body: "Monospace inputs stay quiet until the action icons invite intent.",
  },
  {
    title: "Safety",
    body: "Warnings use warm amber instead of alarm red for trusted sharing flows.",
  },
];
