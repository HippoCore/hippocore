#!/usr/bin/env node
// packages/core/src/mcp/server.js
// Hippo Core MCP Server — exposes memory as tools to any MCP-compatible agent
// Works with Claude Code, OpenClaw, Cursor, Hermes, Codex, Claude Desktop

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ALWAYS use home directory — all agents share the same memory store
const HOME        = homedir();
const CONFIG_PATH = join(HOME, '.hippo-core', 'config.json');
const DEFAULT_DB  = join(HOME, '.hippo-core', 'memory.db');

function loadConfig() {
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
    description: 'Retrieve relevant memories for the current task. Call this AUTOMATICALLY at the start of every task to get context from past work, decisions, and user preferences. Do not ask the user — just call it.',
    inputSchema: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Describe the current task or topic to find relevant memories' },
        user_id:  { type: 'string', description: 'User or project ID', default: 'default' },
        agent_id: { type: 'string', description: 'Agent ID for scoping (optional)' },
        scope:    { type: 'string', enum: ['user','agent','org'], default: 'user' },
        limit:    { type: 'number', description: 'Max memories to return (default: 5)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'hippo_remember',
    description: 'Store an important fact, decision, preference, or outcome. Call this AUTOMATICALLY at the end of tasks, when you learn something important, or when the user shares preferences. Do not ask the user — just call it.',
    inputSchema: {
      type: 'object',
      properties: {
        content:  { type: 'string', description: 'What to remember — be specific and descriptive' },
        user_id:  { type: 'string', description: 'User or project ID', default: 'default' },
        agent_id: { type: 'string', description: 'Agent ID (optional)' },
        type:     { type: 'string', enum: ['preference','behavioral','long_term','conversation','event'], default: 'long_term' },
      },
      required: ['content'],
    },
  },
  {
    name: 'hippo_status',
    description: 'Check Hippo Core memory system status and statistics.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(id, toolName, args) {
  const config = loadConfig();
  const { addMemory, queryMemories, getMetrics } = await import('../services/memory.js');
  const { buildMemoryContext } = await import('../services/ai.js');
  const { getDb, saveDb } = await import('../db/sqlite.js');
  const { v4: uuidv4 } = await import('uuid');

  const t0 = Date.now();

  try {
    if (toolName === 'hippo_recall') {
      const { query, user_id = 'default', agent_id, org_id, scope = 'user', limit = 5 } = args;
      if (!query) return replyError(id, -32602, 'query is required');

      const memories = await queryMemories({ user_id, agent_id, org_id, query, limit, scope }, config);
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
          `[${i+1}] (${m.type}, relevance: ${m.similarity.toFixed(3)}) ${m.content.slice(0, 200)}`
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
      const { content, user_id = 'default', agent_id, org_id, type = 'long_term' } = args;
      if (!content) return replyError(id, -32602, 'content is required');

      const memory = await addMemory({ user_id, agent_id, org_id, type, content }, config);
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

      return reply(id, { content: [{ type: 'text', text: `✓ Stored memory: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"` }] });
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
        reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hippo-core', version: '0.6.0' } });
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
