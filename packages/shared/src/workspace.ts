import { z } from "zod";

export const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
});

export type Workspace = { id: string; name: string; createdAt: string };

/** Clerk's built-in organization roles. Members read; admins also change things. */
export const ADMIN_ROLE = "org:admin";
