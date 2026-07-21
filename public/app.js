'use strict';

const els = {
  authPanel: document.getElementById('authPanel'),
  adminToken: document.getElementById('adminToken'),
  saveTokenBtn: document.getElementById('saveTokenBtn'),
  serviceName: document.getElementById('serviceName'),
  statusBadge: document.getElementById('statusBadge'),
  refreshStatusBtn: document.getElementById('refreshStatusBtn'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  restartBtn: document.getElementById('restartBtn'),
  serviceOutput: document.getElementById('serviceOutput'),
  fileMeta: document.getElementById('fileMeta'),
  configEditor: document.getElementById('configEditor'),
  yamlImport: document.getElementById('yamlImport'),
  importBtn: document.getElementById('importBtn'),
  saveConfigBtn: document.getElementById('saveConfigBtn'),
  downloadLink: document.getElementById('downloadLink'),
  copyLinkBtn: document.getElementById('copyLinkBtn'),
  refreshLogsBtn: document.getElementById('refreshLogsBtn'),
  logsOutput: document.getElementById('logsOutput'),
  toast: document.getElementById('toast')
};

let adminToken = localStorage.getItem('hy2AdminToken') || '';
let meta = {};

init();

function init() {
  els.adminToken.value = adminToken;
  bindEvents();
  loadMeta()
    .then(() => Promise.all([loadConfig(), refreshStatus(), refreshLogs()]))
    .catch((error) => {
      showToast(error.message);
      maybeShowAuth();
    });
}

function bindEvents() {
  els.saveTokenBtn.addEventListener('click', () => {
    adminToken = els.adminToken.value.trim();
    localStorage.setItem('hy2AdminToken', adminToken);
    showToast('Token saved');
    Promise.all([loadConfig(), refreshStatus(), refreshLogs()]).catch((error) => showToast(error.message));
  });

  els.refreshStatusBtn.addEventListener('click', refreshStatus);
  els.refreshLogsBtn.addEventListener('click', refreshLogs);
  els.startBtn.addEventListener('click', () => serviceAction('start'));
  els.stopBtn.addEventListener('click', () => serviceAction('stop'));
  els.restartBtn.addEventListener('click', () => serviceAction('restart'));
  els.saveConfigBtn.addEventListener('click', saveConfig);
  els.importBtn.addEventListener('click', () => els.yamlImport.click());
  els.yamlImport.addEventListener('change', importYaml);
  els.copyLinkBtn.addEventListener('click', copyDownloadLink);

  els.configEditor.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const start = els.configEditor.selectionStart;
    const end = els.configEditor.selectionEnd;
    const value = els.configEditor.value;
    els.configEditor.value = `${value.slice(0, start)}  ${value.slice(end)}`;
    els.configEditor.selectionStart = els.configEditor.selectionEnd = start + 2;
  });
}

async function loadMeta() {
  const response = await fetch('/api/meta');
  meta = await response.json();
  if (!meta.ok) throw new Error(meta.error || 'Could not load metadata');
  els.serviceName.textContent = meta.serviceName || 'hysteria-server.service';
  maybeShowAuth();
}

async function loadConfig() {
  const data = await api('/api/config');
  els.configEditor.value = data.content || '';
  els.fileMeta.textContent = buildFileMeta(data);
  const downloadUrl = data.downloadUrl || '/download/hy2.yaml';
  els.downloadLink.href = downloadUrl;
  els.downloadLink.textContent = new URL(downloadUrl, window.location.href).href;
  els.downloadLink.title = els.downloadLink.textContent;
}

async function saveConfig() {
  await withBusy(els.saveConfigBtn, async () => {
    const data = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ content: els.configEditor.value })
    });
    els.fileMeta.textContent = `${data.size} bytes | ${formatTime(data.updatedAt)}`;
    showToast('Config saved');
  });
}

async function refreshStatus() {
  await withBusy(els.refreshStatusBtn, async () => {
    const data = await api('/api/service/status');
    updateStatus(data.status);
  });
}

async function refreshLogs() {
  await withBusy(els.refreshLogsBtn, async () => {
    const data = await api('/api/service/logs?lines=100');
    els.logsOutput.textContent = data.logs || data.error || '';
  });
}

async function serviceAction(action) {
  const button = action === 'start' ? els.startBtn : action === 'stop' ? els.stopBtn : els.restartBtn;
  await withBusy(button, async () => {
    const data = await api('/api/service/action', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    els.serviceOutput.textContent = data.output || data.error || `${action}: ${data.ok ? 'ok' : 'failed'}`;
    showToast(data.ok ? 'Command executed' : 'Command failed');
    await refreshStatus();
    await refreshLogs();
  });
}

function updateStatus(status) {
  const active = (status && status.active) || 'unknown';
  els.statusBadge.textContent = active;
  els.statusBadge.className = `status-badge ${active}`;
  els.serviceOutput.textContent = status && status.details ? status.details : '';
}

async function importYaml() {
  const file = els.yamlImport.files && els.yamlImport.files[0];
  if (!file) return;
  const text = await file.text();
  els.configEditor.value = text;
  els.fileMeta.textContent = `${file.name} | ${text.length} chars`;
  els.yamlImport.value = '';
  showToast('YAML imported');
}

async function copyDownloadLink() {
  const href = new URL(els.downloadLink.href, window.location.href).href;
  await navigator.clipboard.writeText(href);
  showToast('Link copied');
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (adminToken) headers.set('Authorization', `Bearer ${adminToken}`);

  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    maybeShowAuth(true);
    throw new Error(data.error || 'Admin Token required');
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function withBusy(button, task) {
  const previous = button.textContent;
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function maybeShowAuth(force) {
  if (force || meta.adminAuthRequired) {
    els.authPanel.classList.remove('hidden');
  } else {
    els.authPanel.classList.add('hidden');
  }
}

function buildFileMeta(data) {
  const fileName = data.fileName || 'hy2.yaml';
  const size = typeof data.size === 'number' ? `${data.size} bytes` : '';
  const updatedAt = data.updatedAt ? formatTime(data.updatedAt) : '';
  return [fileName, size, updatedAt].filter(Boolean).join(' | ');
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date(value));
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 2600);
}