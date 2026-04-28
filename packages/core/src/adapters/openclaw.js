// packages/core/src/adapters/openclaw.js
// Drop-in memory for OpenClaw agents.
// Wraps OpenClaw's agent.run() with automatic memory injection.
//
// Usage:
//   import { withMemory } from '@hippo-core/core/adapters/openclaw';
//   const agent = withMemory(new OpenClawAgent({ ... }), { apiKey: '...' });
//   await agent.run(userId, 'What mortgage should I recommend?');

import { createMemoryMiddleware } from './generic.js';

/**
 * withMemory — wraps an OpenClaw agent instance with persistent memory.
 *
 * @param {Object} agent   - An OpenClaw Agent instance
 * @param {Object} config  - Memory config (apiKey, model, dbPath, memoryLimit)
 * @returns {Object}       - Proxy agent with memory-enhanced .run()
 *
 * @example
 * import { Agent } from 'openclaw';
 * import { withMemory } from '@hippo-core/core/adapters/openclaw';
 *
 * const agent = withMemory(new Agent({
 *   model: 'gpt-4o',
 *   tools: [searchTool, calcTool],
 *   systemPrompt: 'You are a mortgage advisor.',
 * }), {
 *   dbPath: './.memory/openclaw.db',
 * });
 *
 * const result = await agent.run('user_123', 'Should I get a fixed rate mortgage?');
 */
export function withMemory(agent, config = {}) {
  const mem = createMemoryMiddleware(config);

  return {
    // Forward all original agent properties
    ...agent,

    /**
     * Memory-enhanced run.
     * @param {string} userId      - Unique user identifier
     * @param {string} userMessage - The user's input
     * @param {Object} options     - Passed through to the original agent.run()
     */
    async run(userId, userMessage, options = {}) {
      // Retrieve memory + build enhanced system prompt
      const { systemPrompt } = await mem.before(
        userId,
        userMessage,
        agent.systemPrompt || options.systemPrompt || '',
      );

      // Run the original OpenClaw agent with memory-injected prompt
      const result = await agent.run(userMessage, {
        ...options,
        systemPrompt,
      });

      // Store the interaction
      await mem.after(userId, userMessage, result?.output || result);

      return result;
    },

    // Expose memory API directly on the agent
    memory: {
      store: (userId, content, type) => mem.store(userId, content, type),
      query: (userId, query, limit)   => mem.query(userId, query, limit),
    },
  };
}

/**
 * OpenClaw tool: gives the agent explicit memory tools it can call.
 * Add these to your agent's tools array.
 *
 * @example
 * import { memoryTools } from '@hippo-core/core/adapters/openclaw';
 * const agent = new Agent({ tools: [...myTools, ...memoryTools(config)] });
 */
export function memoryTools(config = {}) {
  const mem = createMemoryMiddleware(config);

  return [
    {
      name: 'remember',
      description: 'Store an important fact or preference about the user for future sessions.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The user ID' },
          content: { type: 'string', description: 'The fact or preference to remember' },
          type:    { type: 'string', enum: ['preference', 'behavioral', 'long_term'], default: 'preference' },
        },
        required: ['user_id', 'content'],
      },
      execute: async ({ user_id, content, type = 'preference' }) => {
        await mem.store(user_id, content, type);
        return { success: true, stored: content };
      },
    },
    {
      name: 'recall',
      description: 'Recall relevant memories about the user.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          query:   { type: 'string', description: 'What to look up in memory' },
          limit:   { type: 'number', default: 5 },
        },
        required: ['user_id', 'query'],
      },
      execute: async ({ user_id, query, limit = 5 }) => {
        const memories = await mem.query(user_id, query, limit);
        return { memories: memories.map(m => ({ content: m.content, type: m.type, ...m.structured })) };
      },
    },
  ];
}
