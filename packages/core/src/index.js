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
//
// https://github.com/your-org/hippo-core

// Core memory operations
export { addMemory, queryMemories, applyFeedback, getUserProfile, deleteMemory, compressMemories } from './services/memory.js';

// AI utilities
export { embed, extractStructured, summarizeMemories, buildMemoryContext } from './services/ai.js';

// Adapters — pick yours
export { createMemoryAgent, createMemoryMiddleware } from './adapters/generic.js';
export { withMemory as withMemoryOpenClaw, memoryTools }  from './adapters/openclaw.js';
export { memoryPlugin, withMemory as withMemoryPaperclip } from './adapters/paperclip.js';
export { createMemoryRouter, startMemoryServer } from './adapters/express.js';

// DB
export { getDb, closeDb } from './db/sqlite.js';

/**
 * createMemory — the main entry point for Hippo Core.
 *
 * Returns a memory middleware with .before(), .after(), .store(), .query()
 * Compatible with any agent framework.
 *
 * @example
 * import { createMemory } from '@hippo-core/core';
 *
 * const memory = createMemory({ apiKey: process.env.OPENAI_API_KEY });
 *
 * const { systemPrompt } = await memory.before(userId, userMessage);
 * const response = await yourAgent(systemPrompt, userMessage);
 * await memory.after(userId, userMessage, response);
 */
export { createMemoryMiddleware as createMemory } from './adapters/generic.js';
