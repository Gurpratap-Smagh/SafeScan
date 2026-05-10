/**
 * POST /api/chat/sessions/:id/messages — Send a user message, get AI reply.
 *
 * Body: `{ content: string, reports?: number[] }` — `reports` are the focus
 *   report ids for THIS turn. The chat session itself is not pinned to any
 *   report; focus is per-message so the user can shift attention freely.
 *
 * Flow:
 *   1. Save the user message
 *   2. Build context (user profile + focus reports + recent + memories)
 *   3. Load this session's last N messages
 *   4. Call Featherless with system + context + history + new message
 *   5. Save assistant reply
 *   6. Touch session.updatedAt; auto-title if first turn
 *
 * Success `201`: `{ userMessage, assistantMessage, sessionTitle }`.
 *
 * Errors: `401`, `404` session, `400` validation, `502` model failure,
 *   `500` missing FEATHERLESS_API_KEY.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/auth/proxy';
import { aiChat } from '@/lib/integrations/ai-chat';
import { buildChatContext, formatContextAsPromptPrefix } from '@/lib/chat/context-builder';
import { extractAndSaveMemories } from '@/lib/chat/memory-extraction';
import { CHAT_SYSTEM_PROMPT } from '@/lib/chat/system-prompt';
import { badRequest, notFound, ok, parseId, validationError } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';

const MAX_HISTORY_TURNS = 16;
const MAX_FOCUS_REPORTS = 3;

const PostMessageSchema = z
  .object({
    content: z.string().min(1).max(4000),
    reports: z.array(z.number().int().positive()).max(MAX_FOCUS_REPORTS).optional(),
  })
  .strict();

function deriveTitleFromFirstMessage(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 60) return cleaned;
  return cleaned.slice(0, 57) + '…';
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return requireAuth(req, async (caller) => {
    const sessionId = parseId(params.id);
    if (!sessionId) return badRequest('invalid session id');

    const session = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId: caller.id },
      select: { id: true, title: true },
    });
    if (!session) return notFound('session not found');

    const raw = await req.json().catch(() => null);
    const parsed = PostMessageSchema.safeParse(raw);
    if (!parsed.success) return validationError(parsed.error.issues);
    const { content, reports = [] } = parsed.data;

    if (!process.env.FEATHERLESS_API_KEY && (!process.env.WATSONX_API_KEY || !process.env.WATSONX_PROJECT_ID)) {
      return NextResponse.json(
        { error: 'No AI provider configured (set WATSONX_API_KEY + WATSONX_PROJECT_ID or FEATHERLESS_API_KEY)' },
        { status: 500 },
      );
    }

    // 1. Persist the user message immediately so it's visible even if the
    //    model call fails.
    const userMessage = await prisma.chatMessage.create({
      data: { sessionId, role: 'user', content },
    });

    // 2 + 3. Context + history loaded in parallel.
    const [context, history] = await Promise.all([
      buildChatContext({ userId: caller.id, focusReportIds: reports }),
      prisma.chatMessage.findMany({
        where: { sessionId, NOT: { id: userMessage.id } },
        orderBy: { createdAt: 'desc' },
        take: MAX_HISTORY_TURNS,
        select: { role: true, content: true },
      }),
    ]);

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    messages.push({ role: 'system', content: CHAT_SYSTEM_PROMPT });

    const contextPrefix = formatContextAsPromptPrefix(context);
    if (contextPrefix.trim()) {
      messages.push({ role: 'system', content: `Context for this conversation:\n\n${contextPrefix}` });
    }

    // history was fetched newest-first; reverse for chronological order
    for (const m of history.reverse()) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content });
      }
    }
    messages.push({ role: 'user', content });

    let assistantContent: string;
    try {
      assistantContent = await aiChat({
        messages,
        temperature: 0.4,
        maxTokens: 1024,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Model call failed';
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    // 5. Save assistant reply.
    const assistantMessage = await prisma.chatMessage.create({
      data: { sessionId, role: 'assistant', content: assistantContent },
    });

    // 6. Touch session + auto-title if this was the first turn.
    const newTitle =
      session.title == null ? deriveTitleFromFirstMessage(content) : session.title;
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { title: newTitle, updatedAt: new Date() },
    });

    // 7. Best-effort memory extraction (adds ~500ms but populates UserMemory
    //    so future chats are personalized). Failures are silent.
    await extractAndSaveMemories({
      userId: caller.id,
      userMessage: content,
      assistantMessage: assistantContent,
    });

    return ok(
      {
        userMessage: {
          id: userMessage.id,
          role: userMessage.role,
          content: userMessage.content,
          createdAt: userMessage.createdAt,
        },
        assistantMessage: {
          id: assistantMessage.id,
          role: assistantMessage.role,
          content: assistantMessage.content,
          createdAt: assistantMessage.createdAt,
        },
        sessionTitle: newTitle,
      },
      201,
    );
  });
}
