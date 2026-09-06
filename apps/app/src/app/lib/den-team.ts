import { z } from "zod";

// Validate the subset of /v1/org that the desktop needs. In particular, do not
// retain invitation tokens in the people view or its query cache.
export const denTeamSchema = z.object({
  organization: z.object({ id: z.string(), name: z.string() }),
  currentMember: z.object({ id: z.string(), role: z.string(), isOwner: z.boolean() }),
  members: z.array(z.object({
    id: z.string(),
    role: z.string(),
    isOwner: z.boolean(),
    joinedAt: z.string().nullable(),
    user: z.object({ name: z.string(), email: z.string() }),
  })),
  invitations: z.array(z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
    expiresAt: z.string().nullable(),
  })),
});

export type DenTeam = z.infer<typeof denTeamSchema>;
