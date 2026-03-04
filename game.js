import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// esm.sh properly converts CJS→ESM for cannon-es
import * as CANNON from 'https://esm.sh/cannon-es@0.20.0';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const PW       =  7.0;   // platform width (x)
const BACK_Z   = -4.5;   // back wall z
const EDGE_Z   =  3.2;   // drop edge z (coins fall off here)
const WALL_X   =  3.5;   // ±x wall inner face
const WALL_H   =  3.0;   // wall height above platform
const COIN_R   =  0.34;
const COIN_T   =  0.11;
const PRIZE_R  =  0.46;
const PRIZE_T  =  0.15;

const PUS_Z_BACK = -3.8;  // pusher rest z
const PUS_Z_FWD  = -0.4;  // pusher forward limit z
const PUS_SPEED  =  1.6;  // units / second

const MAX_COINS  = 150;
const MAX_PRIZES = 16;
const SEED_COINS  = 48;
const SEED_PRIZES = 10;
const INIT_COINS  = 30;
const JP_THRESH   = 180;

const COIN_COLORS = [0xFFD700, 0xFFC200, 0xFFAA00, 0xF0B000];
const PRIZE_DEFS  = [
  { color: 0xFF4455, emissive: 0xFF2233, pts: 5,  label: '×5'  },
  { color: 0x44AAFF, emissive: 0x2288FF, pts: 10, label: '×10' },
  { color: 0x44FF88, emissive: 0x22DD66, pts: 20, label: '×20' },
  { color: 0xFF88FF, emissive: 0xFF44FF, pts: 50, label: '★JP' },
];

// Slot machine
const SLOT_SYMS   = ['7', '★', '♦', '♣', '♥', '♠', '$'];
const SLOT_COLORS = ['#FF4444','#FFD700','#44AAFF','#44FF88','#FF44FF','#FF8800','#FFFFFF'];
const SLOT_W = 512, SLOT_H = 256;

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
let scene, camera, renderer, controls;
let world, matCoin, matWall;
let pusherBody, pusherMesh;
let dropArrow;
let coinPool = [], prizePool = [];
let coinsHeld = INIT_COINS, score = 0, highScore = 0, jpMeter = 0;
let pusherDir = 1;
let autoMode = false, autoTimer = 0;
let lastTime = 0;
let now = 0; // running ms timestamp

// Slot machine state
let slotCanvas, slotCtx, slotTex;
let slotReels = [
  { pos: 0, speed: 0, landed: false },
  { pos: 0, speed: 0, landed: false },
  { pos: 0, speed: 0, landed: false },
];
let slotState  = 'idle';   // 'idle' | 'spin' | 'result'
let slotTimer  = 0;
let spinCoins  = 0;        // coins collected since last spin
const SPIN_EVERY = 8;      // trigger slot every N coins collected

// Raycasting for drop position
const dropRaycaster = new THREE.Raycaster();
let   dropPlane;           // THREE.Plane – set after init

// Shared geometry
let coinGeo, coinMats, prizeGeos, prizeMats;

// ═══════════════════════════════════════════════════════════════
// ENTRY
// ═══════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
  highScore = parseInt(localStorage.getItem('cp3d_hs') || '0');
  initThree();
  initPhysics();
  buildCabinet();
  buildPusher();
  buildSlotDisplay();
  buildSharedGeometry();
  buildCoinPool();
  buildPrizePool();
  seedCoins();
  seedPrizes();
  bindUI();
  updateUI();
  requestAnimationFrame(loop);
});

// ═══════════════════════════════════════════════════════════════
// THREE.JS
// ═══════════════════════════════════════════════════════════════
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060810);
  scene.fog = new THREE.FogExp2(0x060810, 0.022);

  camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);
  camera.position.set(0, 11, 18);
  camera.lookAt(0, 0.5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const container = document.getElementById('canvas-container');
  container.appendChild(renderer.domElement);
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);

  // Camera controls: right-click drag = orbit, scroll = zoom, left-click = drop
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.5, 0);
  controls.minDistance = 9;
  controls.maxDistance = 30;
  controls.minPolarAngle = Math.PI / 8;
  controls.maxPolarAngle = Math.PI / 2.3;
  controls.enablePan = false;
  controls.mouseButtons = {
    LEFT:   null,                   // left-click reserved for dropping coins
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT:  THREE.MOUSE.ROTATE,
  };
  controls.update();

  // Lights
  scene.add(new THREE.AmbientLight(0x223366, 0.5));

  const sun = new THREE.DirectionalLight(0xfff0dd, 1.0);
  sun.position.set(4, 16, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -10; sun.shadow.camera.right = 10;
  sun.shadow.camera.top  =  10; sun.shadow.camera.bottom = -10;
  sun.shadow.camera.far  = 50;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  // LED corner / accent lights inside cabinet
  const ledCfg = [
    { color: 0xFF6633, pos: [-WALL_X + 0.4, WALL_H * 0.8, BACK_Z + 0.6] },
    { color: 0xFFCC00, pos: [ WALL_X - 0.4, WALL_H * 0.8, BACK_Z + 0.6] },
    { color: 0x33AAFF, pos: [-WALL_X + 0.4, WALL_H * 0.6, EDGE_Z - 0.4] },
    { color: 0xFF33CC, pos: [ WALL_X - 0.4, WALL_H * 0.6, EDGE_Z - 0.4] },
  ];
  ledCfg.forEach(({ color, pos }) => {
    const pl = new THREE.PointLight(color, 1.4, 9, 1.8);
    pl.position.set(...pos);
    scene.add(pl);
  });

  // Slot illumination light
  const slotLight = new THREE.PointLight(0xffffff, 0.7, 5);
  slotLight.position.set(0, 2.6, BACK_Z + 1.2);
  scene.add(slotLight);

  // Drop plane: vertical plane at z = BACK_Z+0.6 facing player (+z normal)
  // Plane equation: normal·p + d = 0  →  z + d = 0  →  d = -(BACK_Z+0.6)
  dropPlane = new THREE.Plane(
    new THREE.Vector3(0, 0, 1),
    -(BACK_Z + 0.6)
  );
}

function resizeRenderer() {
  const c = document.getElementById('canvas-container');
  const w = c.clientWidth  || window.innerWidth;
  const h = c.clientHeight || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ═══════════════════════════════════════════════════════════════
// PHYSICS
// ═══════════════════════════════════════════════════════════════
function initPhysics() {
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 14;
  world.allowSleep = true;

  matCoin = new CANNON.Material('coin');
  matWall = new CANNON.Material('wall');

  world.addContactMaterial(new CANNON.ContactMaterial(matCoin, matWall, {
    friction: 0.45, restitution: 0.12,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(matCoin, matCoin, {
    friction: 0.30, restitution: 0.08,
  }));
}

// ═══════════════════════════════════════════════════════════════
// CABINET
// ═══════════════════════════════════════════════════════════════
function buildCabinet() {
  const depth = EDGE_Z - BACK_Z;   // total platform depth
  const midZ  = (BACK_Z + EDGE_Z) / 2;

  // Platform base (physics + mesh)
  addStaticBox(PW, 0.5, depth, 0, -0.25, midZ, matWall,
    new THREE.MeshStandardMaterial({ color: 0x0c1f14, roughness: 0.9 }));

  // Green felt surface (visual only)
  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(PW, depth),
    new THREE.MeshStandardMaterial({ color: 0x0d3a1e, roughness: 1.0, metalness: 0 })
  );
  felt.rotation.x = -Math.PI / 2;
  felt.position.set(0, 0.01, midZ);
  felt.receiveShadow = true;
  scene.add(felt);

  // Subtle grid lines on felt
  const gridMat = new THREE.MeshStandardMaterial({
    color: 0x0a2a15, roughness: 1.0, transparent: true, opacity: 0.6
  });
  for (let i = -3; i <= 3; i++) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.04, depth), gridMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(i, 0.015, midZ);
    scene.add(line);
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0b1320, roughness: 0.85, metalness: 0.25 });

  // Left wall
  addStaticBox(0.3, WALL_H, depth + 0.6,
    -WALL_X - 0.15, WALL_H / 2, midZ, matWall, wallMat);

  // Right wall
  addStaticBox(0.3, WALL_H, depth + 0.6,
     WALL_X + 0.15, WALL_H / 2, midZ, matWall, wallMat);

  // Back wall
  addStaticBox(PW + 0.6, WALL_H, 0.3,
    0, WALL_H / 2, BACK_Z - 0.15, matWall, wallMat);

  // Front drop lip (low barrier coins push over)
  addStaticBox(PW, 0.18, 0.14, 0, 0.09, EDGE_Z, matWall,
    new THREE.MeshStandardMaterial({ color: 0x556677, roughness: 0.4, metalness: 0.7 }));

  // Collection tray (visual only, no physics needed)
  const trayMesh = new THREE.Mesh(
    new THREE.BoxGeometry(PW, 0.08, 2.6),
    new THREE.MeshStandardMaterial({ color: 0x080b12, roughness: 0.85 })
  );
  trayMesh.position.set(0, -0.65, EDGE_Z + 1.4);
  trayMesh.receiveShadow = true;
  scene.add(trayMesh);

  // Tray label
  const trayLabel = new THREE.Mesh(
    new THREE.PlaneGeometry(PW, 2.6),
    new THREE.MeshStandardMaterial({
      color: 0x0d2a1a, roughness: 1.0,
      emissive: new THREE.Color(0x0a1a10), emissiveIntensity: 0.4,
    })
  );
  trayLabel.rotation.x = -Math.PI / 2;
  trayLabel.position.set(0, -0.60, EDGE_Z + 1.4);
  scene.add(trayLabel);

  // ── LED emissive strip meshes ──────────────────────────────────
  const ledGeoH    = new THREE.BoxGeometry(PW + 0.3, 0.06, 0.07);
  const ledGeoSide = new THREE.BoxGeometry(0.07, 0.06, depth + 0.3);
  [
    { geo: ledGeoH,    color: 0xFF6633, pos: [0, WALL_H + 0.03, BACK_Z - 0.05] },
    { geo: ledGeoH,    color: 0x33AAFF, pos: [0, WALL_H + 0.03, EDGE_Z + 0.05] },
    { geo: ledGeoSide, color: 0xFFCC00, pos: [-WALL_X - 0.29, WALL_H + 0.03, midZ] },
    { geo: ledGeoSide, color: 0xFF33CC, pos: [ WALL_X + 0.29, WALL_H + 0.03, midZ] },
  ].forEach(({ geo, color, pos }) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 2.5,
    }));
    m.position.set(...pos);
    scene.add(m);
  });
}

function addStaticBox(w, h, d, x, y, z, phyMat, threeMat) {
  if (phyMat) {
    const body = new CANNON.Body({ mass: 0, material: phyMat });
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    body.position.set(x, y, z);
    world.addBody(body);
  }
  if (threeMat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), threeMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }
}

// ═══════════════════════════════════════════════════════════════
// PUSHER
// ═══════════════════════════════════════════════════════════════
function buildPusher() {
  const ph = 0.62, pd = 0.56;

  pusherBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matWall });
  pusherBody.addShape(new CANNON.Box(new CANNON.Vec3((PW - 0.05) / 2, ph / 2, pd / 2)));
  pusherBody.position.set(0, ph / 2, PUS_Z_BACK);
  world.addBody(pusherBody);

  pusherMesh = new THREE.Mesh(
    new THREE.BoxGeometry(PW - 0.05, ph, pd),
    new THREE.MeshStandardMaterial({ color: 0x8899bb, metalness: 0.88, roughness: 0.18 })
  );
  pusherMesh.castShadow = true;
  scene.add(pusherMesh);

  // Glowing amber strip on pusher front face
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(PW - 0.1, 0.07, 0.02),
    new THREE.MeshStandardMaterial({ color: 0xFF9900, emissive: 0xFF9900, emissiveIntensity: 2.5 })
  );
  strip.position.set(0, 0, -(pd / 2 + 0.012));
  pusherMesh.add(strip);

  // Drop arrow indicator (3D cone above drop zone)
  const arrowGroup = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.5, 10),
    new THREE.MeshStandardMaterial({ color: 0xFFDD00, emissive: 0xFFAA00, emissiveIntensity: 1.5 })
  );
  cone.position.y = -0.25;
  arrowGroup.add(cone);
  arrowGroup.position.set(0, WALL_H + 0.9, BACK_Z + 0.8);
  arrowGroup.visible = false;
  scene.add(arrowGroup);
  dropArrow = arrowGroup;
}

// ═══════════════════════════════════════════════════════════════
// SLOT MACHINE DISPLAY
// ═══════════════════════════════════════════════════════════════
function buildSlotDisplay() {
  slotCanvas = document.createElement('canvas');
  slotCanvas.width  = SLOT_W;
  slotCanvas.height = SLOT_H;
  slotCtx = slotCanvas.getContext('2d');

  slotTex = new THREE.CanvasTexture(slotCanvas);
  slotTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const panelMat = new THREE.MeshStandardMaterial({
    map: slotTex,
    emissiveMap: slotTex,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: 0.55,
    roughness: 0.15,
    metalness: 0.05,
  });

  // Main display panel
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(5.0, 2.4), panelMat);
  panel.position.set(0, 1.5, BACK_Z + 0.22);
  scene.add(panel);

  // Frame around the panel
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xFFAA00, metalness: 0.9, roughness: 0.15,
    emissive: 0xFF8800, emissiveIntensity: 0.4,
  });
  const frameGeo = new THREE.BoxGeometry(5.4, 2.8, 0.08);
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.set(0, 1.5, BACK_Z + 0.18);
  scene.add(frame);

  drawSlot();
}

function drawSlot() {
  const ctx = slotCtx;
  const W = SLOT_W, H = SLOT_H;

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a0620');
  bg.addColorStop(1, '#050215');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Outer border glow
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, W - 8, H - 8);

  // Inner border
  ctx.strokeStyle = '#FF8800';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, W - 24, H - 24);

  // Title bar
  const titleGrad = ctx.createLinearGradient(0, 14, 0, 44);
  titleGrad.addColorStop(0, '#FF8800');
  titleGrad.addColorStop(1, '#CC5500');
  ctx.fillStyle = titleGrad;
  ctx.fillRect(14, 14, W - 28, 34);

  ctx.fillStyle = '#FFE066';
  ctx.font = 'bold 22px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('★ LUCKY  SLOTS ★', W / 2, 31);

  // Three reel slots
  const REEL_W = 120, REEL_H = 118;
  const REEL_Y = 52;
  const reelXs = [W / 2 - 132, W / 2, W / 2 + 132];
  const isWin = slotState === 'result' && (() => {
    const s = slotReels.map(r => Math.floor(r.pos) % SLOT_SYMS.length);
    return s[0] === s[1] && s[1] === s[2];
  })();

  reelXs.forEach((rx, i) => {
    // Reel shadow
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.roundRect(rx - REEL_W / 2 + 3, REEL_Y + 3, REEL_W, REEL_H, 10);
    ctx.fill();

    // Reel background
    const reelBg = ctx.createLinearGradient(rx - REEL_W/2, 0, rx + REEL_W/2, 0);
    reelBg.addColorStop(0, '#12082a');
    reelBg.addColorStop(0.5, '#1c0d3a');
    reelBg.addColorStop(1, '#12082a');
    ctx.fillStyle = reelBg;
    ctx.beginPath();
    ctx.roundRect(rx - REEL_W / 2, REEL_Y, REEL_W, REEL_H, 10);
    ctx.fill();

    // Reel border — flashes gold on win
    const flashOn = isWin && Math.floor(now / 120) % 2 === 0;
    ctx.strokeStyle = flashOn ? '#FFD700' : (slotState === 'spin' ? '#FF8800' : '#334466');
    ctx.lineWidth = flashOn ? 4 : 2.5;
    ctx.beginPath();
    ctx.roundRect(rx - REEL_W / 2, REEL_Y, REEL_W, REEL_H, 10);
    ctx.stroke();

    // Highlight line across middle of reel
    ctx.fillStyle = 'rgba(255,220,0,0.08)';
    ctx.fillRect(rx - REEL_W / 2, REEL_Y + REEL_H / 2 - 22, REEL_W, 44);

    // Symbol
    const symIdx = Math.floor(reels_pos(i)) % SLOT_SYMS.length;
    ctx.fillStyle = SLOT_COLORS[symIdx];
    ctx.shadowColor  = SLOT_COLORS[symIdx];
    ctx.shadowBlur   = slotState === 'spin' ? 18 : 8;
    ctx.font = 'bold 62px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(SLOT_SYMS[symIdx], rx, REEL_Y + REEL_H / 2);
    ctx.shadowBlur = 0;

    // Spinning motion blur (faint symbols above/below)
    if (slotState === 'spin' && slotReels[i].speed > 1) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = SLOT_COLORS[symIdx];
      ctx.font = 'bold 40px Arial';
      const prevIdx = (symIdx - 1 + SLOT_SYMS.length) % SLOT_SYMS.length;
      const nextIdx = (symIdx + 1) % SLOT_SYMS.length;
      ctx.fillText(SLOT_SYMS[prevIdx], rx, REEL_Y + 20);
      ctx.fillText(SLOT_SYMS[nextIdx], rx, REEL_Y + REEL_H - 18);
      ctx.globalAlpha = 1.0;
    }
  });

  // Status / result text
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (slotState === 'result') {
    if (isWin) {
      const flash = Math.floor(now / 150) % 2 === 0;
      ctx.fillStyle = flash ? '#FFD700' : '#FF8800';
      ctx.font = 'bold 24px Arial';
      ctx.shadowColor = '#FFD700'; ctx.shadowBlur = 20;
      ctx.fillText('🎉  BIG WIN !!  🎉', W / 2, REEL_Y + REEL_H + 20);
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = '#667799';
      ctx.font = '18px Arial';
      ctx.fillText('Try Again...', W / 2, REEL_Y + REEL_H + 20);
    }
  } else if (slotState === 'spin') {
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 18px Arial';
    ctx.fillText('S P I N N I N G . . .', W / 2, REEL_Y + REEL_H + 20);
  } else {
    // Idle: show next spin countdown
    const left = SPIN_EVERY - spinCoins;
    ctx.fillStyle = '#556688';
    ctx.font = '16px Arial';
    ctx.fillText(`${left} coin${left === 1 ? '' : 's'} to spin`, W / 2, REEL_Y + REEL_H + 20);
  }

  slotTex.needsUpdate = true;
}

// Helper: get current display position for reel i
function reels_pos(i) {
  return slotReels[i].pos;
}

function spinSlots() {
  if (slotState !== 'idle') return;
  slotState = 'spin';
  slotTimer = 0;
  slotReels.forEach((r, i) => {
    r.speed  = 12 + i * 4;    // left reel slowest, stops first
    r.landed = false;
    r.target = Math.random() < 0.2
      ? slotReels[0].target ?? Math.floor(Math.random() * SLOT_SYMS.length) // chance of win
      : Math.floor(Math.random() * SLOT_SYMS.length);
  });
  // 20% jackpot: force matching
  if (Math.random() < 0.2) {
    const sym = Math.floor(Math.random() * SLOT_SYMS.length);
    slotReels.forEach(r => { r.target = sym; });
  }
}

function updateSlot(dt) {
  if (slotState === 'spin') {
    slotTimer += dt;
    // Decelerate each reel, left stops first (shortest spin)
    slotReels.forEach((r, i) => {
      const stopDelay = i * 0.55;
      if (slotTimer > 0.6 + stopDelay) {
        r.speed = Math.max(0, r.speed - dt * (5 + i * 2));
        if (r.speed === 0 && !r.landed) {
          r.landed = true;
          r.pos = r.target;      // snap to landed symbol
        } else if (r.speed > 0) {
          r.pos += r.speed * dt;
        }
      } else {
        r.pos += r.speed * dt;   // free-spin
      }
    });

    const allLanded = slotReels.every(r => r.landed);
    if (allLanded) {
      slotState = 'result';
      slotTimer = 0;
      resolveSlot();
    }
    drawSlot();

  } else if (slotState === 'result') {
    slotTimer += dt;
    drawSlot(); // animate flash

    if (slotTimer > 3.5) {
      slotState = 'idle';
      drawSlot();
    }
  }
}

function resolveSlot() {
  const syms = slotReels.map(r => r.pos % SLOT_SYMS.length);
  const win  = syms[0] === syms[1] && syms[1] === syms[2];
  if (win) {
    const bonus = 10 + Math.floor(syms[0]) * 5;
    showMsg(`🎰 老虎机 BIG WIN！+${bonus} 硬币！`);
    coinsHeld += bonus;
    updateUI();
    // Rain bonus coins onto the platform
    for (let i = 0; i < Math.min(bonus / 2, 14); i++) {
      setTimeout(() => {
        spawnCoin(
          (Math.random() - 0.5) * (PW - 0.8),
          WALL_H + 0.8 + Math.random() * 1.5,
          PUS_Z_BACK + 0.5 + Math.random() * (EDGE_Z - PUS_Z_BACK - 1.2)
        );
      }, i * 90);
    }
  }
  drawSlot();
}

// ═══════════════════════════════════════════════════════════════
// SHARED GEOMETRY / POOLS
// ═══════════════════════════════════════════════════════════════
function buildSharedGeometry() {
  coinGeo  = new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_T, 24);
  coinMats = COIN_COLORS.map(c =>
    new THREE.MeshStandardMaterial({ color: c, metalness: 0.95, roughness: 0.12 })
  );
  prizeGeos = PRIZE_DEFS.map(() =>
    new THREE.CylinderGeometry(PRIZE_R, PRIZE_R, PRIZE_T, 24)
  );
  prizeMats = PRIZE_DEFS.map(d =>
    new THREE.MeshStandardMaterial({
      color: d.color, emissive: new THREE.Color(d.emissive),
      emissiveIntensity: 0.55, metalness: 0.7, roughness: 0.22,
    })
  );
}

function buildCoinPool() {
  for (let i = 0; i < MAX_COINS; i++) {
    const mi   = i % coinMats.length;
    const mesh = new THREE.Mesh(coinGeo, coinMats[mi]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.visible = false;
    scene.add(mesh);

    const body = new CANNON.Body({
      mass: 0.08, material: matCoin,
      linearDamping: 0.36, angularDamping: 0.80,
      allowSleep: true, sleepSpeedLimit: 0.22, sleepTimeLimit: 0.4,
    });
    body.addShape(new CANNON.Cylinder(COIN_R, COIN_R, COIN_T, 12));
    body.position.set(0, -100, 0);
    body.sleep();
    world.addBody(body);
    coinPool.push({ body, mesh, active: false });
  }
}

function buildPrizePool() {
  for (let i = 0; i < MAX_PRIZES; i++) {
    const ti   = i % PRIZE_DEFS.length;
    const mesh = new THREE.Mesh(prizeGeos[ti], prizeMats[ti]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.visible = false;
    scene.add(mesh);

    const body = new CANNON.Body({
      mass: 0.12, material: matCoin,
      linearDamping: 0.48, angularDamping: 0.88,
      allowSleep: true, sleepSpeedLimit: 0.2, sleepTimeLimit: 0.4,
    });
    body.addShape(new CANNON.Cylinder(PRIZE_R, PRIZE_R, PRIZE_T, 12));
    body.position.set(0, -100, 0);
    body.sleep();
    world.addBody(body);
    prizePool.push({ body, mesh, active: false, typeIdx: ti });
  }
}

// ═══════════════════════════════════════════════════════════════
// SPAWN / SEED
// ═══════════════════════════════════════════════════════════════
function spawnCoin(x, y, z, vx = 0, vy = 0, vz = 0) {
  const slot = coinPool.find(c => !c.active);
  if (!slot) return;
  slot.active = true;
  slot.mesh.visible = true;
  const b = slot.body;
  b.position.set(x, y, z);
  b.velocity.set(vx, vy, vz);
  b.angularVelocity.set(
    (Math.random() - 0.5) * 3,
    (Math.random() - 0.5) * 3,
    (Math.random() - 0.5) * 3
  );
  b.quaternion.setFromEuler(
    (Math.random() - 0.5) * 0.5,
    Math.random() * Math.PI * 2,
    (Math.random() - 0.5) * 0.5
  );
  b.wakeUp();
}

function spawnPrize(x, z, typeIdx) {
  const slot = prizePool.find(p => !p.active);
  if (!slot) return;
  slot.active = true;
  slot.typeIdx = typeIdx;
  slot.mesh.geometry = prizeGeos[typeIdx];
  slot.mesh.material = prizeMats[typeIdx];
  slot.mesh.visible  = true;
  const b = slot.body;
  b.position.set(x, PRIZE_T / 2 + 0.02, z);
  b.velocity.set(0, 0, 0);
  b.angularVelocity.set(0, (Math.random() - 0.5) * 0.5, 0);
  b.quaternion.setFromEuler(0, Math.random() * Math.PI * 2, 0);
  b.wakeUp();
}

function seedCoins() {
  for (let i = 0; i < SEED_COINS; i++) {
    const x     = (Math.random() - 0.5) * (PW - 1.2);
    const z     = PUS_Z_BACK + 0.7 + Math.random() * (EDGE_Z - PUS_Z_BACK - 1.6);
    const layer = Math.floor(i / 14);
    spawnCoin(x, COIN_T / 2 + layer * (COIN_T + 0.04) + 0.03, z);
  }
}

function seedPrizes() {
  for (let i = 0; i < SEED_PRIZES; i++) {
    const x = (Math.random() - 0.5) * (PW - 2.0);
    const z = PUS_Z_BACK + 1.2 + Math.random() * (EDGE_Z - PUS_Z_BACK - 2.2);
    spawnPrize(x, z, i % PRIZE_DEFS.length);
  }
}

// ═══════════════════════════════════════════════════════════════
// DROP COIN
// ═══════════════════════════════════════════════════════════════
function dropCoin(worldX) {
  if (coinsHeld <= 0) { showMsg('😢 硬币不足！'); return; }
  coinsHeld--;
  const cx = Math.max(-WALL_X + COIN_R + 0.2, Math.min(WALL_X - COIN_R - 0.2, worldX));
  spawnCoin(cx, WALL_H + 0.8, BACK_Z + 0.8, (Math.random() - 0.5) * 0.6, 0, 0.5);
  updateUI();
}

// ═══════════════════════════════════════════════════════════════
// GAME LOOP
// ═══════════════════════════════════════════════════════════════
function loop(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;
  now = ts;  // update global timestamp for slot animation
  update(dt, ts);
  syncMeshes();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

function update(dt, ts) {
  // Auto-drop
  if (autoMode && coinsHeld > 0) {
    autoTimer += dt;
    if (autoTimer > 0.44) {
      autoTimer = 0;
      dropCoin((Math.random() - 0.5) * (PW - 1));
    }
  }

  // Pusher oscillation (kinematic body)
  const pz = pusherBody.position.z;
  pusherBody.velocity.set(0, 0, PUS_SPEED * pusherDir);
  if (pz >= PUS_Z_FWD)  pusherDir = -1;
  if (pz <= PUS_Z_BACK) pusherDir =  1;

  // Bounce drop arrow
  if (dropArrow.visible) {
    dropArrow.position.y = WALL_H + 0.9 + Math.sin(ts / 280) * 0.14;
  }

  // Physics step
  world.fixedStep(1 / 60, dt, 3);

  // Check coin collection
  for (let i = coinPool.length - 1; i >= 0; i--) {
    const c = coinPool[i];
    if (!c.active) continue;
    const p = c.body.position;
    if (p.z > EDGE_Z + 0.7 || p.y < -1.5) {
      collectCoin(c, p.x, p.y, p.z);
    }
  }

  // Check prize collection
  for (const pr of prizePool) {
    if (!pr.active) continue;
    const p = pr.body.position;
    if (p.z > EDGE_Z + 0.7 || p.y < -1.5) {
      collectPrize(pr, p.x, p.y, p.z);
    }
  }

  // Update slot machine animation
  updateSlot(dt);
}

function syncMeshes() {
  pusherMesh.position.copy(pusherBody.position);
  pusherMesh.quaternion.copy(pusherBody.quaternion);
  for (const c of coinPool) {
    if (!c.active) continue;
    c.mesh.position.copy(c.body.position);
    c.mesh.quaternion.copy(c.body.quaternion);
  }
  for (const p of prizePool) {
    if (!p.active) continue;
    p.mesh.position.copy(p.body.position);
    p.mesh.quaternion.copy(p.body.quaternion);
  }
}

// ═══════════════════════════════════════════════════════════════
// COLLECTION
// ═══════════════════════════════════════════════════════════════
function collectCoin(c, wx, wy, wz) {
  c.active = false;
  c.mesh.visible = false;
  c.body.position.set(0, -100, 0);
  c.body.velocity.set(0, 0, 0);
  c.body.sleep();

  score     += 1;
  coinsHeld += 2;
  jpMeter    = Math.min(jpMeter + 2, JP_THRESH);
  spinCoins  += 1;
  updateUI();
  updateJpBar();
  showPopup('+2🪙', wx, wy, wz);

  if (spinCoins >= SPIN_EVERY) {
    spinCoins = 0;
    spinSlots();
  }
  if (jpMeter >= JP_THRESH) triggerJackpot();
}

function collectPrize(pr, wx, wy, wz) {
  const def = PRIZE_DEFS[pr.typeIdx];
  pr.active = false;
  pr.mesh.visible = false;
  pr.body.position.set(0, -100, 0);
  pr.body.velocity.set(0, 0, 0);
  pr.body.sleep();

  score  += def.pts;
  jpMeter = Math.min(jpMeter + def.pts * 3, JP_THRESH);
  updateUI();
  updateJpBar();
  showPopup(`+${def.pts}★`, wx, wy, wz);
  spinSlots(); // prize always triggers a spin

  if (jpMeter >= JP_THRESH) triggerJackpot();
}

function triggerJackpot() {
  jpMeter = 0;
  updateJpBar();
  showMsg('🎰 JACKPOT！大奖降临！');
  document.getElementById('stats-bar').classList.add('jackpot-active');
  setTimeout(() => document.getElementById('stats-bar').classList.remove('jackpot-active'), 2200);

  // Rain coins
  for (let i = 0; i < 22; i++) {
    setTimeout(() => {
      spawnCoin(
        (Math.random() - 0.5) * (PW - 0.9),
        WALL_H + 0.8 + Math.random() * 1.8,
        PUS_Z_BACK + 0.5 + Math.random() * (EDGE_Z - PUS_Z_BACK - 1.2),
        (Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.3
      );
    }, i * 80);
  }
}

// ═══════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════
function updateUI() {
  document.getElementById('ui-coins').textContent   = coinsHeld;
  document.getElementById('ui-score').textContent   = score;
  if (score > highScore) {
    highScore = score;
    localStorage.setItem('cp3d_hs', highScore);
  }
  document.getElementById('ui-hiscore').textContent = highScore;
}

function updateJpBar() {
  document.getElementById('jackpot-fill').style.width =
    (jpMeter / JP_THRESH * 100) + '%';
}

let msgTimer;
function showMsg(text) {
  const el = document.getElementById('game-message');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function showPopup(text, wx, wy, wz) {
  const v    = new THREE.Vector3(wx, wy, wz).project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  const sx   = (v.x + 1) / 2 * rect.width  + rect.left;
  const sy   = (-v.y + 1) / 2 * rect.height + rect.top;
  if (sx < rect.left || sx > rect.right) return; // off-screen
  const div  = document.createElement('div');
  div.className = 'score-popup';
  div.textContent = text;
  div.style.left  = sx + 'px';
  div.style.top   = sy + 'px';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1200);
}

// ═══════════════════════════════════════════════════════════════
// INTERACTION
// ═══════════════════════════════════════════════════════════════
function bindUI() {
  const cvs = renderer.domElement;

  cvs.addEventListener('mousemove', e => {
    const wx = getWorldX(e);
    if (wx === null) { dropArrow.visible = false; return; }
    const cx = Math.max(-WALL_X + 0.4, Math.min(WALL_X - 0.4, wx));
    dropArrow.position.x = cx;
    dropArrow.visible    = true;

    const rect = cvs.getBoundingClientRect();
    const ind  = document.getElementById('drop-indicator');
    ind.style.left    = (e.clientX - rect.left) + 'px';
    ind.style.opacity = '0.65';
  });

  cvs.addEventListener('mouseleave', () => {
    dropArrow.visible = false;
    document.getElementById('drop-indicator').style.opacity = '0';
  });

  // Left click → drop coin (right drag → orbit handled by OrbitControls)
  cvs.addEventListener('click', e => {
    if (e.button !== 0) return;
    const wx = getWorldX(e);
    if (wx !== null) dropCoin(wx);
  });

  document.getElementById('btn-drop').addEventListener('click', () => {
    dropCoin((Math.random() - 0.5) * (PW - 1));
  });

  document.getElementById('btn-auto').addEventListener('click', () => {
    autoMode = !autoMode;
    const btn = document.getElementById('btn-auto');
    btn.textContent = autoMode ? '⏹ 停止' : '🤖 自动';
    btn.classList.toggle('active', autoMode);
  });

  document.getElementById('btn-reset').addEventListener('click', resetGame);
}

function getWorldX(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const nx   = ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  const ny   = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  dropRaycaster.setFromCamera({ x: nx, y: ny }, camera);
  const target = new THREE.Vector3();
  return dropRaycaster.ray.intersectPlane(dropPlane, target) ? target.x : null;
}

// ═══════════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════════
function resetGame() {
  [...coinPool, ...prizePool].forEach(o => {
    o.active = false;
    o.mesh.visible = false;
    o.body.position.set(0, -100, 0);
    o.body.velocity.set(0, 0, 0);
    o.body.sleep();
  });

  coinsHeld  = INIT_COINS;
  score      = 0;
  jpMeter    = 0;
  spinCoins  = 0;
  slotState  = 'idle';
  autoMode   = false;

  document.getElementById('btn-auto').textContent = '🤖 自动';
  document.getElementById('btn-auto').classList.remove('active');
  updateUI();
  updateJpBar();
  drawSlot();
  seedCoins();
  seedPrizes();
  showMsg('🔄 游戏重置！');
}
