// packages/core/src/index.js
// ██╗  ██╗██╗██████╗ ██████╗  ██████╗      ██████╗ ██████╗ ██████╗ ███████╗
// ██║  ██║██║██╔══██╗██╔══██╗██╔═══██╗    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
// ███████║██║██████╔╝██████╔╝██║   ██║    ██║     ██║   ██║██████╔╝█████╗
// ██╔══██║██║██╔═══╝ ██╔═══╝ ██║   ██║    ██║     ██║   ██║██╔══██╗██╔══╝
// ██║  ██║██║██║     ██║     ╚██████╔╝    ╚██████╗╚██████╔╝██║  ██║███████╗
// ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝      ╚═════╝      ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝
//
// v0.3.0 — Multi-agent namespacing + split embedding config
// Named for the hippocampus — the brain's memory center.

export {
  addMemory,
  queryMemories,
  applyFeedback,
  getUserProfile,
  deleteMemory,
  compressMemories,
  reEmbedAll,
  getMetrics,
} from './services/memory.js';

export {
  embed,
  extractStructured,
  summarizeMemories,
  buildPrompt,
  buildMemoryContext,
  estimateTokens,
} from './services/ai.js';

export { createMemoryAgent, createMemoryMiddleware } from './adapters/generic.js';
export { withMemory as withMemoryOpenClaw, memoryTools  } from './adapters/openclaw.js';
export { memoryPlugin, withMemory as withMemoryPaperclip } from './adapters/paperclip.js';
export { createMemoryRouter, startMemoryServer } from './adapters/express.js';
export { startDashboard } from './dashboard/server.js';
export { getDb, closeDb } from './db/sqlite.js';

/**
 * createMemory — main entry point for Hippo Core v0.3.0
 *
 * Config:
 *   // Chat model — flexible, can change per agent
 *   apiKey, baseURL, model
 *
 *   // Embedding model — LOCKED, never change after setup
 *   embeddingApiKey, embeddingBaseURL, embeddingModel
 *
 *   // Namespacing — multi-agent support
 *   agentId    (default: 'default')   identifies which agent
 *   orgId      (default: 'default')   organisation namespace
 *   scope      (default: 'user')      retrieval scope: user|agent|org|user+agent
 *
 *   // Storage
 *   dbPath     (default: .hippo-core/memory.db)
 *
 *   // Retrieval
 *   memoryLimit        (default: 5)
 *   maxMemoryTokens    (default: 500)
 *   sessionHistoryLen  (default: 4)
 *
 * @example
 * // Single agent
 * const memory = createMemory({ apiKey: '...', agentId: 'mortgage-advisor' });
 *
 * // Multiple agents sharing memory
 * const mortgageAgent = createMemory({ apiKey: '...', agentId: 'mortgage', orgId: 'acme' });
 * const supportAgent  = createMemory({ apiKey: '...', agentId: 'support',  orgId: 'acme' });
 *
 * // Retrieve org-wide shared memory
 * const orgMemory = createMemory({ apiKey: '...', orgId: 'acme', scope: 'org' });
 */
export { createMemoryMiddleware as createMemory } from './adapters/generic.js';
