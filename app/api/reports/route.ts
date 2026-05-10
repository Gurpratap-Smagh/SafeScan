/**
 * POST /api/reports
 *
 * Builds a full orchestrated safety report (news, barcode sources, Open Food Facts, openFDA, nutrition APIs, etc.) and persists `SafetyReport`. Requires session.
 *
 * Body (one of): `{ "barcode": string, "scanId"?: number }` OR `{ "productName": string, "scanId"?: number }`.
 *
 * Query: `debug=1` includes orchestrator `meta` in the response.
 *
 * Success `201`: `{ success, report, summary: { newsArticles, openfda* counts }, meta? }`.
 *
 * Errors: `400` validation / bad `scanId`, `404` user, `500` pipeline failure message.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/proxy';
import { orchestrateSafetyReport } from '@/lib/reports/orchestrate-report';
import { badRequest } from '../_lib/http';

const barcodeBody = z
  .object({
    barcode: z.string().min(4).max(40),
    productName: z.string().min(1).max(200).optional(),
    scanId: z.number().int().positive().optional(),
  });

const nameBody = z
  .object({
    productName: z.string().min(2).max(200),
    scanId: z.number().int().positive().optional(),
  });

const bodySchema = z.union([barcodeBody, nameBody]);

export async function POST(req: Request) {
  return requireAuth(req, async (caller) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest('Invalid JSON body');
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
    }

    try {
      const payload =
        'barcode' in parsed.data
          ? { userId: caller.id, barcode: parsed.data.barcode, productNameHint: parsed.data.productName, scanId: parsed.data.scanId }
          : { userId: caller.id, productName: parsed.data.productName, scanId: parsed.data.scanId };

      const { report, meta } = await orchestrateSafetyReport(payload);

      const url = new URL(req.url);
      const debug = url.searchParams.get('debug') === '1';

      return NextResponse.json(
        {
          success: true,
          report,
          summary: {
            newsArticles: meta.newsCount,
            openfdaFoodRecalls: meta.foodRecalls,
            openfdaDrugRecalls: meta.drugRecalls,
            openfdaDrugAdverseEvents: meta.drugAdverseEvents,
            openfdaFoodAdverseEvents: meta.foodAdverseEvents,
            openfdaAdverseEventsTotal: meta.adverseEvents,
          },
          ...(debug ? { meta } : {}),
        },
        { status: 201 },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Report generation failed';
      if (msg === 'User not found') {
        return NextResponse.json({ error: msg }, { status: 404 });
      }
      if (msg.includes('Invalid scanId')) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  });
}
