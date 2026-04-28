// packages/core/src/services/ai.js
// Hippo Core — AI service
// Provider-agnostic: OpenAI, OpenRouter, Ollama, Groq, LM Studio

import OpenAI from 'openai';

let _client = null;

function getClient(config = {}) {
  if (_client && !config.apiKey) return _client;
  _client = new OpenAI({
    apiKey:  config.apiKey  || process.env.HIPPO_CORE_API_KEY || process.env.OPENAI_API_KEY || 'local',
    baseURL: config.baseURL || process.env.HIPPO_CORE_BASE_URL || 'https://api.openai.com/v1',
  });
  return _client;
}

// ~4 chars per token — GPT tokenizer average
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export async function embed(text, config = {}) {
  const client = getClient(config);
  const model  = config.embeddingModel || process.env.HIPPO_CORE_EMBEDDING_MODEL || 'text-embedding-3-small';
  const response = await client.embeddings.create({
    model,
    input: text.trim().slice(0, 8000),
  });
  return response.data[0].embedding;
}

export async function extractStructured(content, config = {}) {
  const client = getClient(config);
  const model  = config.model || process.env.HIPPO_CORE_MODEL || 'gpt-4o-mini';
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens:  600,
    messages: [
      {
        role: 'system',
        content: `You are a memory extraction engine.
Extract structured information from user interaction text.
Return ONLY valid JSON — no markdown, no explanation.
Schema: { "facts": ["string"], "preferences": ["string"], "intent": "string", "entities": { "key": "value" } }
Extract only what is present. Empty arrays/strings for missing fields.`,
      },
      { role: 'user', content: `Extract from:\n\n${content}` },
    ],
  });
  const raw = response.choices[0].message.content.trim();
  try { return JSON.parse(raw); } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
    return { facts: [], preferences: [], intent: '', entities: {} };
  }
}

export async function summarizeMemories(texts, config = {}) {
  const client = getClient(config);
  const model  = config.model || process.env.HIPPO_CORE_MODEL || 'gpt-4o-mini';
  const joined = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens:  800,
    messages: [
      {
        role: 'system',
        content: `Summarize these memory entries into a concise long-term user profile.
Keep facts, preferences, and behavioral patterns useful for future interactions.
Return plain text — 3 to 8 sentences.`,
      },
      { role: 'user', content: joined },
    ],
  });
  return response.choices[0].message.content.trim();
}

/**
 * Build a token-aware prompt with memory injection + session buffer.
 *
 * Memories are sorted by relevance score (descending).
 * Each memory is added until the maxMemoryTokens budget is exhausted.
 * Session history provides short-term context (last N turns).
 *
 * Returns:
 *   systemPrompt    — full system prompt with memory context injected
 *   memoryContext   — just the memory block (for inspection)
 *   sessionMessages — trimmed session turns to append as message history
 *   tokenStats      — full token accounting
 */
export function buildPrompt({
  memories          = [],
  sessionHistory    = [],
  baseSystemPrompt  = '',
  maxMemoryTokens   = 500,
  sessionHistoryLen = 4,
} = {}) {

  // TOKEN-AWARE MEMORY INJECTION
  // Sort by blended score descending (should already be sorted, but enforce it)
  const sorted = [...memories].sort((a, b) => (b.blended || b.similarity || 0) - (a.blended || a.similarity || 0));

  const memoryLines = [];
  let memoryTokensUsed = 0;

  for (const m of sorted) {
    const s = m.structured;
    const lines = [];
    if (s?.facts?.length)       lines.push(...s.facts.map(f => `- Fact: ${f}`));
    if (s?.preferences?.length) lines.push(...s.preferences.map(p => `- Preference: ${p}`));
    if (s?.intent)              lines.push(`- Intent: ${s.intent}`);
    if (!lines.length)          lines.push(`- ${m.content.slice(0, 300)}`);

    const block       = lines.join('\n');
    const blockTokens = estimateTokens(block);

    if (memoryTokensUsed + blockTokens > maxMemoryTokens) break; // budget exhausted

    memoryLines.push(block);
    memoryTokensUsed += blockTokens;
  }

  const memoryContext = memoryLines.length
    ? [
        '### User Memory Context',
        'Known about this user from past interactions. Use naturally — do not quote directly.',
        '',
        ...memoryLines,
      ].join('\n')
    : '';

  // SHORT-TERM SESSION BUFFER
  // Only last N turns — separate from long-term memory
  const recentTurns = sessionHistory.slice(-Math.max(0, sessionHistoryLen));

  // FINAL SYSTEM PROMPT
  const systemPrompt = [baseSystemPrompt, memoryContext].filter(Boolean).join('\n\n');

  // TOKEN ACCOUNTING
  const systemTokens  = estimateTokens(systemPrompt);
  const sessionTokens = recentTurns.reduce((n, t) => n + estimateTokens(t.content), 0);

  const tokenStats = {
    memoryTokensUsed,
    memoryTokensBudget: maxMemoryTokens,
    memoriesInjected:   memoryLines.length,
    memoriesAvailable:  memories.length,
    systemTokens,
    sessionTokens,
    totalEstimated:     systemTokens + sessionTokens,
  };

  return { systemPrompt, memoryContext, sessionMessages: recentTurns, tokenStats };
}

// Legacy compat
export function buildMemoryContext(memories, maxMemoryTokens = 500) {
  const { memoryContext } = buildPrompt({ memories, maxMemoryTokens });
  return memoryContext;
}

export function resetClient() { _client = null; }
