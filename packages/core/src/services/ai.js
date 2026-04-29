// packages/core/src/services/ai.js
// Hippo Core v0.3.0 — AI service
//
// SPLIT CONFIG:
//   Chat model    — flexible, can change per agent per request
//   Embedding model — LOCKED at setup, never changes
//
// This separation means multiple agents using different chat models
// can all share the same memory store safely.

import OpenAI from 'openai';

let _chatClient      = null;
let _embeddingClient = null;

// ── Client factories ──────────────────────────────────────────────────────────

function getChatClient(config = {}) {
  if (_chatClient && !config.apiKey) return _chatClient;
  _chatClient = new OpenAI({
    apiKey:  config.apiKey  || process.env.HIPPO_CORE_API_KEY || process.env.OPENAI_API_KEY || 'local',
    baseURL: config.baseURL || process.env.HIPPO_CORE_BASE_URL || 'https://api.openai.com/v1',
  });
  return _chatClient;
}

function getEmbeddingClient(config = {}) {
  if (_embeddingClient && !config.embeddingApiKey) return _embeddingClient;
  // Embedding client uses dedicated keys — falls back to chat keys if not set
  _embeddingClient = new OpenAI({
    apiKey:  config.embeddingApiKey  || config.apiKey  || process.env.HIPPO_CORE_EMBEDDING_API_KEY || process.env.HIPPO_CORE_API_KEY || process.env.OPENAI_API_KEY || 'local',
    baseURL: config.embeddingBaseURL || config.baseURL || process.env.HIPPO_CORE_EMBEDDING_BASE_URL || process.env.HIPPO_CORE_BASE_URL || 'https://api.openai.com/v1',
  });
  return _embeddingClient;
}

// ── Token estimation ──────────────────────────────────────────────────────────
// ~4 chars per token — GPT tokenizer average
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ── Embeddings ────────────────────────────────────────────────────────────────
// ALWAYS uses the dedicated embedding client + embedding model.
// This is intentionally separate from the chat model.
export async function embed(text, config = {}) {
  const client = getEmbeddingClient(config);
  const model  = config.embeddingModel
    || process.env.HIPPO_CORE_EMBEDDING_MODEL
    || 'text-embedding-3-small';

  const response = await client.embeddings.create({
    model,
    input: text.trim().slice(0, 8000),
  });
  return response.data[0].embedding;
}

// ── Structured extraction ─────────────────────────────────────────────────────
// Uses the chat client. Model can vary per agent.
export async function extractStructured(content, config = {}) {
  const client = getChatClient(config);
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

// ── Summarization ─────────────────────────────────────────────────────────────
export async function summarizeMemories(texts, config = {}) {
  const client = getChatClient(config);
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

// ── Prompt builder ────────────────────────────────────────────────────────────
// Token-aware memory injection + session buffer
export function buildPrompt({
  memories          = [],
  sessionHistory    = [],
  baseSystemPrompt  = '',
  maxMemoryTokens   = 500,
  sessionHistoryLen = 4,
} = {}) {
  // Sort by blended score descending
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
    if (memoryTokensUsed + blockTokens > maxMemoryTokens) break;

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

  const recentTurns  = sessionHistory.slice(-Math.max(0, sessionHistoryLen));
  const systemPrompt = [baseSystemPrompt, memoryContext].filter(Boolean).join('\n\n');

  const tokenStats = {
    memoryTokensUsed,
    memoryTokensBudget: maxMemoryTokens,
    memoriesInjected:   memoryLines.length,
    memoriesAvailable:  memories.length,
    systemTokens:       estimateTokens(systemPrompt),
    sessionTokens:      recentTurns.reduce((n, t) => n + estimateTokens(t.content), 0),
    totalEstimated:     estimateTokens(systemPrompt) + recentTurns.reduce((n, t) => n + estimateTokens(t.content), 0),
  };

  return { systemPrompt, memoryContext, sessionMessages: recentTurns, tokenStats };
}

// Legacy compat
export function buildMemoryContext(memories, maxMemoryTokens = 500) {
  const { memoryContext } = buildPrompt({ memories, maxMemoryTokens });
  return memoryContext;
}

export function resetClients() { _chatClient = null; _embeddingClient = null; }
