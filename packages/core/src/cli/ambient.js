import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AMBIENT_START = '<!-- >>> hippo-core ambient memory >>> -->';
export const AMBIENT_END = '<!-- <<< hippo-core ambient memory <<< -->';

export const AMBIENT_POLICY = `${AMBIENT_START}
## Hippo Core ambient memory

Use Hippo Core automatically. Do not wait for the user to request memory actions.

- At the start of every meaningful task, before substantive work, call \`hippo_recall\` with a short description of the task. Use user scope by default so useful context transfers between agents.
- At the end of a meaningful task, call \`hippo_remember\` once with a concise outcome: decisions made, durable facts learned, user preferences, and what should happen next.
- Remember stable preferences, corrections, commitments, and important project context when they appear, even before task completion.
- Use agent-private scope only when the memory truly belongs to one agent. Otherwise prefer shared user memory.
- Do not ask for permission for routine recall or remember calls, and do not narrate those background calls unless they fail or affect the answer.
- Never store passwords, API keys, access tokens, private keys, authentication codes, or copied sensitive content.
- Skip greetings, casual chat, temporary debugging output, failed experiments, and details already obvious from source control.
- If Hippo Core is unavailable, continue the task normally and mention the failure only when it matters to the user.
${AMBIENT_END}`;

function backup(path, dryRun) {
  if (!existsSync(path) || dryRun) return null;
  const backupPath = `${path}.hippo-backup`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function mergeManagedBlock(current) {
  const pattern = new RegExp(`${AMBIENT_START}[\\s\\S]*?${AMBIENT_END}\\s*`, 'g');
  const clean = current.replace(pattern, '').trimEnd();
  return `${clean}${clean ? '\n\n' : ''}${AMBIENT_POLICY}\n`;
}

function instructionTarget(client, home) {
  if (client === 'codex') {
    const override = join(home, '.codex', 'AGENTS.override.md');
    if (existsSync(override) && readFileSync(override, 'utf8').trim()) return override;
    return join(home, '.codex', 'AGENTS.md');
  }
  if (client === 'claude-code') return join(home, '.claude', 'CLAUDE.md');
  if (client === 'cursor') return join(home, '.cursor', 'rules', 'hippo-core.mdc');
  throw new Error(`Unsupported ambient-memory client: ${client}`);
}

function cursorContent() {
  return `---\ndescription: Hippo Core ambient cross-agent memory\nalwaysApply: true\n---\n\n${AMBIENT_POLICY}\n`;
}

export function installAmbientPolicy(client, options) {
  const path = instructionTarget(client, options.home);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = client === 'cursor' ? cursorContent() : mergeManagedBlock(current);
  const changed = current !== next;
  let backupPath = null;
  if (changed && !options.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    backupPath = backup(path, false);
    writeFileSync(path, next, { mode: 0o600 });
  }
  return { path, changed, backupPath };
}

export function uninstallAmbientPolicy(client, options) {
  const path = instructionTarget(client, options.home);
  if (!existsSync(path)) return { path, changed: false, backupPath: null };
  const current = readFileSync(path, 'utf8');
  if (client === 'cursor') {
    if (!current.includes(AMBIENT_START)) return { path, changed: false, backupPath: null };
    if (!options.dryRun) rmSync(path, { force: true });
    return { path, changed: true, backupPath: null };
  }
  const pattern = new RegExp(`${AMBIENT_START}[\\s\\S]*?${AMBIENT_END}\\s*`, 'g');
  const next = current.replace(pattern, '').trimEnd();
  const output = next ? `${next}\n` : '';
  const changed = current !== output;
  if (changed && !options.dryRun) writeFileSync(path, output, { mode: 0o600 });
  return { path, changed, backupPath: null };
}
