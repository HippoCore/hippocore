// packages/core/src/adapters/generic.js
// The universal adapter.
// Works with ANY agent framework — wrap your agent's run function.

import { addMemory, queryMemories } from '../services/memory.js';
import { buildMemoryContext } from '../services/ai.js';

/**
 * createMemoryAgent
 *
 * Wraps any async agent function with automatic memory:
 * - Retrieves relevant memories before each run
 * - Injects memory context into the system prompt
 * - Stores the interaction after each run
 *
 * @param {Function} agentFn   - Your agent: async (messages, options) => string
 * @param {Object}   config    - Memory config (apiKey, model, dbPath, etc.)
 * @returns {Function}         - Drop-in replacement for agentFn
 *
 * @example
 * const myAgent = createMemoryAgent(async (messages, opts) => {
 *   return openai.chat.completions.create({ messages, ...opts });
 * }, { dbPath: './.memory/agent.db' });
 *
 * await myAgent('user_123', 'What mortgage should I recommend?');
 */
export function createMemoryAgent(agentFn, config = {}) {
  return async function memoryAgent(userId, userMessage, options = {}) {
    // 1. Retrieve relevant memories
    const memories = await queryMemories(
      { user_id: userId, query: userMessage, limit: config.memoryLimit || 5 },
      config,
    );

    // 2. Build memory context string
    const memoryContext = buildMemoryContext(memories);

    // 3. Inject into messages
    const systemMessage = [
      options.systemPrompt || config.systemPrompt || 'You are a helpful assistant.',
      memoryContext,
    ].filter(Boolean).join('\n\n');

    const messages = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage },
    ];

    // 4. Run the agent
    const response = await agentFn(messages, { ...options, memories });

    // 5. Store this interaction as a new memory (async, non-blocking)
    const responseText = typeof response === 'string' ? response : JSON.stringify(response);
    setImmediate(() => {
      addMemory({
        user_id: userId,
        type: 'conversation',
        content: `User: ${userMessage}\nAssistant: ${responseText.slice(0, 1000)}`,
      }, config).catch(console.error);
    });

    return response;
  };
}

/**
 * createMemoryMiddleware
 *
 * Functional middleware pattern — gives you explicit control.
 * Use this when you need to customize how memory is used.
 *
 * @example
 * const mem = createMemoryMiddleware(config);
 *
 * // In your agent loop:
 * const { memories, systemPrompt } = await mem.before(userId, userInput);
 * const response = await yourAgent(systemPrompt, userInput);
 * await mem.after(userId, userInput, response);
 */
export function createMemoryMiddleware(config = {}) {
  return {
    /**
     * Call before your agent runs.
     * Returns memories + a ready-to-use system prompt with memory context.
     */
    async before(userId, userMessage, baseSystemPrompt = '') {
      const memories = await queryMemories(
        { user_id: userId, query: userMessage, limit: config.memoryLimit || 5 },
        config,
      );

      const memoryContext = buildMemoryContext(memories);
      const systemPrompt = [baseSystemPrompt, memoryContext].filter(Boolean).join('\n\n');

      return { memories, systemPrompt, memoryContext };
    },

    /**
     * Call after your agent responds.
     * Stores the interaction in memory.
     */
    async after(userId, userMessage, agentResponse, type = 'conversation') {
      const responseText = typeof agentResponse === 'string'
        ? agentResponse
        : JSON.stringify(agentResponse);

      return addMemory({
        user_id: userId,
        type,
        content: `User: ${userMessage}\nAssistant: ${responseText.slice(0, 1000)}`,
      }, config);
    },

    /**
     * Store an explicit fact or preference (not a conversation).
     */
    async store(userId, content, type = 'preference') {
      return addMemory({ user_id: userId, type, content }, config);
    },

    /**
     * Raw query — returns memories without building a prompt.
     */
    async query(userId, queryText, limit = 5) {
      return queryMemories({ user_id: userId, query: queryText, limit }, config);
    },
  };
}
