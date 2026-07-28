import { z } from "zod";

/** One selectable choice. `description` explains the trade-off and is shown under the label. */
export const agentQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});
export type AgentQuestionOption = z.infer<typeof agentQuestionOptionSchema>;

export const agentQuestionItemSchema = z.object({
  question: z.string().min(1),
  /** Short chip label the provider groups the answer under; it is the key the answer is returned with. */
  header: z.string().min(1),
  multiSelect: z.boolean().optional(),
  options: z.array(agentQuestionOptionSchema).min(1),
});
export type AgentQuestionItem = z.infer<typeof agentQuestionItemSchema>;

/**
 * An agent asking the user to choose, as opposed to asking permission to act. Providers block their run
 * until an answer comes back, so an unanswered question stalls the step until its timeout.
 */
export const agentQuestionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  questions: z.array(agentQuestionItemSchema).min(1).max(4),
});
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

/** Answers are keyed by question header; `values` holds chosen labels, or free text the user typed instead. */
export const agentQuestionAnswerSchema = z.object({
  header: z.string().min(1),
  values: z.array(z.string().min(1)).min(1),
});
export type AgentQuestionAnswer = z.infer<typeof agentQuestionAnswerSchema>;

/** An empty answer list is a dismissal: the provider is told the user declined to answer. */
export const agentQuestionResponseSchema = z.array(agentQuestionAnswerSchema);
export type AgentQuestionResponse = z.infer<typeof agentQuestionResponseSchema>;
