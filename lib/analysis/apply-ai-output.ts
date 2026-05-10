import type { Prisma } from '@prisma/client';
import type { SafetyAiOutput } from '@/lib/analysis/parse-safety-ai-json';
import { verdictFromScore } from '@/app/api/_lib/score';

function toPotentialHarmsJson(
  value: string | string[] | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value as Prisma.InputJsonValue;
  if (typeof value === 'string' && value.trim()) {
    return { summary: value } as Prisma.InputJsonValue;
  }
  return undefined;
}

export function buildSafetyReportUpdateFromAi(
  parsed: SafetyAiOutput,
): Prisma.SafetyReportUpdateInput {
  const { scores, summary, aiAnalysisSummary } = parsed;
  const n = parsed.narrativeFields ?? {};
  const outcome = parsed.outcome;

  const verdict = verdictFromScore(scores.overallScore);

  const potentialHarms = toPotentialHarmsJson(n.potentialHarms);

  // Fall back to summary if aiAnalysisSummary is empty so the UI panel always renders
  const finalAnalysisSummary = (aiAnalysisSummary && aiAnalysisSummary.trim())
    ? aiAnalysisSummary
    : summary;

  return {
    overallScore: scores.overallScore,
    score: scores.overallScore,
    verdict: verdict ?? undefined,
    allergenScore: scores.allergenScore,
    toxicityScore: scores.toxicityScore,
    recallScore: scores.recallScore,
    drugInteractionScore: scores.drugInteractionScore,
    adverseEventScore: scores.adverseEventScore,
    nutritionalScore: scores.nutritionalScore,
    summary,
    aiAnalysisSummary: finalAnalysisSummary,
    knownReactions: n.knownReactions ?? undefined,
    ...(potentialHarms !== undefined ? { potentialHarms } : {}),
    allergenFlags: n.allergenFlags ?? undefined,
    drugFlags: n.drugFlags ?? undefined,
    toxicityFlags: n.toxicityFlags ?? undefined,
    nutritionalSummary: n.nutritionalSummary ?? undefined,
    nutritionalFlags: n.nutritionalFlags ?? undefined,
    dailyValueWarnings: n.dailyValueWarnings ?? undefined,
    conditionFlags: n.conditionFlags ?? undefined,
    fdaReactionSummary: n.fdaReactionSummary ?? undefined,
    severityLevel: outcome?.severityLevel ?? undefined,
    isPersonalized: outcome?.isPersonalized ?? true,
  };
}
