// packages/core/src/services/ai.js
// Wraps OpenAI-compatible APIs: OpenAI, OpenRouter, Ollama, LM Studio, etc.
// Configure via HIPPO_CORE_BASE_URL to point at any provider.

import OpenAI from 'openai';

let _client = null;

function getClient(config = {}) {
  if (_client) return _client;
  _client = new OpenAI({
    apiKey: config.apiKey || process.env.HIPPO_CORE_API_KEY || process.env.OPENAI_API_KEY || 'ollama',
    baseURL: config.baseURL || process.env.HIPPO_CORE_BASE_URL || 'https://api.openai.com/v1',
  });
  return _client;
}

/**
 * Generate a vector embedding for text.
 * Returns a plain number array.
 */
export async function embed(text, config = {}) {
  const client = getClient(config);
  const model = config.embeddingModel
    || process.env.HIPPO_CORE_EMBEDDING_MODEL
    || 'text-embedding-3-small';

  const response = await client.embeddings.create({
    model,
    input: text.trim().slice(0, 8000),
  });

  return response.data[0].embedding;
}

/**
 * Extract structured facts/preferences/intent/entities from raw text.
 * Returns { facts[], preferences[], intent, entities{} }
 */
export async function extractStructured(content, config = {}) {
  const client = getClient(config);
  const model = config.model
    || process.env.HIPPO_CORE_MODEL
    || 'gpt-4o-mini';

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: `You are a memory extraction engine.
Extract structured information from user interaction text.
Return ONLY valid JSON — no markdown, no explanation.

Schema:
{
  "facts": ["string"],
  "preferences": ["string"],
  "intent": "string",
  "entities": { "key": "value" }
}

Extract only what is actually present. Empty arrays/strings for missing fields.`,
      },
      { role: 'user', content: `Extract from:\n\n${content}` },
    ],
  });

  const raw = response.choices[0].message.content.trim();

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return { facts: [], preferences: [], intent: '', entities: {} };
  }
}

/**
 * Summarize many memory texts into a compact long-term profile.
 */
export async function summarizeMemories(texts, config = {}) {
  const client = getClient(config);
  const model = config.model || process.env.HIPPO_CORE_MODEL || 'gpt-4o-mini';
  const joined = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      {
        role: 'system',
        content: `Summarize these memory entries into a concise long-term user profile.
Keep facts, preferences, and behavioral patterns that are useful for future interactions.
Return plain text — 3 to 8 sentences.`,
      },
      { role: 'user', content: joined },
    ],
  });

  return response.choices[0].message.content.trim();
}

/**
 * Build a ready-to-inject memory context string for agent system prompts.
 */
export function buildMemoryContext(memories) {
  if (!memories.length) return '';

  const lines = memories.flatMap((m) => {
    const s = m.structured;
    const parts = [];
    if (s?.facts?.length)       parts.push(...s.facts.map(f => `- Fact: ${f}`));
    if (s?.preferences?.length) parts.push(...s.preferences.map(p => `- Preference: ${p}`));
    if (s?.intent)              parts.push(`- Intent: ${s.intent}`);
    if (!parts.length)          parts.push(`- ${m.content.slice(0, 200)}`);
    return parts;
  });

  return [
    '### User Memory Context',
    'The following is known about this user from past interactions.',
    'Use it to personalize your responses naturally — do not quote it directly.',
    '',
    ...lines,
  ].join('\n');
}

export function resetClient() {
  _client = null;
}
