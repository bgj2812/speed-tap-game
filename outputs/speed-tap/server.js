'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MAX_PLAYERS = 8;
const ROUND_COUNT = 5;
const TARGET_DURATION = 5000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map();
const clients = new Set();

class WebSocketPeer {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.roomCode = null;
    this.playerKey = null;
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let size = second & 0x7f;
      let headerLength = 2;
      if (!masked) return this.terminate();
      if (size === 126) {
        if (this.buffer.length < 4) return;
        size = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (size === 127) {
        if (this.buffer.length < 10) return;
        const largeSize = this.buffer.readBigUInt64BE(2);
        if (largeSize > 65536n) return this.terminate();
        size = Number(largeSize);
        headerLength = 10;
      }
      if (size > 65536) return this.terminate();
      if (this.buffer.length < headerLength + 4 + size) return;
      const mask = this.buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(this.buffer.subarray(headerLength + 4, headerLength + 4 + size));
      this.buffer = this.buffer.subarray(headerLength + 4 + size);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode !== 0x1 || !fin) return this.terminate();
      try {
        const message = JSON.parse(payload.toString('utf8'));
        handleMessage(this, message);
      } catch (_) {
        this.send({ type: 'error', message: 'That message could not be read. Please try again.' });
      }
    }
  }

  send(value) {
    if (this.closed) return;
    const payload = Buffer.from(JSON.stringify(value));
    this.sendFrame(0x1, payload);
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close() {
    if (this.closed) return;
    this.sendFrame(0x8, Buffer.alloc(0));
    this.finish();
    this.socket.end();
  }

  terminate() {
    if (this.closed) return;
    this.finish();
    this.socket.destroy();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    clients.delete(this);
    detachPeer(this);
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('ok');
  }
  if (url.pathname === '/ws') {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', 'upgrade': 'websocket' });
    return res.end('WebSocket upgrade required');
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (_) {
    res.writeHead(400); return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
    }
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'cache-control': ['.html', '.css', '.js'].includes(path.extname(file)) ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    res.end(body);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
  const peer = new WebSocketPeer(socket);
  clients.add(peer);
});

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18);
}

function normalizePlayerKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 80);
}

function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function error(peer, message) { peer.send({ type: 'error', message }); }

function handleMessage(peer, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return error(peer, 'That message could not be read.');
  if (message.type === 'heartbeat') return peer.send({ type: 'heartbeat', serverNow: Date.now() });
  if (message.type === 'create') return createRoom(peer, message);
  if (message.type === 'join') return joinRoom(peer, message);
  if (message.type === 'leave') return leaveRoom(peer);
  const room = peer.roomCode && rooms.get(peer.roomCode);
  const player = room && room.players.get(peer.playerKey);
  if (!room || !player || player.peer !== peer) return error(peer, 'Join a room before playing.');
  if (message.type === 'ready') return setReady(room, player, message.ready, 'lobby');
  if (message.type === 'rematch') return setReady(room, player, message.ready, 'finished');
  if (message.type === 'tap') return acceptTap(room, player, message.round);
  error(peer, 'That game action is not available.');
}

function createRoom(peer, message) {
  const name = normalizeName(message.name);
  const playerKey = normalizePlayerKey(message.playerKey);
  if (!name) return error(peer, 'Please choose a name to create a room.');
  if (!playerKey) return error(peer, 'This browser could not create a player ID. Please refresh and try again.');
  if (peer.roomCode) leaveRoom(peer, false);
  const code = makeRoomCode();
  const player = { playerKey, name, score: 0, connected: true, ready: false, isHost: true, peer };
  const room = {
    code, phase: 'lobby', stage: 'lobby', round: 0, players: new Map([[playerKey, player]]),
    winner: null, roundDeadline: null, timer: null, attempted: new Set(), lastTouchedAt: Date.now(),
  };
  rooms.set(code, room);
  peer.roomCode = code;
  peer.playerKey = playerKey;
  broadcast(room);
}

function joinRoom(peer, message) {
  const name = normalizeName(message.name);
  const playerKey = normalizePlayerKey(message.playerKey);
  const code = normalizeCode(message.code);
  if (!name) return error(peer, 'Please choose a name before joining.');
  if (!playerKey) return error(peer, 'This browser could not create a player ID. Please refresh and try again.');
  if (code.length !== 5) return error(peer, 'Room codes are five characters long. Check the code and try again.');
  const room = rooms.get(code);
  if (!room) return error(peer, `Room ${code} wasn’t found. Check the code or ask your friend for a new one.`);
  const existing = room.players.get(playerKey);
  if (!existing && room.phase !== 'lobby') return error(peer, 'This game is already underway. Join the room before the next match.');
  if (!existing && room.players.size >= MAX_PLAYERS) return error(peer, 'This room is full. The limit is 8 players.');
  if (peer.roomCode) leaveRoom(peer, false);
  let player = existing;
  if (!player) {
    player = { playerKey, name, score: 0, connected: true, ready: false, isHost: false, peer };
    room.players.set(playerKey, player);
  } else {
    if (player.peer && player.peer !== peer) player.peer.close();
    player.name = name;
    player.connected = true;
    player.peer = peer;
    if (room.phase === 'lobby' || room.phase === 'finished') player.ready = false;
  }
  room.lastTouchedAt = Date.now();
  peer.roomCode = room.code;
  peer.playerKey = playerKey;
  broadcast(room);
}

function leaveRoom(peer, notify = true) {
  const room = peer.roomCode && rooms.get(peer.roomCode);
  const player = room && room.players.get(peer.playerKey);
  if (player && player.peer === peer) {
    player.peer = null;
    player.connected = false;
    player.ready = false;
    room.lastTouchedAt = Date.now();
    broadcast(room);
  }
  peer.roomCode = null;
  peer.playerKey = null;
  if (notify) peer.send({ type: 'left' });
}

function detachPeer(peer) {
  const room = peer.roomCode && rooms.get(peer.roomCode);
  const player = room && room.players.get(peer.playerKey);
  if (player && player.peer === peer) {
    player.peer = null;
    player.connected = false;
    player.ready = false;
    room.lastTouchedAt = Date.now();
    broadcast(room);
  }
  peer.roomCode = null;
  peer.playerKey = null;
}

function setReady(room, player, desired, phase) {
  if (room.phase !== phase) return error(player.peer, 'The game has already moved on.');
  player.ready = typeof desired === 'boolean' ? desired : !player.ready;
  room.lastTouchedAt = Date.now();
  const connected = [...room.players.values()].filter((person) => person.connected);
  if (connected.length >= 2 && connected.every((person) => person.ready)) {
    startMatch(room);
  } else {
    broadcast(room);
  }
}

function startMatch(room) {
  clearTimeout(room.timer);
  room.phase = 'playing';
  room.stage = 'waiting';
  room.round = 1;
  room.winner = null;
  room.roundDeadline = null;
  room.attempted = new Set();
  for (const player of room.players.values()) {
    player.score = 0;
    player.ready = false;
  }
  room.lastTouchedAt = Date.now();
  scheduleRound(room);
}

function scheduleRound(room) {
  room.phase = 'playing';
  room.stage = 'waiting';
  room.winner = null;
  room.targetAt = null;
  room.roundDeadline = null;
  room.attempted = new Set();
  room.lastTouchedAt = Date.now();
  broadcast(room);
  const wait = crypto.randomInt(1400, 4501);
  room.timer = setTimeout(() => beginActiveRound(room), wait);
}

function beginActiveRound(room) {
  if (!rooms.has(room.code) || room.phase !== 'playing' || room.stage !== 'waiting') return;
  const targetAt = Date.now();
  room.stage = 'active';
  room.roundDeadline = targetAt + TARGET_DURATION;
  room.targetAt = targetAt;
  room.lastTouchedAt = targetAt;
  broadcast(room);
  room.timer = setTimeout(() => finishRound(room, null), TARGET_DURATION);
}

function acceptTap(room, player, round) {
  if (room.phase !== 'playing' || room.stage !== 'active' || round !== room.round) return;
  if (!player.connected || !player.peer || room.attempted.has(player.playerKey)) return;
  room.attempted.add(player.playerKey);
  const receivedAt = Date.now();
  if (receivedAt > room.roundDeadline) return;
  finishRound(room, player, receivedAt);
}

function finishRound(room, winner, receivedAt) {
  if (room.phase !== 'playing' || room.stage !== 'active') return;
  clearTimeout(room.timer);
  room.stage = 'result';
  room.roundDeadline = null;
  if (winner) {
    winner.score += 1;
    room.winner = {
      playerKey: winner.playerKey,
      name: winner.name,
      reactionMs: Math.max(0, receivedAt - room.targetAt),
    };
  } else {
    room.winner = null;
  }
  room.lastTouchedAt = Date.now();
  broadcast(room);
  room.timer = setTimeout(() => {
    if (room.round >= ROUND_COUNT) {
      room.phase = 'finished';
      room.stage = 'finished';
      room.lastTouchedAt = Date.now();
      broadcast(room);
    } else {
      room.round += 1;
      scheduleRound(room);
    }
  }, 2100);
}

function snapshot(room) {
  const players = [...room.players.values()].map((player) => ({
    playerKey: player.playerKey,
    name: player.name,
    score: player.score,
    connected: player.connected,
    ready: player.ready,
    isHost: player.isHost,
  }));
  return {
    code: room.code,
    phase: room.phase,
    stage: room.stage,
    round: room.round,
    roundCount: ROUND_COUNT,
    targetAt: room.targetAt || null,
    deadlineAt: room.roundDeadline,
    winner: room.winner,
    connectedCount: players.filter((player) => player.connected).length,
    players,
  };
}

function broadcast(room) {
  const message = { type: 'state', serverNow: Date.now(), room: snapshot(room) };
  for (const player of room.players.values()) {
    if (player.peer && player.connected) player.peer.send(message);
  }
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if ([...room.players.values()].some((player) => player.connected)) continue;
    if (now - room.lastTouchedAt < 4 * 60 * 60 * 1000) continue;
    clearTimeout(room.timer);
    rooms.delete(code);
  }
}, 15 * 60 * 1000);
cleanup.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Speed Tap listening on ${PORT}`);
});
