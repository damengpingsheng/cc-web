/**
 * Owns the codex-api-proxy process used by per-session proxy routes.
 *
 * A compatible externally managed instance is reused. If the preferred port is
 * occupied by an older proxy, CC-Web starts its own version on a nearby free
 * port instead of killing a process it does not own.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const PROXY_VERSION = 2;

function httpGetJson(port, requestPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ status: 0, body: null, error }));
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function isCompatibleHealth(result) {
  const body = result?.body;
  const routes = Array.isArray(body?.routes) ? body.routes : [];
  return result?.status === 200
    && body?.ok === true
    && Number(body.version) >= PROXY_VERSION
    && body.upstreams?.apirouter === true
    && body.upstreams?.llmproxy === true
    && routes.includes('/apirouter/v1/responses')
    && routes.includes('/llmproxy/v1/responses')
    && routes.includes('/apirouter/v1/messages')
    && routes.includes('/llmproxy/v1/messages');
}

function createCodexProxyManager(options = {}) {
  const preferredPort = Number(options.port) || 8787;
  const proxyPath = options.proxyPath;
  const pythonPath = options.pythonPath || process.env.CC_WEB_PYTHON_PATH || 'python3';
  const logsDir = options.logsDir;
  const env = options.env || process.env;
  const resolveUpstreams = typeof options.resolveUpstreams === 'function'
    ? options.resolveUpstreams
    : () => ({});
  const log = typeof options.log === 'function' ? options.log : () => {};
  const spawnImpl = options.spawnImpl || spawn;
  const healthImpl = options.healthImpl || httpGetJson;
  const portAvailableImpl = options.portAvailableImpl || isPortAvailable;
  const startupTimeoutMs = Number(options.startupTimeoutMs) || 10000;
  const healthCheckIntervalMs = Number(options.healthCheckIntervalMs) || 5000;
  const externalFailureThreshold = Number(options.externalFailureThreshold) || 2;
  const takeoverTimeoutMs = Number(options.takeoverTimeoutMs) || 10000;
  const disabled = options.disabled === true;

  let readyPromise = null;
  let child = null;
  let activePort = 0;
  let ownsProcess = false;
  let restartEnabled = false;
  let shuttingDown = false;
  let restartAttempt = 0;
  let restartTimer = null;
  let takeoverTimer = null;
  let externalTakeoverActive = false;
  let externalTakeoverToken = 0;
  let lastError = '';
  let healthTimer = null;
  let healthFailures = 0;
  let checkingHealth = false;

  function baseUrl() {
    return activePort ? `http://127.0.0.1:${activePort}` : '';
  }

  function validateUpstreams() {
    const upstreams = resolveUpstreams();
    const apirouter = String(upstreams.apirouter || '').trim().replace(/\/+$/, '');
    const llmproxy = String(upstreams.llmproxy || '').trim().replace(/\/+$/, '');
    if (!apirouter || !llmproxy) {
      throw new Error('代理缺少 APIROUTER_BASE_URL 或 LLMPROXY_BASE_URL 配置');
    }
    return { apirouter, llmproxy };
  }

  async function findStartPort() {
    for (let port = preferredPort; port < preferredPort + 20; port += 1) {
      if (await portAvailableImpl(port)) return port;
    }
    throw new Error(`无法为 codex_api_proxy 找到空闲端口（从 ${preferredPort} 起）`);
  }

  async function waitUntilHealthy(port) {
    const deadline = Date.now() + startupTimeoutMs;
    let lastResult = null;
    while (Date.now() < deadline) {
      if (shuttingDown) throw new Error('codex_api_proxy 已停止');
      lastResult = await healthImpl(port, '/health', 500);
      if (shuttingDown) throw new Error('codex_api_proxy 已停止');
      if (isCompatibleHealth(lastResult)) return true;
      if (child && child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const detail = lastError || lastResult?.error?.message || `HTTP ${lastResult?.status || 0}`;
    throw new Error(`codex_api_proxy 未就绪（127.0.0.1:${port}，${detail}）`);
  }

  function scheduleRestart(reason) {
    if (shuttingDown || !restartEnabled) return;
    const delay = RESTART_DELAYS_MS[Math.min(restartAttempt, RESTART_DELAYS_MS.length - 1)];
    restartAttempt += 1;
    log('WARN', 'codex_proxy_restart_scheduled', { delay, reason });
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      readyPromise = null;
      // A previous child object is intentionally retained while it is down:
      // ensureReady must keep ownership semantics instead of treating the
      // failed process as a reusable external port.
      ensureOwnedReady().catch((error) => {
        lastError = error.message;
        log('ERROR', 'codex_proxy_restart_failed', { error: error.message });
        scheduleRestart(error.message);
      });
    }, delay);
    restartTimer.unref?.();
  }

  function ensureHealthMonitor() {
    if (healthTimer) return;
    clearInterval(healthTimer);
    if (shuttingDown || disabled || !activePort) return;
    healthTimer = setInterval(async () => {
      if (shuttingDown || checkingHealth || !activePort) return;
      if (ownsProcess && (!child || child.exitCode !== null)) return;
      const monitoredPort = activePort;
      const monitoredOwned = ownsProcess;
      checkingHealth = true;
      try {
        const health = await healthImpl(monitoredPort, '/health', 500);
        if (shuttingDown || activePort !== monitoredPort || ownsProcess !== monitoredOwned) return;
        if (isCompatibleHealth(health)) {
          healthFailures = 0;
          return;
        }
        healthFailures += 1;
        if (monitoredOwned) {
          log('WARN', 'codex_proxy_unhealthy', { port: monitoredPort });
          try { child.kill('SIGTERM'); } catch {}
        } else if (healthFailures >= externalFailureThreshold) {
          scheduleExternalTakeover(`health failed ${healthFailures} times`);
        }
      } finally {
        checkingHealth = false;
      }
    }, healthCheckIntervalMs);
    healthTimer.unref?.();
  }

  function scheduleExternalTakeover(reason) {
    if (shuttingDown || readyPromise || takeoverTimer || externalTakeoverActive) return;
    externalTakeoverActive = true;
    const takeoverToken = ++externalTakeoverToken;
    const deadline = Date.now() + takeoverTimeoutMs;
    log('WARN', 'codex_proxy_external_missing', { port: activePort, reason });
    const isCurrent = () => externalTakeoverActive
      && takeoverToken === externalTakeoverToken
      && !shuttingDown;
    const finish = () => {
      if (takeoverToken === externalTakeoverToken) externalTakeoverActive = false;
    };
    const startReplacement = () => {
      let pending;
      pending = startOwned().then(() => baseUrl()).catch((error) => {
        if (shuttingDown) return '';
        lastError = error.message;
        log('ERROR', 'codex_proxy_takeover_failed', { error: error.message });
        scheduleRestart(error.message);
      }).finally(() => {
        if (readyPromise === pending) readyPromise = null;
        finish();
      });
      readyPromise = pending;
    };
    const check = async () => {
      takeoverTimer = null;
      if (!isCurrent() || readyPromise) return;
      const health = await healthImpl(preferredPort, '/health', 500);
      if (!isCurrent() || readyPromise) return;
      if (isCompatibleHealth(health)) {
        healthFailures = 0;
        finish();
        return;
      }
      const available = await portAvailableImpl(preferredPort);
      if (!isCurrent() || readyPromise) return;
      if (!available) {
        if (Date.now() < deadline) {
          takeoverTimer = setTimeout(check, 100);
          takeoverTimer.unref?.();
        } else {
          healthFailures = 0;
          lastError = '';
          ownsProcess = false;
          // The old CLI still targets the preferred port, but it is no longer
          // available to CC-Web. Recover on a nearby port for new requests.
          startReplacement();
        }
        return;
      }
      startReplacement();
    };
    takeoverTimer = setTimeout(() => {
      check().catch((error) => {
        if (!isCurrent()) return;
        lastError = error.message;
        log('ERROR', 'codex_proxy_takeover_failed', { error: error.message });
        scheduleRestart(error.message);
        finish();
      });
    }, 100);
    takeoverTimer.unref?.();
  }

  async function startOwned() {
    if (shuttingDown) throw new Error('codex_api_proxy 已停止');
    if (!proxyPath || !fs.existsSync(proxyPath)) {
      throw new Error(`codex_api_proxy.py 不存在: ${proxyPath || '(未配置)'}`);
    }
    const upstreams = validateUpstreams();
    activePort = await findStartPort();
    if (shuttingDown) {
      activePort = 0;
      throw new Error('codex_api_proxy 已停止');
    }
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'codex-api-proxy.log');
    const output = fs.openSync(logPath, 'a');
    const childEnv = {
      ...env,
      APIROUTER_BASE_URL: upstreams.apirouter,
      LLMPROXY_BASE_URL: upstreams.llmproxy,
    };
    let spawnedChild;
    try {
      spawnedChild = spawnImpl(pythonPath, [
        proxyPath,
        '--port', String(activePort),
        '--apirouter-upstream', upstreams.apirouter,
        '--llmproxy-upstream', upstreams.llmproxy,
      ], {
        cwd: path.dirname(proxyPath),
        env: childEnv,
        stdio: ['ignore', output, output],
        detached: false,
        windowsHide: true,
      });
    } finally {
      fs.closeSync(output);
    }
    child = spawnedChild;
    ownsProcess = true;
    restartEnabled = true;
    spawnedChild.once('error', (error) => {
      lastError = error.message;
      log('ERROR', 'codex_proxy_spawn_failed', { error: error.message });
    });
    spawnedChild.once('close', (code, signal) => {
      if (child === spawnedChild) {
        log('WARN', 'codex_proxy_exited', { pid: spawnedChild.pid, code, signal });
        child = null;
        activePort = 0;
        readyPromise = null;
        scheduleRestart(`exit ${code ?? signal ?? 'unknown'}`);
      }
    });
    log('INFO', 'codex_proxy_started', {
      pid: spawnedChild.pid,
      port: activePort,
      apirouter: upstreams.apirouter,
      llmproxy: upstreams.llmproxy,
      log: logPath,
    });
    try {
      await waitUntilHealthy(activePort);
    } catch (error) {
      const failedPort = activePort;
      child = null;
      activePort = 0;
      try { spawnedChild.kill('SIGTERM'); } catch {}
      if (restartEnabled) scheduleRestart(`startup failed on port ${failedPort}: ${error.message}`);
      throw error;
    }
    lastError = '';
    restartAttempt = 0;
    ensureHealthMonitor();
  }

  async function ensureReady() {
    if (disabled) return null;
    if (externalTakeoverActive && !readyPromise) {
      clearTimeout(takeoverTimer);
      takeoverTimer = null;
      externalTakeoverToken += 1;
      externalTakeoverActive = false;
    }
    if (lastError && !child && !ownsProcess) lastError = '';
    if (activePort) {
      const health = await healthImpl(activePort, '/health', 500);
      if (isCompatibleHealth(health)) {
        healthFailures = 0;
        return baseUrl();
      }
      if (ownsProcess) {
        throw new Error(`CC-Web 托管的 codex_api_proxy 不健康（127.0.0.1:${activePort}）`);
      }
      activePort = 0;
    }
    if (readyPromise) return readyPromise;
    let pending;
    pending = (async () => {
      let reusePort = 0;
      const preferredHealth = await healthImpl(preferredPort, '/health', 500);
      if (isCompatibleHealth(preferredHealth)) reusePort = preferredPort;
      if (reusePort) {
        activePort = reusePort;
        ownsProcess = false;
        lastError = '';
        healthFailures = 0;
        log('INFO', 'codex_proxy_reused', { port: activePort });
        ensureHealthMonitor();
        return baseUrl();
      }
      await startOwned();
      return baseUrl();
    })().catch((error) => {
      lastError = error.message;
      // A failed startup must not poison every later page. Concurrent callers
      // still receive this rejection, while the next request may retry after
      // the user fixes configuration or a transient port/process issue clears.
      readyPromise = null;
      log('ERROR', 'codex_proxy_unavailable', { error: error.message });
      throw error;
    }).finally(() => {
      if (readyPromise === pending) readyPromise = null;
    });
    readyPromise = pending;
    return readyPromise;
  }

  async function ensureOwnedReady() {
    if (disabled || shuttingDown || !restartEnabled) return null;
    if (child && child.exitCode === null && activePort) {
      const health = await healthImpl(activePort, '/health', 500);
      if (isCompatibleHealth(health)) return baseUrl();
    }
    await startOwned();
    return baseUrl();
  }

  function stop() {
    shuttingDown = true;
    restartEnabled = false;
    clearTimeout(restartTimer);
    clearTimeout(takeoverTimer);
    externalTakeoverToken += 1;
    externalTakeoverActive = false;
    clearInterval(healthTimer);
    healthTimer = null;
    takeoverTimer = null;
    if (!ownsProcess || !child) return;
    const pid = child.pid;
    log('INFO', 'codex_proxy_stopping', { pid, port: activePort });
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(pid, 'SIGTERM');
    } catch {}
    child = null;
  }

  function status() {
    return {
      disabled,
      ready: Boolean(activePort && !lastError),
      port: activePort || null,
      managed: ownsProcess,
      pid: child?.pid || null,
      error: lastError || null,
    };
  }

  return { ensureReady, stop, status, baseUrl };
}

module.exports = {
  PROXY_VERSION,
  isCompatibleHealth,
  isPortAvailable,
  httpGetJson,
  createCodexProxyManager,
};
