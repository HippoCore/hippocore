// packages/core/src/adapters/paperclip.js
// Drop-in memory for Paperclip agents.
// Hooks into Paperclip's pipeline via beforeRun / afterRun lifecycle.
//
// Usage:
//   import { memoryPlugin } from '@hippo-core/core/adapters/paperclip';
//   agent.use(memoryPlugin({ apiKey: '...' }));

import { createMemoryMiddleware } from './generic.js';

/**
 * memoryPlugin — Paperclip plugin that adds persistent memory to any agent.
 *
 * @param {Object} config - Memory config (apiKey, model, dbPath, memoryLimit)
 * @returns {Object}      - Paperclip-compatible plugin object
 *
 * @example
 * import { Agent } from 'paperclip-ai';
 * import { memoryPlugin } from '@hippo-core/core/adapters/paperclip';
 *
 * const agent = new Agent({ model: 'gpt-4o' });
 * agent.use(memoryPlugin({ dbPath: './.memory/paperclip.db' }));
 *
 * const result = await agent.run({
 *   userId: 'user_123',
 *   message: 'Should I refinance my mortgage?',
 * });
 */
export function memoryPlugin(config = {}) {
  const mem = createMemoryMiddleware(config);

  return {
    name: 'hippo-core',

    // Called before agent processes the message
    async beforeRun(context) {
      const userId = context.userId || context.user_id || context.session?.userId;
      if (!userId) {
        console.warn('[hippo-core] No userId in context — memory skipped');
        return context;
      }

      const userMessage = context.message || context.input || context.prompt || '';

      const { systemPrompt, memories } = await mem.before(
        userId,
        userMessage,
        context.systemPrompt || '',
      );

      // Inject into context
      return {
        ...context,
        systemPrompt,
        _agentMemory: { userId, userMessage, memories },
      };
    },

    // Called after agent produces a response
    async afterRun(context, result) {
      const { userId, userMessage } = context._agentMemory || {};
      if (!userId || !userMessage) return result;

      const responseText = result?.output || result?.message || result?.content || String(result);
      await mem.after(userId, userMessage, responseText);

      return result;
    },
  };
}

/**
 * withMemory — functional wrapper for Paperclip agents.
 * Use when you want explicit control instead of plugin registration.
 *
 * @example
 * import { createAgent } from 'paperclip-ai';
 * import { withMemory } from '@hippo-core/core/adapters/paperclip';
 *
 * const agent = withMemory(createAgent({ model: 'gpt-4o' }), { dbPath: '...' });
 * const result = await agent.run({ userId: 'user_123', message: 'Hello' });
 */
export function withMemory(agent, config = {}) {
  const plugin = memoryPlugin(config);

  return {
    ...agent,

    async run(context) {
      const enrichedContext = await plugin.beforeRun(context);
      const result = await agent.run(enrichedContext);
      return plugin.afterRun(enrichedContext, result);
    },

    memory: {
      store: (userId, content, type) => createMemoryMiddleware(config).store(userId, content, type),
      query: (userId, query, limit)  => createMemoryMiddleware(config).query(userId, query, limit),
    },
  };
}
