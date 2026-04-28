# 🦛 Hippo Core

**Persistent memory for AI agents. Drop-in. Zero infrastructure.**

Named for the hippocampus — the brain's memory center.

```bash
npm install @hippo-core/core
```

Hippo Core gives your agents a memory. Every session they know who they're talking to, what was said before, and what the user cares about. Works with OpenClaw, Paperclip, Hermes, or any custom agent. Memory is stored locally in a single SQLite file — no database, no Docker, no cloud account required.

---

## How it works

```
User message
  → retrieve relevant memories from .hippo-core/memory.db
  → inject context into system prompt
  → agent responds with full user context
  → store interaction
  → repeat
```

Agents that were stateless become stateful. No changes to your agent logic.

---

## Quick start

```js
import { createMemory } from '@hippo-core/core';

const memory = createMemory({
  apiKey: process.env.OPENAI_API_KEY,
  // SQLite file created automatically at .hippo-core/memory.db
});

// Before your agent runs
const { systemPrompt } = await memory.before(userId, userMessage, 'You are a helpful assistant.');

// Run your agent with the enriched prompt
const response = await yourAgent(systemPrompt, userMessage);

// After your agent responds — store it
await memory.after(userId, userMessage, response);
```

---

## Framework adapters

### OpenClaw

```js
import { Agent } from 'openclaw';
import { withMemory, memoryTools } from '@hippo-core/core/adapters/openclaw';

// Option A: Automatic memory — wrap your agent
const agent = withMemory(new Agent({
  model: 'gpt-4o',
  systemPrompt: 'You are a mortgage advisor.',
}));

const result = await agent.run('user_123', 'What should I know about fixed rates?');

// Option B: Explicit memory tools — agent decides when to remember/recall
const agent = new Agent({
  model: 'gpt-4o',
  tools: [...myTools, ...memoryTools()],
});
```

### Paperclip

```js
import { createAgent } from 'paperclip-ai';
import { memoryPlugin } from '@hippo-core/core/adapters/paperclip';

const agent = createAgent({ model: 'gpt-4o' });
agent.use(memoryPlugin());

const result = await agent.run({ userId: 'user_123', message: 'What mortgage fits my budget?' });
```

### Any other framework

```js
import { createMemory } from '@hippo-core/core';
const memory = createMemory({ apiKey: process.env.OPENAI_API_KEY });

async function run(userId, userMessage) {
  const { systemPrompt } = await memory.before(userId, userMessage, baseSystemPrompt);
  const response = await yourAgent.run(systemPrompt, userMessage);
  await memory.after(userId, userMessage, response);
  return response;
}
```

---

## Importance scoring

```
retrieval_rank = (similarity × 0.7) + (importance × 0.3)
importance     = (recency × 0.3) + (access_frequency × 0.4) + (feedback × 0.3)
```

Memories used often and marked helpful rank higher over time.

---

## Configuration

```js
const memory = createMemory({
  apiKey:         process.env.OPENAI_API_KEY,
  baseURL:        'https://api.openai.com/v1',   // or OpenRouter, Ollama
  model:          'gpt-4o-mini',
  embeddingModel: 'text-embedding-3-small',
  dbPath:         './.hippo-core/memory.db',
  memoryLimit:    5,
});
```

**Local models (Ollama):**
```js
{ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3.2', embeddingModel: 'nomic-embed-text' }
```

---

## What's stored

Everything lives in `.hippo-core/memory.db` — a single file in your project directory. No data leaves your machine except LLM API calls.

---

## Run the demo

```bash
git clone https://github.com/your-org/hippo-core
cd hippo-core && npm install
OPENAI_API_KEY=sk-... npm run demo
```

---

## Contributing

Adding a new framework adapter is a single file in `packages/core/src/adapters/`. See `openclaw.js` as a template. PRs welcome.

---

MIT License
