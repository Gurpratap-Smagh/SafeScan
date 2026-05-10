'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import type { Html5Qrcode } from 'html5-qrcode';

export type Category = 'Food' | 'Medication' | 'Supplement';

export type SafetyReport = {
  id: number;
  productName?: string | null;
  product?: { name?: string | null; ingredientList?: string | null } | null;
  score?: number | null;
  overallScore?: number | null;
  verdict?: string | null;
  severityLevel?: string | null;
  summary?: string | null;
  aiAnalysisSummary?: string | null;
  allergenScore?: number | null;
  toxicityScore?: number | null;
  recallScore?: number | null;
  drugInteractionScore?: number | null;
  adverseEventScore?: number | null;
  nutritionalScore?: number | null;
  allergenFlags?: string | null;
  drugFlags?: string | null;
  toxicityFlags?: string | null;
  nutritionalSummary?: string | null;
  fdaReportCount?: number | null;
  fdaReactionSummary?: string | null;
  potentialHarms?: unknown;
  calories?: number | null;
  sugarLevel?: string | null;
  sodiumLevel?: string | null;
  saturatedFatLevel?: string | null;
  proteinLevel?: string | null;
  fiberLevel?: string | null;
  knownReactions?: string | null;
};

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

const READER_ID = 'safescan-qr-reader';
const SCAN_HINT_MS = 7000;

/** Returns true if name is a placeholder (barcode string or empty). */
function isPlaceholderName(n?: string | null): boolean {
  if (!n) return true;
  return n.startsWith('Barcode:') || n === 'Unknown product' || n.trim() === '';
}

// ─── Multi-step status messages during generation ─────────────────────────────

const PROGRESS_TIMELINE = [
  { ms: 0,     msg: 'Looking up product…',                    pct: 5  },
  { ms: 1800,  msg: 'Checking FDA recalls & adverse events…', pct: 18 },
  { ms: 5000,  msg: 'Scanning drug interactions…',            pct: 32 },
  { ms: 8500,  msg: 'Fetching nutritional data…',             pct: 47 },
  { ms: 13000, msg: 'Running AI safety analysis…',            pct: 60 },
  { ms: 19000, msg: 'Analyzing your health profile…',         pct: 75 },
  { ms: 25000, msg: 'Building your safety report…',           pct: 88 },
  { ms: 31000, msg: 'Almost there…',                          pct: 95 },
];

function useStatusCycle(active: boolean) {
  const [msg, setMsg] = useState('');
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (!active) { setMsg(''); setPct(0); return; }
    const start = Date.now();
    setMsg(PROGRESS_TIMELINE[0].msg);
    setPct(PROGRESS_TIMELINE[0].pct);
    const iv = setInterval(() => {
      const elapsed = Date.now() - start;
      let current = PROGRESS_TIMELINE[0];
      let currentIdx = 0;
      for (let i = 0; i < PROGRESS_TIMELINE.length; i++) {
        if (elapsed >= PROGRESS_TIMELINE[i].ms) { current = PROGRESS_TIMELINE[i]; currentIdx = i; }
      }
      setMsg(current.msg);
      const next = PROGRESS_TIMELINE[currentIdx + 1];
      if (next) {
        const frac = (elapsed - current.ms) / (next.ms - current.ms);
        setPct(Math.round(current.pct + (next.pct - current.pct) * Math.min(frac, 1)));
      } else {
        const overtime = elapsed - current.ms;
        setPct(Math.min(current.pct + (overtime / 15000) * 4, 99));
      }
    }, 600);
    return () => clearInterval(iv);
  }, [active]);

  return { msg, pct };
}

// ─── Scanner / report-generation panel ───────────────────────────────────────

interface ScannerProps {
  onReportReady: (report: SafetyReport, chatSessionId: number | null) => void;
}

export function ScanPanel({ onReportReady }: ScannerProps) {
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const detectedRef = useRef(false);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [pending, setPending] = useState<{ barcode: string } | null>(null);
  const [productName, setProductName] = useState('');
  const [category, setCategory] = useState<Category>('Food');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { msg: statusMsg, pct: statusPct } = useStatusCycle(submitting);

  const stopScanner = useCallback(async () => {
    if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    const s = scannerRef.current;
    if (!s) return;
    try {
      const state = s.getState?.();
      if (state === 2) await s.stop();
      await s.clear();
    } catch { /* ignore */ } finally { scannerRef.current = null; }
  }, []);

  const startScanner = useCallback(async () => {
    setCameraError(null);
    detectedRef.current = false;

    const mod = await import('html5-qrcode');
    const { Html5Qrcode, Html5QrcodeSupportedFormats } = mod;
    const inst = new Html5Qrcode(READER_ID, {
      verbose: false,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.ITF,
        Html5QrcodeSupportedFormats.QR_CODE,
      ],
    });
    scannerRef.current = inst;

    scanTimerRef.current = setTimeout(() => {
      if (!detectedRef.current) {
        toast('Camera struggling? Try entering the barcode manually.', {
          duration: 6000,
          action: {
            label: 'Enter manually',
            onClick: () => { setScanning(false); setPending({ barcode: '' }); },
          },
        });
      }
    }, SCAN_HINT_MS);

    try {
      const qrboxFn = (vw: number, vh: number) => ({
        width: Math.floor(Math.min(vw * 0.85, 480)),
        height: Math.floor(Math.min(Math.min(vw, vh) * 0.55, 220)),
      });

      await inst.start(
        { facingMode: 'environment' },
        {
          fps: 25,
          qrbox: qrboxFn,
          aspectRatio: 1.7777778,
          disableFlip: false,
          videoConstraints: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          ...({ experimentalFeatures: { useBarCodeDetectorIfSupported: true } } as object),
        },
        (decoded) => {
          if (detectedRef.current) return;
          detectedRef.current = true;
          if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
          toast.success(`Barcode detected: ${decoded}`);
          setPending({ barcode: decoded });
          setScanning(false);
        },
        () => { /* per-frame misses */ },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unable to start camera.';
      setCameraError(msg);
      toast.error('Camera error — try entering barcode manually.');
      setScanning(false);
      await stopScanner();
    }
  }, [stopScanner]);

  useEffect(() => {
    if (scanning) { void startScanner(); } else { void stopScanner(); }
    return () => { void stopScanner(); };
  }, [scanning, startScanner, stopScanner]);

  async function submitReport() {
    if (!pending) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const hasBarcode = !!pending.barcode.trim();
      const hasName = !!productName.trim();
      const body = hasBarcode
        ? { barcode: pending.barcode.trim(), ...(hasName ? { productName: productName.trim() } : {}) }
        : hasName
          ? { productName: productName.trim() }
          : null;

      if (!body) {
        setSubmitError('Please enter a barcode or product name.');
        setSubmitting(false);
        return;
      }

      const doFetch = () =>
        fetch('/api/reports', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      let res = await doFetch();
      if (res.status === 401) {
        const g = await fetch('/api/auth/guest', { method: 'POST', credentials: 'include' });
        if (g.ok) res = await doFetch();
      }
      const json = await res.json();
      if (!res.ok) { setSubmitError(json?.error || 'Report failed'); return; }

      let report = json.report as SafetyReport;

      // AI deepening
      try {
        await fetch('/api/analysis/generate', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reportId: report.id }),
        });
        const r2 = await fetch(`/api/reports/${report.id}`, { credentials: 'include' });
        if (r2.ok) {
          const j2 = await r2.json();
          const updated = (j2?.report ?? j2) as SafetyReport;
          if (updated?.id) {
            // Preserve product from original report if re-fetch didn't include it
            report = { ...updated, product: updated.product ?? report.product };
          }
        }
      } catch { /* AI is optional */ }

      // Chat session
      let chatSessionId: number | null = null;
      try {
        let cs = await fetch('/api/chat/sessions', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (cs.status === 401) {
          await fetch('/api/auth/guest', { method: 'POST', credentials: 'include' });
          cs = await fetch('/api/chat/sessions', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
        }
        if (cs.ok) { const cj = await cs.json(); chatSessionId = cj.id as number; }
      } catch { /* optional */ }

      onReportReady(report, chatSessionId);
    } catch {
      setSubmitError('Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  function resetAll() {
    setPending(null);
    setProductName('');
    setSubmitError(null);
    setCameraError(null);
  }

  const needsName = !productName.trim() && !pending?.barcode.trim();
  const canSubmit = !submitting && (!!pending?.barcode.trim() || !!productName.trim());

  return (
    <div className="relative rounded-3xl border border-white/10 bg-white/5 p-6 text-white shadow-lg shadow-black/10 overflow-hidden">

      {/* Comet glow border + particles during report generation */}
      {submitting && (
        <>
          <div
            className="pointer-events-none absolute inset-0 z-10 rounded-3xl"
            style={{
              background:
                'radial-gradient(ellipse at 50% -10%, rgba(0,229,176,0.30) 0%, rgba(0,112,243,0.15) 45%, transparent 70%)',
              animation: 'pulseGlow 1.9s ease-in-out infinite',
            }}
          />
          <div
            className="pointer-events-none absolute inset-0 z-10 rounded-3xl border-2 border-[#00e5b0]/50"
            style={{ animation: 'borderGlow 1.9s ease-in-out infinite' }}
          />
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="pointer-events-none absolute z-10 h-1.5 w-1.5 rounded-full bg-[#00e5b0]"
              style={{
                left: `${12 + i * 18}%`,
                top: '0%',
                opacity: 0,
                animation: `particle ${1.4 + i * 0.25}s ease-out ${i * 0.18}s infinite`,
              }}
            />
          ))}
        </>
      )}

      {/* Camera viewport */}
      <div className="relative mx-auto aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
        <div
          id={READER_ID}
          className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
        />
        {!scanning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-white/60">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9V6a1 1 0 011-1h3M15 5h3a1 1 0 011 1v3M21 15v3a1 1 0 01-1 1h-3M9 19H6a1 1 0 01-1-1v-3" />
            </svg>
            Camera is off
          </div>
        )}
        {scanning && (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute left-1/2 top-1/2 h-[40%] w-[72%] -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-[#00e5b0]"
              style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)' }}
            />
            <div className="absolute left-1/2 top-1/2 h-[40%] w-[72%] -translate-x-1/2 -translate-y-1/2">
              <span className="absolute -left-0.5 -top-0.5 h-4 w-4 rounded-tl-lg border-l-2 border-t-2 border-[#00e5b0]" />
              <span className="absolute -right-0.5 -top-0.5 h-4 w-4 rounded-tr-lg border-r-2 border-t-2 border-[#00e5b0]" />
              <span className="absolute -bottom-0.5 -left-0.5 h-4 w-4 rounded-bl-lg border-b-2 border-l-2 border-[#00e5b0]" />
              <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-br-lg border-b-2 border-r-2 border-[#00e5b0]" />
            </div>
            <div className="absolute left-1/2 top-1/2 h-[40%] w-[72%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl">
              <div className="absolute left-0 right-0 h-0.5 animate-scanline bg-[#00e5b0] shadow-[0_0_12px_#00e5b0]" />
            </div>
            <p className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/80">
              Align barcode inside the frame — hold steady
            </p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => setScanning((s) => !s)}
          disabled={submitting}
          className="flex-1 rounded-xl bg-[#00e5b0] px-4 py-3 text-sm font-semibold text-[#06130f] hover:bg-[#1af0bf] disabled:opacity-50 transition"
        >
          {scanning ? '⏹ Stop scanner' : '📷 Start camera scan'}
        </button>
        <button
          type="button"
          onClick={() => { setScanning(false); setPending({ barcode: '' }); }}
          disabled={submitting}
          className="rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold text-white/80 hover:bg-white/10 disabled:opacity-50 transition"
        >
          ✏️ Enter manually
        </button>
        {pending && !submitting && (
          <button
            type="button"
            onClick={resetAll}
            className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm text-white/60 hover:bg-white/10 transition"
          >
            Reset
          </button>
        )}
      </div>
      {cameraError ? <p className="mt-2 text-sm text-[#ff8596]">{cameraError}</p> : null}

      {/* Post-scan form */}
      {pending && !submitting && (
        <div className="mt-5 rounded-2xl border border-[#00e5b0]/30 bg-[#00e5b0]/5 p-5 space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider text-[#9ed5c6] mb-1">
              {pending.barcode ? 'Barcode detected' : 'Barcode'}
            </label>
            <input
              value={pending.barcode}
              onChange={(e) => setPending({ barcode: e.target.value })}
              placeholder="Enter barcode number"
              className="w-full rounded-xl border border-white/15 bg-black/40 px-4 py-2 font-mono text-white placeholder:text-white/30 outline-none focus:border-[#00e5b0]"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-[#9ed5c6] mb-1">
              Product name{' '}
              <span className="normal-case text-white/40">
                {needsName ? '— required when no barcode' : '— optional, auto-detected from barcode'}
              </span>
            </label>
            <input
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder={needsName ? 'e.g. Great Value Peanut Butter' : 'Leave blank to auto-detect'}
              className={`w-full rounded-xl border bg-black/40 px-4 py-2 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-[#00e5b0] ${
                needsName ? 'border-[#f5b042]/60' : 'border-white/15'
              }`}
            />
            {needsName && (
              <p className="mt-1 text-[11px] text-[#f5b042]">
                ⚠ No barcode detected — enter a product name to continue.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-[#9ed5c6] mb-2">Category</label>
            <div className="grid grid-cols-3 gap-2">
              {(['Food', 'Medication', 'Supplement'] as Category[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                    category === c
                      ? 'bg-[#00e5b0] text-[#06130f]'
                      : 'border border-white/15 bg-white/5 text-white/80 hover:bg-white/10'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={submitReport}
            disabled={!canSubmit}
            className="w-full rounded-xl bg-[#0070f3] px-4 py-3 text-sm font-bold text-white hover:bg-[#1f86ff] disabled:opacity-60 transition"
          >
            Generate Safety Report →
          </button>
          {submitError ? <p className="text-sm text-[#ff8596]">{submitError}</p> : null}
        </div>
      )}

      {/* Generation progress panel */}
      {submitting && (
        <div className="relative z-20 mt-5 rounded-2xl border border-[#00e5b0]/40 bg-black/60 p-6 text-center space-y-4 backdrop-blur-sm">
          {/* Spinning teal ring */}
          <div className="mx-auto flex h-14 w-14 items-center justify-center">
            <svg className="h-14 w-14 animate-spin" viewBox="0 0 56 56" fill="none">
              <circle cx="28" cy="28" r="24" stroke="rgba(0,229,176,0.12)" strokeWidth="4" />
              <path d="M28 4 a24 24 0 0 1 24 24" stroke="#00e5b0" strokeWidth="4" strokeLinecap="round" />
            </svg>
          </div>

          <p className="text-sm font-medium text-white transition-all duration-500">{statusMsg}</p>

          {/* Gradient progress bar */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${statusPct}%`,
                background: 'linear-gradient(90deg, #00e5b0 0%, #0070f3 100%)',
                boxShadow: '0 0 12px rgba(0,229,176,0.55)',
              }}
            />
          </div>

          <p className="text-xs text-white/35">This may take 15–30 seconds</p>
        </div>
      )}

      <style>{`
        @keyframes pulseGlow {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 0.9; }
        }
        @keyframes borderGlow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(0,229,176,0); }
          50% { box-shadow: 0 0 28px 6px rgba(0,229,176,0.4), inset 0 0 28px 2px rgba(0,112,243,0.15); }
        }
        @keyframes particle {
          0% { opacity: 0; transform: translateY(0) scale(0.5); }
          25% { opacity: 0.9; transform: translateY(-10px) scale(1); }
          100% { opacity: 0; transform: translateY(-50px) scale(0.3); }
        }
      `}</style>
    </div>
  );
}

// ─── Safety report view ───────────────────────────────────────────────────────

function verdictColor(v?: string | null) {
  const x = (v ?? '').toLowerCase();
  if (x.includes('safe')) return 'text-[#00e5b0]';
  if (x.includes('caution')) return 'text-[#f5b042]';
  if (x.includes('unsafe') || x.includes('danger')) return 'text-[#ff5577]';
  return 'text-white/80';
}

function ScoreCircle({ score }: { score: number }) {
  const color = score >= 75 ? '#00e5b0' : score >= 50 ? '#f5b042' : '#ff5577';
  const label = score >= 80 ? 'Safe' : score >= 60 ? 'Low risk' : score >= 40 ? 'Moderate' : score >= 20 ? 'High risk' : 'Unsafe';
  const sub = score >= 80 ? 'for you' : score >= 60 ? 'minor concerns' : score >= 40 ? 'review advised' : score >= 20 ? 'avoid if possible' : 'do not consume';
  return (
    <div
      className="flex h-24 w-24 flex-col items-center justify-center rounded-full border-4 bg-black/40 shrink-0 text-center px-1"
      style={{ borderColor: color }}
    >
      <span className="text-base font-extrabold leading-tight" style={{ color }}>{label}</span>
      <span className="text-[9px] leading-tight text-white/40 mt-0.5">{sub}</span>
    </div>
  );
}

export function SafetyReportView({ report }: { report: SafetyReport }) {
  const score = report.overallScore ?? report.score ?? 0;
  const productName =
    isPlaceholderName(report.product?.name)
      ? isPlaceholderName(report.productName)
        ? 'Unknown product'
        : report.productName!
      : report.product!.name!;

  // --- Derive real stats from API-backed report fields ---
  const allergenList = (report.allergenFlags ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allergenCount = allergenList.length;

  // potentialHarms is JSON or string with one recall per line
  const harmsRaw = report.potentialHarms;
  const harmsText = typeof harmsRaw === 'string'
    ? harmsRaw
    : harmsRaw && typeof harmsRaw === 'object'
      ? JSON.stringify(harmsRaw)
      : '';
  const recallLines = harmsText.split('\n').map((s) => s.trim()).filter((s) => s && s.startsWith('['));
  const recallCount = recallLines.length;

  // Count distinct ingredients (rough — split on common separators)
  const ingredientCount = report.product?.ingredientList
    ? report.product.ingredientList
        .split(/[,;()\[\]\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 60).length
    : 0;

  const drugFlagText = (report.drugFlags ?? '').trim();
  const hasDrugConflict = drugFlagText.length > 0 && (report.drugInteractionScore ?? 100) < 80;

  const toxicityFlagText = (report.toxicityFlags ?? '').trim();
  // Count toxicity keywords found (heuristic from flag text)
  const toxicitySignalCount = toxicityFlagText
    ? toxicityFlagText.split(/[,.;|]/).map((s) => s.trim()).filter(Boolean).length
    : 0;

  const adverseCount = report.fdaReportCount ?? 0;

  const nutritionStat = (() => {
    const parts: string[] = [];
    if (report.calories != null) parts.push(`${report.calories} kcal`);
    if (report.sugarLevel) parts.push(`sugar: ${report.sugarLevel}`);
    if (report.sodiumLevel) parts.push(`sodium: ${report.sodiumLevel}`);
    return parts.length ? parts.slice(0, 2).join(' · ') : 'no data';
  })();

  type SubScore = {
    label: string;
    score: number | null | undefined;
    primaryStat: string;
    desc: string;
  };

  const subscores: SubScore[] = [
    {
      label: 'Allergens',
      score: report.allergenScore,
      primaryStat: allergenCount > 0
        ? `${allergenCount} match${allergenCount > 1 ? 'es' : ''}`
        : '0 matches',
      desc: allergenCount > 0
        ? allergenList.slice(0, 2).join(', ')
        : 'vs your profile',
    },
    {
      label: 'Toxicity',
      score: report.toxicityScore,
      primaryStat: ingredientCount > 0
        ? `${toxicitySignalCount}/${ingredientCount} flagged`
        : toxicitySignalCount > 0 ? `${toxicitySignalCount} signals` : '0 flagged',
      desc: 'contaminants / heavy metals',
    },
    {
      label: 'Recalls',
      score: report.recallScore,
      primaryStat: `${recallCount} recall${recallCount === 1 ? '' : 's'}`,
      desc: 'FDA enforcement records',
    },
    {
      label: 'Drug Interactions',
      score: report.drugInteractionScore,
      primaryStat: hasDrugConflict ? 'Conflict found' : '0 conflicts',
      desc: 'vs your medications',
    },
    {
      label: 'Adverse Events',
      score: report.adverseEventScore,
      primaryStat: `${adverseCount} report${adverseCount === 1 ? '' : 's'}`,
      desc: 'FDA FAERS / CAERS',
    },
    {
      label: 'Nutrition',
      score: report.nutritionalScore,
      primaryStat: nutritionStat,
      desc: 'sugar / sodium / calories',
    },
  ];

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-6 text-white shadow-lg shadow-black/10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-white/40">Safety Report</p>
          <h2 className="mt-1 text-2xl font-bold leading-tight">{productName}</h2>
          <p className={`mt-1 text-sm font-semibold ${verdictColor(report.verdict)}`}>
            {report.verdict ?? '—'}
            {report.severityLevel && (
              <span className="ml-2 text-white/50">· {report.severityLevel}</span>
            )}
          </p>
        </div>
        <ScoreCircle score={score} />
      </div>

      {/* Explain why overall is low when a single dimension dominates */}
      {score < 50 && report.allergenScore != null && report.allergenScore <= 25 && (
        <p className="mt-3 rounded-xl border border-[#ff5577]/20 bg-[#ff5577]/5 px-3 py-2 text-xs text-[#ff5577]/80">
          ⚠ Overall score is low because a known allergen was detected — see sub-scores for the full breakdown.
        </p>
      )}

      {report.summary && (
        <p className="mt-4 rounded-2xl bg-black/30 p-4 text-sm leading-relaxed text-white/80">
          {report.summary}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {subscores.map(({ label, score: val, primaryStat, desc }) => {
          const n = val ?? null;
          const barColor = n == null ? 'bg-white/20' : n >= 75 ? 'bg-[#00e5b0]' : n >= 50 ? 'bg-[#f5b042]' : 'bg-[#ff5577]';
          const statColor = n == null ? 'text-white/40' : n >= 75 ? 'text-[#00e5b0]' : n >= 50 ? 'text-[#f5b042]' : 'text-[#ff5577]';
          return (
            <div key={label} className="rounded-xl border border-white/10 bg-black/20 p-3">
              <p className="text-[10px] uppercase tracking-wider text-white/40">{label}</p>
              <p className={`mt-1 text-base font-bold leading-tight ${statColor}`}>{primaryStat}</p>
              <p className="text-[9px] text-white/40 leading-tight mt-0.5">{desc}</p>
              {n != null && (
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div className={`h-full rounded-full ${barColor}`} style={{ width: `${n}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {report.allergenFlags && (
          <span className="rounded-full border border-[#ffb38a]/40 bg-[#ffb38a]/10 px-3 py-1 text-xs text-[#ffb38a]">
            ⚠ Allergens: {report.allergenFlags}
          </span>
        )}
        {report.drugFlags && (
          <span className="rounded-full border border-[#ffb38a]/40 bg-[#ffb38a]/10 px-3 py-1 text-xs text-[#ffb38a]">
            💊 Drug flags
          </span>
        )}
      </div>
    </div>
  );
}

// ─── AI Analysis panel (separate box) ────────────────────────────────────────

export function AIAnalysisPanel({ summary }: { summary: string }) {
  return (
    <div className="rounded-3xl border border-[#00e5b0]/20 bg-white/5 p-6 text-white shadow-lg shadow-black/10">
      <h3 className="mb-3 flex items-center gap-2 font-semibold">
        <span className="text-[#00e5b0]">✦</span> AI Safety Analysis
      </h3>
      <div className="max-h-96 overflow-y-auto pr-1 themed-scroll text-sm leading-relaxed text-white/80 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-bold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:mt-3 [&_h2]:mt-2 [&_h3]:mt-2 [&_ul]:pl-4 [&_ol]:pl-4 [&_li]:my-0.5 [&_strong]:text-white [&_p]:my-1 [&_p:first-child]:mt-0">
        <ReactMarkdown>{summary}</ReactMarkdown>
      </div>
    </div>
  );
}

// ─── Chat panel ─────────────────────────────────────────────────────────────

interface ChatPanelProps {
  reportId: number;
  sessionId: number;
  initialMessage?: string | null;
}

export function ChatPanel({ reportId, sessionId, initialMessage }: ChatPanelProps) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(() =>
    initialMessage && !initialMessage.startsWith('SYSTEM:')
      ? [{ role: 'assistant' as const, content: initialMessage }]
      : [],
  );
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sendLock = useRef(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs, sending]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const content = input.trim();
    if (!content || sendLock.current) return;
    sendLock.current = true;
    setInput('');
    setError(null);
    setSending(true);
    setMsgs((p) => [...p, { role: 'user', content }]);

    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, reports: [reportId] }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json?.error || 'Chat failed'); return; }
      setMsgs((p) => [...p, { role: 'assistant', content: json.assistantMessage.content }]);
    } catch {
      setError('Chat request failed');
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  const starters = [
    'Is this product safe given my allergies?',
    'What are the most concerning ingredients?',
    'Are there healthier alternatives?',
  ];

  return (
    <div className="flex h-full flex-col rounded-3xl border border-white/10 bg-white/5 text-white shadow-lg shadow-black/10">
      <div className="border-b border-white/10 px-5 py-4">
        <h3 className="font-semibold">Ask SafeScan AI</h3>
        <p className="text-xs text-white/50 mt-0.5">Grounded in your profile + this report</p>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 px-5 py-4 themed-scroll"
        style={{ minHeight: 0 }}
      >
        {msgs.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-white/40">Suggested questions:</p>
            {starters.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setInput(q)}
                className="block w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-left text-xs text-white/70 hover:bg-white/10 transition"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div
            key={i}
            className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'ml-auto bg-[#0070f3] text-white'
                : 'bg-white/10 text-white/90'
            }`}
          >
            {m.role === 'assistant' ? (
              <div className="[&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-bold [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:pl-4 [&_ol]:pl-4 [&_li]:my-0.5 [&_strong]:text-white [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
                <ReactMarkdown>{m.content}</ReactMarkdown>
              </div>
            ) : (
              m.content
            )}
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-sm text-white/50 italic">
            <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeDashoffset="8" />
            </svg>
            SafeScan AI is thinking…
          </div>
        )}
      </div>

      <div className="border-t border-white/10 px-4 py-3">
        {error && <p className="mb-2 text-xs text-[#ff8596]">{error}</p>}
        <form onSubmit={send} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a follow-up…"
            disabled={sending}
            className="flex-1 rounded-xl border border-white/15 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-[#00e5b0]"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="rounded-xl bg-[#00e5b0] px-5 py-2.5 text-sm font-semibold text-[#06130f] disabled:opacity-50 transition hover:bg-[#1af0bf]"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
