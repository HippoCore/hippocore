# Hippo Core

Private local memory shared by MCP-compatible AI agents.

```bash
npm install -g @hippo-core/core
hippo-core setup
```

Hippo Core stores durable facts, preferences, decisions, and interaction outcomes in `~/.hippo-core/memory.db`. Its MCP server makes that context available to Codex, Claude Code, Cursor, OpenClaw, and other clients without a hosted database or Hippo Core cloud account.

API keys are read from environment variables and are not persisted by setup:

```bash
export HIPPO_CORE_API_KEY="your-key"
hippo-core mcp
```

The MCP server provides `hippo_recall`, `hippo_remember`, `hippo_history`, `hippo_resolve`, `hippo_retract`, and `hippo_status`.

Stable `memory_key` values let new evidence supersede old evidence without deleting history. Provenance, confidence, temporal validity, lifecycle status, relations, and audit events remain inspectable, while normal recall returns only active evidence.

Interactions are selectively decomposed into atomic claims through `addMemories`, giving every independently changing fact or preference its own lifecycle. Run `npm run benchmark` to execute the bundled deterministic quality suite across temporal accuracy, conflict safety, privacy isolation, user control, and atomicity.

## JavaScript

```js
import { createMemory } from '@hippo-core/core';

const memory = createMemory({ agentId: 'support', orgId: 'acme' });
const { systemPrompt } = await memory.before('user-123', message, basePrompt);
const response = await runAgent(systemPrompt, message);
await memory.after('user-123', message, response);
```

See the [GitHub repository](https://github.com/HippoCore/hippocore) for configuration, MCP examples, dashboard usage, and development instructions.
