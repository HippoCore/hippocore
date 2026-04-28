// examples/generic/demo.js
// Hippo Core — working demo
// Run: OPENAI_API_KEY=sk-... node examples/generic/demo.js

import { createMemory } from '../../packages/core/src/index.js';

const memory = createMemory({
  apiKey:  process.env.OPENAI_API_KEY,
  dbPath:  './.hippo-core/demo.db',
});

async function main() {
  const USER = 'demo_user_001';

  console.log('\n🦛 Hippo Core — Demo\n');

  // 1. Store memories
  console.log('📥 Storing memories...');

  await memory.store(USER,
    'User is looking for a mortgage under $500k and strongly prefers fixed rates. Has 2 kids in school.',
    'preference');

  await memory.store(USER,
    'User previously declined a variable rate 30-year mortgage from TD Bank in March.',
    'behavioral');

  await memory.store(USER,
    'User wants to close before September because their lease ends.',
    'preference');

  console.log('✓ 3 memories stored\n');

  // 2. Simulate a user question
  const question = 'What kind of mortgage should I be looking at?';
  console.log(`💬 User: "${question}"\n`);

  // 3. Retrieve and inject
  const { systemPrompt, memories } = await memory.before(USER, question, 'You are a mortgage advisor.');

  console.log(`🧠 ${memories.length} memories retrieved:`);
  memories.forEach((m, i) => {
    console.log(`  [${i+1}] (${m.type}, similarity: ${m.similarity}) ${m.content.slice(0, 75)}...`);
  });

  console.log('\n📋 System prompt your agent receives:\n');
  console.log(systemPrompt);
  console.log('\n✅ Agent now has full user context. Response will be personalized.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.message.includes('API')) {
    console.error('→ Set OPENAI_API_KEY=sk-... and try again');
  }
  process.exit(1);
});
