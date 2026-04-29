// packages/core/src/adapters/generic.js
// Hippo Core v0.3.0 — universal adapter
//
// Config:
//   apiKey, baseURL, model              — chat provider (flexible, per-agent)
//   embeddingApiKey, embeddingBaseURL,  — embedding provider (LOCKED, never changes)
//   embeddingModel
//   dbPath                              — SQLite file
//   agentId                             — identifies this agent (default: 'default')
//   orgId                               — organisation namespace (default: 'default')
//   memoryLimit       (default: 5)
//   maxMemoryTokens   (default: 500)
//   sessionHistoryLen (default: 4)
//   scope             (default: 'user') — retrieval scope

import { addMemory, queryMemories } from '../services/memory.js';
import { buildPrompt, estimateTokens } from '../services/ai.js';
import { getDb, saveDb } from '../db/sqlite.js';
import { v4 as uuidv4 } from 'uuid';

export function createMemoryMiddleware(config = {}) {
  const cfg = {
    memoryLimit:       config.memoryLimit       || 5,
    maxMemoryTokens:   config.maxMemoryTokens   || 500,
    sessionHistoryLen: config.sessionHistoryLen || 4,
    retrievalLimit:    config.retrievalLimit    || 100,
    agentId:           config.agentId           || config.agent_id || 'default',
    orgId:             config.orgId             || config.org_id   || 'default',
    scope:             config.scope             || 'user',
    ...config,
  };

  return {
    /**
     * Call before your agent runs.
     * Returns: systemPrompt, memories, sessionMessages, tokenStats
     *
     * @param {string} userId
     * @param {string} userMessage
     * @param {string} baseSystemPrompt
     * @param {Array}  sessionHistory  — last N turns [{role, content}]
     */
    async before(userId, userMessage, baseSystemPrompt = '', sessionHistory = []) {
      const t0 = Date.now();

      const memories = await queryMemories({
        user_id:        userId,
        agent_id:       cfg.agentId,
        org_id:         cfg.orgId,
        query:          userMessage,
        limit:          cfg.memoryLimit,
        scope:          cfg.scope,
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

      logRequest({ userId, agentId: cfg.agentId, orgId: cfg.orgId, query: userMessage, memoriesRetrieved: memories.length, memoryTokensUsed: tokenStats.memoryTokensUsed, totalTokens: tokenStats.totalEstimated, retrievalMs: retrieval_ms }, cfg).catch(() => {});

      return { systemPrompt, memoryContext, memories, sessionMessages, tokenStats };
    },

    async after(userId, userMessage, agentResponse, type = 'conversation') {
      const responseText = typeof agentResponse === 'string' ? agentResponse : JSON.stringify(agentResponse);
      return addMemory({
        user_id:  userId,
        agent_id: cfg.agentId,
        org_id:   cfg.orgId,
        type,
        content: `User: ${userMessage}\nAssistant: ${responseText.slice(0, 1000)}`,
      }, cfg);
    },

    async store(userId, content, type = 'preference') {
      return addMemory({ user_id: userId, agent_id: cfg.agentId, org_id: cfg.orgId, type, content }, cfg);
    },

    async query(userId, queryText, limit = 5) {
      return queryMemories({ user_id: userId, agent_id: cfg.agentId, org_id: cfg.orgId, query: queryText, limit, scope: cfg.scope }, cfg);
    },
  };
}

export function createMemoryAgent(agentFn, config = {}) {
  const mem = createMemoryMiddleware(config);

  return async function memoryAgent(userId, userMessage, options = {}) {
    const { systemPrompt, sessionMessages, tokenStats } = await mem.before(
      userId, userMessage,
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
      addMemory({ user_id: userId, agent_id: config.agentId || 'default', org_id: config.orgId || 'default', type: 'conversation', content: `User: ${userMessage}\nAssistant: ${responseText.slice(0, 1000)}` }, config).catch(console.error);
    });

    return response;
  };
}

async function logRequest({ userId, agentId, orgId, query, memoriesRetrieved, memoryTokensUsed, totalTokens, retrievalMs }, config) {
  try {
    const db = await getDb(config.dbPath);
    db.exec({
      sql:  `INSERT INTO request_log (id, user_id, agent_id, org_id, query, memories_retrieved, memory_tokens_used, total_tokens, retrieval_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [uuidv4(), userId, agentId, orgId, query?.slice(0, 200), memoriesRetrieved, memoryTokensUsed, totalTokens, retrievalMs],
    });
    saveDb();
  } catch {}
}
