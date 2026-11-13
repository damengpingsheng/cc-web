/**
 * APIRouter / llmproxy 独立网关配置。
 *
 * 环境变量优先，其次读取当前用户的 ~/.agents/codex.env。两套凭据严格按
 * APIROUTER_* / LLMPROXY_* 前缀解析，不回退到 OPENAI_API_KEY。
 */

const fs = require('fs');
const path = require('path');

function normalizeGatewayBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeUsageBaseUrl(value) {
  return normalizeGatewayBaseUrl(value).replace(/\/v1$/i, '');
}

function parseEnvFile(text, lookup = () => '') {
  const parsed = {};
  const readValue = (name) => lookup(name) || parsed[name] || '';
  const expand = (value) => value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, plain) => readValue(braced || plain),
  );
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = expand(value);
  }
  return parsed;
}

function createGatewayEnvResolver({ env = process.env, envPath } = {}) {
  const agentsEnvPath = envPath || path.join(env.HOME || env.USERPROFILE || '', '.agents', 'codex.env');

  function readEnvFile() {
    try {
      return parseEnvFile(fs.readFileSync(agentsEnvPath, 'utf8'), (name) => env[name] || '');
    } catch {
      return {};
    }
  }

  function resolve(name) {
    if (env[name]) return env[name];
    return readEnvFile()[name] || '';
  }

  function resolveGateway(gateway) {
    const prefix = gateway === 'llmproxy' ? 'LLMPROXY' : 'APIROUTER';
    return {
      baseUrl: normalizeGatewayBaseUrl(resolve(`${prefix}_BASE_URL`)),
      apiKey: resolve(`${prefix}_API_KEY`),
    };
  }

  function loadUsageConfig(raw, prefix, defaults) {
    const baseUrl = resolve(`${prefix}_BASE_URL`) || raw?.baseUrl;
    return {
      ...defaults,
      ...raw,
      baseUrl: normalizeUsageBaseUrl(baseUrl),
      authToken: resolve(`${prefix}_API_KEY`),
    };
  }

  return { readEnvFile, resolve, resolveGateway, loadUsageConfig };
}

module.exports = {
  normalizeGatewayBaseUrl,
  normalizeUsageBaseUrl,
  parseEnvFile,
  createGatewayEnvResolver,
};
