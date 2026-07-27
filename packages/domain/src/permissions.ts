import { z } from "zod";

export const permissionProfileSchema = z.enum([
  "read_only", "ask_before_changes", "auto_edit", "autonomous",
]);
export type PermissionProfile = z.infer<typeof permissionProfileSchema>;

export const permissionDecisionSchema = z.enum([
  "allow_once", "allow_session", "deny",
]);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

export const permissionRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  kind: z.enum(["file_write", "shell", "network", "external_directory", "destructive"]),
  title: z.string().min(1),
  detail: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  command: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
});
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
