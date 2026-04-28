// packages/core/src/adapters/generic.js
// Hippo Core — universal adapter
// Works with any agent framework

import { addMemory, queryMemories } from '../services/memory.js';
import { buildPrompt, estimateTokens } from '../services/ai.js';
import { getDb, saveDb } from '../db/sqlite.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * createMemoryMiddleware — the main entry point.
 *
 * Config:
 *   apiKey, baseURL, model, embeddingModel  — AI provider
 *   dbPath                                  — SQLite file location
 *   memoryLimit      (default: 5)           — max memories retrieved
 *   maxMemoryTokens  (default: 500)         — token budget for memory injection
 *   sessionHistoryLen (default: 4)          — max session turns kept
 *   retrievalLimit   (default: 100)         — candidate pool for similarity search
 */
export function createMemoryMiddleware(config = {}) {
  const cfg = {
    memoryLimit:       config.memoryLimit       || 5,
    maxMemoryTokens:   config.maxMemoryTokens   || 500,
    sessionHistoryLen: config.sessionHistoryLen || 4,
    retrievalLimit:    config.retrievalLimit    || 100,
    ...config,
  };

  return {
    /**
     * Call before your agent runs.
     * Returns: systemPrompt, memories, sessionMessages, tokenStats
     */
    async before(userId, userMessage, baseSystemPrompt = '', sessionHistory = []) {
      const t0 = Date.now();

      const memories = await queryMemories({
        user_id:        userId,
        query:          userMessage,
        limit:          cfg.memoryLimit,
        retrievalLimit: cfg.retrievalLimit,
      }, cfg);

      const { systemPrompt, memoryContext, sessionMessages, tokenStats } = buildPrompt({
        memories,
        sessionHistory,
        baseSystemPrompt,
        maxMemoryTokens:   cfg.maxMemoryTokens,
        sessionHistoryLen: cfg.sessionHistoryLen,
      });

      const retrieval_ms = Date.now() - t0;

      // Log request for dashboard metrics
      logRequest({
        userId,
        query:              userMessage,
        memoriesRetrieved:  memories.length,
        memoryTokensUsed:   tokenStats.memoryTokensUsed,
        totalTokens:        tokenStats.totalEstimated,
        retrievalMs:        retrieval_ms,
      }, cfg).catch(() => {});

      return { systemPrompt, memoryContext, memories, sessionMessages, tokenStats };
    },

    /**
     * Call after your agent responds. Stores the interaction.
     */
    async after(userId, userMessage, agentResponse, type = 'conversation') {
      const responseText = typeof agentResponse === 'string'
        ? agentResponse
        : JSON.stringify(agentResponse);
      return addMemory({
        user_id: userId,
        type,
        content: `User: ${userMessage}\nAssistant: ${responseText.slice(0, 1000)}`,
      }, cfg);
    },

    /**
     * Store an explicit fact or preference.
     */
    async store(userId, content, type = 'preference') {
      return addMemory({ user_id: userId, type, content }, cfg);
    },

    /**
     * Raw query — returns memories + token stats without building a prompt.
     */
    async query(userId, queryText, limit = 5) {
      return queryMemories({ user_id: userId, query: queryText, limit }, cfg);
    },
  };
}

/**
 * createMemoryAgent — wraps any async agent function with automatic memory.
 */
export function createMemoryAgent(agentFn, config = {}) {
  const mem = createMemoryMiddleware(config);

  return async function memoryAgent(userId, userMessage, options = {}) {
    const { systemPrompt, sessionMessages, tokenStats } = await mem.before(
      userId,
      userMessage,
      options.systemPrompt || config.systemPrompt || 'You are a helpful assistant.',
      options.sessionHistory || [],
    );

    const messages = [
      { role: 'system', content: systemPrompt },
      ...sessionMessages,
      { role: 'user', content: userMessage },
    ];

    const response = await agentFn(messages, { ...options, tokenStats });

    const responseText = typeof response === 'string' ? response : JSON.stringify(response);
    setImmediate(() => {
      addMemory({
        user_id: userId,
        type:    'conversation',
        content: `User: ${userMessage}\nAssistant: ${responseText.slice(0, 1000)}`,
      }, config).catch(console.error);
    });

    return response;
  };
}

// Log to request_log table for dashboard
async function logRequest({ userId, query, memoriesRetrieved, memoryTokensUsed, totalTokens, retrievalMs }, config) {
  try {
    const db = await getDb(config.dbPath);
    db.exec({
      sql: `INSERT INTO request_log
              (id, user_id, query, memories_retrieved, memory_tokens_used, total_tokens, retrieval_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      bind: [uuidv4(), userId, query?.slice(0, 200), memoriesRetrieved, memoryTokensUsed, totalTokens, retrievalMs],
    });
    saveDb();
  } catch {}
}
