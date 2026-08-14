import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { VERSION, getHippoHome, getConfigPath, getDefaultDbPath, publicConfig } from '../config.js';
import { getDb, closeDb } from '../db/sqlite.js';

const JSON_CLIENTS = {
  'claude-code': {
    label: 'Claude Code',
    path: home => join(home, '.claude.json'),
  },
  cursor: {
    label: 'Cursor',
    path: home => join(home, '.cursor', 'mcp.json'),
  },
};

function codexPath(home) {
  return join(home, '.codex', 'config.toml');
}

function launcher() {
  return {
    command: 'npx',
    args: ['-y', `@hippo-core/core@${VERSION}`, 'mcp'],
  };
}

function parseJsonFile(path) {
  if (!existsSync(path)) return {};
  const source = readFileSync(path, 'utf8').trim();
  if (!source) return {};
  const parsed = JSON.parse(source);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

function backup(path, dryRun) {
  if (!existsSync(path) || dryRun) return null;
  const backupPath = `${path}.hippo-backup`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function writeJsonClient(id, options) {
  const client = JSON_CLIENTS[id];
  const path = client.path(options.home);
  const config = parseJsonFile(path);
  config.mcpServers = config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers
    : {};
  config.mcpServers['hippo-core'] = launcher();

  const changed = JSON.stringify(parseJsonFile(path)) !== JSON.stringify(config);
  let backupPath = null;
  if (changed && !options.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    backupPath = backup(path, false);
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  return { id, label: client.label, path, changed, backupPath };
}

const CODEX_START = '# >>> hippo-core managed';
const CODEX_END = '# <<< hippo-core managed';

function codexBlock() {
  const spec = launcher();
  return [
    CODEX_START,
    '[mcp_servers.hippo-core]',
    `command = ${JSON.stringify(spec.command)}`,
    `args = ${JSON.stringify(spec.args)}`,
    CODEX_END,
  ].join('\n');
}

function writeCodex(options) {
  const path = codexPath(options.home);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const managedPattern = new RegExp(`${CODEX_START}[\\s\\S]*?${CODEX_END}\\s*`, 'g');
  const withoutManaged = current.replace(managedPattern, '').trimEnd();
  if (!current.includes(CODEX_START) && /^\[mcp_servers\.hippo-core\]\s*$/m.test(current)) {
    return {
      id: 'codex',
      label: 'Codex',
      path,
      changed: false,
      backupPath: null,
      note: 'existing unmanaged hippo-core entry preserved',
    };
  }
  const next = `${withoutManaged}${withoutManaged ? '\n\n' : ''}${codexBlock()}\n`;
  const changed = current !== next;
  let backupPath = null;
  if (changed && !options.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    backupPath = backup(path, false);
    writeFileSync(path, next, { mode: 0o600 });
  }
  return { id: 'codex', label: 'Codex', path, changed, backupPath };
}

export function supportedClients() {
  return ['codex', ...Object.keys(JSON_CLIENTS)];
}

export function detectClients(home = homedir()) {
  const detected = [];
  if (existsSync(join(home, '.codex'))) detected.push('codex');
  if (existsSync(join(home, '.claude')) || existsSync(join(home, '.claude.json'))) detected.push('claude-code');
  if (existsSync(join(home, '.cursor'))) detected.push('cursor');
  return detected;
}

export async function install(options = {}) {
  const home = options.home || homedir();
  const env = { ...process.env, ...(options.env || {}) };
  const dryRun = Boolean(options.dryRun);
  const requested = options.clients?.length ? options.clients : detectClients(home);
  const clients = [...new Set(requested)];
  const invalid = clients.filter(id => !supportedClients().includes(id));
  if (invalid.length) throw new Error(`Unsupported client: ${invalid.join(', ')}`);

  // Validate all user-owned files before creating the vault or changing a
  // client, so malformed JSON cannot leave a partial multi-client install.
  for (const id of clients) {
    if (id !== 'codex') parseJsonFile(JSON_CLIENTS[id].path(home));
  }

  const hippoHome = getHippoHome(env);
  const configPath = getConfigPath(env);
  const dbPath = getDefaultDbPath(env);
  if (!dryRun) {
    mkdirSync(hippoHome, { recursive: true });
    if (!existsSync(configPath)) {
      writeFileSync(configPath, `${JSON.stringify(publicConfig({
        provider: 'openai',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        embeddingModel: 'text-embedding-3-small',
        dbPath,
      }), null, 2)}\n`, { mode: 0o600 });
    }
    await getDb(dbPath);
    closeDb();
  }

  const writeOptions = { home, dryRun };
  const results = clients.map(id => id === 'codex'
    ? writeCodex(writeOptions)
    : writeJsonClient(id, writeOptions));

  return { hippoHome, configPath, dbPath, dryRun, detected: detectClients(home), clients: results };
}
