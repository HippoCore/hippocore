// examples/paperclip/agent.js
// Example: Paperclip agent with persistent memory.
//
// Install: npm install paperclip-ai @hippo-core/core
// Run: OPENAI_API_KEY=sk-... node examples/paperclip/agent.js

// Uncomment when paperclip is installed:
// import { createAgent } from 'paperclip-ai';
import { memoryPlugin, withMemory } from '../../packages/core/src/adapters/paperclip.js';

const MEMORY_CONFIG = {
  dbPath: './.memory/paperclip.db',
  apiKey: process.env.OPENAI_API_KEY,
};

// Option A: Plugin registration (if Paperclip supports .use())
// const agent = createAgent({ model: 'gpt-4o' });
// agent.use(memoryPlugin(MEMORY_CONFIG));
//
// const result = await agent.run({
//   userId: 'user_123',
//   message: 'What mortgage fits my budget?',
// });

// Option B: Functional wrapper
// const baseAgent = createAgent({ model: 'gpt-4o' });
// const agent = withMemory(baseAgent, MEMORY_CONFIG);
//
// const result = await agent.run({
//   userId: 'user_123',
//   message: 'What mortgage fits my budget?',
// });

console.log('Paperclip adapter loaded. Uncomment and configure your agent above.');
console.log('See README for full integration guide.');
