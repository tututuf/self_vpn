'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'hy2.yaml');
const DEFAULT_ADMIN_CONFIG_PATH = path.join(ROOT, 'admin.config.json');
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

function getRuntimeConfig(overrides = {}) {
  const adminConfigPath = resolveRootPath(
    pick(overrides.adminConfigPath, process.env.ADMIN_CONFIG_PATH, DEFAULT_ADMIN_CONFIG_PATH)
  );
  const fileConfig = loadAdminConfig(adminConfigPath);
  const adminConfigDir = path.dirname(adminConfigPath);
  const port = toPort(pick(overrides.port, process.env.PORT, fileConfig.port, 8787), 8787);
  const configPath = resolveConfiguredPath(
    pick(overrides.configPath, process.env.HY2_YAML_PATH, fileConfig.hy2YamlPath, fileConfig.configPath, DEFAULT_CONFIG_PATH),
    adminConfigDir
  );
  const serviceName = String(pick(
    overrides.serviceName,
    process.env.VPN_SERVICE_NAME,
    fileConfig.vpnServiceName,
    fileConfig.serviceName,
    'hysteria-server.service'
  ));

  if (!/^[A-Za-z0-9_.@:-]+$/.test(serviceName)) {
    throw new Error('VPN service name can only contain letters, numbers, _, -, ., @ and :');
  }

  const commandTimeoutMs = Number(pick(
    overrides.commandTimeoutMs,
    process.env.COMMAND_TIMEOUT_MS,
    fileConfig.commandTimeoutMs,
    20000
  ));

  return {
    adminConfigPath,
    host: String(pick(overrides.host, process.env.HOST, fileConfig.host, '0.0.0.0')),
    port,
    configPath,
    serviceName,
    adminToken: String(pick(overrides.adminToken, process.env.ADMIN_TOKEN, fileConfig.adminToken, '')),
    downloadToken: String(pick(overrides.downloadToken, process.env.DOWNLOAD_TOKEN, fileConfig.downloadToken, '')),
    systemctlBin: String(pick(overrides.systemctlBin, process.env.SYSTEMCTL_BIN, fileConfig.systemctlBin, 'systemctl')),
    journalctlBin: String(pick(overrides.journalctlBin, process.env.JOURNALCTL_BIN, fileConfig.journalctlBin, 'journalctl')),
    commandTimeoutMs: Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 20000,
    runCommand: overrides.runCommand || runCommand
  };
}

function loadAdminConfig(adminConfigPath) {
  try {
    const raw = fs.readFileSync(adminConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('admin config must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Failed to load admin config ${adminConfigPath}: ${error.message}`);
  }
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function toPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

function resolveRootPath(value) {
  const filePath = String(value);
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  return path.resolve(ROOT, filePath);
}

function resolveConfiguredPath(value, baseDir) {
  const filePath = String(value);
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  return path.resolve(baseDir, filePath);
}

function createApp(overrides = {}) {
  const config = getRuntimeConfig(overrides);

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, config);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || 'Internal server error'
      });
    }
  });

  return { server, config };
}

async function route(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  setBaseHeaders(res);

  if (req.method === 'GET' && url.pathname === '/api/meta') {
    return sendJson(res, 200, {
      ok: true,
      serviceName: config.serviceName,
      configFileName: path.basename(config.configPath),
      adminAuthRequired: Boolean(config.adminToken),
      downloadRequiresToken: Boolean(config.downloadToken)
    });
  }

  if (req.method === 'GET' && (url.pathname === '/download/hy2.yaml' || url.pathname === '/hy2.yaml')) {
    if (!isDownloadAllowed(req, url, config)) {
      return sendJson(res, 401, { ok: false, error: 'Download token required' });
    }
    return sendYamlDownload(res, config);
  }

  if (url.pathname.startsWith('/api/')) {
    if (!isAdminAllowed(req, config)) {
      return sendJson(res, 401, {
        ok: false,
        error: config.adminToken ? 'Invalid admin token' : 'Admin token is required for remote access'
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const content = await readConfigFile(config);
      const stat = await fsp.stat(config.configPath).catch(() => null);
      return sendJson(res, 200, {
        ok: true,
        content,
        fileName: path.basename(config.configPath),
        size: stat ? stat.size : Buffer.byteLength(content),
        updatedAt: stat ? stat.mtime.toISOString() : null,
        downloadUrl: getDownloadUrl(req, config)
      });
    }

    if (req.method === 'PUT' && url.pathname === '/api/config') {
      const body = await readJsonBody(req);
      if (!body || typeof body.content !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'content must be a string' });
      }
      await writeConfigFile(config.configPath, body.content);
      return sendJson(res, 200, {
        ok: true,
        size: Buffer.byteLength(body.content, 'utf8'),
        updatedAt: new Date().toISOString()
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/service/status') {
      const status = await getServiceStatus(config);
      return sendJson(res, 200, { ok: true, status });
    }

    if (req.method === 'GET' && url.pathname === '/api/service/logs') {
      const lines = clamp(Number(url.searchParams.get('lines') || 80), 20, 300);
      const result = await config.runCommand(config.journalctlBin, [
        '--no-pager',
        '-n',
        String(lines),
        '-u',
        config.serviceName
      ], { timeoutMs: config.commandTimeoutMs });
      return sendJson(res, 200, {
        ok: result.code === 0,
        logs: trimOutput(result.stdout || result.stderr),
        exitCode: result.code,
        error: result.code === 0 ? null : trimOutput(result.stderr || result.stdout)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/service/action') {
      const body = await readJsonBody(req);
      const action = body && body.action;
      if (!ALLOWED_ACTIONS.has(action)) {
        return sendJson(res, 400, { ok: false, error: 'Unsupported service action' });
      }
      const result = await config.runCommand(config.systemctlBin, [action, config.serviceName], {
        timeoutMs: config.commandTimeoutMs
      });
      return sendJson(res, result.code === 0 ? 200 : 500, {
        ok: result.code === 0,
        action,
        exitCode: result.code,
        output: trimOutput(result.stdout || result.stderr),
        error: result.code === 0 ? null : trimOutput(result.stderr || result.stdout)
      });
    }

    return sendJson(res, 404, { ok: false, error: 'API route not found' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url.pathname);
  }

  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}

async function sendYamlDownload(res, config) {
  const content = await readConfigFile(config);
  res.writeHead(200, {
    'Content-Type': 'application/x-yaml; charset=utf-8',
    'Content-Disposition': `attachment; filename="${path.basename(config.configPath)}"`,
    'Cache-Control': 'no-store'
  });
  res.end(content);
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(PUBLIC_ROOT, `.${decodeURIComponent(requested)}`);
  const relative = path.relative(PUBLIC_ROOT, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const stat = await fsp.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) {
    res.writeHead(404);
    return res.end('Not found');
  }

  res.writeHead(200, {
    'Content-Type': contentType(target),
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

async function readConfigFile(config) {
  try {
    return await fsp.readFile(config.configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeConfigFile(configPath, content) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tempPath, content, 'utf8');
  await fsp.rename(tempPath, configPath);
}

async function getServiceStatus(config) {
  const [active, enabled, details] = await Promise.all([
    config.runCommand(config.systemctlBin, ['is-active', config.serviceName], {
      timeoutMs: config.commandTimeoutMs
    }),
    config.runCommand(config.systemctlBin, ['is-enabled', config.serviceName], {
      timeoutMs: config.commandTimeoutMs
    }),
    config.runCommand(config.systemctlBin, ['status', '--no-pager', '-l', config.serviceName], {
      timeoutMs: config.commandTimeoutMs
    })
  ]);

  return {
    active: trimOutput(active.stdout || active.stderr) || 'unknown',
    enabled: trimOutput(enabled.stdout || enabled.stderr) || 'unknown',
    exitCode: details.code,
    details: trimOutput(details.stdout || details.stderr)
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs || 20000;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
        settled = true;
        resolve({
          code: null,
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim()
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        resolve({ code: null, stdout, stderr: error.message });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function isAdminAllowed(req, config) {
  if (!config.adminToken) return isLoopback(req);
  return safeEqual(getProvidedToken(req), config.adminToken);
}

function isDownloadAllowed(req, url, config) {
  if (!config.downloadToken) return true;
  return safeEqual(url.searchParams.get('token') || '', config.downloadToken);
}

function getProvidedToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-admin-token'] || '').trim();
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function getDownloadUrl(req, config) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`;
  const url = `${protocol}://${host}/download/hy2.yaml`;
  if (!config.downloadToken) return url;
  return `${url}?token=${encodeURIComponent(config.downloadToken)}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function setBaseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function trimOutput(value) {
  return String(value || '').trim().slice(0, 20000);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

if (require.main === module) {
  const { server, config } = createApp();
  server.listen(config.port, config.host, () => {
    const authNote = config.adminToken
      ? 'admin token enabled'
      : 'admin API only allows loopback because adminToken is not set';
    const downloadNote = config.downloadToken
      ? 'download token enabled'
      : 'download link is public';
    console.log(`VPN admin listening on http://${config.host}:${config.port}`);
    console.log(`Admin config: ${config.adminConfigPath}`);
    console.log(`Service: ${config.serviceName}`);
    console.log(`YAML: ${config.configPath}`);
    console.log(`${authNote}; ${downloadNote}`);
  });
}

module.exports = {
  createApp,
  getRuntimeConfig,
  loadAdminConfig,
  runCommand
};