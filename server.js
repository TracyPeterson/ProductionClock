'use strict';

/*
 * Production Clock server
 *
 *   /view     - transparent clock output (point a browser / OBS browser source here)
 *   /control  - control panel
 *
 * Time can come from the PC clock, an NTP server (time.windows.com by default),
 * or a manually entered time. All viewers sync to the server's notion of "now"
 * over a WebSocket so every output shows the same time.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;

// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle, so keep settings.json next to the .exe instead.
const DATA_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

const DEFAULTS = {
  timeSource: {
    mode: 'system',            // 'system' | 'ntp' | 'manual'
    ntpHost: 'time.windows.com',
    ntpIntervalMin: 10,
    manualOffsetMs: 0,         // (desired time - PC time) when mode === 'manual'
  },
  clock: {
    visible: true,
    format: '24',              // '12' | '24'
    showSeconds: true,
    showAmPm: true,            // only used in 12h mode
    leadingZero: true,         // pad hour to two digits
    timezone: 'local',         // 'local' or an IANA zone like 'America/New_York'
    fontFamily: 'Arial, Helvetica, sans-serif',
    googleFont: '',            // optional Google Font family name
    fontSize: 14,
    fontUnit: 'vw',            // 'vw' | 'px'
    fontWeight: 700,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 0,           // px
    shadow: true,
    letterSpacing: 0,          // em * 100 (so 5 = 0.05em)
    x: 50,                     // % of viewport width
    y: 40,                     // % of viewport height
    align: 'center',           // 'left' | 'center' | 'right'
    tabularDigits: true,
  },
  countdown: {
    enabled: false,
    mode: 'duration',          // 'duration' | 'target'
    durationMs: 10 * 60 * 1000,
    targetEpochMs: 0,
    running: false,
    endAt: 0,                  // epoch ms (server time) when running in duration mode
    remainingMs: 10 * 60 * 1000,
    label: '',
    showHours: 'auto',         // 'auto' | 'always' | 'never'
    overrun: 'stop',           // 'stop' (hold at 0:00) | 'negative' (count up with minus)
    warnSeconds: 60,
    warnColor: '#ffcc00',
    zeroColor: '#ff3333',
    flashAtZero: true,
    fontFamily: 'Arial, Helvetica, sans-serif',
    googleFont: '',
    fontSize: 7,
    fontUnit: 'vw',
    fontWeight: 700,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 0,
    shadow: true,
    letterSpacing: 0,
    x: 50,
    y: 70,
    align: 'center',
    tabularDigits: true,
  },
};

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, src) {
  for (const key of Object.keys(src)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const sv = src[key];
    if (isPlainObject(sv) && isPlainObject(target[key])) {
      deepMerge(target[key], sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function loadSettings() {
  const s = clone(DEFAULTS);
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      deepMerge(s, saved);
    }
  } catch (err) {
    console.error('Could not read settings.json, using defaults:', err.message);
  }
  return s;
}

let settings = loadSettings();
let saveTimer = null;

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error('Could not write settings.json:', err.message);
    }
  }, 250);
}

// ---------------------------------------------------------------------------
// Time source
// ---------------------------------------------------------------------------

let timeOffsetMs = 0; // production time = Date.now() + timeOffsetMs

const timeStatus = {
  mode: 'system',
  offsetMs: 0,
  lastSyncAt: null,
  lastRttMs: null,
  lastError: null,
  syncing: false,
  ntpHost: null,
};

function now() {
  return Date.now() + timeOffsetMs;
}

const NTP_EPOCH_OFFSET = 2208988800; // seconds between 1900 and 1970

function ntpTimestampToMs(buf, offset) {
  const secs = buf.readUInt32BE(offset) - NTP_EPOCH_OFFSET;
  const frac = buf.readUInt32BE(offset + 4) / 4294967296;
  return secs * 1000 + frac * 1000;
}

function ntpQuery(host, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x23; // LI = 0, VN = 4, Mode = 3 (client)

    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* ignore */ }
      if (err) reject(err); else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error(`NTP request to ${host} timed out`)), timeoutMs);

    socket.on('error', (err) => finish(err));
    socket.on('message', (msg) => {
      const t3 = Date.now();
      if (msg.length < 48) return finish(new Error('Short NTP response'));
      const stratum = msg[1];
      if (stratum === 0) return finish(new Error('NTP server sent a kiss-of-death response'));
      const t1 = ntpTimestampToMs(msg, 32); // server receive
      const t2 = ntpTimestampToMs(msg, 40); // server transmit
      const offsetMs = ((t1 - t0) + (t2 - t3)) / 2;
      const rttMs = (t3 - t0) - (t2 - t1);
      finish(null, { offsetMs, rttMs, stratum });
    });

    const t0 = Date.now();
    socket.send(packet, 0, 48, 123, host, (err) => {
      if (err) finish(err);
    });
  });
}

let ntpTimer = null;

async function syncNtp() {
  const host = settings.timeSource.ntpHost || 'time.windows.com';
  timeStatus.syncing = true;
  timeStatus.ntpHost = host;
  broadcastStatus();
  try {
    // Take a few samples and keep the one with the lowest round-trip time.
    let best = null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await ntpQuery(host);
        if (!best || r.rttMs < best.rttMs) best = r;
      } catch (err) {
        if (i === 2 && !best) throw err;
      }
    }
    timeOffsetMs = Math.round(best.offsetMs);
    timeStatus.offsetMs = timeOffsetMs;
    timeStatus.lastRttMs = Math.round(best.rttMs);
    timeStatus.lastSyncAt = Date.now();
    timeStatus.lastError = null;
    console.log(`NTP sync with ${host}: offset ${timeOffsetMs} ms, rtt ${timeStatus.lastRttMs} ms`);
  } catch (err) {
    timeStatus.lastError = err.message;
    console.error('NTP sync failed:', err.message);
  } finally {
    timeStatus.syncing = false;
    broadcastStatus();
  }
}

function scheduleNtp() {
  clearInterval(ntpTimer);
  ntpTimer = null;
  if (settings.timeSource.mode !== 'ntp') return;
  const minutes = Math.max(1, Number(settings.timeSource.ntpIntervalMin) || 10);
  ntpTimer = setInterval(() => {
    if (settings.timeSource.mode === 'ntp') syncNtp();
  }, minutes * 60 * 1000);
}

function applyTimeSource() {
  const ts = settings.timeSource;
  timeStatus.mode = ts.mode;
  if (ts.mode === 'manual') {
    timeOffsetMs = Number(ts.manualOffsetMs) || 0;
    timeStatus.offsetMs = timeOffsetMs;
    timeStatus.lastError = null;
    timeStatus.ntpHost = null;
    scheduleNtp();
    broadcastStatus();
  } else if (ts.mode === 'ntp') {
    scheduleNtp();
    syncNtp();
  } else {
    timeOffsetMs = 0;
    timeStatus.offsetMs = 0;
    timeStatus.lastError = null;
    timeStatus.ntpHost = null;
    scheduleNtp();
    broadcastStatus();
  }
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

function countdownStart() {
  const cd = settings.countdown;
  if (cd.mode === 'target') return;
  if (cd.running) return;
  let remaining = Number(cd.remainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) remaining = Number(cd.durationMs) || 0;
  cd.endAt = now() + remaining;
  cd.running = true;
}

function countdownPause() {
  const cd = settings.countdown;
  if (!cd.running) return;
  cd.remainingMs = cd.endAt - now();
  cd.running = false;
  cd.endAt = 0;
}

function countdownReset() {
  const cd = settings.countdown;
  cd.running = false;
  cd.endAt = 0;
  cd.remainingMs = Number(cd.durationMs) || 0;
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) => res.redirect('/control'));
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/view', (req, res) => res.sendFile(path.join(__dirname, 'public', 'view.html')));

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function statusPayload() {
  return {
    ...timeStatus,
    serverNow: now(),
    pcNow: Date.now(),
    port: PORT,
    addresses: lanAddresses(),
    clients: wss ? wss.clients.size : 0,
  };
}

app.get('/api/settings', (req, res) => res.json(settings));

app.patch('/api/settings', (req, res) => {
  const patch = req.body;
  if (!isPlainObject(patch)) return res.status(400).json({ error: 'Body must be a JSON object' });

  const before = JSON.stringify(settings.timeSource);
  const wasRunning = settings.countdown.running;
  const prevDuration = settings.countdown.durationMs;

  deepMerge(settings, patch);

  // If the duration changed while the countdown is idle, reset the remaining time too.
  if (patch.countdown && 'durationMs' in patch.countdown && !wasRunning && prevDuration !== settings.countdown.durationMs) {
    settings.countdown.remainingMs = Number(settings.countdown.durationMs) || 0;
  }

  if (JSON.stringify(settings.timeSource) !== before) applyTimeSource();

  saveSettings();
  broadcastSettings();
  res.json(settings);
});

app.post('/api/settings/reset', (req, res) => {
  settings = clone(DEFAULTS);
  applyTimeSource();
  saveSettings();
  broadcastSettings();
  res.json(settings);
});

app.get('/api/status', (req, res) => res.json(statusPayload()));

app.post('/api/time/sync', async (req, res) => {
  if (settings.timeSource.mode !== 'ntp') {
    settings.timeSource.mode = 'ntp';
    timeStatus.mode = 'ntp';
    saveSettings();
    broadcastSettings();
    scheduleNtp();
  }
  await syncNtp();
  res.json(statusPayload());
});

// Set the clock manually. Body: { epochMs } or { time: "HH:MM[:SS]" } (today, local to the server) or { iso }.
app.post('/api/time/set', (req, res) => {
  const body = req.body || {};
  let target = null;

  if (Number.isFinite(body.epochMs)) {
    target = body.epochMs;
  } else if (typeof body.iso === 'string') {
    const d = new Date(body.iso);
    if (!Number.isNaN(d.getTime())) target = d.getTime();
  } else if (typeof body.time === 'string') {
    const m = body.time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const d = new Date();
      d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
      target = d.getTime();
    }
  }

  if (target === null) return res.status(400).json({ error: 'Provide epochMs, iso, or time "HH:MM[:SS]"' });

  settings.timeSource.mode = 'manual';
  settings.timeSource.manualOffsetMs = target - Date.now();
  applyTimeSource();
  saveSettings();
  broadcastSettings();
  res.json(statusPayload());
});

// Nudge the manual clock by a number of milliseconds (positive or negative).
app.post('/api/time/nudge', (req, res) => {
  const delta = Number((req.body || {}).deltaMs);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'deltaMs required' });
  if (settings.timeSource.mode !== 'manual') {
    // Switch to manual, starting from the current production time.
    settings.timeSource.manualOffsetMs = timeOffsetMs;
    settings.timeSource.mode = 'manual';
  }
  settings.timeSource.manualOffsetMs = (Number(settings.timeSource.manualOffsetMs) || 0) + delta;
  applyTimeSource();
  saveSettings();
  broadcastSettings();
  res.json(statusPayload());
});

app.post('/api/countdown/:action', (req, res) => {
  const { action } = req.params;
  if (action === 'start') countdownStart();
  else if (action === 'pause') countdownPause();
  else if (action === 'reset') countdownReset();
  else if (action === 'toggle') settings.countdown.enabled = !settings.countdown.enabled;
  else return res.status(404).json({ error: 'Unknown action' });
  saveSettings();
  broadcastSettings();
  res.json(settings.countdown);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

function broadcastSettings() {
  broadcast({ type: 'settings', settings });
}

function broadcastStatus() {
  broadcast({ type: 'status', status: statusPayload() });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'settings', settings }));
  ws.send(JSON.stringify({ type: 'status', status: statusPayload() }));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg && msg.type === 'ping') {
      const t = now();
      ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, t1: t, t2: now() }));
    }
  });
  ws.on('error', () => { /* ignore */ });
});

// Keep client counts fresh on the control panel.
setInterval(broadcastStatus, 5000);

applyTimeSource();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Is another copy of Production Clock running?`);
    console.error(`Close it, or start this one on a different port, e.g.  set PORT=3001  (Windows)  or  PORT=3001 ./production-clock  (macOS/Linux).`);
  } else {
    console.error('\nServer error:', err.message);
  }
  console.error('\nThis window will close in 30 seconds.');
  setTimeout(() => process.exit(1), 30000);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Production Clock running');
  console.log(`  Control panel: http://localhost:${PORT}/control`);
  console.log(`  Clock output:  http://localhost:${PORT}/view`);
  for (const a of lanAddresses()) {
    console.log(`  LAN (${a.name}): http://${a.address}:${PORT}/view`);
  }
});
