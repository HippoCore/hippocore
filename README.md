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
npx -y @hippo-core/core install
```

That one command creates the local vault, detects Codex, Claude Code, and Cursor,
and safely adds Hippo Core to each detected MCP configuration. Existing settings
are preserved and changed files receive a `.hippo-backup` copy. Restart the
configured agents; they will recall relevant context before meaningful work and
save durable outcomes afterward without being prompted.

## Ambient memory

Installation adds a managed global instruction block for Codex and Claude Code
and an always-on Cursor rule. The policy makes memory automatic but selective:
stable decisions, preferences, corrections, and outcomes are shared; secrets,
casual chat, temporary debugging output, and low-value noise are never saved.
Routine memory calls stay in the background and do not interrupt the user.

Hippo Core preserves instructions you already have, backs up changed files, and
updates only its own clearly marked block on later installs.

Preview without changing anything, or select clients explicitly:

```bash
npx -y @hippo-core/core install --dry-run
npx -y @hippo-core/core install --client codex,claude-code,cursor
```

The vault works immediately without an account or provider key using private,
deterministic local embeddings and conservative single-memory extraction.
Configure an OpenAI-compatible or local model provider for richer semantic
extraction and atomic multi-fact memories. The simplest hosted setup is:

```bash
export HIPPO_CORE_API_KEY="your-key"
```

Use `hippo-core setup` for other providers and local models.

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

## Cross-agent shared vault

Hippo Core uses native SQLite in WAL mode with atomic writes and busy-timeout handling. Independent MCP server processes see committed memories immediately without reopening the vault, while `user+agent` scope keeps agent-private evidence isolated.

Run the end-to-end proof locally:

```bash
npm run test:cross-agent
```

The test launches two live MCP servers and a local mock model provider. Agent B opens its database connection first, Agent A stores a preference, and Agent B then demonstrates both private-scope denial and authorized user-scope recall with source provenance.

## Local dashboard

```bash
hippo-core dashboard
```

The dashboard listens on `http://localhost:4444` by default.

Its overview makes Hippo Core's value visible by comparing the accumulated
memory context eligible for each recall with the targeted context actually
injected. It reports the estimated tokens avoided and context-reduction
percentage globally and for each recent recall. The counterfactual is
snapshotted when recall happens and is explicitly labeled as a context estimate,
not an exact provider bill.

## Development

```bash
npm install
npm test
npm run benchmark
npm run pack:check
```

Hippo Core is MIT licensed.
