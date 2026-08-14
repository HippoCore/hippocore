import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export const VERSION = '1.3.0';

export function getHippoHome(env = process.env) {
  return resolve(env.HIPPO_CORE_HOME || join(homedir(), '.hippo-core'));
}

export function getConfigPath(env = process.env) {
  return join(getHippoHome(env), 'config.json');
}

export function getDefaultDbPath(env = process.env) {
  return resolve(env.HIPPO_CORE_DB_PATH || join(getHippoHome(env), 'memory.db'));
}

export function loadConfig(overrides = {}, env = process.env) {
  let stored = {};
  const configPath = getConfigPath(env);
  if (existsSync(configPath)) {
    try { stored = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
  }

  const config = {
    ...stored,
    ...overrides,
    apiKey: env.HIPPO_CORE_API_KEY || env.OPENAI_API_KEY || overrides.apiKey || stored.apiKey,
    baseURL: env.HIPPO_CORE_BASE_URL || overrides.baseURL || stored.baseURL,
    model: env.HIPPO_CORE_MODEL || overrides.model || stored.model,
    embeddingApiKey: env.HIPPO_CORE_EMBEDDING_API_KEY || overrides.embeddingApiKey || stored.embeddingApiKey,
    embeddingBaseURL: env.HIPPO_CORE_EMBEDDING_BASE_URL || overrides.embeddingBaseURL || stored.embeddingBaseURL,
    embeddingModel: env.HIPPO_CORE_EMBEDDING_MODEL || overrides.embeddingModel || stored.embeddingModel,
    dbPath: overrides.dbPath || getDefaultDbPath(env),
  };

  if (stored.dbPath && !env.HIPPO_CORE_DB_PATH && !overrides.dbPath) config.dbPath = resolve(stored.dbPath);
  return config;
}

export function publicConfig(config = {}) {
  const { apiKey, embeddingApiKey, ...safe } = config;
  return safe;
}
