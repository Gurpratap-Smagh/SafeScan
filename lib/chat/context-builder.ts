import { prisma } from '@/lib/prisma';

/**
 * Loads everything the chatbot needs to ground its reply: user profile,
 * focus reports (full detail), recent reports (compact list), and memories.
 *
 * Tier 1 = focusReports (passed via URL/body).
 * Tier 2 = recentReports auto-injected so the AI can reference any of the
 *          user's last N scans by product name without an extra fetch.
 *
 * All queries scoped by `userId` — defense in depth against IDOR even if
 * the route handler's auth check is bypassed.
 */
export async function buildChatContext(params: {
  userId: number;
  focusReportIds?: number[];
  recentLimit?: number;
  memoryLimit?: number;
}) {
  const { userId } = params;
  const focusReportIds = params.focusReportIds ?? [];
  const recentLimit = params.recentLimit ?? 30;
  const memoryLimit = params.memoryLimit ?? 20;

  const [user, focusReports, recentReports, memories] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      include: { allergies: true, conditions: true, medications: true },
    }),
    focusReportIds.length
      ? prisma.safetyReport.findMany({
          where: { id: { in: focusReportIds }, userId },
          include: { product: true },
          orderBy: { reportDate: 'desc' },
        })
      : Promise.resolve([]),
    prisma.safetyReport.findMany({
      where: { userId, ...(focusReportIds.length ? { id: { notIn: focusReportIds } } : {}) },
      orderBy: { reportDate: 'desc' },
      take: recentLimit,
      select: {
        id: true,
        overallScore: true,
        score: true,
        verdict: true,
        severityLevel: true,
        reportDate: true,
        product: { select: { name: true, barcodeNumber: true } },
      },
    }),
    prisma.userMemory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: memoryLimit,
    }),
  ]);

  return { user, focusReports, recentReports, memories };
}

export type ChatContext = Awaited<ReturnType<typeof buildChatContext>>;

function joinNonEmpty(values: Array<string | null | undefined>, sep = ', '): string {
  return values
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0)
    .join(sep);
}

/** Renders the loaded context as a single prompt-prefix string. */
export function formatContextAsPromptPrefix(ctx: ChatContext): string {
  const parts: string[] = [];

  // --- User profile ---
  if (ctx.user) {
    parts.push('# User Profile');
    parts.push(`- Name: ${ctx.user.name}`);
    if (ctx.user.country) parts.push(`- Country: ${ctx.user.country}`);
    if (ctx.user.age != null) parts.push(`- Age: ${ctx.user.age}`);

    const allergens = joinNonEmpty(ctx.user.allergies.map((a) => a.allergen ?? a.name));
    if (allergens) parts.push(`- Known allergies: ${allergens}`);

    const conditions = joinNonEmpty(ctx.user.conditions.map((c) => c.conditionName ?? c.name));
    if (conditions) parts.push(`- Conditions: ${conditions}`);

    const meds = joinNonEmpty(ctx.user.medications.map((m) => m.medicationName ?? m.name));
    if (meds) parts.push(`- Medications: ${meds}`);
  }

  // --- Focus reports (full detail) ---
  if (ctx.focusReports.length) {
    parts.push('\n# Reports in focus (the user is currently looking at these)');
    for (const r of ctx.focusReports) {
      const name = r.product?.name ?? 'Unknown product';
      const score = r.overallScore ?? r.score ?? '—';
      parts.push(`\n## ${name} (report id ${r.id})`);
      parts.push(`- Score: ${score}/100`);
      if (r.verdict) parts.push(`- Verdict: ${r.verdict}`);
      if (r.severityLevel) parts.push(`- Severity: ${r.severityLevel}`);
      if (r.allergenFlags) parts.push(`- Allergen flags: ${r.allergenFlags}`);
      if (r.drugFlags) parts.push(`- Drug interaction flags: ${r.drugFlags}`);
      if (r.toxicityFlags) parts.push(`- Toxicity flags: ${r.toxicityFlags}`);
      if (r.conditionFlags) parts.push(`- Condition flags: ${r.conditionFlags}`);
      if (r.aiAnalysisSummary) parts.push(`\n### AI Analysis:\n${r.aiAnalysisSummary}`);
      if (r.summary) parts.push(`\n### Summary:\n${r.summary}`);
      // Nutritional data
      const hasNutrition = r.calories != null || r.sugarLevel || r.sodiumLevel;
      if (hasNutrition) {
        parts.push('\n### Nutritional data:');
        if (r.calories != null) parts.push(`- Calories: ${r.calories}`);
        if (r.sugarLevel) parts.push(`- Sugar: ${r.sugarLevel}`);
        if (r.sodiumLevel) parts.push(`- Sodium: ${r.sodiumLevel}`);
        if (r.saturatedFatLevel) parts.push(`- Saturated fat: ${r.saturatedFatLevel}`);
        if (r.proteinLevel) parts.push(`- Protein: ${r.proteinLevel}`);
        if (r.fiberLevel) parts.push(`- Fiber: ${r.fiberLevel}`);
        if (r.nutritionalSummary) parts.push(`- Detail: ${r.nutritionalSummary.slice(0, 500)}`);
        if (r.nutritionalFlags) parts.push(`- Health labels: ${r.nutritionalFlags.slice(0, 300)}`);
        if (r.dailyValueWarnings) parts.push(`- DV warnings: ${r.dailyValueWarnings}`);
        if (r.nutritionalScore != null) parts.push(`- Nutritional score: ${r.nutritionalScore}/100`);
      }
      // FDA data — ALWAYS emitted so AI never claims "I don't have access".
      // A score of 100 with no summary means "search ran, 0 results found".
      parts.push('\n### FDA adverse events (FAERS / CAERS):');
      const adverseCount = r.fdaReportCount ?? 0;
      parts.push(`- Reports matched: ${adverseCount}`);
      if (r.fdaReactionSummary) parts.push(`- Summary: ${r.fdaReactionSummary.slice(0, 800)}`);
      else if (adverseCount === 0) parts.push('- (FDA search ran and returned 0 adverse reports for this product)');

      // Recalls — count from potentialHarms text
      parts.push('\n### FDA recalls / enforcement:');
      const harmsText = r.potentialHarms
        ? typeof r.potentialHarms === 'string'
          ? r.potentialHarms
          : JSON.stringify(r.potentialHarms)
        : '';
      const recallLines = harmsText.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('['));
      const recallCount = recallLines.length;
      parts.push(`- Recalls matched: ${recallCount}`);
      if (recallCount > 0) parts.push(`- Detail:\n${harmsText.slice(0, 1000)}`);
      else parts.push('- (FDA recall search ran and returned 0 enforcement actions for this product)');

      if (r.knownReactions) parts.push(`\n### Known reactions:\n${r.knownReactions.slice(0, 500)}`);
      // Sub-scores
      parts.push('\n### Sub-scores:');
      if (r.allergenScore != null) parts.push(`- Allergen: ${r.allergenScore}/100`);
      if (r.toxicityScore != null) parts.push(`- Toxicity: ${r.toxicityScore}/100`);
      if (r.recallScore != null) parts.push(`- Recall: ${r.recallScore}/100`);
      if (r.drugInteractionScore != null) parts.push(`- Drug interaction: ${r.drugInteractionScore}/100`);
      if (r.adverseEventScore != null) parts.push(`- Adverse events: ${r.adverseEventScore}/100`);
      // Full ingredient list
      if (r.product?.ingredientList) {
        const ing = r.product.ingredientList.length > 1200
          ? r.product.ingredientList.slice(0, 1200) + '…'
          : r.product.ingredientList;
        parts.push(`\n### Full Ingredient List:\n${ing}`);
      }
      if (r.product?.brand) parts.push(`- Brand: ${r.product.brand}`);
      if (r.product?.barcodeNumber) parts.push(`- Barcode: ${r.product.barcodeNumber}`);
    }
  }

  // --- Recent reports (compact) ---
  if (ctx.recentReports.length) {
    parts.push('\n# Recent scan history (compact — for quick reference)');
    for (const r of ctx.recentReports) {
      const name = r.product?.name ?? 'Unknown product';
      const score = r.overallScore ?? r.score ?? '—';
      const verdict = r.verdict ?? '—';
      const date = r.reportDate.toISOString().slice(0, 10);
      parts.push(`- [${r.id}] ${name}: ${score} (${verdict}) — ${date}`);
    }
  }

  // --- Memories ---
  if (ctx.memories.length) {
    parts.push('\n# Remembered about this user');
    for (const m of ctx.memories) {
      parts.push(`- [${m.kind}] ${m.content}`);
    }
  }

  return parts.join('\n');
}
