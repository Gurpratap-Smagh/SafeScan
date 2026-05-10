/**
 * POST /api/analysis/generate
 *
 * Runs Featherless (OpenAI-compatible) chat over the safety prompts, parses structured JSON, updates the `SafetyReport` + linked `scan_history` scores when applicable.
 *
 * Body: `{ "reportId": number }` — must belong to the authenticated user.
 *
 * Query: `debug=1` includes `rawModelText` in the response (dev/prod caution).
 *
 * Success `200`: `{ success, report, ai: { scores, summary, ... } }`.
 *
 * Errors: `400` validation, `404` report/user, `502` parse/model failure, `500` missing `FEATHERLESS_API_KEY`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verdictFromScore } from '@/app/api/_lib/score';
import { buildSafetyReportUpdateFromAi } from '@/lib/analysis/apply-ai-output';
import { parseSafetyAiOutput } from '@/lib/analysis/parse-safety-ai-json';
import { aiChat } from '@/lib/integrations/ai-chat';
import { prisma } from '@/lib/prisma';
import { SAFETY_ANALYSIS_SYSTEM_PROMPT } from '@/lib/prompts/safety-analysis-system';
import { buildSafetyAnalysisUserPrompt } from '@/lib/prompts/safety-analysis-user';
import { requireAuth } from '@/lib/auth/proxy';
import { badRequest } from '../../_lib/http';

const bodySchema = z
  .object({
    reportId: z.number().int().positive(),
  })
  .strict();

export async function POST(req: Request) {
  return requireAuth(req, async (caller) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest('Invalid JSON body');
    }

    const parsedBody = bodySchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsedBody.error.issues }, { status: 400 });
    }

    const reportId = parsedBody.data.reportId;

    const existing = await prisma.safetyReport.findFirst({
      where: { id: reportId, userId: caller.id },
      include: {
        product: true,
      },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }

    const user = await prisma.user.findUnique({
      where: { id: caller.id },
      include: {
        allergies: true,
        conditions: true,
        medications: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    try {
      const userPrompt = buildSafetyAnalysisUserPrompt({
        user,
        allergies: user.allergies,
        conditions: user.conditions,
        medications: user.medications,
        report: existing,
        product: existing.product,
      });

      const rawCompletion = await aiChat({
        messages: [
          { role: 'system', content: SAFETY_ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.35,
        maxTokens: 4096,
      });

      let structured: ReturnType<typeof parseSafetyAiOutput>;
      try {
        structured = parseSafetyAiOutput(rawCompletion);
      } catch (parseErr) {
        const isProd = process.env.NODE_ENV === 'production';
        return NextResponse.json(
          {
            error: 'Model response could not be parsed as JSON',
            detail: parseErr instanceof Error ? parseErr.message : String(parseErr),
            ...(!isProd ? { rawResponse: rawCompletion.slice(0, 12000) } : {}),
          },
          { status: 502 },
        );
      }

      const updateData = buildSafetyReportUpdateFromAi(structured);

      const updated = await prisma.safetyReport.update({
        where: { id: reportId },
        data: updateData,
        include: { product: true },
      });

      // If AI returned a better product name, persist it
      if (structured.productName && existing.product?.id) {
        const aiName = structured.productName.trim();
        if (aiName && aiName.toLowerCase() !== 'unknown product' && aiName.toLowerCase() !== 'unknown') {
          await prisma.product.update({
            where: { id: existing.product.id },
            data: { name: aiName },
          });
          if (updated.product) updated.product.name = aiName;
        }
      }

      if (updated.scanId != null) {
        const v = verdictFromScore(structured.scores.overallScore);
        await prisma.scanHistory.update({
          where: { id: updated.scanId },
          data: {
            score: structured.scores.overallScore,
            verdict: v ?? undefined,
          },
        });
      }

      const url = new URL(req.url);
      const debug = url.searchParams.get('debug') === '1';

      return NextResponse.json(
        {
          success: true,
          report: updated,
          ai: {
            scores: structured.scores,
            summary: structured.summary,
            aiAnalysisSummary: structured.aiAnalysisSummary,
            narrativeFields: structured.narrativeFields ?? null,
            outcome: structured.outcome ?? null,
          },
          ...(debug ? { rawModelText: rawCompletion } : {}),
        },
        { status: 200 },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Analysis failed';
      if (msg.includes('FEATHERLESS_API_KEY')) {
        return NextResponse.json({ error: msg }, { status: 500 });
      }
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  });
}
