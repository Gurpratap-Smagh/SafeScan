/**
 * GET /api/reports/:reportId
 *
 * Fetches one persisted safety report for the authenticated owner only.
 *
 * Query: `fields` — optional subset selector parsed by `parseReportFieldsQuery` (invalid sections → `400` with `allowedSections`).
 *
 * Success `200`: shaped report JSON from `buildSafetyReportResponse`. `403` other user’s report, `404` not found, `400` bad id.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/auth/proxy';
import {
  buildSafetyReportResponse,
  parseReportFieldsQuery,
} from '@/lib/reports/safety-report-response';
import { badRequest, notFound, parseId } from '../../_lib/http';

export async function GET(req: Request, { params }: { params: { reportId: string } }) {
  return requireAuth(req, async (caller) => {
    const reportId = parseId(params.reportId);
    if (!reportId) return badRequest('invalid report id');

    const report = await prisma.safetyReport.findUnique({
      where: { id: reportId },
      include: { product: true },
    });
    if (!report) return notFound('report not found');
    if (report.userId !== caller.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const parsed = parseReportFieldsQuery(searchParams.get('fields'));

    if (parsed.mode === 'invalid') {
      return NextResponse.json(
        {
          error: 'Invalid fields sections',
          invalid: parsed.invalid,
          allowedSections: parsed.allowed.sort(),
        },
        { status: 400 },
      );
    }

    const { product, ...reportWithoutProduct } = report;
    const body = buildSafetyReportResponse(reportWithoutProduct as Parameters<typeof buildSafetyReportResponse>[0], parsed);
    return NextResponse.json({ report: { ...body, product } });
  });
}
