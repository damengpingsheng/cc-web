/**
 * Client gateway routing values shared by session persistence and runtime spawn.
 *
 * The two legacy values remain accepted so existing sessions keep their traffic
 * path after an upgrade: apirouter -> direct-apirouter, localproxy -> proxy-apirouter.
 */

const GATEWAY_IDS = Object.freeze([
  'proxy-apirouter',
  'proxy-llmproxy',
  'direct-apirouter',
  'direct-llmproxy',
]);

const GATEWAY_LABELS = Object.freeze({
  'proxy-apirouter': '代理走 apirouter',
  'proxy-llmproxy': '代理走 llmproxy',
  'direct-apirouter': '直连 apirouter',
  'direct-llmproxy': '直连 llmproxy',
});

const LEGACY_GATEWAYS = Object.freeze({
  apirouter: 'direct-apirouter',
  localproxy: 'proxy-apirouter',
});

function normalizeGateway(value, fallback = 'direct-apirouter') {
  const raw = String(value || '').trim();
  if (GATEWAY_IDS.includes(raw)) return raw;
  if (LEGACY_GATEWAYS[raw]) return LEGACY_GATEWAYS[raw];
  return fallback;
}

function gatewayParts(value, fallback = 'direct-apirouter') {
  const gateway = normalizeGateway(value, fallback);
  const [transport, upstream] = gateway.split('-');
  return { gateway, transport, upstream };
}

function isProxyGateway(value) {
  return gatewayParts(value).transport === 'proxy';
}

function gatewayLabel(value) {
  return GATEWAY_LABELS[normalizeGateway(value)];
}

module.exports = {
  GATEWAY_IDS,
  GATEWAY_LABELS,
  LEGACY_GATEWAYS,
  normalizeGateway,
  gatewayParts,
  isProxyGateway,
  gatewayLabel,
};
