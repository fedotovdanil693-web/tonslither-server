// ═══════════════════════════════════════════════════════
//  TON SLITHER — PvP GAME SERVER
//  Node.js + Socket.io
//  Open arena + 2.5min waves + Cash Out
//  All game logic runs HERE (server-authoritative, anti-cheat)
// ═══════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

// ═══════════════════════ CONFIG ═══════════════════════
const WORLD       = 2400;
const TICK_RATE   = 33;        // ms ~30fps
const START_SEGS  = 40;
const SEG_DIST    = 7;
const BASE_SPEED  = 2.5;
const BOOST_SPEED = 4.8;
const BOOST_MAX   = 100;
const BOOST_REGEN = 0.13;
const BOOST_DRAIN = 0.45;
const TURN_RATE   = 0.09;

const WAVE_DURATION = 150 * 1000; // 2.5 minutes per wave

const STAKE_TIERS = [0.1, 0.5, 1, 5];
const PLAYER_COLORS = ['#00aefc','#f04060','#ffd24d','#a855f7','#f97316','#22d3ee','#84cc16','#ec4899','#06b6d4','#fb7185'];

// ═══════════════════════ STATE ════════════════════════
// rooms[stake] = { players: Map<socketId, player>, waveEndsAt: ts, waveNumber: int }
const rooms = {};
STAKE_TIERS.forEach(stake => {
  rooms[stake] = {
    players: new Map(),
    waveEndsAt: Date.now() + WAVE_DURATION,
    waveNumber: 1,
  };
});

app.get('/', (req, res) => res.send('TON Slither server is running'));
app.get('/health', (req, res) => {
  const roomInfo = {};
  STAKE_TIERS.forEach(s => { roomInfo[s] = rooms[s].players.size; });
  res.json({ ok: true, rooms: roomInfo });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ═══════════════════════ HELPERS ══════════════════════
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function angleDiff(a, b) {
  return ((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
}

function makeSnake(id, name, stake) {
  const angle = Math.random() * Math.PI * 2;
  const r = 200 + Math.random() * 800;
  const cx = WORLD / 2 + Math.cos(angle) * r;
  const cy = WORLD / 2 + Math.sin(angle) * r;
  const seg = [];
  for (let i = 0; i < START_SEGS; i++) seg.push({ x: cx - i * SEG_DIST, y: cy });

  return {
    id, name, stake,
    seg,
    color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
    angle: 0,
    targetAngle: 0,
    speed: BASE_SPEED,
    boost: BOOST_MAX,
    boosting: false,
    alive: true,
    sessionEnded: false,
    kills: 0,
    earnedTon: 0,        // accumulated value from kills THIS session
    joinedAt: Date.now(),
  };
}

function snakeWidth(p) { return 9 + Math.min(p.kills * 3, 18); }
function snakeTargetLen(p) { return START_SEGS + p.kills * 20; }

function moveSnake(p, dt) {
  if (!p.alive) return;
  const da = angleDiff(p.targetAngle, p.angle);
  p.angle += clamp(da, -TURN_RATE * dt * 6, TURN_RATE * dt * 6);

  const spd = p.speed * dt;
  let hx = p.seg[0].x + Math.cos(p.angle) * spd;
  let hy = p.seg[0].y + Math.sin(p.angle) * spd;

  if (hx <= 8 || hx >= WORLD - 8) p.angle = Math.PI - p.angle;
  if (hy <= 8 || hy >= WORLD - 8) p.angle = -p.angle;

  hx = clamp(hx, 8, WORLD - 8);
  hy = clamp(hy, 8, WORLD - 8);

  p.seg.unshift({ x: hx, y: hy });
  while (p.seg.length > snakeTargetLen(p)) p.seg.pop();
}

// ═══════════════════════ SESSION END (death / cashout / leave) ═══
function endSession(room, p, reason) {
  if (p.sessionEnded) return;
  p.sessionEnded = true;
  p.alive = false;

  const pnl = p.earnedTon - p.stake;
  io.to(`room-${p.id}-private`).emit('session_end', {
    reason,              // 'death' | 'cashout' | 'left'
    kills: p.kills,
    earnedTon: p.earnedTon,
    pnl,
    length: p.seg.length,
  });

  if (reason === 'death') {
    io.to(`room-${p.stake}`).emit('kill_feed', { type: 'death', name: p.name });
  } else if (reason === 'cashout') {
    io.to(`room-${p.stake}`).emit('kill_feed', { type: 'cashout', name: p.name, amount: p.earnedTon });
  }

  setTimeout(() => room.players.delete(p.id), 50);
}

function killPlayer(room, dead, killer) {
  if (dead.sessionEnded) return;
  killer.kills += 1;
  killer.earnedTon += dead.stake;
  endSession(room, dead, 'death');
}

// ═══════════════════════ GAME LOOP PER ROOM ═══════════
function tickRoom(stake) {
  const room = rooms[stake];

  // ── wave timer ──
  const now = Date.now();
  let waveJustEnded = false;
  if (now >= room.waveEndsAt) {
    waveJustEnded = true;
    room.waveNumber += 1;
    room.waveEndsAt = now + WAVE_DURATION;
  }

  let players = [...room.players.values()];
  if (players.length === 0) {
    if (waveJustEnded) broadcastWave(room, stake, []);
    return;
  }

  const dt = 1;

  // ── update each player ──
  players.forEach(p => {
    if (!p.alive) return;
    p.speed = p.boosting && p.boost > 0 ? BOOST_SPEED : BASE_SPEED;
    if (p.boosting && p.boost > 0) {
      p.boost = Math.max(0, p.boost - BOOST_DRAIN * dt);
      if (p.boost === 0) p.boosting = false;
    } else {
      p.boost = Math.min(BOOST_MAX, p.boost + BOOST_REGEN * dt);
    }
    moveSnake(p, dt);
  });

  // ── collisions ──
  for (const p of players) {
    if (!p.alive || p.sessionEnded) continue;
    const head = p.seg[0];
    const hw = snakeWidth(p);

    for (const other of players) {
      if (other.id === p.id || !other.alive || other.sessionEnded) continue;
      const oh = other.seg[0];
      const ow = snakeWidth(other);

      // p head hits other's body -> p dies, other gets credit
      let hitBody = false;
      for (let i = 5; i < other.seg.length; i += 2) {
        if (dist(head, other.seg[i]) < ow * 0.85) { hitBody = true; break; }
      }
      if (hitBody) { killPlayer(room, p, other); break; }

      // head-on
      if (dist(head, oh) < (hw + ow) * 0.5) {
        if (p.seg.length >= other.seg.length) killPlayer(room, other, p);
        else killPlayer(room, p, other);
        break;
      }
    }
  }

  // ── broadcast live state ──
  const livePlayers = [...room.players.values()];
  const state = {
    players: livePlayers.map(p => ({
      id: p.id, name: p.name, color: p.color,
      seg: p.seg, angle: p.angle, alive: p.alive,
      kills: p.kills, stake: p.stake, boost: p.boost,
      boosting: p.boosting, earnedTon: p.earnedTon,
    })),
    wave: { number: room.waveNumber, endsAt: room.waveEndsAt },
    timestamp: now,
  };
  io.to(`room-${stake}`).emit('state', state);

  // ── wave end: leaderboard snapshot ──
  if (waveJustEnded) broadcastWave(room, stake, livePlayers);
}

function broadcastWave(room, stake, livePlayers) {
  const board = livePlayers
    .filter(p => p.alive)
    .sort((a, b) => b.earnedTon - a.earnedTon)
    .slice(0, 5)
    .map(p => ({ name: p.name, earnedTon: p.earnedTon, kills: p.kills, length: p.seg.length }));

  io.to(`room-${stake}`).emit('wave_end', {
    waveNumber: room.waveNumber,
    leaderboard: board,
    nextWaveEndsAt: room.waveEndsAt,
  });
}

// ═══════════════════════ SOCKET HANDLERS ══════════════
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('join', ({ name, stake }) => {
    stake = STAKE_TIERS.includes(stake) ? stake : STAKE_TIERS[0];
    name = (name || 'Player').toString().slice(0, 16);

    const room = rooms[stake];
    const player = makeSnake(socket.id, name, stake);
    room.players.set(socket.id, player);

    socket.join(`room-${stake}`);
    socket.join(`room-${socket.id}-private`);
    socket.data.stake = stake;

    socket.emit('joined', {
      id: socket.id,
      world: WORLD,
      you: { color: player.color, name: player.name, stake: player.stake },
      wave: { number: room.waveNumber, endsAt: room.waveEndsAt },
    });

    console.log(`${name} joined room ${stake} TON (${room.players.size} players)`);
  });

  socket.on('input', ({ angle, boosting }) => {
    const stake = socket.data.stake;
    if (stake === undefined) return;
    const p = rooms[stake].players.get(socket.id);
    if (!p || !p.alive) return;
    if (typeof angle === 'number') p.targetAngle = angle;
    p.boosting = !!boosting;
  });

  // ── Cash Out: lock in current earnings and end session immediately ──
  socket.on('cash_out', () => {
    const stake = socket.data.stake;
    if (stake === undefined) return;
    const room = rooms[stake];
    const p = room.players.get(socket.id);
    if (!p || !p.alive || p.sessionEnded) return;
    endSession(room, p, 'cashout');
  });

  socket.on('respawn', () => {
    const stake = socket.data.stake;
    if (stake === undefined) return;
    const room = rooms[stake];
    const old = room.players.get(socket.id);
    const name = old ? old.name : 'Player';
    const fresh = makeSnake(socket.id, name, stake);
    room.players.set(socket.id, fresh);
    socket.emit('joined', {
      id: socket.id, world: WORLD,
      you: { color: fresh.color, name: fresh.name, stake: fresh.stake },
      wave: { number: room.waveNumber, endsAt: room.waveEndsAt },
    });
  });

  socket.on('disconnect', () => {
    const stake = socket.data.stake;
    if (stake !== undefined && rooms[stake]) {
      const p = rooms[stake].players.get(socket.id);
      if (p && !p.sessionEnded) endSession(rooms[stake], p, 'left');
      rooms[stake].players.delete(socket.id);
    }
    console.log('disconnected:', socket.id);
  });
});

// ═══════════════════════ START LOOPS ══════════════════
STAKE_TIERS.forEach(stake => {
  setInterval(() => tickRoom(stake), TICK_RATE);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TON Slither server running on port ${PORT}`));
