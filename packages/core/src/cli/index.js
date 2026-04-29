#!/usr/bin/env node
// packages/core/src/cli/index.js
// Hippo Core CLI — setup wizard and status checker
// Run: npx @hippo-core/core setup
//      npx @hippo-core/core status

import { createInterface } from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const CONFIG_PATH = join(process.cwd(), '.hippo-core', 'config.json');
const DB_PATH     = join(process.cwd(), '.hippo-core', 'memory.db');

// ── Colours ───────────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

const tick  = `${c.green}✓${c.reset}`;
const cross = `${c.red}✗${c.reset}`;
const arrow = `${c.gray}→${c.reset}`;

function bold(s)   { return `${c.bold}${s}${c.reset}`; }
function dim(s)    { return `${c.dim}${s}${c.reset}`; }
function green(s)  { return `${c.green}${s}${c.reset}`; }
function red(s)    { return `${c.red}${s}${c.reset}`; }
function cyan(s)   { return `${c.cyan}${s}${c.reset}`; }
function gray(s)   { return `${c.gray}${s}${c.reset}`; }
function yellow(s) { return `${c.yellow}${s}${c.reset}`; }

// ── Providers ─────────────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    id:             'openai',
    name:           'OpenAI',
    description:    'GPT-4o, GPT-4o-mini — most popular',
    baseURL:        'https://api.openai.com/v1',
    model:          'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    needsKey:       true,
    keyHint:        'Get your key at platform.openai.com',
  },
  {
    id:             'openrouter',
    name:           'OpenRouter',
    description:    'Access 100+ models with one API key',
    baseURL:        'https://openrouter.ai/api/v1',
    model:          'openai/gpt-4o-mini',
    embeddingModel: 'openai/text-embedding-3-small',
    needsKey:       true,
    keyHint:        'Get your key at openrouter.ai',
  },
  {
    id:             'ollama',
    name:           'Ollama (local)',
    description:    'Free, private, runs on your machine — no API key needed',
    baseURL:        'http://localhost:11434/v1',
    model:          'llama3.2',
    embeddingModel: 'nomic-embed-text',
    needsKey:       false,
    keyHint:        'Install Ollama at ollama.com then run: ollama pull llama3.2 && ollama pull nomic-embed-text',
  },
  {
    id:             'groq',
    name:           'Groq',
    description:    'Very fast inference, generous free tier',
    baseURL:        'https://api.groq.com/openai/v1',
    model:          'llama-3.1-8b-instant',
    embeddingModel: 'text-embedding-3-small',
    needsKey:       true,
    keyHint:        'Get your key at console.groq.com',
  },
  {
    id:             'lmstudio',
    name:           'LM Studio (local)',
    description:    'Local models with a desktop UI — no API key needed',
    baseURL:        'http://localhost:1234/v1',
    model:          'local-model',
    embeddingModel: 'local-model',
    needsKey:       false,
    keyHint:        'Download LM Studio at lmstudio.ai and start the local server',
  },
  {
    id:             'custom',
    name:           'Custom / Other',
    description:    'Any OpenAI-compatible API endpoint',
    baseURL:        '',
    model:          '',
    embeddingModel: '',
    needsKey:       true,
    keyHint:        'Enter your provider details manually',
  },
];

// ── Input helpers ─────────────────────────────────────────────────────────────
function ask(rl, question, defaultVal = '') {
  return new Promise(resolve => {
    const hint = defaultVal ? gray(` (${defaultVal})`) : '';
    rl.question(`  ${cyan('?')} ${question}${hint}: `, answer => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function askSecret(rl, question) {
  // Try raw mode for hidden input, fall back to normal
  return new Promise(resolve => {
    try {
      process.stdout.write(`  ${cyan('?')} ${question}: `);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let input = '';
      function handler(ch) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(input);
        } else if (ch === '\u0003') {
          process.exit();
        } else if (ch === '\u007f') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += ch;
          process.stdout.write('*');
        }
      }
      stdin.on('data', handler);
    } catch {
      // Raw mode not available — fall back to visible input
      rl.question(`  ${cyan('?')} ${question}: `, answer => {
        resolve(answer.trim());
      });
    }
  });
}

function askNumber(rl, question, min, max) {
  return new Promise(resolve => {
    function prompt() {
      rl.question(`  ${cyan('?')} ${question} (${min}-${max}): `, answer => {
        const n = parseInt(answer.trim(), 10);
        if (n >= min && n <= max) {
          resolve(n);
        } else {
          console.log(`  ${yellow('!')} Please enter a number between ${min} and ${max}`);
          prompt();
        }
      });
    }
    prompt();
  });
}

// ── Step runner ───────────────────────────────────────────────────────────────
async function step(label, fn) {
  const padded = label.padEnd(44);
  process.stdout.write(`  ${arrow} ${padded}`);
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    const detail = result ? gray(` ${result}`) : '';
    process.stdout.write(`${tick}${detail} ${gray(`(${ms}ms)`)}\n`);
    return { ok: true };
  } catch (err) {
    process.stdout.write(`${cross} ${red(err.message)}\n`);
    return { ok: false, error: err.message };
  }
}

// ── Header ────────────────────────────────────────────────────────────────────
function header(title) {
  console.log('');
  console.log(bold('🦛 Hippo Core') + gray(' — ' + title));
  console.log(gray('━'.repeat(50)));
  console.log('');
}

// ── SETUP ─────────────────────────────────────────────────────────────────────
async function runSetup() {
  header('Setup Wizard');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let existing = {};
  if (existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
    console.log(dim('  Found existing config. Press Enter to keep current values.\n'));
  }

  // ── Provider selection ──
  console.log('  Choose your AI provider:\n');
  PROVIDERS.forEach((p, i) => {
    const num    = cyan(`  [${i + 1}]`);
    const name   = bold(p.name.padEnd(22));
    const desc   = gray(p.description);
    const local  = p.needsKey ? '' : yellow(' ★ no API key needed');
    console.log(`${num} ${name} ${desc}${local}`);
  });
  console.log('');

  const providerIdx = await askNumber(rl, 'Select provider', 1, PROVIDERS.length);
  const provider    = PROVIDERS[providerIdx - 1];

  console.log('');
  console.log(`  ${tick} Selected: ${bold(provider.name)}`);

  if (provider.needsKey === false) {
    console.log(`  ${yellow('!')} ${provider.keyHint}`);
    console.log('');
  }

  // ── API Key ──
  let apiKey = '';
  if (provider.needsKey) {
    console.log(`  ${gray(provider.keyHint)}`);
    apiKey = await askSecret(rl, 'API key (input hidden)');
    if (!apiKey) {
      console.log('\n  ' + red('API key is required for this provider.'));
      rl.close();
      process.exit(1);
    }
  } else {
    apiKey = 'local';
  }

  // ── Model / URL (show defaults, allow override) ──
  console.log('');
  let baseURL        = provider.baseURL;
  let model          = provider.model;
  let embeddingModel = provider.embeddingModel;

  if (provider.id === 'custom') {
    baseURL        = await ask(rl, 'API base URL', existing.baseURL || '');
    model          = await ask(rl, 'Chat model', existing.model || '');
    embeddingModel = await ask(rl, 'Embedding model', existing.embeddingModel || '');
  } else {
    // Show defaults and allow override
    baseURL        = await ask(rl, 'API base URL', provider.baseURL);
    model          = await ask(rl, 'Chat model', provider.model);
    embeddingModel = await ask(rl, 'Embedding model', provider.embeddingModel);
  }

  const dbPath = await ask(rl, 'Memory file location', '.hippo-core/memory.db');
  rl.close();

  const config = {
    apiKey,
    baseURL,
    model,
    embeddingModel,
    dbPath: join(process.cwd(), dbPath),
    provider: provider.id,
  };

  // ── Run tests ──
  console.log('');
  console.log(gray('  Running checks...\n'));

  let passed = 0;
  let failed = 0;

  const track = (r) => { r.ok ? passed++ : failed++; return r; };

  await track(await step('Creating memory directory...', async () => {
    mkdirSync(join(process.cwd(), '.hippo-core'), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }));

  if (provider.id !== 'ollama' && provider.id !== 'lmstudio') {
    await track(await step('Connecting to AI provider...', async () => {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
      await client.models.list();
      return 'connected';
    }));
  }

  let testEmbedding = null;
  await track(await step('Generating test embedding...', async () => {
    const { embed } = await import('../services/ai.js');
    testEmbedding = await embed('Hippo Core memory test', config);
    if (!testEmbedding?.length) throw new Error('Empty embedding returned');
    return `${testEmbedding.length} dimensions`;
  }));

  await track(await step('Testing AI extraction...', async () => {
    const { extractStructured } = await import('../services/ai.js');
    const r = await extractStructured(
      'Sarah prefers fixed rate mortgages and has a budget of $400k.',
      config
    );
    if (!r?.facts) throw new Error('No structured data returned');
    return `${r.facts.length} facts extracted`;
  }));

  let testId = null;
  await track(await step('Storing test memory...', async () => {
    const { addMemory } = await import('../services/memory.js');
    const m = await addMemory({
      user_id: '__hippo_test__',
      type:    'preference',
      content: 'Hippo Core setup test memory.',
    }, config);
    testId = m.id;
    return `id: ${m.id.slice(0, 8)}...`;
  }));

  await track(await step('Retrieving by similarity...', async () => {
    const { queryMemories } = await import('../services/memory.js');
    const results = await queryMemories({
      user_id: '__hippo_test__',
      query:   'test memory setup',
      limit:   1,
    }, config);
    if (!results.length) throw new Error('No results returned');
    return `similarity: ${results[0].similarity}`;
  }));

  await step('Cleaning up test data...', async () => {
    if (testId) {
      const { deleteMemory } = await import('../services/memory.js');
      await deleteMemory(testId, config);
    }
  });

  // ── Summary ──
  console.log('');
  console.log(gray('  ' + '━'.repeat(50)));
  console.log('');

  if (failed === 0) {
    console.log(`  ${green('✓ All checks passed. Hippo Core is ready.')}`);
    console.log('');
    console.log(`  Provider:  ${bold(provider.name)}`);
    console.log(`  Model:     ${gray(model)}`);
    console.log(`  Memory:    ${gray(config.dbPath)}`);
    console.log('');
    console.log('  Add memory to your agent:\n');
    console.log(cyan("  import { createMemory } from '@hippo-core/core';"));
    console.log(cyan("  const memory = createMemory({ apiKey: 'your-key' });"));
    console.log('');
    console.log(gray("  Run 'npx @hippo-core/core status' anytime to check.\n"));
  } else {
    console.log(`  ${red(`✗ ${failed} check(s) failed.`)} ${gray(`${passed} passed.`)}`);
    console.log('');
    if (provider.id === 'ollama') {
      console.log(yellow('  Make sure Ollama is running: ollama serve'));
      console.log(yellow('  And the models are pulled:'));
      console.log(yellow(`    ollama pull ${model}`));
      console.log(yellow(`    ollama pull ${embeddingModel}`));
    } else {
      console.log(gray('  Check your API key and try again: npx @hippo-core/core setup'));
    }
    console.log('');
    process.exit(1);
  }
}

// ── STATUS ────────────────────────────────────────────────────────────────────
async function runStatus() {
  header('Status');

  const hasConfig = existsSync(CONFIG_PATH);
  const hasDb     = existsSync(DB_PATH);

  console.log(`  ${arrow} Config file       ${hasConfig ? tick + ' ' + gray(CONFIG_PATH) : cross + ' ' + red('Not found — run setup first')}`);
  console.log(`  ${arrow} Memory database   ${hasDb ? tick + ' ' + gray(DB_PATH) : gray('Not created yet')}`);

  if (!hasConfig) {
    console.log('');
    console.log(gray("  Run 'npx @hippo-core/core setup' to get started.\n"));
    return;
  }

  let config = {};
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.log('  ' + red('Could not read config file.'));
    return;
  }

  const providerName = PROVIDERS.find(p => p.id === config.provider)?.name || config.provider || 'Unknown';

  console.log(`  ${arrow} Provider          ${tick} ${gray(providerName)}`);
  console.log(`  ${arrow} Model             ${tick} ${gray(config.model || 'not set')}`);
  console.log(`  ${arrow} Embedding model   ${tick} ${gray(config.embeddingModel || 'not set')}`);
  console.log(`  ${arrow} API endpoint      ${tick} ${gray(config.baseURL || 'not set')}`);
  console.log(`  ${arrow} API key           ${tick} ${gray(config.apiKey && config.apiKey !== 'local' ? '***' + config.apiKey.slice(-4) : config.apiKey || 'not set')}`);

  process.stdout.write(`  ${arrow} API connection    `);
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    await client.models.list();
    process.stdout.write(`${tick} ${gray('connected')}\n`);
  } catch (err) {
    process.stdout.write(`${cross} ${red(err.message)}\n`);
  }

  console.log('');
  console.log(gray('  ' + '━'.repeat(50)));
  console.log(`\n  ${green('🦛 Hippo Core is running.')}\n`);
}


// ── RE-EMBED COMMAND ──────────────────────────────────────────────────────────
async function runReEmbed() {
  header('Re-Embed Migration');

  if (!existsSync(CONFIG_PATH)) {
    console.log(red('  No config found. Run setup first.'));
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

  console.log(`  ${arrow} Current embedding model: ${bold(config.embeddingModel || 'text-embedding-3-small')}`);
  console.log(`  ${arrow} Database: ${gray(config.dbPath || '.hippo-core/memory.db')}`);
  console.log('');
  console.log(yellow('  ⚠  This will re-generate ALL embeddings using the current model.'));
  console.log(yellow('     This is needed when switching embedding models.'));
  console.log(gray('     It may cost API credits if using a paid provider.'));
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await ask(rl, 'Continue? (yes/no)', 'no');
  rl.close();

  if (confirm.toLowerCase() !== 'yes') {
    console.log(gray('\n  Cancelled.\n'));
    return;
  }

  console.log('');
  const { reEmbedAll } = await import('../services/memory.js');

  let lastPct = -1;
  const result = await reEmbedAll(config, (done, total) => {
    const pct = Math.floor(done / total * 100);
    if (pct !== lastPct) {
      process.stdout.write(`\r  ${arrow} Re-embedding... ${pct}% (${done}/${total})`);
      lastPct = pct;
    }
  });

  console.log(`\n\n  ${tick} Re-embedded ${result.done} of ${result.total} memories.\n`);
}

// ── DASHBOARD COMMAND ────────────────────────────────────────────────────────
async function runDashboard() {
  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  }
  const { startDashboard } = await import('../dashboard/server.js');
  const port = config.dashboardPort || 4444;
  await startDashboard(config);
  console.log(gray('  Press Ctrl+C to stop.'));
}

// ── Entry point ───────────────────────────────────────────────────────────────
const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch(err => { console.error(red(err.message)); process.exit(1); });
} else if (command === 'status') {
  runStatus().catch(err => { console.error(red(err.message)); process.exit(1); });
} else if (command === 're-embed') {
  runReEmbed().catch(err => { console.error(red(err.message)); process.exit(1); });
} else if (command === 'dashboard') {
  runDashboard().catch(err => { console.error(red(err.message)); process.exit(1); });
} else {
  console.log('');
  console.log(bold('🦛 Hippo Core'));
  console.log('');
  console.log('  Commands:');
  console.log(`  ${cyan('npx @hippo-core/core setup')}      — first-time setup and connection test`);
  console.log(`  ${cyan('npx @hippo-core/core status')}     — check if everything is running`);
  console.log(`  ${cyan('npx @hippo-core/core dashboard')}   — open developer monitoring dashboard`);
  console.log(`  ${cyan('npx @hippo-core/core re-embed')}   — migrate embeddings after changing model`);
  console.log('');
  console.log('  Supported providers:');
  PROVIDERS.forEach(p => {
    const local = !p.needsKey ? yellow(' ★ no key needed') : '';
    console.log(`  ${gray('·')} ${p.name.padEnd(20)} ${gray(p.description)}${local}`);
  });
  console.log('');
}