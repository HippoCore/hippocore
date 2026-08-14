# Hippo Core

Private, local memory shared by your AI coding agents.

Hippo Core gives Codex, Claude Code, Cursor, OpenClaw, and other MCP-compatible tools one durable memory they can share. Memories stay in a user-owned SQLite file; model and embedding requests go only to the provider you configure.

## Why Hippo Core

- **One memory, many agents:** use the same facts, preferences, and project decisions across MCP clients.
- **Local-first:** no hosted database, Docker service, or Hippo Core cloud account.
- **Auditable:** inspect and manage the underlying memory store from the local dashboard.
- **Scoped:** isolate or share memory by user, agent, and organization.
- **Provider-independent:** use OpenAI-compatible hosted or local models.

## Install and configure

```bash
npm install -g @hippo-core/core
hippo-core setup
```

Configuration is stored at `~/.hippo-core/config.json`. API keys are not written there; supply them through the environment:

```bash
export HIPPO_CORE_API_KEY="your-key"
```

Optional overrides include `HIPPO_CORE_HOME`, `HIPPO_CORE_DB_PATH`, `HIPPO_CORE_BASE_URL`, `HIPPO_CORE_MODEL`, `HIPPO_CORE_EMBEDDING_API_KEY`, `HIPPO_CORE_EMBEDDING_BASE_URL`, and `HIPPO_CORE_EMBEDDING_MODEL`.

## MCP server

Configure an MCP client to run:

```json
{
  "mcpServers": {
    "hippo-core": {
      "command": "hippo-core",
      "args": ["mcp"],
      "env": {
        "HIPPO_CORE_API_KEY": "${HIPPO_CORE_API_KEY}"
      }
    }
  }
}
```

The server exposes:

- `hippo_recall` — retrieve relevant memories at the beginning of work.
- `hippo_remember` — save decisions, preferences, facts, and outcomes.
- `hippo_status` — inspect memory and retrieval statistics.

## JavaScript API

```js
import { createMemory } from '@hippo-core/core';

const memory = createMemory({ agentId: 'mortgage-advisor', orgId: 'acme' });
const { systemPrompt } = await memory.before('user-123', userMessage, baseSystemPrompt);
const response = await runAgent(systemPrompt, userMessage);
await memory.after('user-123', userMessage, response);
```

Recall combines semantic similarity, keyword overlap, and learned importance. Exact duplicate entries within a namespace are stored once.

## Trustworthy memory

Hippo Core keeps evidence instead of silently overwriting it. Give changing information a stable `memory_key`:

```js
await memory.store('user-123', 'I prefer concise answers', 'preference', {
  memory_key: 'preference.response_detail'
});
```

New evidence for that key supersedes the previous value while preserving its source and validity period. Normal recall returns only active evidence. The JavaScript API also exposes `getMemoryHistory`, `resolveConflict`, and `retractMemory`; MCP clients receive `hippo_history`, `hippo_resolve`, and `hippo_retract`.

Memories can carry `source_kind`, `source_ref`, `confidence`, `valid_from`, `valid_until`, and an explicit/inferred evidence status. Every recalled memory includes the semantic, lexical, importance, and confidence signals that caused its selection.

One interaction can produce multiple atomic memories. Each extracted claim receives its own type, stable key, confidence, provenance, embedding, and lifecycle, so changing an editor preference does not disturb a home-city fact learned in the same conversation.

## Memory quality benchmark

```bash
npm run benchmark
```

The deterministic benchmark executes the real storage and recall APIs without paid model calls. Its versioned fixtures currently measure temporal accuracy, unresolved-conflict safety, namespace isolation, user retraction, explainability, and atomic multi-fact extraction. A regression exits non-zero and reports the exact failed check.

## Local dashboard

```bash
hippo-core dashboard
```

The dashboard listens on `http://localhost:4444` by default.

## Development

```bash
npm install
npm test
npm run benchmark
npm run pack:check
```

Hippo Core is MIT licensed.
