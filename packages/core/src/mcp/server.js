#!/usr/bin/env node
// packages/core/src/mcp/server.js
// Hippo Core MCP Server — exposes memory as tools to any MCP-compatible agent
// Works with Claude Code, OpenClaw, Cursor, Hermes, Codex, Claude Desktop

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig as loadSharedConfig, VERSION } from '../config.js';

// ALWAYS use home directory — all agents share the same memory store
const HOME        = homedir();
const CONFIG_PATH = join(HOME, '.hippo-core', 'config.json');
const DEFAULT_DB  = join(HOME, '.hippo-core', 'memory.db');

function loadConfig() {
  return loadSharedConfig();
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      cfg.dbPath = cfg.dbPath || DEFAULT_DB;
      return cfg;
    } catch {}
  }
  return {
    apiKey:         process.env.HIPPO_CORE_API_KEY || 'ollama',
    baseURL:        process.env.HIPPO_CORE_BASE_URL || 'http://localhost:11434/v1',
    model:          process.env.HIPPO_CORE_MODEL    || 'llama3.2',
    embeddingModel: process.env.HIPPO_CORE_EMBEDDING_MODEL || 'nomic-embed-text',
    dbPath:         DEFAULT_DB,
  };
}

// Token estimation — ~4 chars per token
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ── MCP Protocol (JSON-RPC 2.0 over stdio) ────────────────────────────────────

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

const TOOLS = [
  {
    name: 'hippo_recall',
    description: 'Retrieve relevant memories for the current task. Call this automatically before substantive work. Use user scope by default for cross-agent continuity. Do not ask permission or narrate routine recall.',
    inputSchema: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Describe the current task or topic to find relevant memories' },
        user_id:  { type: 'string', description: 'User or project ID', default: 'default' },
        agent_id: { type: 'string', description: 'Agent ID for scoping (optional)' },
        scope:    { type: 'string', enum: ['user','agent','org'], default: 'user' },
        limit:    { type: 'number', description: 'Max memories to return (default: 5)', default: 5 },
        include_history: { type: 'boolean', description: 'Include superseded, disputed, and retracted evidence', default: false },
      },
      required: ['query'],
    },
  },
  {
    name: 'hippo_remember',
    description: 'Store an important durable fact, decision, preference, correction, or outcome. Call this automatically after meaningful work. Skip transient chatter and debugging noise. Never store passwords, API keys, access tokens, private keys, authentication codes, or copied sensitive content. Do not ask permission or narrate routine saves.',
    inputSchema: {
      type: 'object',
      properties: {
        content:  { type: 'string', description: 'What to remember — be specific and descriptive' },
        user_id:  { type: 'string', description: 'User or project ID', default: 'default' },
        agent_id: { type: 'string', description: 'Agent ID (optional)' },
        type:     { type: 'string', enum: ['preference','behavioral','long_term','conversation','event'], default: 'long_term' },
        memory_key: { type: 'string', description: 'Stable key for a fact or preference that may change' },
        source_kind: { type: 'string', enum: ['user','agent','tool','import'], default: 'user' },
        source_ref: { type: 'string', description: 'Optional source message, URL, file, or event identifier' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        valid_from: { type: 'string', description: 'ISO timestamp when this became true' },
        valid_until: { type: 'string', description: 'ISO timestamp when this stopped being true' },
        conflict_mode: { type: 'string', enum: ['supersede','dispute'], default: 'supersede' },
      },
      required: ['content'],
    },
  },
  {
    name: 'hippo_status',
    description: 'Check Hippo Core memory system status and statistics.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hippo_history',
    description: 'Inspect the complete evidence history for one logical memory key.',
    inputSchema: { type: 'object', properties: {
      memory_key: { type: 'string' }, user_id: { type: 'string', default: 'default' }, org_id: { type: 'string' },
    }, required: ['memory_key'] },
  },
  {
    name: 'hippo_resolve',
    description: 'Resolve disputed memories by selecting a winner while preserving losing evidence.',
    inputSchema: { type: 'object', properties: {
      winner_id: { type: 'string' }, loser_ids: { type: 'array', items: { type: 'string' } }, actor: { type: 'string' },
    }, required: ['winner_id'] },
  },
  {
    name: 'hippo_retract',
    description: 'Retract a memory without deleting its audit history.',
    inputSchema: { type: 'object', properties: {
      memory_id: { type: 'string' }, reason: { type: 'string' },
    }, required: ['memory_id'] },
  },
];

async function handleToolCall(id, toolName, args) {
  const config = loadConfig();
  const { addMemory, addMemories, queryMemories, getMetrics, getMemoryHistory, resolveConflict, retractMemory } = await import('../services/memory.js');
  const { buildMemoryContext } = await import('../services/ai.js');
  const { getDb, saveDb } = await import('../db/sqlite.js');
  const { v4: uuidv4 } = await import('uuid');

  const t0 = Date.now();

  try {
    if (toolName === 'hippo_recall') {
      const { query, user_id = 'default', agent_id, org_id, scope = 'user', limit = 5, include_history = false } = args;
      if (!query) return replyError(id, -32602, 'query is required');

      const memories = await queryMemories({ user_id, agent_id, org_id, query, limit, scope, include_history }, config);
      const retrieval_ms = Date.now() - t0;

      // Count tokens actually injected
      let tokens_injected = 0;
      let responseText = '';

      if (!memories.length) {
        responseText = `No relevant memories found for: "${query}"\n\nThis may be the first time working on this topic. I'll remember what we work on today.`;
      } else {
        const context = buildMemoryContext(memories, config.maxMemoryTokens || 800);
        tokens_injected = estimateTokens(context);
        const summary = memories.map((m, i) =>
          `[${i+1}] (${m.type}, status: ${m.status}, score: ${m.blended.toFixed(3)}, source: ${m.provenance.source_kind}) ${m.content.slice(0, 200)}`
        ).join('\n');
        responseText = `Retrieved ${memories.length} relevant memories (${tokens_injected} tokens of context):\n\n${summary}\n\n---\n${context}`;
      }

      // Log to request_log for dashboard
      try {
        const db = await getDb(config.dbPath);
        db.exec({
          sql: `INSERT INTO request_log (id, user_id, agent_id, org_id, framework, query, memories_retrieved, tokens_injected, retrieval_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bind: [uuidv4(), user_id, agent_id || 'default', org_id || 'default', 'mcp', query.slice(0, 200), memories.length, tokens_injected, retrieval_ms],
        });
        saveDb();
      } catch {}

      return reply(id, { content: [{ type: 'text', text: responseText }] });
    }

    if (toolName === 'hippo_remember') {
      const { content, user_id = 'default', agent_id, org_id, type = 'long_term', ...trust } = args;
      if (!content) return replyError(id, -32602, 'content is required');

      const memory = trust.memory_key
        ? await addMemory({ user_id, agent_id, org_id, type, content, ...trust }, config)
        : await addMemories({ user_id, agent_id, org_id, type, content, ...trust }, config);
      const retrieval_ms = Date.now() - t0;

      // Log to request_log
      try {
        const db = await getDb(config.dbPath);
        db.exec({
          sql: `INSERT INTO request_log (id, user_id, agent_id, org_id, framework, query, memories_retrieved, tokens_injected, retrieval_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bind: [uuidv4(), user_id, agent_id || 'default', org_id || 'default', 'mcp', 'remember: ' + content.slice(0, 100), 0, 0, retrieval_ms],
        });
        saveDb();
      } catch {}

      const stored = memory.memories || (memory.id ? [memory] : []);
      const message = memory.skipped
        ? `Skipped memory: ${memory.reason}`
        : `✓ Stored ${stored.length} atomic ${stored.length === 1 ? 'memory' : 'memories'}${stored.map(item => item.memory_key).filter(Boolean).length ? ` (${stored.map(item => item.memory_key).filter(Boolean).join(', ')})` : ''}`;
      return reply(id, { content: [{ type: 'text', text: message }] });
    }

    if (toolName === 'hippo_history') {
      const history = await getMemoryHistory(args, config);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] });
    }

    if (toolName === 'hippo_resolve') {
      const result = await resolveConflict(args, config);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    }

    if (toolName === 'hippo_retract') {
      const result = await retractMemory(args.memory_id, args.reason || '', config);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    }

    if (toolName === 'hippo_status') {
      const metrics = await getMetrics(config);
      const lines = [
        '🦛 Hippo Core Memory Status',
        `Memories stored: ${metrics.total_memories}`,
        `Users: ${metrics.total_users}`,
        `Agents: ${metrics.total_agents}`,
        `Total recalls: ${metrics.total_retrievals}`,
        `Database: ${config.dbPath}`,
      ];
      return reply(id, { content: [{ type: 'text', text: lines.join('\n') }] });
    }

    replyError(id, -32601, `Unknown tool: ${toolName}`);

  } catch (err) {
    reply(id, {
      content: [{ type: 'text', text: `Hippo Core error: ${err.message}\n\nRun: npx @hippo-core/core setup` }],
      isError: true,
    });
  }
}

// ── Message loop ──────────────────────────────────────────────────────────────

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (!id && method === 'notifications/initialized') continue;
    switch (method) {
      case 'initialize':
        reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hippo-core', version: VERSION } });
        break;
      case 'tools/list':
        reply(id, { tools: TOOLS });
        break;
      case 'tools/call':
        await handleToolCall(id, params?.name, params?.arguments || {});
        break;
      case 'ping':
        reply(id, {});
        break;
      default:
        if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
