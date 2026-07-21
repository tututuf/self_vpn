'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

test('config can be read, saved, and downloaded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy2-admin-'));
  const configPath = path.join(dir, 'hy2.yaml');
  await fs.writeFile(configPath, 'mixed-port: 7890\n', 'utf8');

  const { server } = createApp({
    host: '127.0.0.1',
    port: 0,
    configPath,
    adminToken: 'secret',
    downloadToken: 'download-secret',
    runCommand: fakeRunCommand
  });

  await listen(server);
  const base = address(server);

  const read = await fetchJson(`${base}/api/config`, {
    headers: { Authorization: 'Bearer secret' }
  });
  assert.equal(read.content, 'mixed-port: 7890\n');
  assert.match(read.downloadUrl, /token=download-secret/);

  const saved = await fetchJson(`${base}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content: 'mixed-port: 7999\n' })
  });
  assert.equal(saved.ok, true);
  assert.equal(await fs.readFile(configPath, 'utf8'), 'mixed-port: 7999\n');

  const download = await fetch(`${base}/download/hy2.yaml?token=download-secret`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'mixed-port: 7999\n');

  await close(server);
});

test('admin config file supplies tokens, service name, and yaml path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy2-admin-file-'));
  const configPath = path.join(dir, 'hy2.yaml');
  const adminConfigPath = path.join(dir, 'admin.config.json');
  await fs.writeFile(configPath, 'mode: rule\n', 'utf8');
  await fs.writeFile(adminConfigPath, JSON.stringify({
    host: '127.0.0.1',
    port: 0,
    adminToken: 'file-secret',
    downloadToken: 'file-download-secret',
    hy2YamlPath: './hy2.yaml',
    vpnServiceName: 'custom-hysteria.service'
  }), 'utf8');

  const { server, config } = createApp({
    adminConfigPath,
    runCommand: fakeRunCommand
  });

  assert.equal(config.adminToken, 'file-secret');
  assert.equal(config.downloadToken, 'file-download-secret');
  assert.equal(config.serviceName, 'custom-hysteria.service');
  assert.equal(config.configPath, configPath);

  await listen(server);
  const base = address(server);
  const read = await fetchJson(`${base}/api/config`, {
    headers: { Authorization: 'Bearer file-secret' }
  });

  assert.equal(read.content, 'mode: rule\n');
  assert.match(read.downloadUrl, /token=file-download-secret/);

  await close(server);
});

test('admin endpoints reject invalid token', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy2-admin-'));
  const configPath = path.join(dir, 'hy2.yaml');
  await fs.writeFile(configPath, 'mixed-port: 7890\n', 'utf8');

  const { server } = createApp({
    host: '127.0.0.1',
    port: 0,
    configPath,
    adminToken: 'secret',
    runCommand: fakeRunCommand
  });

  await listen(server);
  const response = await fetch(`${address(server)}/api/config`, {
    headers: { Authorization: 'Bearer nope' }
  });

  assert.equal(response.status, 401);
  await close(server);
});

test('service actions are fixed to supported systemctl actions', async () => {
  const calls = [];
  const { server } = createApp({
    host: '127.0.0.1',
    port: 0,
    adminToken: 'secret',
    runCommand: async (command, args) => {
      calls.push([command, args]);
      return { code: 0, stdout: 'ok\n', stderr: '' };
    }
  });

  await listen(server);
  const base = address(server);

  const ok = await fetchJson(`${base}/api/service/action`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'restart' })
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0], ['systemctl', ['restart', 'hysteria-server.service']]);

  const bad = await fetch(`${base}/api/service/action`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'enable --now anything' })
  });
  assert.equal(bad.status, 400);

  await close(server);
});

async function fakeRunCommand(command, args) {
  if (args[0] === 'is-active') return { code: 0, stdout: 'active\n', stderr: '' };
  if (args[0] === 'is-enabled') return { code: 0, stdout: 'enabled\n', stderr: '' };
  if (args[0] === 'status') return { code: 0, stdout: 'status output\n', stderr: '' };
  return { code: 0, stdout: `${command} ${args.join(' ')}\n`, stderr: '' };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function address(server) {
  const info = server.address();
  return `http://${info.address}:${info.port}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}