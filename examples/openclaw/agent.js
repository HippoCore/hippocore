// examples/openclaw/agent.js
// Example: OpenClaw agent with persistent memory.
//
// Install: npm install openclaw @hippo-core/core
// Run: OPENAI_API_KEY=sk-... node examples/openclaw/agent.js

// Uncomment when openclaw is installed:
// import { Agent } from 'openclaw';
import { withMemory, memoryTools } from '../../packages/core/src/adapters/openclaw.js';

const MEMORY_CONFIG = {
  dbPath: './.memory/openclaw.db',
  apiKey: process.env.OPENAI_API_KEY,
};

// Option A: Wrap your existing agent
// const baseAgent = new Agent({
//   model: 'gpt-4o',
//   systemPrompt: 'You are a helpful mortgage advisor.',
//   tools: [searchTool, calcTool],
// });
//
// const agent = withMemory(baseAgent, MEMORY_CONFIG);
//
// // Use exactly like before — memory is automatic
// const result = await agent.run('user_123', 'What mortgage fits my budget?');

// Option B: Give the agent explicit memory tools
// const agent = new Agent({
//   model: 'gpt-4o',
//   tools: [
//     ...myTools,
//     ...memoryTools(MEMORY_CONFIG),  // adds 'remember' and 'recall' tools
//   ],
// });

console.log('OpenClaw adapter loaded. Uncomment and configure your agent above.');
console.log('See README for full integration guide.');
