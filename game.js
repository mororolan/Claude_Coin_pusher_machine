'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────
const CANVAS_W = 560;
const CANVAS_H = 500;

const COIN_RADIUS = 14;
const PUSHER_HEIGHT = 22;
const PUSHER_SPEED = 1.2;       // px per frame
const PUSHER_RANGE = 90;        // how far pusher travels forward
const GRAVITY = 0.55;
const FRICTION = 0.985;
const RESTITUTION = 0.3;        // bounciness

const PLATFORM_Y = CANVAS_H - 100;  // main platform top
const LEDGE_Y    = CANVAS_H - 40;   // front lip top (coins fall off here)
const WALL_L     = 30;
const WALL_R     = CANVAS_W - 30;
const SLOT_W     = CANVAS_W - WALL_L - WALL_R;

const COLORS = ['#ffd700', '#ffae00', '#e5c100', '#f0b429', '#ffc233'];

// Prize tokens sprinkled on the platform at start
const PRIZE_COLORS = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ff9a9e'];

// ─── State ───────────────────────────────────────────────────────────────────
let canvas, ctx;
let coins = [];        // { x, y, vx, vy, r, color, onPlatform, isResting }
let prizes = [];       // { x, y, r, color, points, collected }
let pusherX;           // current x of pusher front edge
let pusherDir = 1;     // 1 = moving forward, -1 = moving back
let pusherBase;        // resting position (back)
let coinsHeld = 20;
let score = 0;
let highScore = 0;
let autoMode = false;
let autoTimer = 0;
let lastTime = 0;
let animId;
let messageTimeout;

// ─── Init ────────────────────────────────────────────────────────────────────
function init() {
  canvas = document.getElementById('game-canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx = canvas.getContext('2d');

  pusherBase = WALL_L + 20;
  pusherX = pusherBase;

  highScore = parseInt(localStorage.getItem('coinPusherHS') || '0');
  document.getElementById('high-score').textContent = highScore;

  seedCoins();
  seedPrizes();
  bindEvents();
  requestAnimationFrame(loop);
}

function seedCoins() {
  // Place a bunch of coins already on the platform to start
  for (let i = 0; i < 28; i++) {
    const x = WALL_L + COIN_RADIUS + Math.random() * (SLOT_W - COIN_RADIUS * 2);
    const y = PLATFORM_Y - COIN_RADIUS - Math.random() * 60;
    coins.push(makeCoin(x, y, 0, 0));
  }
}

function seedPrizes() {
  const prizeData = [
    { points: 5,   label: '★5'  },
    { points: 10,  label: '★10' },
    { points: 20,  label: '★20' },
    { points: 50,  label: '★50' },
  ];
  for (let i = 0; i < 12; i++) {
    const pd = prizeData[Math.floor(Math.random() * prizeData.length)];
    prizes.push({
      x: WALL_L + 20 + Math.random() * (SLOT_W - 40),
      y: PLATFORM_Y - 10,
      r: 12,
      color: PRIZE_COLORS[Math.floor(Math.random() * PRIZE_COLORS.length)],
      points: pd.points,
      label: pd.label,
      collected: false,
    });
  }
}

function makeCoin(x, y, vx, vy) {
  return {
    x, y, vx, vy,
    r: COIN_RADIUS,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    onPlatform: false,
    isResting: false,
    shinePct: Math.random(),
  };
}

// ─── Events ──────────────────────────────────────────────────────────────────
function bindEvents() {
  const gameArea = document.getElementById('game-area');
  const indicator = document.getElementById('drop-indicator');
  const hint      = document.getElementById('drop-hint');

  gameArea.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    indicator.style.left = `${e.clientX - rect.left - 15}px`;
    indicator.style.top  = '15px';
    indicator.style.opacity = '1';
  });

  gameArea.addEventListener('mouseleave', () => {
    indicator.style.opacity = '0';
  });

  gameArea.addEventListener('click', e => {
    if (coinsHeld <= 0) { showMessage('😢', '没有硬币了！'); return; }
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const mx = Math.min(Math.max((e.clientX - rect.left) * scaleX, WALL_L + COIN_RADIUS), WALL_R - COIN_RADIUS);
    dropCoin(mx);
  });

  document.getElementById('btn-insert').addEventListener('click', () => {
    if (coinsHeld <= 0) { showMessage('😢', '没有硬币了！'); return; }
    const mx = WALL_L + COIN_RADIUS + Math.random() * (SLOT_W - COIN_RADIUS * 2);
    dropCoin(mx);
  });

  document.getElementById('btn-auto').addEventListener('click', () => {
    autoMode = !autoMode;
    const btn = document.getElementById('btn-auto');
    btn.textContent = autoMode ? '⏹ 停止自动' : '自动投币';
    btn.style.background = autoMode
      ? 'linear-gradient(135deg,#e94560,#c0392b)'
      : 'linear-gradient(135deg,#4a90d9,#2563eb)';
  });

  document.getElementById('btn-reset').addEventListener('click', resetGame);
}

function dropCoin(x) {
  coinsHeld--;
  updateUI();
  const coin = makeCoin(x, 20, (Math.random() - 0.5) * 1.5, 1);
  coins.push(coin);
}

// ─── Game loop ────────────────────────────────────────────────────────────────
function loop(ts) {
  const dt = Math.min((ts - lastTime) / 16.67, 3); // normalise to 60fps
  lastTime = ts;

  update(dt);
  render();
  animId = requestAnimationFrame(loop);
}

function update(dt) {
  // Auto-drop
  if (autoMode && coinsHeld > 0) {
    autoTimer += dt;
    if (autoTimer > 20) {
      autoTimer = 0;
      const mx = WALL_L + COIN_RADIUS + Math.random() * (SLOT_W - COIN_RADIUS * 2);
      dropCoin(mx);
    }
  }

  // Move pusher
  pusherX += PUSHER_SPEED * pusherDir * dt;
  if (pusherX >= pusherBase + PUSHER_RANGE) {
    pusherDir = -1;
  } else if (pusherX <= pusherBase) {
    pusherDir = 1;
  }

  const pusherFront = pusherX;

  // Update coins
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i];
    if (c.isResting) continue;

    // Gravity
    c.vy += GRAVITY * dt;
    // Friction on platform
    if (c.onPlatform) {
      c.vx *= Math.pow(FRICTION, dt);
    }

    c.x += c.vx * dt;
    c.y += c.vy * dt;

    // Wall collisions
    if (c.x - c.r < WALL_L) {
      c.x = WALL_L + c.r;
      c.vx = Math.abs(c.vx) * RESTITUTION;
    }
    if (c.x + c.r > WALL_R) {
      c.x = WALL_R - c.r;
      c.vx = -Math.abs(c.vx) * RESTITUTION;
    }

    // Platform collision
    if (c.y + c.r >= PLATFORM_Y && c.y - c.r < LEDGE_Y) {
      c.y = PLATFORM_Y - c.r;
      c.vy *= -RESTITUTION;
      c.onPlatform = true;
      if (Math.abs(c.vy) < 0.5 && Math.abs(c.vx) < 0.3) {
        c.vy = 0;
        if (Math.abs(c.vx) < 0.1) {
          c.vx = 0;
          c.isResting = true;
        }
      }
    }

    // Pusher collision - push coins forward
    if (
      c.onPlatform &&
      c.y + c.r >= PLATFORM_Y - 5 &&
      c.x + c.r > pusherFront &&
      c.x - c.r < pusherFront + 30 &&
      c.y > PLATFORM_Y - PUSHER_HEIGHT - c.r
    ) {
      c.x = pusherFront - c.r;
      c.vx = -PUSHER_SPEED * 2.5;
      c.isResting = false;
    }

    // Coin falls off front ledge
    if (c.x - c.r < WALL_L + 5) {
      collectCoin(i, c);
      continue;
    }

    // Coin fell off bottom (lost)
    if (c.y > CANVAS_H + 50) {
      coins.splice(i, 1);
    }
  }

  // Coin-coin collisions (simple)
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      const a = coins[i], b = coins[j];
      if (a.isResting && b.isResting) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.r + b.r;
      if (dist < minDist && dist > 0) {
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        // Separate
        if (!a.isResting) { a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5; }
        if (!b.isResting) { b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5; }
        // Exchange velocity component along normal
        const dvx = b.vx - a.vx, dvy = b.vy - a.vy;
        const dot = dvx * nx + dvy * ny;
        if (dot < 0) {
          const imp = dot * RESTITUTION;
          if (!a.isResting) { a.vx += imp * nx; a.vy += imp * ny; a.isResting = false; }
          if (!b.isResting) { b.vx -= imp * nx; b.vy -= imp * ny; b.isResting = false; }
        }
      }
    }
  }

  // Prize collection check
  for (const p of prizes) {
    if (p.collected) continue;
    // If any coin overlaps prize and prize is near ledge
    for (const c of coins) {
      const dx = c.x - p.x, dy = c.y - p.y;
      if (dx * dx + dy * dy < (c.r + p.r) * (c.r + p.r)) {
        p.x = c.x; p.y = c.y; // prize rides with coin
      }
    }
    if (p.x < WALL_L + 5 || p.y > LEDGE_Y + 10) {
      p.collected = true;
      awardPoints(p.points, p.x, p.y);
    }
  }
}

function collectCoin(index, coin) {
  coins.splice(index, 1);
  score += 1;
  coinsHeld += 2; // get back 2 for each that falls
  updateUI();
  showRewardPopup('+2🪙', coin.x, coin.y);
}

function awardPoints(pts, x, y) {
  score += pts;
  updateUI();
  showRewardPopup(`+${pts}★`, x, y);
}

function updateUI() {
  document.getElementById('coins-held').textContent = coinsHeld;
  document.getElementById('score').textContent = score;
  if (score > highScore) {
    highScore = score;
    localStorage.setItem('coinPusherHS', highScore);
    document.getElementById('high-score').textContent = highScore;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  drawBackground();
  drawPlatform();
  drawPusher();
  drawPrizes();
  drawCoins();
  drawWalls();
  drawFallingZone();
}

function drawBackground() {
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, '#0d1117');
  grad.addColorStop(1, '#1a1a2e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let x = WALL_L; x <= WALL_R; x += 30) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_H; y += 30) {
    ctx.beginPath(); ctx.moveTo(WALL_L, y); ctx.lineTo(WALL_R, y); ctx.stroke();
  }
}

function drawPlatform() {
  // Main platform
  const grad = ctx.createLinearGradient(0, PLATFORM_Y, 0, LEDGE_Y);
  grad.addColorStop(0, '#2a2a4a');
  grad.addColorStop(1, '#1a1a30');
  ctx.fillStyle = grad;
  ctx.fillRect(WALL_L, PLATFORM_Y, SLOT_W, LEDGE_Y - PLATFORM_Y);

  // Platform top sheen
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(WALL_L, PLATFORM_Y, SLOT_W, 4);

  // Ledge / drop edge
  ctx.fillStyle = '#e94560';
  ctx.fillRect(WALL_L, LEDGE_Y, SLOT_W, 4);

  // Below ledge (collection tray)
  const trayGrad = ctx.createLinearGradient(0, LEDGE_Y + 4, 0, CANVAS_H);
  trayGrad.addColorStop(0, '#1a0a0f');
  trayGrad.addColorStop(1, '#0d0509');
  ctx.fillStyle = trayGrad;
  ctx.fillRect(WALL_L, LEDGE_Y + 4, SLOT_W, CANVAS_H - LEDGE_Y - 4);

  ctx.fillStyle = 'rgba(233,69,96,0.15)';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('收币区', CANVAS_W / 2, LEDGE_Y + 30);
}

function drawPusher() {
  const py = PLATFORM_Y - PUSHER_HEIGHT;
  const pw = WALL_R - pusherX;

  // Pusher body
  const grad = ctx.createLinearGradient(pusherX, py, WALL_R, PLATFORM_Y);
  grad.addColorStop(0, '#4a90d9');
  grad.addColorStop(1, '#2563eb');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(pusherX, py, pw, PUSHER_HEIGHT, 4);
  ctx.fill();

  // Front face highlight
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(pusherX, py, 4, PUSHER_HEIGHT);

  // Push direction arrow
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('◀', pusherX + 8, PLATFORM_Y - 6);
}

function drawPrizes() {
  for (const p of prizes) {
    if (p.collected) continue;
    ctx.save();
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.font = `bold 7px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.label, p.x, p.y);
    ctx.textBaseline = 'alphabetic';
  }
}

function drawCoins() {
  for (const c of coins) {
    const grad = ctx.createRadialGradient(
      c.x - c.r * 0.3, c.y - c.r * 0.3, c.r * 0.1,
      c.x, c.y, c.r
    );
    grad.addColorStop(0, '#fff7c0');
    grad.addColorStop(0.4, c.color);
    grad.addColorStop(1, '#8b6914');

    ctx.save();
    ctx.shadowColor = 'rgba(255,215,0,0.5)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();

    // Inner ring
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r * 0.65, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Symbol
    ctx.fillStyle = 'rgba(100,70,0,0.7)';
    ctx.font = `bold ${c.r}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('¥', c.x, c.y + 1);
    ctx.textBaseline = 'alphabetic';
  }
}

function drawWalls() {
  // Left wall
  const lGrad = ctx.createLinearGradient(0, 0, WALL_L, 0);
  lGrad.addColorStop(0, '#0d1117');
  lGrad.addColorStop(1, '#1e293b');
  ctx.fillStyle = lGrad;
  ctx.fillRect(0, 0, WALL_L, CANVAS_H);

  // Right wall
  const rGrad = ctx.createLinearGradient(WALL_R, 0, CANVAS_W, 0);
  rGrad.addColorStop(0, '#1e293b');
  rGrad.addColorStop(1, '#0d1117');
  ctx.fillStyle = rGrad;
  ctx.fillRect(WALL_R, 0, CANVAS_W - WALL_R, CANVAS_H);

  // Wall borders glow
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(WALL_L, 0); ctx.lineTo(WALL_L, CANVAS_H);
  ctx.moveTo(WALL_R, 0); ctx.lineTo(WALL_R, CANVAS_H);
  ctx.stroke();
}

function drawFallingZone() {
  // Top drop zone hint
  const grad = ctx.createLinearGradient(0, 0, 0, 50);
  grad.addColorStop(0, 'rgba(233,69,96,0.15)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fillRect(WALL_L, 0, SLOT_W, 60);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showRewardPopup(text, x, y) {
  const gameArea = document.getElementById('game-area');
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / CANVAS_W;
  const scaleY = rect.height / CANVAS_H;

  const div = document.createElement('div');
  div.className = 'reward-popup';
  div.textContent = text;
  div.style.left = `${x * scaleX - 20}px`;
  div.style.top  = `${y * scaleY - 10}px`;
  gameArea.appendChild(div);
  setTimeout(() => div.remove(), 1300);
}

function showMessage(icon, text) {
  const overlay = document.getElementById('message-overlay');
  document.getElementById('message-icon').textContent = icon;
  document.getElementById('message-text').textContent = text;
  overlay.classList.remove('hidden');
  clearTimeout(messageTimeout);
  messageTimeout = setTimeout(() => overlay.classList.add('hidden'), 2000);
}

function resetGame() {
  coins = [];
  prizes = [];
  coinsHeld = 20;
  score = 0;
  autoMode = false;
  autoTimer = 0;
  const btn = document.getElementById('btn-auto');
  btn.textContent = '自动投币';
  btn.style.background = 'linear-gradient(135deg,#4a90d9,#2563eb)';
  updateUI();
  seedCoins();
  seedPrizes();
  showMessage('🔄', '游戏已重置！');
}

// ─── Start ────────────────────────────────────────────────────────────────────
window.addEventListener('load', init);
