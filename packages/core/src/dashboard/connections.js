// src/dashboard/connections.js
// Hippo Core — Connection manager v4
//
// STRICT RULE: A framework is only "installed" if its BINARY EXISTS.
// We NEVER use config files or directories we created as proof of installation.
// "Connected" = binary exists AND MCP entry is in the config.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';

const HOME   = homedir();
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

const MCP_ENTRY = {
  command: IS_WIN ? 'cmd' : 'npx',
  args:    IS_WIN ? ['/c', 'npx', '@hippo-core/core', 'mcp'] : ['@hippo-core/core', 'mcp'],
};

// ── Core helpers ──────────────────────────────────────────────────────────────

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, data) {
  mkdirSync(p.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

function findFirst(paths) {
  return paths.find(p => existsSync(p)) || null;
}

// ONLY check for actual binary executables — never config files we created
function binaryExists(cmd) {
  try {
    execSync(IS_WIN ? `where.exe ${cmd}` : `which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// Check for actual app binary on disk (not config dirs)
function exeExists(...paths) {
  return paths.some(p => p && existsSync(p));
}

function npmInstall(pkg, cwd) {
  execSync(`npm install ${pkg}`, { cwd, stdio: 'pipe', shell: IS_WIN });
}

// ── OpenClaw ──────────────────────────────────────────────────────────────────

function isOpenClawInstalled() {
  // Only trust actual binaries
  return binaryExists('openclaw') || binaryExists('openclaw-gateway') ||
    exeExists(
      join(HOME, 'AppData', 'Local', 'Programs', 'openclaw', 'openclaw.exe'),
      join(HOME, 'AppData', 'Local', 'Programs', 'OpenClaw', 'OpenClaw.exe'),
      '/Applications/OpenClaw.app/Contents/MacOS/OpenClaw',
      '/usr/local/bin/openclaw'
    );
}

function openClawConfigPath() {
  return findFirst([
    join(HOME, '.openclaw', 'openclaw.json'),
    join(HOME, '.config', 'openclaw', 'openclaw.json'),
    join(HOME, 'AppData', 'Roaming', 'openclaw', 'openclaw.json'),
  ]);
}

export function getOpenClawStatus() {
  if (!isOpenClawInstalled()) return { connected: false, installed: false, reason: 'Not installed' };
  const p = openClawConfigPath();
  if (!p) return { connected: false, installed: true, reason: 'Not connected' };
  const cfg = readJson(p) || {};
  const wired = !!(cfg.mcpServers?.['hippo-core'] || cfg.mcp?.servers?.['hippo-core']);
  return { connected: wired, installed: true, configPath: p, reason: wired ? 'Connected' : 'Not connected' };
}

export function connectOpenClaw() {
  if (!isOpenClawInstalled()) return { success: false, reason: 'OpenClaw binary not found on this machine.' };
  let p = openClawConfigPath();
  if (!p) {
    p = join(HOME, '.openclaw', 'openclaw.json');
    mkdirSync(join(HOME, '.openclaw'), { recursive: true });
    writeJson(p, { mcpServers: {} });
  }
  const cfg = readJson(p) || {};
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers['hippo-core'] = MCP_ENTRY;
  writeJson(p, cfg);
  return { success: true, configPath: p };
}

export function disconnectOpenClaw() {
  const p = openClawConfigPath();
  if (!p) return { success: false };
  const cfg = readJson(p) || {};
  delete cfg?.mcpServers?.['hippo-core'];
  writeJson(p, cfg);
  return { success: true };
}

// ── Paperclip ─────────────────────────────────────────────────────────────────

function isPaperclipInstalled() {
  // Only trust the actual CLI binary
  return binaryExists('paperclipai') ||
    exeExists(
      join(HOME, 'AppData', 'Roaming', 'npm', 'paperclipai.cmd'),
      join(HOME, 'AppData', 'Roaming', 'npm', 'paperclipai'),
      '/usr/local/bin/paperclipai'
    );
}

function paperclipInstancePath() {
  return findFirst([
    join(HOME, '.paperclip', 'instances', 'default'),
    join(HOME, 'AppData', 'Roaming', '.paperclip', 'instances', 'default'),
  ]);
}

export function getPaperclipStatus() {
  if (!isPaperclipInstalled()) return { connected: false, installed: false, reason: 'Not installed' };
  const instancePath = paperclipInstancePath();
  if (!instancePath) return { connected: false, installed: true, reason: 'Not connected' };
  const pluginPath = join(instancePath, 'packages', 'node_modules', '@hippo-core', 'paperclip-plugin');
  const connected = existsSync(join(pluginPath, 'package.json'));
  return { connected, installed: true, instancePath, pluginPath, reason: connected ? 'Plugin installed' : 'Not connected', windowsBug: IS_WIN };
}

export async function connectPaperclip() {
  if (!isPaperclipInstalled()) return { success: false, reason: 'Paperclip binary not found on this machine.' };
  const instancePath = paperclipInstancePath();
  if (!instancePath) return { success: false, reason: 'Paperclip instance not found. Run paperclipai onboard first.' };
  const packagesPath = join(instancePath, 'packages');
  const pkgJson = join(packagesPath, 'package.json');
  mkdirSync(packagesPath, { recursive: true });
  if (!existsSync(pkgJson)) {
    writeJson(pkgJson, { name: 'paperclip-plugins', version: '1.0.0', private: true });
  }
  try {
    npmInstall('@hippo-core/paperclip-plugin', packagesPath);
    return { success: true };
  } catch (err) {
    return { success: false, reason: `Install failed on Windows. Use manual install: cd ${packagesPath} && npm install @hippo-core/paperclip-plugin` };
  }
}

// ── Hermes ────────────────────────────────────────────────────────────────────

function isHermesInstalled() {
  return binaryExists('hermes') ||
    exeExists(
      join(HOME, 'AppData', 'Local', 'Programs', 'hermes', 'hermes.exe'),
      '/Applications/Hermes.app/Contents/MacOS/Hermes',
      '/usr/local/bin/hermes'
    );
}

function hermesMcpPath() {
  return findFirst([
    join(HOME, '.hermes', 'mcp.json'),
    join(HOME, '.config', 'hermes', 'mcp.json'),
  ]);
}

export function getHermesStatus() {
  if (!isHermesInstalled()) return { connected: false, installed: false, reason: 'Not installed' };
  const mcpPath = hermesMcpPath();
  if (!mcpPath) return { connected: false, installed: true, reason: 'Not connected' };
  const cfg = readJson(mcpPath) || {};
  const wired = !!cfg.mcpServers?.['hippo-core'];
  return { connected: wired, installed: true, mcpPath, reason: wired ? 'Connected' : 'Not connected' };
}

export function connectHermes() {
  if (!isHermesInstalled()) return { success: false, reason: 'Hermes binary not found on this machine.' };
  const mcpPath = hermesMcpPath() || join(HOME, '.hermes', 'mcp.json');
  const cfg = readJson(mcpPath) || {};
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers['hippo-core'] = MCP_ENTRY;
  writeJson(mcpPath, cfg);
  return { success: true, mcpPath };
}

export function disconnectHermes() {
  const p = hermesMcpPath();
  if (!p) return { success: false };
  const cfg = readJson(p) || {};
  delete cfg?.mcpServers?.['hippo-core'];
  writeJson(p, cfg);
  return { success: true };
}

// ── Claude Desktop ────────────────────────────────────────────────────────────

function isClaudeDesktopInstalled() {
  return exeExists(
    join(HOME, 'AppData', 'Local', 'AnthropicClaude', 'claude.exe'),
    join(HOME, 'AppData', 'Local', 'AnthropicClaude', 'Update.exe'),
    '/Applications/Claude.app/Contents/MacOS/Claude',
    '/usr/local/bin/claude-desktop'
  );
}

function claudeDesktopConfigPath() {
  return findFirst(IS_WIN
    ? [join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')]
    : IS_MAC
      ? [join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]
      : [join(HOME, '.config', 'claude', 'claude_desktop_config.json')]
  );
}

export function getClaudeDesktopStatus() {
  if (!isClaudeDesktopInstalled()) return { connected: false, installed: false, reason: 'Not installed' };
  const p = claudeDesktopConfigPath();
  if (!p) return { connected: false, installed: true, reason: 'Not connected' };
  const cfg = readJson(p) || {};
  const wired = !!cfg.mcpServers?.['hippo-core'];
  return { connected: wired, installed: true, configPath: p, reason: wired ? 'Connected' : 'Not connected' };
}

export function connectClaudeDesktop() {
  if (!isClaudeDesktopInstalled()) return { success: false, reason: 'Claude Desktop binary not found.' };
  const p = claudeDesktopConfigPath();
  if (!p) return { success: false, reason: 'Open Claude Desktop once first to create the config.' };
  const cfg = readJson(p) || {};
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers['hippo-core'] = MCP_ENTRY;
  writeJson(p, cfg);
  return { success: true, configPath: p, note: 'Restart Claude Desktop to activate Hippo Core.' };
}

export function disconnectClaudeDesktop() {
  const p = claudeDesktopConfigPath();
  if (!p) return { success: false };
  const cfg = readJson(p) || {};
  delete cfg?.mcpServers?.['hippo-core'];
  writeJson(p, cfg);
  return { success: true };
}

// ── Claude Code ───────────────────────────────────────────────────────────────

function isClaudeCodeInstalled() {
  return binaryExists('claude');
}

function claudeCodeConfigPath() {
  return findFirst([
    join(HOME, '.claude', 'claude_desktop_config.json'),
    join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  ]);
}

export function getClaudeCodeStatus() {
  if (!isClaudeCodeInstalled()) return { connected: false, installed: false, reason: 'Not installed' };
  const p = claudeCodeConfigPath();
  if (!p) return { connected: false, installed: true, reason: 'Not connected' };
  const cfg = readJson(p) || {};
  const wired = !!cfg.mcpServers?.['hippo-core'];
  return { connected: wired, installed: true, configPath: p, reason: wired ? 'Connected' : 'Not connected' };
}

export function connectClaudeCode() {
  if (!isClaudeCodeInstalled()) return { success: false, reason: 'Claude Code not found. Install: npm install -g @anthropic-ai/claude-code' };
  let p = claudeCodeConfigPath();
  if (!p) {
    p = join(HOME, '.claude', 'claude_desktop_config.json');
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeJson(p, { mcpServers: {} });
  }
  const cfg = readJson(p) || {};
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers['hippo-core'] = MCP_ENTRY;
  writeJson(p, cfg);
  return { success: true, configPath: p };
}

export function disconnectClaudeCode() {
  const p = claudeCodeConfigPath();
  if (!p) return { success: false };
  const cfg = readJson(p) || {};
  delete cfg?.mcpServers?.['hippo-core'];
  writeJson(p, cfg);
  return { success: true };
}

// ── Cursor ────────────────────────────────────────────────────────────────────

function isCursorInstalled() {
  return binaryExists('cursor') ||
    exeExists(
      join(HOME, 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
      '/usr/local/bin/cursor'
    );
}

function cursorConfigPath() {
  return findFirst([
    join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'mcp.json'),
    join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json'),
    join(HOME, '.config', 'Cursor', 'User', 'mcp.json'),
    join(HOME, '.cursor', 'mcp.json'),
  ]);
}

export function getCursorStatus() {
  if (!isCursorInstalled()) return { connected: false, installed: false, reason: 'Not installed' };
  const p = cursorConfigPath();
  if (!p) return { connected: false, installed: true, reason: 'Not connected' };
  const cfg = readJson(p) || {};
  const wired = !!cfg.mcpServers?.['hippo-core'];
  return { connected: wired, installed: true, configPath: p, reason: wired ? 'Connected' : 'Not connected' };
}

export function connectCursor() {
  if (!isCursorInstalled()) return { success: false, reason: 'Cursor binary not found on this machine.' };
  let p = cursorConfigPath();
  if (!p) {
    p = IS_WIN
      ? join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'mcp.json')
      : IS_MAC ? join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json')
               : join(HOME, '.config', 'Cursor', 'User', 'mcp.json');
  }
  const cfg = readJson(p) || {};
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers['hippo-core'] = MCP_ENTRY;
  writeJson(p, cfg);
  return { success: true, configPath: p, note: 'Restart Cursor to activate Hippo Core.' };
}

export function disconnectCursor() {
  const p = cursorConfigPath();
  if (!p) return { success: false };
  const cfg = readJson(p) || {};
  delete cfg?.mcpServers?.['hippo-core'];
  writeJson(p, cfg);
  return { success: true };
}

// ── Codex ─────────────────────────────────────────────────────────────────────

function isCodexInstalled() {
  return binaryExists('codex');
}

function codexConfigPath() {
  return findFirst([
    join(HOME, '.codex', 'config.json'),
    join(HOME, 'AppData', 'Roaming', 'codex', 'config.json'),
    join(HOME, '.config', 'codex', 'config.json'),
  ]);
}

export function getCodexStatus() {
  if (!isCodexInstalled()) return { connected: false, installed: false, reason: 'Not installed' };
  const p = codexConfigPath();
  if (!p) return { connected: false, installed: true, reason: 'Not connected' };
  const cfg = readJson(p) || {};
  const wired = !!cfg.mcpServers?.['hippo-core'];
  return { connected: wired, installed: true, configPath: p, reason: wired ? 'Connected' : 'Not connected' };
}

export function connectCodex() {
  if (!isCodexInstalled()) return { success: false, reason: 'Codex not found. Install: npm install -g @openai/codex' };
  let p = codexConfigPath();
  if (!p) {
    p = join(HOME, '.codex', 'config.json');
    mkdirSync(join(HOME, '.codex'), { recursive: true });
    writeJson(p, { mcpServers: {} });
  }
  const cfg = readJson(p) || {};
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers['hippo-core'] = MCP_ENTRY;
  writeJson(p, cfg);
  return { success: true, configPath: p };
}

export function disconnectCodex() {
  const p = codexConfigPath();
  if (!p) return { success: false };
  const cfg = readJson(p) || {};
  delete cfg?.mcpServers?.['hippo-core'];
  writeJson(p, cfg);
  return { success: true };
}

// ── All statuses ──────────────────────────────────────────────────────────────

export function getAllConnectionStatuses() {
  return {
    openclaw:       getOpenClawStatus(),
    paperclip:      getPaperclipStatus(),
    hermes:         getHermesStatus(),
    claude_desktop: getClaudeDesktopStatus(),
    claude_code:    getClaudeCodeStatus(),
    cursor:         getCursorStatus(),
    codex:          getCodexStatus(),
  };
}
