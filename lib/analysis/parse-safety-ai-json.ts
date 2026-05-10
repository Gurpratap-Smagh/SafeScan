import { z } from 'zod';

const narrativeFieldsSchema = z.object({
  knownReactions: z.string().optional(),
  potentialHarms: z.union([z.array(z.string()), z.string()]).optional(),
  allergenFlags: z.string().optional(),
  drugFlags: z.string().optional(),
  toxicityFlags: z.string().optional(),
  nutritionalSummary: z.string().optional(),
  nutritionalFlags: z.string().optional(),
  dailyValueWarnings: z.string().optional(),
  conditionFlags: z.string().optional(),
  fdaReactionSummary: z.string().optional(),
});

const outcomeSchema = z.object({
  severityLevel: z.enum(['mild', 'moderate', 'severe', 'critical']),
  isPersonalized: z.boolean(),
});

export const safetyAiOutputSchema = z.object({
  productName: z.string().optional(),
  summary: z.string(),
  aiAnalysisSummary: z.string(),
  scores: z.object({
    overallScore: z.number().min(0).max(100),
    allergenScore: z.number().min(0).max(100),
    toxicityScore: z.number().min(0).max(100),
    recallScore: z.number().min(0).max(100),
    drugInteractionScore: z.number().min(0).max(100),
    adverseEventScore: z.number().min(0).max(100),
    nutritionalScore: z.number().min(0).max(100),
  }),
  narrativeFields: narrativeFieldsSchema.partial().optional(),
  outcome: outcomeSchema.optional(),
});

export type SafetyAiOutput = z.infer<typeof safetyAiOutputSchema>;

export function extractJsonFromMarkdown(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}

export function parseSafetyAiOutput(raw: string): SafetyAiOutput {
  const jsonStr = extractJsonFromMarkdown(raw);
  if (!jsonStr) {
    throw new Error('Could not find JSON in model response');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Invalid JSON in model response');
  }
  return safetyAiOutputSchema.parse(parsed);
}
