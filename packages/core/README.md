# Hippo Core

Private local memory shared by MCP-compatible AI agents.

```bash
npx -y @hippo-core/core install
```

The installer creates the shared SQLite vault and safely configures detected
Codex, Claude Code, and Cursor installations. Use `--dry-run` to preview or
`--client codex,claude-code,cursor` to choose explicit targets. Existing client
settings are preserved and modified files receive a `.hippo-backup` copy.

Installation starts the dashboard in the background and registers it for
user-level login startup on Windows, macOS, and Linux. Use `hippo-core repair`
to restore managed configuration, `hippo-core update` to move to the latest
release, or `hippo-core uninstall` to disconnect
agents and stop the dashboard. Uninstall preserves the memory vault.

The installer also enables ambient memory. Codex, Claude Code, and Cursor recall
context before meaningful work and save durable outcomes afterward without user
prompts. Managed instruction blocks preserve existing rules and explicitly skip
secrets, casual conversation, and temporary debugging noise.

Without a configured model provider, Hippo Core falls back to deterministic
local embeddings and conservative single-memory extraction. No network call or
account is required; configuring a provider upgrades extraction quality.

Hippo Core stores durable facts, preferences, decisions, and interaction outcomes in `~/.hippo-core/memory.db`. Its MCP server makes that context available to Codex, Claude Code, Cursor, OpenClaw, and other clients without a hosted database or Hippo Core cloud account.

API keys are read from environment variables and are not persisted by setup:

```bash
export HIPPO_CORE_API_KEY="your-key"
hippo-core mcp
```

The MCP server provides `hippo_recall`, `hippo_remember`, `hippo_history`, `hippo_resolve`, `hippo_retract`, and `hippo_status`.

Run `hippo-core dashboard` to see the estimated accumulated context without
Hippo Core versus the targeted context actually injected. The dashboard shows
tokens avoided and context reduction globally and for each recent recall. This
is a conservative context estimate, clearly distinguished from provider billing.

Use `hippo-core dashboard start`, `stop`, or `status` to manage the background
process explicitly.

Stable `memory_key` values let new evidence supersede old evidence without deleting history. Provenance, confidence, temporal validity, lifecycle status, relations, and audit events remain inspectable, while normal recall returns only active evidence.

Interactions are selectively decomposed into atomic claims through `addMemories`, giving every independently changing fact or preference its own lifecycle. Run `npm run benchmark` to execute the bundled deterministic quality suite across temporal accuracy, conflict safety, privacy isolation, user control, and atomicity.

The v1 shared vault uses native SQLite WAL transactions so multiple live MCP processes see committed writes safely. `npm run test:cross-agent` launches two independent servers and verifies shared recall, agent-private isolation, provenance, and clean shutdown.

## JavaScript

```js
import { createMemory } from '@hippo-core/core';

const memory = createMemory({ agentId: 'support', orgId: 'acme' });
const { systemPrompt } = await memory.before('user-123', message, basePrompt);
const response = await runAgent(systemPrompt, message);
await memory.after('user-123', message, response);
```

See the [GitHub repository](https://github.com/HippoCore/hippocore) for configuration, MCP examples, dashboard usage, and development instructions.
