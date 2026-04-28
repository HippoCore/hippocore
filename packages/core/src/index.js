// packages/core/src/index.js
// ██╗  ██╗██╗██████╗ ██████╗  ██████╗      ██████╗ ██████╗ ██████╗ ███████╗
// ██║  ██║██║██╔══██╗██╔══██╗██╔═══██╗    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
// ███████║██║██████╔╝██████╔╝██║   ██║    ██║     ██║   ██║██████╔╝█████╗
// ██╔══██║██║██╔═══╝ ██╔═══╝ ██║   ██║    ██║     ██║   ██║██╔══██╗██╔══╝
// ██║  ██║██║██║     ██║     ╚██████╔╝    ╚██████╗╚██████╔╝██║  ██║███████╗
// ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝      ╚═════╝      ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝
//
// Persistent memory for AI agents. Zero infrastructure.
// Named for the hippocampus — the brain's memory center.

// Core memory operations
export {
  addMemory,
  queryMemories,
  applyFeedback,
  getUserProfile,
  deleteMemory,
  compressMemories,
  getMetrics,
} from './services/memory.js';

// AI utilities
export {
  embed,
  extractStructured,
  summarizeMemories,
  buildPrompt,
  buildMemoryContext,
  estimateTokens,
} from './services/ai.js';

// Adapters
export { createMemoryAgent, createMemoryMiddleware } from './adapters/generic.js';
export { withMemory as withMemoryOpenClaw, memoryTools  } from './adapters/openclaw.js';
export { memoryPlugin, withMemory as withMemoryPaperclip } from './adapters/paperclip.js';
export { createMemoryRouter, startMemoryServer } from './adapters/express.js';

// Dashboard
export { startDashboard } from './dashboard/server.js';

// DB
export { getDb, closeDb } from './db/sqlite.js';

/**
 * createMemory — main entry point.
 *
 * Config options:
 *   apiKey, baseURL, model, embeddingModel  — AI provider
 *   dbPath                                  — SQLite file (default: .hippo-core/memory.db)
 *   memoryLimit        (default: 5)         — max memories retrieved per query
 *   maxMemoryTokens    (default: 500)       — token budget for memory injection
 *   sessionHistoryLen  (default: 4)         — max short-term session turns
 *   retrievalLimit     (default: 100)       — candidate pool size for similarity search
 *
 * @example
 * import { createMemory } from '@hippo-core/core';
 * const memory = createMemory({ apiKey: process.env.OPENAI_API_KEY });
 *
 * const { systemPrompt, tokenStats } = await memory.before(userId, userMessage);
 * const response = await yourAgent(systemPrompt, userMessage);
 * await memory.after(userId, userMessage, response);
 */
export { createMemoryMiddleware as createMemory } from './adapters/generic.js';
