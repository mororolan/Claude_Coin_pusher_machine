import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const PW        = 7.0;   // platform width  (x)
const BACK_Z    = -4.5;  // back wall z
const EDGE_Z    =  3.2;  // front drop edge z
const WALL_X    =  3.5;  // ±x wall position
const WALL_H    =  3.0;  // wall height above platform
const COIN_R    =  0.34;
const COIN_T    =  0.11;
const PRIZE_R   =  0.46;
const PRIZE_T   =  0.15;
const PUS_Z_BACK  = -3.8;
const PUS_Z_FWD   = -0.4;
const PUS_SPEED   =  1.6;  // units/sec

const MAX_COINS  = 160;
const MAX_PRIZES = 18;
const SEED_COINS  = 50;
const SEED_PRIZES = 10;
const INIT_COINS  = 30;
const JP_THRESHOLD = 180;

const COIN_COLORS  = [0xFFD700, 0xFFC200, 0xFFAA00, 0xF0B000];
const PRIZE_DEFS = [
  { color: 0xFF4455, emissive: 0xFF2233, pts: 5,  label: '×5'  },
  { color: 0x44AAFF, emissive: 0x2288FF, pts: 10, label: '×10' },
  { color: 0x44FF88, emissive: 0x22DD66, pts: 20, label: '×20' },
  { color: 0xFF88FF, emissive: 0xFF44FF, pts: 50, label: '★JP' },
];

// ═══════════════════════════════════════════════════════════════
// GLOBALS
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
let dropWorldX = 0;
const dropRaycaster = new THREE.Raycaster();
const dropPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -BACK_Z - 0.5);

// Shared geometry
let coinGeo, coinMats;
let prizeGeos, prizeMats;

// ═══════════════════════════════════════════════════════════════
// ENTRY
// ═══════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
  highScore = parseInt(localStorage.getItem('cp3d_hs') || '0');
  initThree();
  initPhysics();
  buildCabinet();
  buildPusher();
  buildDropArrow();
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
  scene.background = new THREE.Color(0x050810);
  scene.fog = new THREE.FogExp2(0x050810, 0.025);

  camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);
  camera.position.set(0, 11, 17);
  camera.lookAt(0, 0.5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const container = document.getElementById('canvas-container');
  container.appendChild(renderer.domElement);
  onResize();
  window.addEventListener('resize', onResize);

  // OrbitControls (limited)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.5, 0);
  controls.minDistance = 9; controls.maxDistance = 28;
  controls.minPolarAngle = Math.PI / 8;
  controls.maxPolarAngle = Math.PI / 2.4;
  controls.enablePan = false;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.update();

  // Lighting
  scene.add(new THREE.AmbientLight(0x223366, 0.5));

  const sun = new THREE.DirectionalLight(0xfff5e0, 1.0);
  sun.position.set(4, 16, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -10; sun.shadow.camera.right = 10;
  sun.shadow.camera.top = 10;   sun.shadow.camera.bottom = -10;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  // LED corner lights inside cabinet
  [
    { c: 0xFF6633, p: [-WALL_X + 0.4, WALL_H * 0.8, BACK_Z + 0.4]  },
    { c: 0xFFCC00, p: [ WALL_X - 0.4, WALL_H * 0.8, BACK_Z + 0.4]  },
    { c: 0x33AAFF, p: [-WALL_X + 0.4, WALL_H * 0.8, EDGE_Z - 0.4]  },
    { c: 0xFF33CC, p: [ WALL_X - 0.4, WALL_H * 0.8, EDGE_Z - 0.4]  },
  ].forEach(({ c, p }) => {
    const pl = new THREE.PointLight(c, 1.2, 10, 1.5);
    pl.position.set(...p);
    scene.add(pl);
  });
}

function onResize() {
  const c = document.getElementById('canvas-container');
  renderer.setSize(c.clientWidth, c.clientHeight);
  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();
}

// ═══════════════════════════════════════════════════════════════
// PHYSICS
// ═══════════════════════════════════════════════════════════════
function initPhysics() {
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 15;
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
  // Platform surface
  addBox(PW, 0.5, EDGE_Z - BACK_Z,  0, -0.25, (BACK_Z + EDGE_Z) / 2, matWall,
    new THREE.MeshStandardMaterial({ color: 0x0d2215, roughness: 0.95 }), true);

  // Felt top
  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(PW, EDGE_Z - BACK_Z),
    new THREE.MeshStandardMaterial({ color: 0x0d3320, roughness: 1.0 })
  );
  felt.rotation.x = -Math.PI / 2;
  felt.position.set(0, 0.01, (BACK_Z + EDGE_Z) / 2);
  felt.receiveShadow = true;
  scene.add(felt);

  // Left / Right walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0e1520, roughness: 0.85, metalness: 0.2 });
  const wallDepth = EDGE_Z - BACK_Z + 0.6;
  addBox(0.3, WALL_H, wallDepth, -WALL_X - 0.15, WALL_H / 2, (BACK_Z + EDGE_Z) / 2, matWall, wallMat);
  addBox(0.3, WALL_H, wallDepth,  WALL_X + 0.15, WALL_H / 2, (BACK_Z + EDGE_Z) / 2, matWall, wallMat);

  // Back wall
  addBox(PW + 0.6, WALL_H, 0.3, 0, WALL_H / 2, BACK_Z - 0.15, matWall, wallMat);

  // Front drop lip
  addBox(PW, 0.18, 0.14, 0, 0.09, EDGE_Z, matWall,
    new THREE.MeshStandardMaterial({ color: 0x556677, roughness: 0.5, metalness: 0.6 }));

  // Collection tray (visual)
  const tray = new THREE.Mesh(
    new THREE.BoxGeometry(PW, 0.1, 2.5),
    new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.8 })
  );
  tray.position.set(0, -0.7, EDGE_Z + 1.5);
  tray.receiveShadow = true;
  scene.add(tray);

  // Collection tray label
  addBox(PW, 0.01, 2.5, 0, -0.64, EDGE_Z + 1.5, null,
    new THREE.MeshStandardMaterial({ color: 0x1a3a2a, roughness: 0.9, emissive: 0x0a1a10, emissiveIntensity: 0.5 }));

  // LED strip meshes (emissive, decorative)
  const ledGeo = new THREE.BoxGeometry(PW + 0.3, 0.06, 0.08);
  const sideLedGeo = new THREE.BoxGeometry(0.08, 0.06, wallDepth);
  [
    { geo: ledGeo,     color: 0xFF6633, pos: [0, WALL_H + 0.03, BACK_Z - 0.1] },
    { geo: ledGeo,     color: 0x33AAFF, pos: [0, WALL_H + 0.03, EDGE_Z + 0.1] },
    { geo: sideLedGeo, color: 0xFFCC00, pos: [-WALL_X - 0.3, WALL_H + 0.03, (BACK_Z + EDGE_Z) / 2] },
    { geo: sideLedGeo, color: 0xFF33CC, pos: [ WALL_X + 0.3, WALL_H + 0.03, (BACK_Z + EDGE_Z) / 2] },
  ].forEach(({ geo, color, pos }) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 2.0,
    }));
    m.position.set(...pos);
    scene.add(m);
  });
}

function addBox(w, h, d, x, y, z, phyMat, threeMat, recShadow = false) {
  if (phyMat) {
    const body = new CANNON.Body({ mass: 0, material: phyMat });
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    body.position.set(x, y, z);
    world.addBody(body);
  }
  if (threeMat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), threeMat);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = recShadow;
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }
}

// ═══════════════════════════════════════════════════════════════
// PUSHER
// ═══════════════════════════════════════════════════════════════
function buildPusher() {
  const pw = PW - 0.05, ph = 0.65, pd = 0.58;

  pusherBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matWall });
  pusherBody.addShape(new CANNON.Box(new CANNON.Vec3(pw / 2, ph / 2, pd / 2)));
  pusherBody.position.set(0, ph / 2, PUS_Z_BACK);
  world.addBody(pusherBody);

  const geo = new THREE.BoxGeometry(pw, ph, pd);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8899bb, metalness: 0.85, roughness: 0.2 });
  pusherMesh = new THREE.Mesh(geo, mat);
  pusherMesh.castShadow = true;
  scene.add(pusherMesh);

  // Orange glow strip on pusher face
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(pw, 0.07, 0.02),
    new THREE.MeshStandardMaterial({ color: 0xFF9900, emissive: 0xFF9900, emissiveIntensity: 2.0 })
  );
  strip.position.set(0, 0, -(pd / 2 + 0.01));
  pusherMesh.add(strip);
}

// ═══════════════════════════════════════════════════════════════
// DROP ARROW (3D indicator)
// ═══════════════════════════════════════════════════════════════
function buildDropArrow() {
  const group = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.55, 10),
    new THREE.MeshStandardMaterial({ color: 0xFFDD00, emissive: 0xFFAA00, emissiveIntensity: 1.2 })
  );
  cone.position.y = -0.27;
  group.add(cone);
  group.position.set(0, WALL_H + 0.8, BACK_Z + 0.6);
  group.visible = false;
  scene.add(group);
  dropArrow = group;
}

// ═══════════════════════════════════════════════════════════════
// SHARED GEOMETRY
// ═══════════════════════════════════════════════════════════════
function buildSharedGeometry() {
  coinGeo = new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_T, 24);
  coinMats = COIN_COLORS.map(c => new THREE.MeshStandardMaterial({
    color: c, metalness: 0.95, roughness: 0.12,
  }));

  prizeGeos = PRIZE_DEFS.map(() => new THREE.CylinderGeometry(PRIZE_R, PRIZE_R, PRIZE_T, 24));
  prizeMats = PRIZE_DEFS.map(d => new THREE.MeshStandardMaterial({
    color: d.color, emissive: d.emissive, emissiveIntensity: 0.5,
    metalness: 0.7, roughness: 0.25,
  }));
}

// ═══════════════════════════════════════════════════════════════
// OBJECT POOLS
// ═══════════════════════════════════════════════════════════════
function buildCoinPool() {
  for (let i = 0; i < MAX_COINS; i++) {
    const mi = i % coinMats.length;
    const mesh = new THREE.Mesh(coinGeo, coinMats[mi]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.visible = false;
    scene.add(mesh);

    const body = new CANNON.Body({
      mass: 0.08, material: matCoin,
      linearDamping: 0.38, angularDamping: 0.82,
      allowSleep: true, sleepSpeedLimit: 0.25, sleepTimeLimit: 0.4,
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
    const ti = i % PRIZE_DEFS.length;
    const mesh = new THREE.Mesh(prizeGeos[ti], prizeMats[ti]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.visible = false;
    scene.add(mesh);

    const body = new CANNON.Body({
      mass: 0.12, material: matCoin,
      linearDamping: 0.50, angularDamping: 0.90,
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
  b.angularVelocity.set((Math.random()-0.5)*3, (Math.random()-0.5)*3, (Math.random()-0.5)*3);
  b.quaternion.setFromEuler((Math.random()-0.5)*0.4, Math.random()*Math.PI*2, (Math.random()-0.5)*0.4);
  b.wakeUp();
}

function spawnPrize(x, z, typeIdx) {
  const slot = prizePool.find(p => !p.active);
  if (!slot) return;
  slot.active = true;
  slot.typeIdx = typeIdx;
  slot.mesh.geometry = prizeGeos[typeIdx];
  slot.mesh.material = prizeMats[typeIdx];
  slot.mesh.visible = true;
  const b = slot.body;
  b.position.set(x, PRIZE_T / 2 + 0.02, z);
  b.velocity.set(0, 0, 0);
  b.angularVelocity.set(0, (Math.random()-0.5)*0.5, 0);
  b.quaternion.setFromEuler(0, Math.random()*Math.PI*2, 0);
  b.wakeUp();
}

function seedCoins() {
  for (let i = 0; i < SEED_COINS; i++) {
    const x = (Math.random()-0.5) * (PW - 1.2);
    const z = PUS_Z_BACK + 0.6 + Math.random() * (EDGE_Z - PUS_Z_BACK - 1.5);
    const layer = Math.floor(i / 14);
    spawnCoin(x, COIN_T / 2 + layer * (COIN_T + 0.03) + 0.02, z);
  }
}

function seedPrizes() {
  for (let i = 0; i < SEED_PRIZES; i++) {
    const x = (Math.random()-0.5) * (PW - 2.0);
    const z = PUS_Z_BACK + 1.0 + Math.random() * (EDGE_Z - PUS_Z_BACK - 2.0);
    spawnPrize(x, z, i % PRIZE_DEFS.length);
  }
}

// ═══════════════════════════════════════════════════════════════
// DROP COIN (player action)
// ═══════════════════════════════════════════════════════════════
function dropCoin(worldX) {
  if (coinsHeld <= 0) { showMsg('😢 硬币不足！'); return; }
  coinsHeld--;
  const cx = Math.max(-WALL_X + COIN_R + 0.15, Math.min(WALL_X - COIN_R - 0.15, worldX));
  spawnCoin(cx, WALL_H + 0.8, BACK_Z + 0.8, (Math.random()-0.5)*0.6, 0, 0.4);
  updateUI();
}

// ═══════════════════════════════════════════════════════════════
// GAME LOOP
// ═══════════════════════════════════════════════════════════════
function loop(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;
  update(dt);
  syncMeshes();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

function update(dt) {
  // Auto drop
  if (autoMode && coinsHeld > 0) {
    autoTimer += dt;
    if (autoTimer > 0.42) {
      autoTimer = 0;
      dropCoin((Math.random()-0.5) * (PW - 1));
    }
  }

  // Pusher oscillation
  const pz = pusherBody.position.z;
  pusherBody.velocity.set(0, 0, PUS_SPEED * pusherDir);
  if (pz >= PUS_Z_FWD)  pusherDir = -1;
  if (pz <= PUS_Z_BACK) pusherDir =  1;

  // Pulse drop arrow
  if (dropArrow.visible) {
    dropArrow.position.y = WALL_H + 0.8 + Math.sin(ts / 300) * 0.12;
  }

  // Physics step
  world.fixedStep(1 / 60, dt, 3);

  // Collect fallen coins
  for (let i = coinPool.length - 1; i >= 0; i--) {
    const c = coinPool[i];
    if (!c.active) continue;
    const p = c.body.position;
    if (p.z > EDGE_Z + 0.6 || p.y < -1.2) {
      retireCoin(c, true);
    }
  }

  // Collect fallen prizes
  for (const p of prizePool) {
    if (!p.active) continue;
    const pos = p.body.position;
    if (pos.z > EDGE_Z + 0.6 || pos.y < -1.2) {
      retirePrize(p);
    }
  }
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
function retireCoin(c, collected) {
  const px = c.body.position.x, py = c.body.position.y, pz = c.body.position.z;
  c.active = false;
  c.mesh.visible = false;
  c.body.position.set(0, -100, 0);
  c.body.velocity.set(0, 0, 0);
  c.body.sleep();

  if (collected) {
    score += 1;
    coinsHeld += 2;
    jpMeter = Math.min(jpMeter + 2, JP_THRESHOLD);
    updateUI();
    updateJP();
    showPopup('+2🪙', px, py, pz);
  }
}

function retirePrize(p) {
  const def = PRIZE_DEFS[p.typeIdx];
  const px = p.body.position.x, py = p.body.position.y, pz = p.body.position.z;
  p.active = false;
  p.mesh.visible = false;
  p.body.position.set(0, -100, 0);
  p.body.velocity.set(0, 0, 0);
  p.body.sleep();

  score += def.pts;
  jpMeter = Math.min(jpMeter + def.pts * 3, JP_THRESHOLD);
  updateUI();
  updateJP();
  showPopup(`+${def.pts}★`, px, py, pz);

  if (jpMeter >= JP_THRESHOLD) jackpot();
}

function jackpot() {
  jpMeter = 0;
  updateJP();
  showMsg('🎰 JACKPOT！大奖！');
  document.getElementById('stats-bar').classList.add('jackpot-active');
  setTimeout(() => document.getElementById('stats-bar').classList.remove('jackpot-active'), 2000);
  // Rain coins from above
  for (let i = 0; i < 22; i++) {
    setTimeout(() => {
      const x = (Math.random()-0.5) * (PW - 0.8);
      const z = PUS_Z_BACK + 0.5 + Math.random() * (EDGE_Z - PUS_Z_BACK - 1.5);
      spawnCoin(x, WALL_H + 1 + Math.random() * 2, z, (Math.random()-0.5)*0.6, 0, (Math.random()-0.5)*0.4);
    }, i * 75);
  }
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
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

function updateJP() {
  document.getElementById('jackpot-fill').style.width = (jpMeter / JP_THRESHOLD * 100) + '%';
}

let msgTimer;
function showMsg(text) {
  const el = document.getElementById('game-message');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function showPopup(text, wx, wy, wz) {
  const v = new THREE.Vector3(wx, wy, wz).project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  const sx = (v.x + 1) / 2 * rect.width  + rect.left;
  const sy = (-v.y + 1) / 2 * rect.height + rect.top;
  const div = document.createElement('div');
  div.className = 'score-popup';
  div.textContent = text;
  div.style.left = sx + 'px';
  div.style.top  = sy + 'px';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1200);
}

// ═══════════════════════════════════════════════════════════════
// INTERACTION
// ═══════════════════════════════════════════════════════════════
function bindUI() {
  const cvs = renderer.domElement;

  cvs.addEventListener('mousemove', e => {
    const wx = getMouseWorldX(e);
    if (wx !== null) {
      dropWorldX = wx;
      const clampedX = Math.max(-WALL_X + 0.4, Math.min(WALL_X - 0.4, wx));
      dropArrow.position.x = clampedX;
      dropArrow.visible = true;
      const rect = cvs.getBoundingClientRect();
      const ind = document.getElementById('drop-indicator');
      ind.style.left = (e.clientX - rect.left) + 'px';
      ind.style.opacity = '0.6';
    }
  });

  cvs.addEventListener('mouseleave', () => {
    dropArrow.visible = false;
    document.getElementById('drop-indicator').style.opacity = '0';
  });

  // Left-click drops coin; right-click / drag rotates camera
  cvs.addEventListener('click', e => {
    if (e.button !== 0) return;
    const wx = getMouseWorldX(e);
    if (wx !== null) dropCoin(wx);
  });

  document.getElementById('btn-drop').addEventListener('click', () => {
    dropCoin((Math.random()-0.5) * (PW - 1));
  });

  document.getElementById('btn-auto').addEventListener('click', () => {
    autoMode = !autoMode;
    const btn = document.getElementById('btn-auto');
    btn.textContent = autoMode ? '⏹ 停止' : '🤖 自动';
    btn.classList.toggle('active', autoMode);
  });

  document.getElementById('btn-reset').addEventListener('click', resetGame);
}

function getMouseWorldX(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  const ny = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  dropRaycaster.setFromCamera({ x: nx, y: ny }, camera);
  const target = new THREE.Vector3();
  const hit = dropRaycaster.ray.intersectPlane(dropPlane, target);
  return hit ? target.x : null;
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
  coinsHeld = INIT_COINS; score = 0; jpMeter = 0;
  autoMode = false;
  document.getElementById('btn-auto').textContent = '🤖 自动';
  document.getElementById('btn-auto').classList.remove('active');
  updateUI(); updateJP();
  seedCoins(); seedPrizes();
  showMsg('🔄 游戏重置！');
}
