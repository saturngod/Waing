import { z } from "zod";

/**
 * One entry of a workspace file index, as offered to the `@` mention picker. `path` is always relative to the
 * project root and uses POSIX separators so the same string can be pasted into a prompt on any platform.
 */
export const workspaceFileSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["file", "directory"]),
}).strict();
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

/** `truncated` tells the UI the index hit its entry cap, so an absent match may still exist on disk. */
export const workspaceFileMatchesSchema = z.object({
  matches: z.array(workspaceFileSchema),
  truncated: z.boolean(),
}).strict();
export type WorkspaceFileMatches = z.infer<typeof workspaceFileMatchesSchema>;
