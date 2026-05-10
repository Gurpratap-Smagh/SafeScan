/**
 * Unified AI chat.
 * Primary: watsonx.ai (IBM Cloud) — always tried first.
 * Fallback: Featherless — only used if watsonx is not configured or fails.
 */

import { featherlessChat } from '@/lib/integrations/featherless';
import { watsonxChat } from '@/lib/integrations/watsonx';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function aiChat(params: {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const hasWatsonx = !!(process.env.WATSONX_API_KEY && process.env.WATSONX_PROJECT_ID);

  if (hasWatsonx) {
    const result = await watsonxChat(params);
    if (result.ok) return result.content;
    console.warn(`[aiChat] watsonx failed (${result.status}): ${result.error} — falling back to Featherless`);
  }

  return featherlessChat(params);
}
