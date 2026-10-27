(() => {
'use strict';

/* =========================================================
 * ★ 連線設定（兩台 iPad 一起玩）★
 *   以後想加「中繼伺服器（TURN）」，讓兩台不在同一個 Wi-Fi 也能連，只要改這裡：
 *   在 iceServers 裡多加一行，格式像這樣（網址、帳號、密碼換成伺服器給你的）：
 *     { urls: 'turn:伺服器網址:3478', username: '帳號', credential: '密碼' },
 *   其他程式都不用改。
 *   peerServer 是「配對伺服器」：null 表示用 PeerJS 免費的公開伺服器，不需要帳號。
 * ========================================================= */
const NET_CONFIG = {
  peerjsUrls: [
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js',
  ],
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  peerServer: null,
  roomPrefix: 'ater-ayer-room-',
  connectTimeout: 15,
  lostTimeout: 10,
  sendHz: 15,
  guestSendHz: 20,
  interpDelay: 0.12,
  maxInterpDelay: 0.45,
};

/* =========================================================
 * 0. 小工具
 * ========================================================= */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const angleDiff = (a, b) => {           // 兩角度差，落在 -PI ~ PI
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};
function mulberry32(seed) {             // 可重現的亂數
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(a, b, c) {            // 由世界種子＋區塊座標得到區塊種子
  let h = (a ^ Math.imul(b | 0, 0x27d4eb2d) ^ Math.imul(c | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const hash2 = (x, y) => (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 1000) / 1000;
function circleRectOverlap(cx, cy, r, s) {
  const nx = clamp(cx, s.x, s.x + s.w), ny = clamp(cy, s.y, s.y + s.h);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const pointInRect = (x, y, s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;

/* =========================================================
 * 1. 世界、角色、武器、敵人設定
 * ========================================================= */
const CELL = 32;                 // 草叢格子
const CHUNK = 512;               // 無限世界以 512px 的區塊為單位隨機生成
const CCELLS = CHUNK / CELL;
const GEN_RADIUS = 1900;         // 主角周圍多遠的區塊要先生成
const DESPAWN_DIST = 1800;       // 怪物離主角太遠就消失（不算擊倒）
const SPAWN = { x: 160, y: 256 };

// 主角「亞特」的屬性
const PC = {
  radius: 16,
  startHp: 10, maxHpCap: 30,     // 生命（每顆心 2 點），每過一關 +1 顆心，大魔王 +2 顆心
  speed: 190, shieldSpeedMul: 0.45, aimSpeedMul: 0.55,
  maxStamina: 100, staminaRegen: 34, regenDelay: 0.7,
  dodgeCost: 25, dodgeSpeed: 560, dodgeTime: 0.2, dodgeCooldown: 0.12,
  attackActive: 0.16, attackHalfArc: 1.15,
  blockCost: 14, perfectWindow: 0.22, shieldHalfArc: 1.35, hurtInvuln: 1.0,
  perfectDodgeWindow: 0.3,       // 敵人出手前 0.3 秒內閃避 → 迅影時刻
  flurryHits: 3,                 // 迅影時刻可以砍幾下
  flurryTimeScale: 0.08,         // 迅影時刻時，世界的時間倍率
  flurryWindow: 2.2,             // 觸發後幾秒內要按攻擊
  aimLine: 330,                  // 瞄準虛線長度
  maxArrows: 99,
};

// 近戰武器：atk 攻擊力、range 距離、cd 揮擊間隔
const WEAPONS = {
  traveler:       { name: '旅人短劍', atk: 2,  range: 60, cd: 0.36 },
  thornBlade:     { name: '棘刺短劍', atk: 3,  range: 60, cd: 0.32 },
  mossHammer:     { name: '苔岩重錘', atk: 5,  range: 62, cd: 0.58 },
  sandScimitar:   { name: '沙刃彎刀', atk: 4,  range: 66, cd: 0.32 },
  sandAxe:        { name: '砂岩戰斧', atk: 7,  range: 64, cd: 0.60 },
  frostRapier:    { name: '霜晶細劍', atk: 5,  range: 74, cd: 0.28 },
  glacierSword:   { name: '冰川巨劍', atk: 9,  range: 76, cd: 0.62 },
  emberDagger:    { name: '熾核短刃', atk: 7,  range: 62, cd: 0.26 },
  lavaGreatsword: { name: '熔岩大劍', atk: 12, range: 80, cd: 0.66 },
  voidScythe:     { name: '虛空長鐮', atk: 10, range: 86, cd: 0.40 },
  abyssBlade:     { name: '虛淵之刃', atk: 13, range: 82, cd: 0.30 },          // 大魔王寶物
  ancientAbyssSword: { name: '遠古虛淵大劍', atk: 20, range: 92, cd: 0.48 },
  starHammer:     { name: '裂星錘',   atk: 15, range: 72, cd: 0.72 },
};
// 弓：atk 攻擊力、speed 箭速、special 特殊效果
const BOWS = {
  thornBow: { name: '棘藤短弓',   atk: 3, speed: 520, special: null },
  sandBow:  { name: '砂岩長弓',   atk: 5, speed: 660, special: null },
  frostBow: { name: '霜晶穿透弓', atk: 6, speed: 620, special: 'pierce' },
  emberBow: { name: '熾核火焰弓', atk: 7, speed: 600, special: 'fire' },
  voidBow:  { name: '虛空三連弓', atk: 8, speed: 620, special: 'triple' },
  abyssStarBow: { name: '虛淵星弓', atk: 12, speed: 720, special: 'triple' },   // 大魔王寶物
};
const SPECIAL_TEXT = { pierce: '箭矢會穿透敵人', fire: '火焰箭，會點燃草叢', triple: '一次射出三支箭' };

// 敵人職業的基礎數值（每一關會再放大）
const ROLES = {
  melee:  { size: 30, hp: 5,  speed: 70, chaseSpeed: 128, sight: 240, lose: 440, reach: 58, windup: 0.5,  atkCooldown: 1.0, damage: 1, armor: false, knockResist: 1,   ranged: false },
  brute:  { size: 42, hp: 14, speed: 55, chaseSpeed: 96,  sight: 260, lose: 460, reach: 72, windup: 0.72, atkCooldown: 1.4, damage: 2, armor: true,  knockResist: 0.4, ranged: false },
  archer: { size: 28, hp: 4,  speed: 65, chaseSpeed: 110, sight: 380, lose: 580, reach: 0,  windup: 0.8,  atkCooldown: 1.8, damage: 1, armor: false, knockResist: 1,   ranged: true,
            keepMin: 170, keepMax: 330, shootRange: 440, arrowSpeed: 360 },
};

// 每一關的地形與怪物外觀（第 6 關之後循環，但怪物更強）
const THEMES = [
  { name: '苔原燼野', shape: 'square',
    ground: ['#4e8442', '#548b47', '#497d3d'], grass: ['#3a772e', '#3f7f32', '#66b04d'],
    rock: ['#7d8189', '#9a9ea6', '#4e5158'], deco: ['#f3e3a1', '#e9a6c4'],
    roles: { melee: { name: '棘影獸', patrol: '#9a74cf', chase: '#e5483c' },
             brute: { name: '岩甲獸', patrol: '#5b7396', chase: '#b4243c' },
             archer: { name: '棘影射手', patrol: '#c08a3e', chase: '#ff7a1f' } },
    drops: { light: 'thornBlade', heavy: 'mossHammer', bow: 'thornBow' } },
  { name: '赤砂荒地', shape: 'diamond',
    ground: ['#c4a46a', '#cbad73', '#b8985f'], grass: ['#8f7f2e', '#998a35', '#cdbb5c'],
    rock: ['#a5714a', '#c08a5e', '#6e4a2f'], deco: ['#e8e0c8', '#d98c5a'],
    roles: { melee: { name: '沙殼蟲', patrol: '#3f8f8a', chase: '#e2582a' },
             brute: { name: '砂岩巨蟲', patrol: '#5e4a8a', chase: '#b33a1e' },
             archer: { name: '沙殼弓手', patrol: '#3a6ea5', chase: '#e88a1a' } },
    drops: { light: 'sandScimitar', heavy: 'sandAxe', bow: 'sandBow' } },
  { name: '霜晶雪原', shape: 'hex',
    ground: ['#d5e2ea', '#dde8ef', '#c8d7e1'], grass: ['#5f8f86', '#6a9a90', '#a8dccd'],
    rock: ['#8a9db0', '#a9bccd', '#5a6c7d'], deco: ['#ffffff', '#b8d8f0'],
    roles: { melee: { name: '霜角獸', patrol: '#5a7fc4', chase: '#d23c6e' },
             brute: { name: '冰甲獸', patrol: '#3f5878', chase: '#a61e4a' },
             archer: { name: '霜角獵手', patrol: '#3d9a94', chase: '#e0602a' } },
    drops: { light: 'frostRapier', heavy: 'glacierSword', bow: 'frostBow' } },
  { name: '熔岩焦土', shape: 'triangle',
    ground: ['#4a3a35', '#523f39', '#43342f'], grass: ['#6d5a2a', '#76632f', '#b0944a'],
    rock: ['#3a3434', '#585050', '#1f1b1b'], deco: ['#ff8a3d', '#ffcf6a'],
    roles: { melee: { name: '熾核魔', patrol: '#c08a5a', chase: '#ff5a1f' },
             brute: { name: '熔殼巨魔', patrol: '#8a7a70', chase: '#e0301a' },
             archer: { name: '熾核弓魔', patrol: '#b07ab0', chase: '#ff9a2a' } },
    drops: { light: 'emberDagger', heavy: 'lavaGreatsword', bow: 'emberBow' } },
  { name: '虛空迷境', shape: 'circle',
    ground: ['#2d2a45', '#332f4f', '#28253e'], grass: ['#4b3f7a', '#53468a', '#8a7ad0'],
    rock: ['#5a5670', '#77738f', '#2a2738'], deco: ['#7fe0d0', '#e07fd0'],
    roles: { melee: { name: '虛瞳怪', patrol: '#7fd1c4', chase: '#ff4fa0' },
             brute: { name: '虛甲守衛', patrol: '#9a8ad0', chase: '#e0306a' },
             archer: { name: '虛瞳射手', patrol: '#c4d17f', chase: '#ff8a3a' } },
    drops: { light: 'voidScythe', heavy: 'starHammer', bow: 'voidBow' } },
];
const themeOf = n => THEMES[(n - 1) % THEMES.length];
// 第 6 關之後地形循環，但怪物會變成「狂暴／遠古／深淵」變種：名字不同、身上長出尖刺、更強
const ELITE_PREFIX = ['', '狂暴', '遠古', '深淵'];
const eliteOf = n => Math.min(ELITE_PREFIX.length - 1, Math.floor((n - 1) / THEMES.length));
const levelName = n => ELITE_PREFIX[eliteOf(n)] + themeOf(n).name;
const isBossLevel = n => n % 5 === 0;          // 每 5 關有大魔王
const killTargetOf = n => {                        // 第 1 關 12 隻，之後每關 +4；魔王關先打一半；第 7 關（狂暴赤砂荒地）起再打七折
  if (!NET.on && n >= 16 && n <= 20) return ({16:24,17:3,18:60,19:3,20:12})[n];
  const base = isBossLevel(n) ? Math.round((8 + 4 * n) / 2) : 8 + 4 * n;
  return n >= 7 ? Math.round(base * 0.7) : base;
};

/* =========================================================
 * 2. DOM 與畫布
 * ========================================================= */
const $ = id => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const probe = $('safeProbe');
const startScreen = $('startScreen'), pauseScreen = $('pauseScreen'), endScreen = $('endScreen');
const levelScreen = $('levelScreen'), bagScreen = $('bagScreen'), rotateHint = $('rotateHint');
const endTitle = $('endTitle'), endText = $('endText'), levelTitle = $('levelTitle'), levelText = $('levelText');
const bagStats = $('bagStats'), bagGrid = $('bagGrid'), pageInfo = $('pageInfo');

let VW = 0, VH = 0, DPR = 1;
const SAFE = { t: 0, r: 0, b: 0, l: 0 };

/* =========================================================
 * 3. 遊戲狀態
 * ========================================================= */
const game = {
  mode: 'title',            // title | play | levelclear | between | ending | over
  paused: false, portrait: false,
  time: 0, slowT: 0, shake: 0, flash: 0, endT: 0, result: '',
  theme: THEMES[0], banner: null, hints: [], seenHint: {},
  flurry: null,             // 迅影時刻狀態
};
const lvl = { n: 1, kills: 0, target: 12, maxAlive: 5, spawnT: 0, spawned: 0, types: null, snapshot: null };
let player, inv, enemies, arrows, sparks, particles, texts, pickups, burningCells, ashCells, chunks, grass, worldSeed;
let fireTick = 0;
const flashingStones = new Set();
const cam = { x: 0, y: 0 };
const input = { dirX: 0, dirY: 0, mag: 0, attackPressed: false, dodgePressed: false, shootPressed: false, shieldHeld: false, shootHeld: false };

/* =========================================================
 * 4. 虛擬搖桿、按鈕位置
 * ========================================================= */
const joy = { homeX: 0, homeY: 0, baseX: 0, baseY: 0, radius: 64, knobR: 28, id: null, kx: 0, ky: 0 };
const buttons = [
  { key: 'attack', label: '攻擊', x: 0, y: 0, r: 52, rgb: '255,128,82',  touches: new Set() },
  { key: 'dodge',  label: '閃避', x: 0, y: 0, r: 40, rgb: '110,196,255', touches: new Set() },
  { key: 'shield', label: '舉盾', x: 0, y: 0, r: 40, rgb: '140,232,168', touches: new Set() },
  { key: 'shoot',  label: '射箭', x: 0, y: 0, r: 40, rgb: '255,214,102', touches: new Set() },
  { key: 'ult',    label: '無影斬', x: 0, y: 0, r: 42, rgb: '235,55,75', touches: new Set() },
  { key: 'vac',    label: '吸怪器', x: 0, y: 0, r: 42, rgb: '70,215,170', touches: new Set() },
];
const BTN = { attack: buttons[0], dodge: buttons[1], shield: buttons[2], shoot: buttons[3], ult: buttons[4], vac: buttons[5] };
const pauseBtn = { x: 0, y: 0, r: 22 };
const bagBtn = { x: 0, y: 0, r: 30 };

function layoutUI() {
  joy.homeX = SAFE.l + 128;
  joy.homeY = VH - SAFE.b - 128;
  if (joy.id === null) { joy.baseX = joy.homeX; joy.baseY = joy.homeY; }
  bagBtn.x = joy.homeX; bagBtn.y = joy.homeY - joy.radius - 66;    // 搖桿正上方
  const ax = VW - SAFE.r - 104, ay = VH - SAFE.b - 104;
  BTN.attack.x = ax;       BTN.attack.y = ay;
  BTN.dodge.x = ax - 124;  BTN.dodge.y = ay + 16;
  BTN.shield.x = ax - 16;  BTN.shield.y = ay - 124;
  BTN.shoot.x = ax - 120;  BTN.shoot.y = ay - 102;
  BTN.ult.x = ax - 120;    BTN.ult.y = ay - 210;        // 射箭的正上方
  BTN.vac.x = ax - 16;     BTN.vac.y = ay - 232;        // 舉盾的正上方
  pauseBtn.x = VW - SAFE.r - 40; pauseBtn.y = SAFE.t + 40;
}

/* =========================================================
 * 5. 無限世界：以區塊（chunk）為單位隨機生成
 *    - 每個區塊有自己的岩石、火爆石、木箱（都是固體）
 *    - 草叢存在一張全域的 Map，用格子座標當 key
 * ========================================================= */
const ck = (cx, cy) => (cx + 50000) * 100000 + (cy + 50000);
const gk = (gx, gy) => (gx + 1000000) * 2000000 + (gy + 1000000);

function genChunk(cx, cy) {
  const key = ck(cx, cy);
  if (chunks.has(key)) return;
  const R = mulberry32(hashSeed(worldSeed, cx, cy));
  const ch = { cx, cy, x: cx * CHUNK, y: cy * CHUNK, solids: [], hazards: [] };
  chunks.set(key, ch);
  const home = cx === 0 && cy === 0;
  const inChunk = (r, m) => r.x >= ch.x + m && r.y >= ch.y + m && r.x + r.w <= ch.x + CHUNK - m && r.y + r.h <= ch.y + CHUNK - m;
  const free = (r, pad) => !ch.solids.some(o => rectsOverlap({ x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 }, r))
    && (!home || !circleRectOverlap(SPAWN.x, SPAWN.y, 120, r))
    && !ch.hazards.some(h => rectHitsHazard(h, r, pad));                     // 不放在地形機關上（依實際形狀）
  const add = (s) => { s.chunk = ch; ch.solids.push(s); };
  const patches = [];

  if (home) {
    // 新手區：右邊一顆火爆石＋一片草叢，下面兩個木箱
    add({ x: SPAWN.x + 120, y: SPAWN.y - 18, w: 36, h: 36, kind: 'stone', flash: 0 });
    patches.push({ x: SPAWN.x + 250, y: SPAWN.y, r: 2.8 });
    add({ x: SPAWN.x - 70, y: SPAWN.y + 96, w: 30, h: 30, kind: 'crate' });
    add({ x: SPAWN.x + 10, y: SPAWN.y + 112, w: 30, h: 30, kind: 'crate' });
  }
  placeHazards(ch, R, home);                        // 先放流沙／冰池／熔岩流／裂隙（依地形），岩石再避開它們
  // 岩石
  const rocks = 1 + Math.floor(R() * 3);
  for (let n = 0, tries = 0; n < rocks && tries < 20; tries++) {
    const w = 40 + Math.floor(R() * 3) * 20, h = 40 + Math.floor(R() * 3) * 20;
    const s = { x: ch.x + 24 + R() * (CHUNK - 48 - w), y: ch.y + 24 + R() * (CHUNK - 48 - h), w, h, kind: 'rock' };
    if (!free(s, 50)) continue;
    add(s); n++;
  }
  // 草叢區（多半附一顆火爆石）
  // 註：所有固體之間至少留 40px、離區塊邊緣至少 22px，保證主角（直徑 32px）不會卡在兩個固體的夾縫中
  const pCount = R() < 0.75 ? 1 + (R() < 0.35 ? 1 : 0) : 0;
  for (let k = 0; k < pCount; k++) {
    const p = { x: ch.x + 70 + R() * (CHUNK - 140), y: ch.y + 70 + R() * (CHUNK - 140), r: 2 + R() * 2.5 };
    if (home && Math.hypot(p.x - SPAWN.x, p.y - SPAWN.y) < 200) continue;
    patches.push(p);
    if (R() < 0.65) {
      for (let t = 0; t < 6; t++) {
        const a = R() * TAU, d = (p.r + 1.3) * CELL;
        const s = { x: p.x + Math.cos(a) * d - 18, y: p.y + Math.sin(a) * d - 18, w: 36, h: 36, kind: 'stone', flash: 0 };
        if (inChunk(s, 22) && free(s, 40)) { add(s); break; }
      }
    }
  }
  // 木箱
  const crates = (R() < 0.5 ? 1 : 0) + (R() < 0.2 ? 1 : 0);
  for (let k = 0, tries = 0; k < crates && tries < 10; tries++) {
    const s = { x: ch.x + 20 + R() * (CHUNK - 70), y: ch.y + 20 + R() * (CHUNK - 70), w: 30, h: 30, kind: 'crate' };
    if (!inChunk(s, 22) || !free(s, 40)) continue;
    add(s); k++;
  }
  // 草叢格子（只放在本區塊內，避免跟還沒生成的鄰居區塊衝突）
  const g0x = cx * CCELLS, g0y = cy * CCELLS;
  const addCell = (gx, gy) => {
    if (gx < g0x || gx >= g0x + CCELLS || gy < g0y || gy >= g0y + CCELLS) return;
    const k = gk(gx, gy);
    if (grass.has(k)) return;
    const cell = { x: gx * CELL, y: gy * CELL, w: CELL, h: CELL };
    if (ch.solids.some(s => rectsOverlap({ x: s.x - 2, y: s.y - 2, w: s.w + 4, h: s.h + 4 }, cell))) return;
    if (home && Math.hypot(cell.x + CELL / 2 - SPAWN.x, cell.y + CELL / 2 - SPAWN.y) < 80) return;
    if (ch.hazards.some(h => hzContains(h, cell.x + CELL / 2, cell.y + CELL / 2, 20))) return;
    grass.set(k, { key: k, gx, gy, state: 'grass', t: 0, seed: (R() * 1000) | 0 });
  };
  for (const p of patches) {
    const gcx = Math.floor(p.x / CELL), gcy = Math.floor(p.y / CELL), r = Math.ceil(p.r) + 1;
    for (let gy = gcy - r; gy <= gcy + r; gy++)
      for (let gx = gcx - r; gx <= gcx + r; gx++)
        if (Math.hypot(gx - gcx, gy - gcy) <= p.r * (0.72 + R() * 0.45)) addCell(gx, gy);
  }
  for (let k = 0; k < 5; k++) addCell(g0x + Math.floor(R() * CCELLS), g0y + Math.floor(R() * CCELLS));
}
function ensureChunks(x, y, r) {
  const c0x = Math.floor((x - r) / CHUNK), c1x = Math.floor((x + r) / CHUNK);
  const c0y = Math.floor((y - r) / CHUNK), c1y = Math.floor((y + r) / CHUNK);
  for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) genChunk(cx, cy);
}
// 取出某個範圍內的固體（只查詢涵蓋的區塊）
function solidsInBox(x0, y0, x1, y1, out) {
  out.length = 0;
  const c0x = Math.floor(x0 / CHUNK), c1x = Math.floor(x1 / CHUNK);
  const c0y = Math.floor(y0 / CHUNK), c1y = Math.floor(y1 / CHUNK);
  for (let cy = c0y; cy <= c1y; cy++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const ch = chunks.get(ck(cx, cy));
      if (!ch) continue;
      for (const s of ch.solids) if (s.x <= x1 && s.x + s.w >= x0 && s.y <= y1 && s.y + s.h >= y0) out.push(s);
    }
  }
  return out;
}
function removeSolid(s) {
  const list = s.chunk.solids, i = list.indexOf(s);
  if (i >= 0) list.splice(i, 1);
}

/* =========================================================
 * 6. 物理碰撞
 * ========================================================= */
// 把圓形從矩形推出去（圓 vs AABB）
function circleRectPush(e, s, rad) {
  const nx = clamp(e.x, s.x, s.x + s.w), ny = clamp(e.y, s.y, s.y + s.h);
  const dx = e.x - nx, dy = e.y - ny, d2 = dx * dx + dy * dy;
  if (d2 >= rad * rad) return;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2), push = rad - d;
    e.x += (dx / d) * push; e.y += (dy / d) * push;
  } else {           // 圓心已在矩形內：從最近的一邊推出
    const left = e.x - s.x, right = s.x + s.w - e.x, top = e.y - s.y, bottom = s.y + s.h - e.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) e.x = s.x - rad;
    else if (m === right) e.x = s.x + s.w + rad;
    else if (m === top) e.y = s.y - rad;
    else e.y = s.y + s.h + rad;
  }
}
// 移動實體：先查詢路徑附近的固體，再拆成每步 ≤ 6px 的小步移動，避免高速衝刺穿牆
const SCR_MOVE = [];
function moveEntity(e, dx, dy, rad) {
  const len = Math.hypot(dx, dy);
  const pad = rad * 2 + 4;
  const near = solidsInBox(Math.min(e.x, e.x + dx) - pad, Math.min(e.y, e.y + dy) - pad,
                           Math.max(e.x, e.x + dx) + pad, Math.max(e.y, e.y + dy) + pad, SCR_MOVE);
  const steps = Math.max(1, Math.ceil(len / 6));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    e.x += sx; e.y += sy;
    for (let pass = 0; pass < 2; pass++) {        // 兩輪解算，處理同時碰到兩個固體的轉角
      for (const s of near) {
        if (e.x + rad <= s.x || e.x - rad >= s.x + s.w || e.y + rad <= s.y || e.y - rad >= s.y + s.h) continue;
        circleRectPush(e, s, rad);
      }
    }
  }
}
// 是否碰到燃燒中的草叢
function checkFireContact(e, rad) {
  const gx0 = Math.floor((e.x - rad) / CELL), gx1 = Math.floor((e.x + rad) / CELL);
  const gy0 = Math.floor((e.y - rad) / CELL), gy1 = Math.floor((e.y + rad) / CELL);
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const c = grass.get(gk(gx, gy));
      if (!c || c.state !== 'burning') continue;
      if (circleRectOverlap(e.x, e.y, rad, { x: gx * CELL + 3, y: gy * CELL + 3, w: CELL - 6, h: CELL - 6 })) return c;
    }
  }
  return null;
}
function nearestEnemy(x, y, maxD) {
  let best = null, bd = maxD;
  for (const e of enemies) {
    if (e.dead || e.dying) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/* =========================================================
 * 7. 觸控事件處理（多點觸控核心）
 *    每根手指都有唯一 identifier：搖桿只認領一根手指（joy.id），
 *    每個按鈕各自記錄按住它的手指集合（touches），所以可同時操作互不干擾。
 * ========================================================= */
function hitButton(x, y) {
  let best = null, bd = Infinity;
  for (const b of buttons) {
    const d = Math.hypot(x - b.x, y - b.y);
    if (b.key === 'ult' && !inv.ultimate) continue;      // 還沒學會無影斬時，按鈕不存在
    if (b.key === 'vac' && !inv.vacuum) continue;
    if (d <= b.r * 1.2 && d < bd) { bd = d; best = b; }
  }
  return best;
}
function updateJoy(x, y) {
  let dx = x - joy.baseX, dy = y - joy.baseY;
  const len = Math.hypot(dx, dy);
  if (len > joy.radius) { dx = dx / len * joy.radius; dy = dy / len * joy.radius; }
  joy.kx = dx / joy.radius; joy.ky = dy / joy.radius;
}
function releaseJoy() { joy.id = null; joy.kx = 0; joy.ky = 0; joy.baseX = joy.homeX; joy.baseY = joy.homeY; }
function pointerDown(id, x, y) {
  if (game.mode !== 'play' || game.paused || game.portrait) return;
  if (Math.hypot(x - pauseBtn.x, y - pauseBtn.y) <= pauseBtn.r * 1.5) { pauseGame(); return; }
  if (Math.hypot(x - bagBtn.x, y - bagBtn.y) <= bagBtn.r * 1.3) { openBag(); return; }
  const b = hitButton(x, y);
  if (b) {
    b.touches.add(id);
    if (b.key === 'attack') input.attackPressed = true;
    else if (b.key === 'dodge') input.dodgePressed = true;
    else if (b.key === 'ult') input.ultPressed = true;
    else if (b.key === 'vac') input.vacPressed = true;
    else if (b.key === 'shoot') {
      input.shootPressed = true;
      if (aimStick.id === null) { aimStick.id = id; aimStick.engaged = false; aimStick.sx = x; aimStick.sy = y; aimStick.dx = aimStick.dy = 0; }
    }
    return;
  }
  if (joy.id === null && x < VW * 0.5) {
    joy.id = id;
    if (Math.hypot(x - joy.homeX, y - joy.homeY) <= joy.radius * 1.4) { joy.baseX = joy.homeX; joy.baseY = joy.homeY; }
    else { joy.baseX = clamp(x, joy.radius + 10, VW * 0.5); joy.baseY = clamp(y, joy.radius + 10, VH - joy.radius - 10); }
    updateJoy(x, y);
  }
}
// ---- 射箭鈕＝瞄準搖桿：按住後拖曳中間的小圓點，360° 控制箭的方向 ----
const aimStick = { id: null, sx: 0, sy: 0, dx: 0, dy: 0, engaged: false, radius: 58, dead: 16 };
// 方向以「手指按下的位置」為起點計算：點在按鈕哪裡都不會被誤判成拖曳
function updateAimStick(x, y) {
  aimStick.dx = x - aimStick.sx; aimStick.dy = y - aimStick.sy;
  if (Math.hypot(aimStick.dx, aimStick.dy) >= aimStick.dead) aimStick.engaged = true;   // 拖出死區後才接手方向
}
function releaseAimStick() { aimStick.id = null; }
function pointerMove(id, x, y) {
  if (id === joy.id) updateJoy(x, y);
  if (id === aimStick.id) updateAimStick(x, y);
}
function pointerUp(id) {
  if (id === joy.id) releaseJoy();
  if (id === aimStick.id) releaseAimStick();
  for (const b of buttons) b.touches.delete(id);
}
// 安全網：手指已經不在螢幕上卻還被記錄（例如被系統手勢打斷）就釋放它
function reconcileTouches(list) {
  const alive = new Set();
  for (let i = 0; i < list.length; i++) alive.add(list[i].identifier);
  if (typeof joy.id === 'number' && !alive.has(joy.id)) releaseJoy();
  if (typeof aimStick.id === 'number' && !alive.has(aimStick.id)) releaseAimStick();
  for (const b of buttons) for (const id of b.touches) if (typeof id === 'number' && !alive.has(id)) b.touches.delete(id);
}
function onTouchStart(ev) {
  ev.preventDefault();
  reconcileTouches(ev.touches);
  for (let i = 0; i < ev.changedTouches.length; i++) { const t = ev.changedTouches[i]; pointerDown(t.identifier, t.clientX, t.clientY); }
}
function onTouchMove(ev) {
  ev.preventDefault();
  for (let i = 0; i < ev.changedTouches.length; i++) { const t = ev.changedTouches[i]; pointerMove(t.identifier, t.clientX, t.clientY); }
}
function onTouchEnd(ev) {
  ev.preventDefault();
  for (let i = 0; i < ev.changedTouches.length; i++) pointerUp(ev.changedTouches[i].identifier);
  reconcileTouches(ev.touches);
}
canvas.addEventListener('touchstart', onTouchStart, { passive: false });
canvas.addEventListener('touchmove', onTouchMove, { passive: false });
canvas.addEventListener('touchend', onTouchEnd, { passive: false });
canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

// 滑鼠（桌機測試用）
let mouseDown = false;
canvas.addEventListener('mousedown', e => { mouseDown = true; pointerDown('mouse', e.clientX, e.clientY); });
window.addEventListener('mousemove', e => { if (mouseDown) pointerMove('mouse', e.clientX, e.clientY); });
window.addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; pointerUp('mouse'); } });

// 頁面層級：禁止捲動與縮放（卡片內允許上下捲）
document.addEventListener('touchmove', e => {
  // 背包和卡片內的觸控由各自的 UI 處理，避免 Safari 的點擊被取消
  if (e.target && e.target.closest && e.target.closest('.card, .bag, .vcard')) return;
  e.preventDefault();
}, { passive: false });
['gesturestart', 'gesturechange', 'gestureend', 'dblclick'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
document.addEventListener('contextmenu', e => e.preventDefault());

// 鍵盤（桌機測試用）：WASD 移動，J/空白 攻擊，K 閃避，L/Shift 舉盾，U 射箭（按住），B 背包，P 暫停
const keys = new Set();
window.addEventListener('keydown', e => {
  if (e.target && e.target.id === 'netCodeInput') return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!e.repeat && (e.code === 'Escape' || e.code === 'Enter')) {
    if (prologue && prologue.playing) { prologue.skip(); return; }
    if (ch1End && ch1End.playing) { ch1End.skip(); return; }
  }
  if (!e.repeat) {
    if (e.code === 'KeyJ' || e.code === 'Space') input.attackPressed = true;
    if (e.code === 'KeyK') input.dodgePressed = true;
    if (e.code === 'KeyU') input.shootPressed = true;
    if (e.code === 'KeyR') input.ultPressed = true;
    if (e.code === 'KeyV') input.vacPressed = true;
    if (e.code === 'KeyB' || e.code === 'KeyI') { if (!bagScreen.classList.contains('hidden')) closeBag(); else openBag(); }
    if ((e.code === 'KeyP' || e.code === 'Escape') && game.mode === 'play' && bagScreen.classList.contains('hidden')) {
      if (game.paused) resumeGame(); else pauseGame();
    }
  }
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));

function resetInputs() {
  releaseJoy();
  releaseAimStick();
  for (const b of buttons) b.touches.clear();
  keys.clear(); mouseDown = false;
  input.attackPressed = input.dodgePressed = input.shootPressed = input.ultPressed = input.vacPressed = false;
  input.shieldHeld = input.shootHeld = false;
}
window.addEventListener('blur', resetInputs);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { Sfx.suspend(); resetInputs(); if (game.mode === 'play' && !game.paused) pauseGame(); }
  else Sfx.unlock();          // 回到遊戲時嘗試恢復聲音（若系統要求，下一次點擊也會恢復）
});

function readInput() {
  let x = 0, y = 0;
  if (joy.id !== null) { x = joy.kx; y = joy.ky; }
  else {
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
  }
  let len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; len = 1; }
  const DEAD = 0.15;
  if (len < DEAD) { input.dirX = input.dirY = input.mag = 0; }
  else { input.dirX = x / len; input.dirY = y / len; input.mag = (len - DEAD) / (1 - DEAD); }
  input.shieldHeld = BTN.shield.touches.size > 0 || keys.has('KeyL') || keys.has('ShiftLeft') || keys.has('ShiftRight');
  input.shootHeld = BTN.shoot.touches.size > 0 || keys.has('KeyU');
  if (game.mode !== 'play' || (NET.on && (game.paused || game.portrait))) {
    input.dirX = input.dirY = input.mag = 0;
    input.shieldHeld = input.shootHeld = false;
    input.attackPressed = input.dodgePressed = input.shootPressed = input.ultPressed = input.vacPressed = false;
  }
}

/* =========================================================
 * 8. 特效
 * ========================================================= */
function addParticle(p) { if (particles.length < 700) particles.push(p); }
function burst(x, y, n, color, spMin, spMax, life, size, type) {
  if (NET.on && netCapOK(x, y)) netCap(['b', r1(x), r1(y), n, color, spMin, spMax, life, size, type || 0]);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, sp = rand(spMin, spMax);
    addParticle({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: life * rand(0.6, 1), max: life,
      size: size * rand(0.6, 1.2), color, type: type || 'dot', rot: Math.random() * TAU, vr: rand(-8, 8) });
  }
}
function ring(x, y, color, size) { if (NET.on && netCapOK(x, y)) netCap(['r', r1(x), r1(y), color, size]); addParticle({ x, y, vx: 0, vy: 0, life: 0.35, max: 0.35, size: size || 10, color, type: 'ring', rot: 0, vr: 0 }); }
function addText(x, y, text, color, size) { if (NET.on && netCapOK(x, y)) netCap(['t', r1(x), r1(y), text, color, size]); texts.push({ x, y, text, color, size: size || 18, life: 1.0, max: 1.0 }); }
function showHint(id, text, dur) {
  if (id && game.seenHint[id]) return;
  if (id) game.seenHint[id] = true;
  game.hints.push({ text, t: dur || 7 });
}


/* =========================================================
 * 8.5 音效與音樂（Web Audio API 即時合成，不使用任何音檔）
 *
 *  音效設計參考專業遊戲音效的「分層」做法：
 *   起音 transient（尖銳的一瞬間） + 本體 body（主要衝擊） + 低頻 sub（重量感） + 殘響 tail（空間感）
 *   每次播放隨機微調音高，避免同一個聲音聽膩。
 *  音訊路由：
 *   世界音效 → 左右聲道定位 → worldBus ┐
 *   背景音樂 → musicBus ───────────────┼→ 低通濾波（迅影時刻時關小，世界變悶）→ mix
 *   殘響 reverb ───────────────────────┘
 *   亞特自己的音效 → playerBus ──────────────────────────────────────────────→ mix
 *   mix → 壓縮器（讓打擊更紮實、音量更穩）→ 喇叭
 * ========================================================= */
const Sfx = (() => {
  let ac = null, mix, comp, lp, worldBus, playerBus, musicBus, revIn, noiseBuf, curve;
  let custom = null, customSrc = null, customGain = null, customName = '';   // 玩家自選的背景音樂
  let out = null, P = 1, slow = false;
  // 音量 0～1（滑桿 0%～100%），預設 80%
  const st = { sfxVol: 0.8, musicVol: 0.8 };
  try {
    const saved = JSON.parse(localStorage.getItem('ater-audio') || 'null');
    if (saved) {
      if (typeof saved.sfxVol === 'number') st.sfxVol = clamp(saved.sfxVol, 0, 1); else if (saved.sfx === false) st.sfxVol = 0;
      if (typeof saved.musicVol === 'number') st.musicVol = clamp(saved.musicVol, 0, 1); else if (saved.music === false) st.musicVol = 0;
    }
  } catch (err) { /* 讀不到設定就用預設 */ }
  // 滑桿數值 → 實際音量：用平方曲線，聽感上比較均勻；80% 時等於原本的標準音量
  const sfxGainOf = v => Math.pow(v / 0.8, 2);
  const musicGainOf = v => 0.6 * Math.pow(v / 0.8, 2);
  const save = () => { try { localStorage.setItem('ater-audio', JSON.stringify(st)); } catch (err) { /* 略過 */ } };
  const lastPlay = {};

  // 人工產生殘響的脈衝響應（隨時間衰減的雜訊）
  function makeIR(sec, decay) {
    const len = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }
  function makeCurve(k) {            // 失真曲線：增加顆粒感與破壞力
    const n = 1025, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / (n - 1) - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    return c;
  }

  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ac) {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (err) { /* 略過 */ }
      try { ac = new AC(); } catch (err) { ac = null; return; }
      mix = ac.createGain(); mix.gain.value = 0.5;
      comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 8; comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.16;
      // 最後一道柔性限幅：確保任何瞬間都不會破音
      const limiter = ac.createWaveShaper(), lc = new Float32Array(1025);       // 奇數長度：輸入 0 剛好對到輸出 0，不產生直流偏移
      for (let i = 0; i < 1025; i++) { const x = i * 2 / 1024 - 1; lc[i] = 0.95 * Math.tanh(1.6 * x) / Math.tanh(1.6); }
      limiter.curve = lc;
      mix.connect(comp); comp.connect(limiter); limiter.connect(ac.destination);
      lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 18000; lp.Q.value = 0.7;
      lp.connect(mix);
      worldBus = ac.createGain(); worldBus.gain.value = sfxGainOf(st.sfxVol); worldBus.connect(lp);
      musicBus = ac.createGain(); musicBus.gain.value = musicGainOf(st.musicVol); musicBus.connect(lp);
      customGain = ac.createGain(); customGain.gain.value = 0; customGain.connect(musicBus);
      playerBus = ac.createGain(); playerBus.gain.value = sfxGainOf(st.sfxVol); playerBus.connect(mix);
      revIn = ac.createGain();
      const conv = ac.createConvolver(); conv.buffer = makeIR(2.2, 2.6);
      const revOut = ac.createGain(); revOut.gain.value = 0.35;
      revIn.connect(conv); conv.connect(revOut); revOut.connect(lp);
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      curve = makeCurve(18);
      const silent = ac.createBufferSource();           // iOS 解鎖：先播一段無聲
      silent.buffer = ac.createBuffer(1, 1, 22050); silent.connect(ac.destination); silent.start(0);
    }
    if (ac.state !== 'running') { try { const r = ac.resume(); if (r && r.catch) r.catch(() => {}); } catch (err) { /* 略過 */ } }
  }
  const ready = () => !!ac && ac.state === 'running';
  function glide(param, target, sec) {
    const now = ac.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + sec);
  }

  // ---------- 合成積木 ----------
  function env(g, t, vol, attack, dur, hold) {
    vol = Math.max(0.0002, vol);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    if (hold) g.gain.setValueAtTime(vol, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + (hold || 0) + 0.01));
  }
  // ---------- 聲部管理（長時間遊玩不會越來越卡的關鍵）----------
  // 每個聲音用到的節點都記下來，聲音一結束就全部拔除；否則節點會一直留在音訊系統裡，
  // 玩越久累積越多，iPad 的音訊處理器最後會負荷不了，導致音樂消失、出現雜音。
  // 用「預定結束時間」計算目前發聲數；即使系統漏發 onended 通知，也會在逾時後自動回收，計數不會卡死
  const voices = [];
  let group = null;
  const MAX_VOICES = 150, MAX_WORLD_VOICES = 90;
  function track(src, nodes, end) {
    const grp = group;
    if (grp) grp.pending++;
    const v = { end, done: false };
    v.cleanup = () => {
      if (v.done) return;
      v.done = true;
      const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1);
      for (const n of nodes) { try { n.disconnect(); } catch (err) { /* 已拔除 */ } }
      if (grp && --grp.pending <= 0) for (const n of grp.nodes) { try { n.disconnect(); } catch (err) { /* 已拔除 */ } }
    };
    voices.push(v);
    src.onended = v.cleanup;
  }
  function prune() {                       // 結束超過 0.5 秒仍未回收的聲部，強制回收
    const now = ac.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end + 0.5 < now) voices[i].cleanup();
  }
  const activeCount = () => voices.length;
  function finish(node, o, t, nodes) {      // 加上失真、音量包絡、輸出與殘響送出
    if (o.dist) { const ws = ac.createWaveShaper(); ws.curve = curve; node.connect(ws); node = ws; nodes.push(ws); }
    const g = ac.createGain(); nodes.push(g);
    env(g, t, o.vol, o.attack || 0.004, o.dur, o.hold);
    node.connect(g); g.connect(o.to || out);
    if (o.rev) {
      const busVol = (o.to || out) === musicBus ? musicGainOf(st.musicVol) : sfxGainOf(st.sfxVol);
      const sg = ac.createGain(); sg.gain.value = o.rev * busVol; g.connect(sg); sg.connect(revIn); nodes.push(sg);
    }
  }
  function filt(node, o, t, nodes) {
    if (!o.lp) return node;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = o.q || 0.7; nodes.push(f);
    f.frequency.setValueAtTime(o.lp, t);
    if (o.lpPeak) {                  // 濾波包絡：先打開再收（銅管的「叭」感）
      f.frequency.exponentialRampToValueAtTime(o.lpPeak, t + (o.attack || 0.004) + 0.03);
      f.frequency.exponentialRampToValueAtTime(o.lp1 || o.lp, t + o.dur);
    } else if (o.lp1) f.frequency.exponentialRampToValueAtTime(o.lp1, t + o.dur);
    node.connect(f);
    return f;
  }
  // 振盪器聲部
  function tone(o) {
    if (activeCount() >= MAX_VOICES) return;
    const t = ac.currentTime + (o.delay || 0);
    const osc = ac.createOscillator();
    osc.type = o.type || 'sine';
    const p = o.noP ? 1 : P;
    osc.frequency.setValueAtTime(o.f0 * p, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 * p), t + (o.glide || o.dur));
    if (o.detune) osc.detune.value = o.detune;
    const nodes = [osc];
    finish(filt(osc, o, t, nodes), o, t, nodes);
    const end = t + o.dur + (o.hold || 0) + 0.05;
    osc.start(t); osc.stop(end);
    track(osc, nodes, end);
  }
  // 濾波雜訊聲部（揮擊風聲、衝擊、碎裂…）
  function noise(o) {
    if (activeCount() >= MAX_VOICES) return;
    const t = ac.currentTime + (o.delay || 0);
    const src = ac.createBufferSource(), f = ac.createBiquadFilter();
    src.buffer = noiseBuf;
    f.type = o.ft || 'bandpass'; f.Q.value = o.q || 1;
    f.frequency.setValueAtTime(o.f0 * P, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 * P), t + (o.glide || o.dur));
    src.connect(f);
    const nodes = [src, f];
    finish(f, o, t, nodes);
    const len = o.dur + (o.hold || 0) + 0.05;
    src.start(t, Math.random() * 0.8, len);
    track(src, nodes, t + len);
  }
  // 金屬撞擊：非諧和泛音（真實金屬的聲音特徵）
  function metal(base, v, rev) {
    const parts = [[1, 0.9, 1], [2.32, 0.6, 0.6], [4.25, 0.45, 0.4], [5.63, 0.3, 0.3], [6.9, 0.22, 0.2]];
    for (const [m, dur, a] of parts) tone({ type: m < 2 ? 'triangle' : 'sine', f0: base * m, dur, vol: 0.12 * a * v, rev });
    noise({ ft: 'highpass', f0: 2500, dur: 0.03, vol: 0.6 * v });
    noise({ ft: 'bandpass', f0: 900, q: 1.5, dur: 0.1, vol: 0.3 * v, dist: true });
  }
  function bell(f, v, delay, rev) {
    tone({ f0: f, dur: 0.6, vol: 0.12 * v, delay, rev: rev || 0.3 });
    tone({ f0: f * 2.76, dur: 0.25, vol: 0.04 * v, delay });
  }
  function brass(f, dur, v, delay, rev) {      // 兩支微走音的鋸齒波＋濾波包絡＝合成銅管
    for (const det of [-7, 7]) tone({ type: 'sawtooth', f0: f, detune: det, lp: 420, lpPeak: 2600, lp1: 1100, attack: 0.04, hold: Math.max(0, dur - 0.18), dur: 0.18, vol: 0.09 * v, delay, rev, noP: true });
  }
  function boom(v, delay, rev) {               // 定音鼓／太鼓
    tone({ f0: 95, f1: 55, glide: 0.25, dur: 0.6, vol: 0.55 * v, delay, rev, noP: true });
    noise({ ft: 'lowpass', f0: 500, dur: 0.12, vol: 0.3 * v, delay });
  }
  function hitLayers(v, big) {
    noise({ ft: 'highpass', f0: 3000, dur: 0.03, vol: 0.5 * v });                                  // 起音：喀
    noise({ ft: 'lowpass', f0: 1300, f1: 280, dur: big ? 0.24 : 0.16, vol: 0.7 * v, dist: true, rev: big ? 0.35 : 0.12 });   // 本體：碎裂衝擊
    tone({ f0: big ? 95 : 115, f1: 40, dur: big ? 0.3 : 0.18, vol: (big ? 0.8 : 0.6) * v });       // 低頻：重量
    noise({ ft: 'bandpass', f0: 2600, f1: 1100, q: 2, dur: 0.08, vol: 0.25 * v, delay: 0.004 });     // 刀刃切入
  }

  // ---------- 音效配方 ----------
  const DEF = {
    swing: (v, o) => {
      const h = o.heavy;
      noise({ f0: h ? 280 : 550, f1: h ? 1300 : 2600, q: 1.4, dur: h ? 0.32 : 0.2, attack: h ? 0.1 : 0.06, vol: 0.8 * v });     // 破風聲（先漲後收）
      noise({ ft: 'highpass', f0: 4200, dur: 0.12, attack: 0.04, vol: 0.12 * v, delay: 0.02 });
      tone({ f0: 3300, dur: 0.22, vol: 0.022 * v, delay: 0.05, attack: 0.02 });                       // 劍刃的「鏘」
      tone({ f0: 4870, dur: 0.18, vol: 0.014 * v, delay: 0.05, attack: 0.02 });
    },
    flurrySlash: v => {
      noise({ ft: 'highpass', f0: 2400, f1: 6500, dur: 0.12, attack: 0.02, vol: 0.5 * v });
      tone({ f0: 5200, dur: 0.18, vol: 0.03 * v, rev: 0.4 });
    },
    hit: (v, o) => hitLayers(v, o.big),
    arrowHit: v => {
      noise({ ft: 'highpass', f0: 2500, dur: 0.02, vol: 0.4 * v });
      tone({ f0: 180, f1: 80, dur: 0.1, vol: 0.4 * v });
      noise({ ft: 'lowpass', f0: 900, dur: 0.08, vol: 0.4 * v, dist: true });
    },
    burnHit: v => { noise({ ft: 'highpass', f0: 3000, f1: 6000, dur: 0.25, vol: 0.25 * v }); noise({ ft: 'lowpass', f0: 700, dur: 0.1, vol: 0.3 * v }); },
    kill: v => {
      hitLayers(v, true);
      noise({ ft: 'lowpass', f0: 2200, f1: 140, dur: 0.6, vol: 0.4 * v, delay: 0.05, rev: 0.4 });       // 化為煙塵
      tone({ type: 'square', f0: 220, f1: 55, dur: 0.35, vol: 0.12 * v, lp: 800, dist: true, delay: 0.02 });   // 怪物哀號
    },
    hurt: v => {
      noise({ ft: 'lowpass', f0: 800, dur: 0.2, vol: 0.7 * v, dist: true });
      tone({ f0: 90, f1: 40, dur: 0.3, vol: 0.8 * v });
      noise({ ft: 'highpass', f0: 2000, dur: 0.04, vol: 0.4 * v });
      tone({ type: 'sawtooth', f0: 380, f1: 210, dur: 0.18, vol: 0.07 * v, lp: 1300 });               // 悶哼
    },
    dodge: v => {
      noise({ f0: 350, f1: 1100, q: 1, dur: 0.22, attack: 0.05, vol: 0.7 * v });
      noise({ ft: 'lowpass', f0: 500, dur: 0.08, vol: 0.25 * v });                                    // 腳步摩擦
    },
    denied: v => { tone({ type: 'square', f0: 160, dur: 0.1, vol: 0.1 * v, lp: 900 }); tone({ type: 'square', f0: 150, dur: 0.1, vol: 0.1 * v, lp: 900, delay: 0.13 }); },
    shieldUp: v => { noise({ f0: 1400, q: 2, dur: 0.07, vol: 0.45 * v }); tone({ f0: 2200, dur: 0.1, vol: 0.08 * v }); },
    block: v => metal(480, v, 0.35),
    parry: v => {
      metal(620, 1.4 * v, 0.5);
      [1568, 2093, 2637, 3136].forEach((f, i) => bell(f, 0.8 * v, 0.03 + i * 0.04, 0.5));
      tone({ f0: 70, f1: 35, dur: 0.5, vol: 0.6 * v });
    },
    flurryStart: v => {                                                                               // 時間凝結
      noise({ f0: 200, f1: 3000, dur: 0.3, attack: 0.25, vol: 0.3 * v });
      noise({ ft: 'lowpass', f0: 3000, f1: 150, dur: 0.8, vol: 0.5 * v, delay: 0.25, rev: 0.6 });
      tone({ f0: 60, f1: 30, dur: 0.9, vol: 0.7 * v, delay: 0.25 });
      tone({ f0: 1760, dur: 1.2, vol: 0.05 * v, delay: 0.25, rev: 0.6 });
      tone({ f0: 2637, dur: 1.0, vol: 0.035 * v, delay: 0.3, rev: 0.6 });
    },
    windup: v => {                                                                                    // 野獸低吼
      tone({ type: 'sawtooth', f0: 68, f1: 96, dur: 0.45, attack: 0.08, vol: 0.13 * v, lp: 650, dist: true });
      noise({ f0: 320, q: 4, dur: 0.4, attack: 0.1, vol: 0.1 * v });
    },
    cue: v => { tone({ f0: 2800, dur: 0.18, vol: 0.07 * v, rev: 0.3 }); tone({ f0: 4200, dur: 0.12, vol: 0.05 * v }); },   // 出手前的「鏘」閃光
    enemySwing: v => noise({ f0: 250, f1: 950, q: 1.2, dur: 0.25, attack: 0.07, vol: 0.4 * v }),
    bowDraw: v => {
      tone({ type: 'sawtooth', f0: 140, f1: 240, dur: 0.35, attack: 0.05, vol: 0.05 * v, lp: 1500 });
      noise({ f0: 2000, q: 8, dur: 0.3, attack: 0.1, vol: 0.06 * v });
    },
    bowShot: v => {
      tone({ type: 'triangle', f0: 220, f1: 90, dur: 0.18, vol: 0.35 * v });                           // 弓弦
      tone({ type: 'sawtooth', f0: 110, dur: 0.12, vol: 0.1 * v, lp: 800 });
      noise({ ft: 'highpass', f0: 3000, dur: 0.06, vol: 0.25 * v });
      noise({ f0: 2000, f1: 800, dur: 0.25, vol: 0.15 * v, delay: 0.02 });                             // 箭矢破空
    },
    thunk: v => { tone({ f0: 200, f1: 90, dur: 0.08, vol: 0.4 * v }); noise({ f0: 700, q: 2, dur: 0.06, vol: 0.35 * v }); noise({ ft: 'highpass', f0: 3500, dur: 0.02, vol: 0.2 * v }); },
    stone: v => {
      noise({ ft: 'highpass', f0: 5000, dur: 0.02, vol: 0.6 * v });
      tone({ f0: 3100, dur: 0.12, vol: 0.05 * v }); tone({ f0: 1900, dur: 0.1, vol: 0.04 * v });
      for (let k = 0; k < 3; k++) noise({ ft: 'highpass', f0: 3000 + Math.random() * 3000, dur: 0.02, vol: 0.25 * v, delay: 0.05 + k * 0.05 + Math.random() * 0.03 });
    },
    ignite: v => {
      noise({ ft: 'lowpass', f0: 150, f1: 2200, dur: 0.5, attack: 0.12, vol: 0.45 * v, rev: 0.3 });
      tone({ f0: 70, f1: 45, dur: 0.4, vol: 0.35 * v });
    },
    crackle: v => noise({ ft: 'highpass', f0: 2000 + Math.random() * 4000, dur: 0.02, vol: 0.2 * v }),
    grass: v => { noise({ ft: 'highpass', f0: 2500, f1: 5000, dur: 0.1, vol: 0.2 * v }); noise({ f0: 1200, q: 3, dur: 0.05, vol: 0.12 * v }); },
    vacAppear: v => { tone({ f0: 300, f1: 900, dur: 0.35, vol: 0.12 * v }); tone({ type: 'triangle', f0: 660, f1: 990, dur: 0.18, vol: 0.08 * v, delay: 0.3 }); },
    vacSuck: v => {                               // 約 3.8 秒的吸氣聲：雜訊緩衝只有 2 秒，所以用 4 段（各 < 1.2 秒）接起來
      [[0, 300, 900], [0.95, 900, 1500], [1.9, 1500, 2100], [2.85, 2100, 2600]].forEach(([d, f0, f1], i) =>
        noise({ ft: 'bandpass', f0, f1, dur: 1.15, attack: i ? 0.2 : 0.3, vol: 0.4 * v, q: 0.7, delay: d }));
      tone({ type: 'sawtooth', f0: 80, f1: 220, dur: 3.8, hold: 3.0, attack: 0.3, vol: 0.05 * v, lp: 600 });
    },
    vacGulp: v => { tone({ f0: 220, f1: 90, dur: 0.12, vol: 0.25 * v }); noise({ ft: 'lowpass', f0: 600, dur: 0.06, vol: 0.2 * v }); },
    vacClose: v => { tone({ f0: 140, f1: 70, dur: 0.25, vol: 0.4 * v }); tone({ type: 'triangle', f0: 520, f1: 380, dur: 0.12, vol: 0.06 * v, delay: 0.05 }); },
    vacSpit: v => { noise({ ft: 'bandpass', f0: 1800, f1: 700, dur: 0.09, vol: 0.35 * v, q: 2 }); tone({ type: 'triangle', f0: 700, f1: 1200, dur: 0.08, vol: 0.07 * v }); },
    rift: v => { noise({ f0: 300, f1: 3000, dur: 0.35, attack: 0.1, vol: 0.3 * v }); [1320, 1760].forEach((f, i) => tone({ f0: f, dur: 0.4, vol: 0.05 * v, delay: 0.1 + i * 0.06, rev: 0.5 })); },
    bossWarn: v => { [146.8, 155.6, 220].forEach(f => brass(f, 0.7, v, 0, 0.5)); boom(v, 0, 0.4); },
    bossRoar: v => {
      tone({ type: 'sawtooth', f0: 90, f1: 38, dur: 1.4, attack: 0.1, vol: 0.18 * v, lp: 700, dist: true, rev: 0.5 });
      noise({ ft: 'lowpass', f0: 1200, f1: 200, dur: 1.4, attack: 0.1, vol: 0.4 * v, rev: 0.5 });
    },
    bossSlam: v => { boom(1.3 * v, 0, 0.6); hitLayers(v, true); noise({ ft: 'lowpass', f0: 2000, f1: 120, dur: 0.9, vol: 0.4 * v, rev: 0.5 }); },
    bossDash: v => noise({ f0: 200, f1: 1600, dur: 0.45, attack: 0.08, vol: 0.5 * v, q: 0.8 }),
    bossOrb: v => { [880, 1175, 1568].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f * 0.5, dur: 0.25, vol: 0.05 * v, delay: i * 0.03, rev: 0.4 })); },
    bossDie: v => {
      boom(1.5 * v, 0, 0.7); boom(1.2 * v, 0.5, 0.6);
      noise({ ft: 'lowpass', f0: 6000, f1: 80, dur: 2.2, vol: 0.5 * v, rev: 0.8 });
      [261.6, 329.6, 392, 523.3].forEach(f => brass(f, 1.8, 0.9 * v, 1.0, 0.6));
    },
    ultCharge: v => {                                                                              // 心跳＋舉刀的刀鳴＋低沉蓄力
      tone({ f0: 70, f1: 40, dur: 0.35, vol: 0.7 * v }); tone({ f0: 70, f1: 40, dur: 0.35, vol: 0.6 * v, delay: 0.32 });
      noise({ ft: 'highpass', f0: 2200, f1: 7000, dur: 0.35, attack: 0.08, vol: 0.35 * v, delay: 0.1 });
      tone({ f0: 3300, dur: 0.9, vol: 0.06 * v, delay: 0.25, rev: 0.5 }); tone({ f0: 4870, dur: 0.7, vol: 0.04 * v, delay: 0.25 });
      tone({ type: 'sawtooth', f0: 55, f1: 110, dur: 0.95, attack: 0.5, vol: 0.08 * v, lp: 500 });
    },
    smoke: v => { noise({ f0: 900, f1: 260, dur: 0.25, vol: 0.4 * v }); noise({ ft: 'highpass', f0: 3000, dur: 0.08, vol: 0.15 * v }); },
    ultSlash: v => {
      noise({ ft: 'highpass', f0: 3000, f1: 8000, dur: 0.07, attack: 0.01, vol: 0.5 * v });
      tone({ f0: 4200, dur: 0.12, vol: 0.04 * v });
      hitLayers(0.9 * v, true);
    },
    ultEnd: v => {
      noise({ f0: 4000, f1: 200, dur: 0.6, vol: 0.35 * v, rev: 0.5 });
      tone({ f0: 80, f1: 35, dur: 0.6, vol: 0.7 * v });
      tone({ type: 'square', f0: 1800, dur: 0.04, vol: 0.06 * v, delay: 0.45 });             // 收刀「喀」
      tone({ f0: 3300, dur: 0.6, vol: 0.05 * v, delay: 0.47, rev: 0.5 });
    },
    unsheathe: v => {                                                                                // 拔刀：金屬摩擦＋刀刃餘韻
      noise({ ft: 'highpass', f0: 2200, f1: 6500, dur: 0.28, attack: 0.06, vol: 0.4 });
      tone({ f0: 3300, dur: 0.5, vol: 0.05, delay: 0.2, rev: 0.4 }); tone({ f0: 4870, dur: 0.35, vol: 0.035, delay: 0.2 });
    },
    crate: v => {
      for (let k = 0; k < 4; k++) noise({ f0: 900 + Math.random() * 1500, q: 3, dur: 0.04, vol: 0.5 * v, delay: k * 0.025 + Math.random() * 0.01 });   // 木頭斷裂
      tone({ f0: 130, f1: 60, dur: 0.15, vol: 0.45 * v });
      noise({ ft: 'lowpass', f0: 600, dur: 0.25, vol: 0.3 * v, dist: true, rev: 0.2 });
    },
    pickupFood: v => { bell(784, v, 0); bell(1175, v, 0.09); },
    pickupArrows: v => { noise({ f0: 1800, q: 4, dur: 0.03, vol: 0.3 * v }); noise({ f0: 1500, q: 4, dur: 0.03, vol: 0.3 * v, delay: 0.05 }); bell(1568, 0.5 * v, 0.06); },
    pickupLegend: v => { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => bell(f, v, i * 0.07, 0.6)); brass(784, 0.8, 0.7 * v, 0.4, 0.4); },
    chestOpen: v => { tone({ type: 'sawtooth', f0: 160, f1: 260, dur: 0.3, vol: 0.06 * v, lp: 1200 }); [784, 988, 1175, 1568].forEach((f, i) => bell(f, v, 0.25 + i * 0.07, 0.6)); noise({ ft: 'highpass', f0: 6000, dur: 1.2, vol: 0.08 * v, delay: 0.25, rev: 0.5 }); },
    elite: v => { [220, 277.2, 329.6].forEach(f => brass(f, 0.5, 0.8 * v, 0, 0.4)); boom(0.7 * v, 0, 0.3); },
    pickupItem: v => { [523, 659, 784, 1047].forEach((f, i) => bell(f, v, i * 0.08, 0.4)); brass(1047, 0.5, 0.6 * v, 0.32, 0.3); },
    alert: v => { tone({ type: 'square', f0: 1320, dur: 0.05, vol: 0.05 * v, lp: 3000 }); tone({ f0: 1760, dur: 0.1, vol: 0.06 * v, delay: 0.06 }); },
    levelStart: v => {                                                                                  // 管弦齊奏＋定音鼓
      [262, 330, 392, 523].forEach(f => brass(f, 0.9, 0.9 * v, 0, 0.4));
      boom(v, 0, 0.3); noise({ ft: 'highpass', f0: 5000, dur: 1.4, vol: 0.18 * v, rev: 0.4 });
    },
    levelClear: v => {                                                                                  // 原創勝利號角
      [[392, 0, 0.14], [523, 0.15, 0.14], [659, 0.3, 0.14], [784, 0.45, 0.5], [659, 0.98, 0.14], [784, 1.13, 0.9]]
        .forEach(([f, d, l]) => brass(f, l, v, d, 0.4));
      [262, 330, 392].forEach(f => brass(f, 0.9, 0.6 * v, 1.13, 0.4));
      boom(v, 0.45, 0.3); boom(v, 1.13, 0.4);
    },
    gameOver: v => { [[392, 0], [311, 0.35], [262, 0.7]].forEach(([f, d]) => brass(f / 2, 0.6, v, d, 0.5)); boom(v, 0.7, 0.5); boom(0.8 * v, 0.9, 0.5); },
    // ---- 通關煙火與勝利號角 ----
    fwLaunch: v => { noise({ f0: 500, f1: 2600, q: 5, dur: 0.85, attack: 0.08, vol: 0.16 * v }); tone({ f0: 1200, f1: 2600, dur: 0.75, attack: 0.1, vol: 0.02 * v }); },
    fwBoom: v => {
      boom(1.0 * v, 0, 0.6); noise({ ft: 'lowpass', f0: 1800, f1: 120, dur: 0.7, vol: 0.45 * v, rev: 0.6 });
      for (let k = 0; k < 10; k++) noise({ ft: 'highpass', f0: 3000 + Math.random() * 4000, dur: 0.02, vol: 0.16 * v, delay: 0.25 + Math.random() * 1.1 });
    },
    fwBig: v => {
      boom(1.4 * v, 0, 0.7); noise({ ft: 'lowpass', f0: 2600, f1: 120, dur: 1.0, vol: 0.55 * v, rev: 0.7 });
      [1568, 2093, 2637, 3136].forEach((fq, i) => bell(fq, 0.7 * v, 0.9 + i * 0.12, 0.6));
    },
    fwCrackle: v => { for (let k = 0; k < 6; k++) noise({ ft: 'highpass', f0: 3500 + Math.random() * 3000, dur: 0.02, vol: 0.18 * v, delay: Math.random() * 0.3 }); },
    victory: v => {
      [[523.3, 0, 0.18], [659.3, 0.2, 0.18], [784, 0.4, 0.18], [1046.5, 0.6, 0.7], [880, 1.4, 0.18], [987.8, 1.6, 0.18], [1046.5, 1.8, 1.4]]
        .forEach(([fq, d, l]) => brass(fq, l, v, d, 0.5));
      [[261.6, 329.6, 392], [349.2, 440, 523.3], [392, 493.9, 587.3], [523.3, 659.3, 784]].forEach((ch, i) => ch.forEach(fq => brass(fq / 2, 0.9, 0.6 * v, 0.6 + i * 0.6, 0.5)));
      [0, 0.6, 1.2, 1.8, 2.4].forEach(d => boom(v, d, 0.4));
      noise({ ft: 'highpass', f0: 5000, dur: 2.5, vol: 0.15 * v, delay: 1.8, rev: 0.6 });
      [2093, 2637, 3136, 4186].forEach((fq, i) => bell(fq, 0.8 * v, 1.8 + i * 0.1, 0.6));
    },
    ui: v => { tone({ f0: 1200, dur: 0.04, vol: 0.05 * v }); noise({ ft: 'highpass', f0: 4000, dur: 0.015, vol: 0.1 * v }); },
  };
  const MIN_GAP = { hit: 0.03, crackle: 0.06, grass: 0.05, ignite: 0.12, arrowHit: 0.03, burnHit: 0.08, thunk: 0.04, stone: 0.05, alert: 0.15, cue: 0.05, windup: 0.08 };

  // o.player＝亞特自己的聲音；否則依 o.x/o.y 定位：距離越遠越小聲，並分左右聲道
  function play(name, o) {
    if (st.sfxVol <= 0 || !ready() || !DEF[name]) return;
    o = o || {};
    const now = ac.currentTime;
    if (now - (lastPlay[name] === undefined ? -1 : lastPlay[name]) < (MIN_GAP[name] || 0.025)) return;
    let v = o.vol || 1;
    group = null;
    prune();
    if (o.player) out = playerBus;
    else {
      if (activeCount() >= MAX_WORLD_VOICES) return;      // 太多聲音同時響時，略過遠方的音效
      out = worldBus;
      if (o.x !== undefined && player) {
        // 350px 內全音量，之後逐漸變小，900px（畫面外）以外完全聽不到
        const d = Math.hypot(o.x - player.x, o.y - player.y);
        v *= d < 350 ? 1 : clamp(1 - (d - 350) / 550, 0, 1);
        if (v < 0.04) return;
        if (ac.createStereoPanner) {
          const pn = ac.createStereoPanner();
          pn.pan.value = clamp((o.x - player.x) / 500, -0.85, 0.85);
          pn.connect(worldBus); out = pn;
          group = { nodes: [pn], pending: 0 };
        }
      }
    }
    lastPlay[name] = now;
    P = (o.pitch || 1) * rand(0.93, 1.07);         // 每次音高都不同
    try { DEF[name](v, o); } catch (err) { /* 單一音效失敗不影響遊戲 */ }
    if (group && group.pending === 0) for (const n of group.nodes) n.disconnect();   // 一個聲部都沒建立就直接回收
    group = null;
    P = 1;
  }
  // 過場動畫前把遊戲配樂淡出，結束後淡回原本音量
  let ducked = false;
  function duck(on) {
    ducked = on;
    if (ac) glide(musicBus.gain, on ? 0 : musicGainOf(st.musicVol), on ? 1.6 : 0.6);
  }
  function setSlow(on) {
    if (!ac || on === slow) return;
    slow = on;
    if (customSrc) {                 // 自訂音樂在慢動作時也跟著變慢變低（0.25 秒平滑滑音）
      glide(customSrc.playbackRate, on ? 0.8 : 1, 0.25);
    }
    glide(lp.frequency, on ? 450 : 18000, on ? 0.12 : 0.35);
  }

  /* ---------- 背景音樂：原創英雄主題 ----------
   *  風格參考冒險遊戲的原野主題：大調＋混合利地亞（I–♭VII 進行）、銅管主旋律、
   *  弦樂「噠噠咚」騎馬節奏、定音鼓與小鼓行進。層次會隨時間一層層疊上去，
   *  遇到敵人追擊時加強，最後轉調升高全音進入高潮，讓人越聽越熱血。 */
  const MELODY = [       // 每小節：[半音（相對主音）, 十六分音符長度]
    [[0, 8], [7, 4], [12, 4]],
    [[14, 6], [12, 2], [10, 4], [9, 4]],
    [[7, 8], [5, 4], [4, 4]],
    [[5, 4], [7, 4], [9, 8]],
    [[12, 8], [14, 4], [16, 4]],
    [[17, 6], [16, 2], [14, 4], [12, 4]],
    [[10, 4], [14, 4], [12, 4], [9, 4]],
    [[12, 12], [null, 4]],
  ];
  const CHORDS = [0, 10, 0, 5, 0, 5, 10, 0];         // C、B♭、C、F、C、F、B♭、C
  const SONGS = [                                     // 每種地形：移調、速度、大小調
    { key: 0, bpm: 132, minor: false },   // 苔原
    { key: -2, bpm: 126, minor: false },  // 赤砂
    { key: 2, bpm: 120, minor: false },   // 霜原
    { key: -3, bpm: 140, minor: true },   // 熔岩
    { key: 1, bpm: 128, minor: true },    // 虛空
  ];
  const MINOR = { 4: 3, 9: 8, 16: 15, 21: 20 };
  const C3 = 130.81;
  const hz = semi => C3 * Math.pow(2, semi / 12);
  let mStep = 0, mNext = 0, phrase = 0, phraseKey = 0, barLevel = 0, combatHold = 0;
  function musicReset() { mStep = 0; phrase = 0; phraseKey = 0; barLevel = 0; if (ac) mNext = ac.currentTime + 0.1; }
  function music(themeIdx, combat) {
    if (!ready() || st.musicVol <= 0) return;
    if (custom) { if (!customSrc) startCustom(); return; }
    const S = SONGS[themeIdx % SONGS.length];
    const sd = 60 / S.bpm / 4;
    if (combat) combatHold = 8; else combatHold = Math.max(0, combatHold - 1 / 60);
    // 看門狗：排程時間若落後、跳太遠或變成無效數字，就重新對準，音樂不會卡死
    if (!isFinite(mNext) || mNext < ac.currentTime || mNext > ac.currentTime + 2) mNext = ac.currentTime + 0.05;
    out = musicBus; P = 1; group = null;
    prune();
    const m = s => (S.minor && MINOR[s] !== undefined ? MINOR[s] : s);
    while (mNext < ac.currentTime + 0.18) {
      const s = mStep % 16, bar = Math.floor(mStep / 16) % 8, delay = mNext - ac.currentTime;
      if (s === 0) {
        if (bar === 0) {
          phrase = Math.floor(mStep / 128);
          // 每一段（8 小節）越來越熱血；第 5 段起在高潮與次高潮之間交替
          const base = phrase >= 4 ? (phrase % 2 === 0 ? 4 : 3) : Math.min(3, phrase);
          phraseKey = base === 4 ? 2 : 0;          // 高潮段：升高全音
          barLevel = base;
        }
        const base = phrase >= 4 ? (phrase % 2 === 0 ? 4 : 3) : Math.min(3, phrase);
        barLevel = Math.min(4, Math.max(base, combatHold > 0 ? Math.min(3, base + 2) : base));
        if (combat === 2) barLevel = 4;                // 大魔王戰：全編制
      }
      const L = barLevel, K = S.key + phraseKey;
      const root = CHORDS[bar], third = S.minor && root !== 10 ? 3 : 4;
      // ---- 弦樂和聲（每小節一次，緩慢漸強）----
      if (s === 0) {
        for (const iv of [0, third, 7]) for (const det of [-8, 8])
          tone({ type: 'sawtooth', f0: hz(K + root + iv + 12), detune: det, lp: 1400, attack: 0.3, hold: sd * 16 - 0.5, dur: 0.4, vol: 0.022, rev: 0.3, delay });
      }
      // ---- 低音 ----
      if (L === 0 ? (s === 0 || s === 8) : s % 4 === 0) {
        const oct = L >= 2 && (s === 4 || s === 12) ? 12 : 0;
        tone({ type: 'triangle', f0: hz(K + root - 12 + oct), dur: sd * (L === 0 ? 7 : 3), vol: 0.32, attack: 0.01, delay });
        tone({ f0: hz(K + root - 24), dur: sd * 3, vol: 0.2, delay });
      }
      // ---- 弦樂騎馬節奏「噠噠咚」（L1 起）----
      if (L >= 1 && [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15].includes(s)) {
        const iv = (s % 4 === 0) ? 0 : (s % 4 === 2 ? 7 : third);
        tone({ type: 'sawtooth', f0: hz(K + root + iv + 12), dur: sd * 0.8, vol: s % 4 === 0 ? 0.05 : 0.032, lp: 2600, attack: 0.004, delay });
      }
      // ---- 銅管主旋律（L2 起；高潮時高八度加厚）----
      if (L >= 2) {
        let pos = 0;
        for (const [semi, len] of MELODY[bar]) {
          if (pos === s && semi !== null) {
            brass(hz(K + m(semi) + 12), sd * len, L >= 4 ? 1.2 : 1, delay, 0.3);
            if (L >= 4) brass(hz(K + m(semi) + 24), sd * len, 0.5, delay, 0.3);
          }
          pos += len;
        }
      }
      // ---- 法國號對位（L3 起）----
      if (L >= 3 && (s === 0 || s === 8)) brass(hz(K + root + third), sd * 7, 0.55, delay, 0.3);
      // ---- 打擊樂 ----
      if (s === 0 || (L >= 1 && s === 8)) boom(L >= 3 ? 1 : 0.7, delay, 0.25);
      if (L >= 1 && (s === 4 || s === 12)) { noise({ f0: 1900, q: 0.8, dur: 0.14, vol: 0.32, delay }); tone({ type: 'triangle', f0: 190, f1: 160, dur: 0.08, vol: 0.2, delay }); }
      if (L >= 2 && s % 2 === 0) noise({ ft: 'highpass', f0: 8000, dur: 0.03, vol: s % 4 === 2 ? 0.07 : 0.035, delay });
      if (L >= 3 && bar === 7 && s >= 8) noise({ f0: 1900, q: 0.8, dur: 0.1, vol: 0.12 + (s - 8) * 0.03, delay });   // 小鼓滾奏
      if (L >= 3 && bar === 0 && s === 0) noise({ ft: 'highpass', f0: 5000, dur: 1.6, vol: 0.2, rev: 0.4, delay });  // 銅鈸
      mStep++; mNext += sd;
    }
  }
  function setSfxVol(v) {
    st.sfxVol = clamp(v, 0, 1); save();
    if (ac) { glide(worldBus.gain, sfxGainOf(st.sfxVol), 0.08); glide(playerBus.gain, sfxGainOf(st.sfxVol), 0.08); }
  }
  function setMusicVol(v) {
    st.musicVol = clamp(v, 0, 1); save();
    if (ac) glide(musicBus.gain, musicGainOf(st.musicVol), 0.08);
  }
  const setSfx = on => setSfxVol(on ? 0.8 : 0);       // 舊介面相容
  // ---------- 自訂背景音樂（檔案只存在玩家自己的裝置上）----------
  function decode(arr) {
    return new Promise((res, rej) => {
      try { const pr = ac.decodeAudioData(arr, res, rej); if (pr && pr.then) pr.then(res, rej); } catch (err) { rej(err); }
    });
  }
  function startCustom() {
    stopCustom();
    if (!custom || !ac) return;
    customSrc = ac.createBufferSource();
    customSrc.buffer = custom; customSrc.loop = true;          // 無縫循環
    customSrc.playbackRate.value = slow ? 0.8 : 1;
    customSrc.connect(customGain);
    const me = customSrc;
    me.onended = () => { if (customSrc === me) { try { me.disconnect(); } catch (err) { /* 略過 */ } customSrc = null; } };   // 下一幀 music() 會重新播放
    customSrc.start();
  }
  function stopCustom() {
    if (!customSrc) return;
    try { customSrc.stop(); } catch (err) { /* 已停止 */ }
    customSrc.disconnect(); customSrc = null;
  }
  async function setCustom(arrayBuffer, name) {
    unlock();
    if (!ac) throw new Error('no audio');
    const buf = await decode(arrayBuffer.slice(0));
    custom = buf; customName = name || '自訂音樂';
    lastTarget = -1;
    startCustom();
    return buf.duration;
  }
  function clearCustom() { stopCustom(); custom = null; customName = ''; mNext = 0; }
  // 自訂音樂：開始遊戲後就一直播放（暫停、背包、過關畫面也不中斷）
  let lastTarget = -1;
  function musicActive(on) {
    if (!ac || !customGain) return;
    const target = on && custom ? 0.55 : 0;
    if (target === lastTarget) return;                 // 只在狀態改變時排程，避免每幀堆積自動化事件
    lastTarget = target;
    glide(customGain.gain, target, 0.6);
  }
  const setMusic = on => setMusicVol(on ? 0.8 : 0);   // 舊介面相容
  function suspend() { if (ac && ac.state === 'running') { try { ac.suspend(); } catch (err) { /* 略過 */ } } }
  return { unlock, play, setSlow, music, musicReset, setSfx, setMusic, setSfxVol, setMusicVol, suspend, duck, st, get ctx() { return ac; },
           setCustom, clearCustom, musicActive, get customName() { return customName; },
           get musicInfo() { return { phrase, level: barLevel, keyUp: phraseKey }; },
           get started() { return !!ac; }, get running() { return ready(); }, get voices() { return voices.length; } };
})();
// 連線時：房主把隊友聽得到的世界音效轉播過去
{
  const play0 = Sfx.play;
  Sfx.play = (name, o) => {
    if (NET.on && o && !o.player && o.x !== undefined && netCapOK(o.x, o.y)) netCap(['s', name, r1(o.x), r1(o.y), o.big ? 1 : 0, o.pitch || 0, o.heavy ? 1 : 0]);
    play0(name, o);
  };
}
// iPad 解鎖音效：任何一次點擊或觸控結束時都嘗試啟動
document.addEventListener('touchend', () => Sfx.unlock(), { passive: true });
document.addEventListener('click', () => Sfx.unlock());

/* =========================================================
 * 9. 主角邏輯
 * ========================================================= */
function newInventory() {
  return { melee: [{ uid: 1, kind: 'weapon', base: 'traveler', rarity: 'common', affixes: [] }], bows: [], meleeEq: 1, bowEq: null,
    arrows: 0, ultimate: false, ultMax: 180, vacuum: false, vacMax: 180, nextUid: 1 };
}
function makePlayer() {
  return {
    x: SPAWN.x, y: SPAWN.y, r: PC.radius, hp: PC.startHp, maxHp: PC.startHp,
    stamina: PC.maxStamina, regenWait: 0, facing: 0, kx: 0, ky: 0,
    attackT: 0, attackCD: 0, attackQueue: 0, swingDir: 0, attackHit: new Set(),
    dodgeT: 0, dodgeCD: 0, dodgeDir: 0, dodgeStartT: -99, dodgeSX: 0, dodgeSY: 0, trail: [],
    shieldUp: false, shieldT: 0, aiming: false, aimT: 0,
    invuln: 0, hurtFlash: 0, staminaFlash: 0, dead: false,
  };
}
function resetPlayerTransient(p) {
  p.x = SPAWN.x; p.y = SPAWN.y; p.kx = p.ky = 0; p.facing = 0;
  p.attackT = p.attackCD = p.attackQueue = 0; p.dodgeT = p.dodgeCD = 0; p.dodgeStartT = -99;
  p.trail = []; p.shieldUp = false; p.aiming = false; p.invuln = 0; p.hurtFlash = 0; p.staminaFlash = 0;
  p.dead = false; p.hp = p.maxHp; p.stamina = PC.maxStamina;
}

// 舉盾時自動面向「最有威脅」的對象：正在蓄力的敵人、飛來的箭、最近的敵人
function shieldFocus(p) {
  let best = null, bd = Infinity;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    const range = e.state === 'windup' ? (e.t.ranged ? 520 : e.t.reach + 90) : (e.t.ranged ? 0 : 170);
    if (d <= range && d < bd) { bd = d; best = e; }
  }
  for (const a of arrows) {
    if (a.owner !== 'enemy') continue;
    const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
    if (d < 260 && d < bd && dx * a.vx + dy * a.vy > 0) { bd = d; best = a; }
  }
  return best;
}

function updatePlayer(dt) {
  const p = player;
  for (let i = p.trail.length - 1; i >= 0; i--) { p.trail[i].life -= dt; if (p.trail[i].life <= 0) p.trail.splice(i, 1); }
  if (p.dead) return;
  p.rageT = Math.max(0, (p.rageT || 0) - dt);
  p.riftCD = Math.max(0, (p.riftCD || 0) - dt);
  if (game.ult) { updateUltimate(dt); return; }           // 無影斬進行中：全自動
  if (input.ultPressed) { tryUltimate(); if (game.ult) return; }
  if (input.vacPressed) tryVacuum();
  p.attackCD -= dt; p.dodgeCD -= dt; p.invuln -= dt; p.hurtFlash -= dt;
  p.regenWait -= dt; p.attackQueue -= dt; p.staminaFlash -= dt;
  const mag = input.mag, dirX = input.dirX, dirY = input.dirY;
  const W = curW();
  const F = game.flurry;
  // 剛來到燼野時刀還收著：怪物出現在畫面上，或先按了攻擊，就拔刀
  if (p.sheathed) {
    const seen = enemies.some(e => !e.dead && Math.abs(e.x - cam.x - VW / 2) < VW / 2 - 10 && Math.abs(e.y - cam.y - VH / 2) < VH / 2 - 10);
    if ((seen && game.time >= (p.drawAfter || 0)) || input.attackPressed) drawKnife(seen && !input.attackPressed);
  }

  if (input.attackPressed) p.attackQueue = 0.18;     // 攻擊輸入緩衝

  // ---- 閃避 ----
  if (input.dodgePressed && p.dodgeT <= 0 && p.dodgeCD <= 0) {
    if (p.stamina >= PC.dodgeCost) {
      p.stamina -= PC.dodgeCost; p.regenWait = PC.regenDelay;
      p.dodgeT = PC.dodgeTime;
      p.dodgeDir = mag > 0 ? Math.atan2(dirY, dirX) : p.facing;
      p.facing = p.dodgeDir;
      p.dodgeStartT = game.time; p.dodgeSX = p.x; p.dodgeSY = p.y;   // 記錄閃避起點與時間（迅影時刻判定用）
      p.attackT = 0; p.attackQueue = 0; p.aiming = false;
      burst(p.x, p.y + 10, 8, 'rgba(230,220,190,1)', 40, 120, 0.4, 4, 'smoke');
      Sfx.play('dodge', { player: true });
    } else {
      p.staminaFlash = 0.6;
      addText(p.x, p.y - 34, '體力不足', '#ffd166', 16);
      Sfx.play('denied', { player: true });
    }
  }

  // ---- 攻擊 ----
  if (F) {
    // 迅影時刻：每按一次攻擊就衝過去砍一刀，最多三刀
    if (p.attackQueue > 0 && p.attackT <= 0 && F.hits < PC.flurryHits && p.dodgeT <= 0) { p.attackQueue = 0; flurrySlash(); }
  } else if (p.attackQueue > 0 && p.attackCD <= 0 && p.dodgeT <= 0) {
    p.attackQueue = 0; p.aiming = false;
    if (mag < 0.25) { const t = nearestEnemy(p.x, p.y, 120); if (t) p.facing = Math.atan2(t.y - p.y, t.x - p.x); }
    else p.facing = Math.atan2(dirY, dirX);
    p.swingDir = p.facing; p.attackT = PC.attackActive; p.attackCD = W.cd; p.attackHit.clear();
    Sfx.play('swing', { player: true, heavy: W.cd > 0.5 });   // 重武器的破風聲較低沉、較長
  }
  if (p.attackT > 0) { resolveAttackHits(); p.attackT -= dt; }

  // ---- 射箭：按住瞄準（虛線），放開射出 ----
  if (input.shootPressed && !inv.bowEq) { addText(p.x, p.y - 34, '還沒有弓', '#ffd166', 16); Sfx.play('denied', { player: true }); }
  if (inv.bowEq && p.dodgeT <= 0 && p.attackT <= 0 && !p.aiming) {
    // 剛按下時先自動對準最近的怪物；之後拖曳射箭鈕上的小圓點就能自由改方向
    // 畫面內有敵人 → 對準離自己最近的那一隻；沒有 → 維持目前面對的方向
    const autoAim = () => { const t = nearestOnScreen(p); if (t) p.facing = Math.atan2(t.y - p.y, t.x - p.x); };
    if (input.shootHeld) {
      p.aiming = true; p.aimT = 0;
      Sfx.play('bowDraw', { player: true });
      if (aimStick.engaged) p.facing = Math.atan2(aimStick.dy, aimStick.dx);
      else autoAim();
    } else if (input.shootPressed) {
      // 同一幀內按下又放開的快速點擊：自動瞄準後直接射出
      if (aimStick.engaged) p.facing = Math.atan2(aimStick.dy, aimStick.dx); else autoAim();
      fireArrow();
    }
  }
  const stickAiming = p.aiming && BTN.shoot.touches.size > 0;     // 用觸控瞄準時，移動搖桿不會改變瞄準方向
  if (p.aiming) {
    p.aimT += dt;
    if (aimStick.engaged) p.facing = Math.atan2(aimStick.dy, aimStick.dx);
    else if (stickAiming) { const t = nearestOnScreen(p); if (t) p.facing = Math.atan2(t.y - p.y, t.x - p.x); }   // 還沒拖曳：持續鎖定最近的敵人
    if (!input.shootHeld) { p.aiming = false; fireArrow(); }
  }

  // ---- 舉盾 ----
  const wantShield = input.shieldHeld && p.dodgeT <= 0 && p.attackT <= 0 && !p.aiming;
  if (wantShield && !p.shieldUp) { p.shieldT = 0; Sfx.play('shieldUp', { player: true }); }   // 剛舉起盾的瞬間開始計時（完美格擋用）
  p.shieldUp = wantShield;
  let lockedFacing = false;
  if (p.shieldUp) {
    p.shieldT += dt;
    const t = shieldFocus(p);
    if (t) { p.facing = Math.atan2(t.y - p.y, t.x - p.x); lockedFacing = true; }
  }

  // ---- 移動 ----
  let mx = 0, my = 0;
  if (p.dodgeT > 0) {
    p.dodgeT -= dt;
    mx = Math.cos(p.dodgeDir) * PC.dodgeSpeed * dt;
    my = Math.sin(p.dodgeDir) * PC.dodgeSpeed * dt;
    p.trail.push({ x: p.x, y: p.y, life: 0.22 });
    if (p.dodgeT <= 0) p.dodgeCD = PC.dodgeCooldown;
  } else if (mag > 0) {
    let sp = PC.speed * mag;
    if (p.shieldUp) sp *= PC.shieldSpeedMul;
    if (p.aiming) sp *= PC.aimSpeedMul;
    if (p.attackT > 0) sp *= 0.45;
    mx = dirX * sp * dt; my = dirY * sp * dt;
    if (!lockedFacing && p.attackT <= 0 && !stickAiming) p.facing = Math.atan2(dirY, dirX);   // 觸控瞄準中由射箭搖桿決定方向（鍵盤則沿用移動方向）
  }
  // 地形：流沙變慢、薄冰打滑、熔岩燙傷、裂隙傳送
  let terrainH;
  [mx, my, terrainH] = applyTerrain(p, mx, my, dt, p.r);
  if (terrainH && terrainH.kind === 'lava' && p.dodgeT <= 0 && p.invuln <= 0) {
    if (damagePlayer(Math.max(1, Math.round(p.maxHp * 0.2)), terrainH.x, terrainH.y, 'fire')) addText(p.x, p.y - 50, '好燙！', '#ff8c42', 18);
  }
  if (tryRift(p, terrainH, p.r)) snapCamera();
  mx += p.kx * dt; my += p.ky * dt;
  const kd = Math.exp(-9 * dt); p.kx *= kd; p.ky *= kd;
  const preX = p.x, preY = p.y;
  moveEntity(p, mx, my, p.r);
  const moved = Math.hypot(p.x - preX, p.y - preY);
  p.walkDist = (p.walkDist || 0) + moved; p.moveSpeed = dt > 0 ? moved / dt : 0;   // 走路動畫依實際移動距離換格
  if (F) p.trail.push({ x: p.x, y: p.y, life: 0.12 });

  // ---- 體力回復 ----
  if (p.regenWait <= 0 && p.dodgeT <= 0) p.stamina = Math.min(PC.maxStamina, p.stamina + PC.staminaRegen * (p.shieldUp ? 0.5 : 1) * dt);

  // ---- 燃燒草叢 ----
  const c = checkFireContact(p, p.r - 2);
  if (c) damagePlayer(1, c.gx * CELL + CELL / 2, c.gy * CELL + CELL / 2, 'fire');
}

function fireArrow() {
  const p = player, B = curB();
  if (!B) return;
  if (inv.arrows <= 0) { addText(p.x, p.y - 34, '沒有箭矢', '#ffd166', 16); Sfx.play('denied', { player: true }); return; }
  if (B.fx.has('thrifty') && Math.random() < 0.35) addText(p.x, p.y - 40, '回收！', '#ffd666', 14);   // 不消耗箭矢
  else inv.arrows--;
  Sfx.play('bowShot', { player: true });
  const spreads = B.fx.has('triple') ? [-0.14, 0, 0.14] : [0];
  for (const s of spreads) {
    const a = p.facing + s;
    if (netGuest()) { netAct({ a: 'shoot', x: r1(p.x + Math.cos(a) * (p.r + 4)), y: r1(p.y + Math.sin(a) * (p.r + 4)), ang: r3(a), sp: B.speed, dmg: B.atk, fx: [...B.fx].filter(f => f !== 'vamp' && f !== 'thrifty') }); continue; }
    spawnArrow(p.x + Math.cos(a) * (p.r + 4), p.y + Math.sin(a) * (p.r + 4), a, B.speed, B.atk, 'player', null);
    const ar = arrows[arrows.length - 1];
    ar.fire = B.fx.has('fire'); ar.pierce = B.fx.has('pierce'); ar.fx = B.fx;
  }
  p.kx -= Math.cos(p.facing) * 60; p.ky -= Math.sin(p.facing) * 60;
}
function spawnArrow(x, y, a, speed, dmg, owner, special) {
  arrows.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, dmg, owner,
    fire: special === 'fire', pierce: special === 'pierce', hit: null, life: owner === 'player' ? 1.4 : 2.4 });
}

/* =========================================================
 * 10. 戰鬥：揮劍判定、傷害、迅影時刻
 * ========================================================= */
const SCR_ATK = [];
function resolveAttackHits() {
  const p = player, W = curW(), reach = W.range, half = PC.attackHalfArc;
  const src = game.flurry ? 'flurry' : 'sword';
  for (const e of enemies) {
    if (e.dead || p.attackHit.has(e)) continue;
    const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
    if (d > reach + e.rad * 0.7) continue;
    const a = Math.atan2(dy, dx);
    if (d >= p.r + e.rad + 6 && Math.abs(angleDiff(a, p.swingDir)) > half) continue;
    p.attackHit.add(e);
    burst(p.x + dx * 0.6, p.y + dy * 0.6, 6, '#ffffff', 80, 220, 0.25, 3);
    (netGuest() ? netHit : damageEnemy)(e, W.atk * (e.state === 'stunned' ? 2 : 1) * rollCrit(W.fx, e), src, a);   // 暈眩中傷害加倍
    applyHitFx(e, W.fx, W.atk);
  }
  // 火爆石與木箱
  const near = solidsInBox(p.x - reach, p.y - reach, p.x + reach, p.y + reach, SCR_ATK).slice();
  for (const s of near) {
    if ((s.kind !== 'stone' && s.kind !== 'crate') || p.attackHit.has(s)) continue;
    const nx = clamp(p.x, s.x, s.x + s.w), ny = clamp(p.y, s.y, s.y + s.h);
    const dx = nx - p.x, dy = ny - p.y, d = Math.hypot(dx, dy);
    if (d > reach) continue;
    if (Math.abs(angleDiff(Math.atan2(dy, dx), p.swingDir)) > half) continue;
    p.attackHit.add(s);
    if (s.kind === 'stone') hitStone(s, nx, ny); else breakCrate(s);
  }
  // 砍草
  const gx0 = Math.floor((p.x - reach) / CELL), gx1 = Math.floor((p.x + reach) / CELL);
  const gy0 = Math.floor((p.y - reach) / CELL), gy1 = Math.floor((p.y + reach) / CELL);
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const c = grass.get(gk(gx, gy));
      if (!c || c.state !== 'grass') continue;
      const cx = gx * CELL + CELL / 2, cy = gy * CELL + CELL / 2, d = Math.hypot(cx - p.x, cy - p.y);
      if (d > reach + 6) continue;
      if (d > p.r + 10 && Math.abs(angleDiff(Math.atan2(cy - p.y, cx - p.x), p.swingDir)) > half) continue;
      cutGrass(c, cx, cy);
    }
  }
}
function cutGrass(c, cx, cy) {
  grass.delete(c.key);
  Sfx.play('grass', { x: cx, y: cy });
  burst(cx, cy, 6, game.theme.grass[2], 40, 150, 0.6, 4, 'leaf');
  if (NET.on) {
    if (netGuest()) { netAct({ a: 'cut', x: c.gx, y: c.gy }); return; }
    netWorld({ k: 'c', x: c.gx, y: c.gy, s: 0 });
  }
  const r = Math.random();
  if (r < 0.04 && player.hp < player.maxHp) dropFood(cx, cy, false);
  else if (r < 0.08) dropArrows(cx, cy, 1);
}
function hitStone(s, hx, hy) {
  s.flash = 0.18; flashingStones.add(s);
  Sfx.play('stone', { x: hx, y: hy });
  game.shake = Math.max(game.shake, 4);
  burst(hx, hy, 8, '#fff2c4', 60, 200, 0.25, 3);
  if (netGuest()) netAct({ a: 'stone', x: s.x + s.w / 2, y: s.y + s.h / 2 });
  emitSparks(s);
}
function breakCrate(s) {
  if (s.broken) return;
  s.broken = true;
  removeSolid(s);
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  burst(cx, cy, 14, '#b07a3e', 60, 220, 0.6, 5, 'leaf');
  Sfx.play('crate', { x: cx, y: cy });
  game.shake = Math.max(game.shake, 3);
  if (NET.on) {
    if (netGuest()) { netAct({ a: 'crate', x: cx, y: cy }); return; }
    netWorld({ k: 'cr', x: cx, y: cy });
  }
  if (Math.random() < 0.5) dropFood(cx, cy, Math.random() < 0.3);
  else dropArrows(cx, cy, 3 + Math.floor(Math.random() * 3));
  showHint('crate', '木箱裡有食物或箭矢，走過去就能撿起來', 5);
}

function damagePlayer(amount, sx, sy, src) {
  const p = player;
  if (game.mode !== 'play' || p.dead || game.flurry || game.ult) return false;
  if (p.dodgeT > 0 || p.invuln > 0) return false;
  if (p.sheathed) drawKnife(false);                 // 被打到了當然也要拔刀
  p.hp = Math.max(0, p.hp - amount);
  p.invuln = PC.hurtInvuln; p.hurtFlash = 0.25; p.aiming = false;
  const a = Math.atan2(p.y - sy, p.x - sx);
  p.kx = Math.cos(a) * 320; p.ky = Math.sin(a) * 320;
  game.shake = Math.max(game.shake, 7);
  Sfx.play('hurt', { player: true });
  addText(p.x, p.y - 30, '-' + amount, src === 'fire' ? '#ff8c42' : '#ff5a5a', 22);
  burst(p.x, p.y, 10, src === 'fire' ? '#ff8c42' : '#ff5a5a', 60, 200, 0.4, 3);
  if (p.hp <= 0) {
    p.dead = true; p.shieldUp = false; p.attackT = 0;
    burst(p.x, p.y, 30, '#7cc4ff', 60, 260, 0.9, 4);
    Sfx.play('gameOver', { player: true });
    if (NET.on) netLocalDown(); else endGame('lose');
  }
  return true;
}

function damageEnemy(e, amount, src, ang) {
  if (e.dead || e.dying) return;
  if (e.boss && e.phase === 2 && (src === 'arrow' || src === 'firearrow')) {      // 第二階段：弓箭打不動
    if (!(game.time - (e.immTextT || -9) < 0.6)) { addText(e.x, e.y - e.rad - 16, '弓箭無效！', '#cccccc', 15); e.immTextT = game.time; }   // 每次都提示（最多 0.6 秒一次）
    burst(e.x, e.y, 5, '#dddddd', 40, 140, 0.3, 2);
    return;
  }
  if (e.boss && e.invulnT > 0) { if (Math.random() < 0.3) addText(e.x, e.y - e.rad - 16, '無效', '#cccccc', 14); return; }
  if (src === 'fire' || src === 'burn') { if (e.fireInvuln > 0) return; e.fireInvuln = 0.9; }
  e.hp -= amount; e.hurtFlash = 0.14;
  Sfx.play(src === 'fire' || src === 'burn' ? 'burnHit' : (src === 'arrow' || src === 'firearrow') ? 'arrowHit' : 'hit', { x: e.x, y: e.y, big: src === 'flurry' || amount >= 8 });
  const color = src === 'fire' || src === 'burn' || src === 'firearrow' ? '#ff8c42' : src === 'flurry' ? '#9fe3ff' : '#ffffff';
  addText(e.x, e.y - e.rad - 12, '-' + amount, color, src === 'flurry' ? 24 : 18);
  const kbBase = src === 'burn' ? 0 : ({ sword: 300, arrow: 160, firearrow: 160, fire: 140, reflect: 220, flurry: 0, ult: 0 }[src] || 200);   // 燒傷不擊退
  e.kx += Math.cos(ang) * kbBase * e.t.knockResist; e.ky += Math.sin(ang) * kbBase * e.t.knockResist;
  if (e.hp <= 0) { const nc = NET.noCap; NET.noCap = false; killEnemy(e); NET.noCap = nc; return; }
  if (e.boss) return;                               // 大魔王有自己的行動，不會被打斷
  if (src === 'flurry' || src === 'ult' || src === 'burn' || e.state === 'stunned') return;     // 迅影時刻、無影斬與暈眩中不改變狀態
  if (e.t.armor && e.state === 'windup') return;            // 重甲蓄力時不會被打斷
  e.state = 'hurt'; e.stateT = e.t.armor ? 0.18 : 0.32;
}
function killEnemy(e) {
  if (e.boss) { bossDefeated(e); return; }
  e.dead = true;
  Sfx.play('kill', { x: e.x, y: e.y });
  burst(e.x, e.y, 24, e.t.colorChase, 60, 260, 0.7, 4);
  burst(e.x, e.y, 10, 'rgba(60,50,60,1)', 20, 80, 0.9, 7, 'smoke');
  game.shake = Math.max(game.shake, 5);
  dropLoot(e);
  if (game.mode === 'play') {
    lvl.kills++;
    game.runKills = (game.runKills || 0) + 1;          // 通關紀錄：總擊倒數
    if (lateActive() && lateEnemyKilled(e)) return;
    if (lvl.kills >= lvl.target) {
      if (!isBossLevel(lvl.n)) levelClear();
      else if (!lvl.bossSpawned) spawnBoss();      // 魔王關：小怪打完，大魔王現身
    }
  }
}




/* =========================================================
 * 地形特色：每種地形（苔原以外）都有自己的機關，對亞特和怪物都有效
 *   赤砂荒地：流沙坑（變慢＋被拉向中心）
 *   霜晶雪原：薄冰（打滑、停不下來）
 *   熔岩焦土：熔岩池（扣最大生命 20%，魔王 5%）
 *   虛空迷境：成對的虛空裂隙（走進一個從另一個出來）
 * ========================================================= */
const HAZARD_OF_THEME = [null, 'sand', 'ice', 'lava', 'rift'];
const HAZARD_HINT = {
  sand: '赤砂荒地有流沙坑：踩進去會變慢，還會被拉向中心，怪物也一樣',
  ice: '霜晶雪原有薄冰：踩上去會打滑停不下來，怪物也會滑',
  lava: '熔岩焦土有熔岩池：碰到會扣最大生命 20%，怪物也一樣，可以把牠們引進去！閃避的無敵時間可以衝過去',
  rift: '虛空迷境有成對的裂隙：走進一個會從另一個出來，怪物也會被傳送',
};
// ---- 不規則形狀：橢圓＋幾道起伏（星形輪廓），碰撞依實際形狀判斷 ----
function hzRadius(h, th) {
  const t = th - h.ang, A = h.base * h.stretch, B = h.base;
  let r = A * B / Math.hypot(B * Math.cos(t), A * Math.sin(t));
  for (const [k, a, ph] of h.harm) r *= 1 + a * Math.sin(k * t + ph);
  return r;
}
function hzContains(h, x, y, pad) {
  const dx = x - h.x, dy = y - h.y, d = Math.hypot(dx, dy);
  if (d > h.r + pad) return false;
  return d < hzRadius(h, Math.atan2(dy, dx)) + pad;
}
function makeShape(h) {                               // 預先算好輪廓點（畫圖用）
  h.pts = [];
  for (let i = 0; i < 56; i++) { const th = i / 56 * TAU, r = hzRadius(h, th); h.pts.push([h.x + Math.cos(th) * r, h.y + Math.sin(th) * r]); }
  h.r = Math.max(...h.pts.map(([px, py]) => Math.hypot(px - h.x, py - h.y)));
  return h;
}
// 矩形（岩石、木箱）是否碰到機關
function rectHitsHazard(h, s, pad) {
  if (s.x - pad > h.x + h.r || s.x + s.w + pad < h.x - h.r || s.y - pad > h.y + h.r || s.y + s.h + pad < h.y - h.r) return false;
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) if (hzContains(h, s.x + s.w * fx, s.y + s.h * fy, pad)) return true;
  return h.pts.some(([px, py]) => px > s.x - pad && px < s.x + s.w + pad && py > s.y - pad && py < s.y + s.h + pad);
}
// 在區塊裡放置地形機關（數量為舊版的一半；在岩石之前放，岩石會避開它們的實際形狀）
function placeHazards(ch, R, home) {
  ch.hazards = [];
  const kind = HAZARD_OF_THEME[(lvl.n - 1) % THEMES.length];
  if (!kind) return;
  const want = kind === 'rift' ? (R() < 0.22 ? 2 : 0)
    : kind === 'lava' ? (R() < 0.6 ? 1 : 0) + (R() < 0.15 ? 1 : 0)
    : (R() < 0.5 ? 1 : 0);
  for (let k = 0, tries = 0; k < want && tries < 30; tries++) {
    const h = { kind, x: 0, y: 0, ang: R() * TAU, seed: (R() * 1000) | 0, harm: [] };
    const H = (kk, amp) => h.harm.push([kk, amp, R() * TAU]);
    if (kind === 'ice') { h.base = 66 + R() * 34; h.stretch = 1.2 + R() * 0.5; H(2, 0.05 + R() * 0.05); H(3, 0.05 + R() * 0.04); H(5, 0.03); }       // 大片結冰池塘
    else if (kind === 'lava') { h.base = 24 + R() * 14; h.stretch = 1.6 + R() * 1.1; H(3, 0.08 + R() * 0.06); H(5, 0.06 + R() * 0.04); H(8, 0.035); }  // 長條熔岩流，邊緣崎嶇
    else if (kind === 'sand') { h.base = 40 + R() * 20; h.stretch = 1.1 + R() * 0.45; H(2, 0.06); H(3, 0.05 + R() * 0.05); H(4, 0.035); }       // 歪歪的流沙坑
    else { h.base = 24; h.stretch = 1; }                                                                                                         // 裂隙本身是圓形傳送門
    // 先用估計的最大半徑找位置，再算出真正的輪廓
    const est = h.base * h.stretch * 1.25 + 4;
    h.x = ch.x + est + 18 + R() * Math.max(1, CHUNK - 2 * est - 36);
    h.y = ch.y + est + 18 + R() * Math.max(1, CHUNK - 2 * est - 36);
    makeShape(h);
    if (h.x - h.r < ch.x + 16 || h.x + h.r > ch.x + CHUNK - 16 || h.y - h.r < ch.y + 16 || h.y + h.r > ch.y + CHUNK - 16) continue;
    if (hzContains(h, SPAWN.x, SPAWN.y, 230)) continue;                              // 出生點附近不放
    if (ch.solids.some(s => rectHitsHazard(h, s, 18))) continue;
    if (ch.hazards.some(o => Math.hypot(o.x - h.x, o.y - h.y) < o.r + h.r + (kind === 'rift' ? 200 : 30))) continue;
    if (kind === 'rift') {                                                           // 裂隙周圍的侵蝕痕跡（只是外觀）
      h.stain = { x: h.x, y: h.y, base: 40 + R() * 10, stretch: 1.2 + R() * 0.4, ang: R() * TAU, harm: [[3, 0.12, R() * TAU], [5, 0.08, R() * TAU]] };
      makeShape(h.stain);
    }
    ch.hazards.push(h); k++;
  }
  if (kind === 'rift') {
    if (ch.hazards.length === 2) { ch.hazards[0].pair = ch.hazards[1]; ch.hazards[1].pair = ch.hazards[0]; }
    else ch.hazards.length = 0;
  }
}
// 找出 (x,y) 所在的地形機關；pad＞0 表示「碰到邊緣就算」
function hazardAt(x, y, pad) {
  const c0x = Math.floor((x - 120) / CHUNK), c1x = Math.floor((x + 120) / CHUNK);
  const c0y = Math.floor((y - 120) / CHUNK), c1y = Math.floor((y + 120) / CHUNK);
  for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
    const ch = chunks.get(ck(cx, cy));
    if (!ch || !ch.hazards) continue;
    for (const h of ch.hazards) if (hzContains(h, x, y, pad)) return h;
  }
  return null;
}
// 依所在地形調整這一幀的移動量（亞特與怪物共用）
function applyTerrain(ent, mx, my, dt, rad) {
  const h = hazardAt(ent.x, ent.y, -rad * 0.2);
  ent.terrain = h ? h.kind : null;
  if (h && h.kind === 'sand') {                         // 流沙：變慢＋被拉向中心
    const d = Math.hypot(h.x - ent.x, h.y - ent.y) || 1;
    mx *= 0.45; my *= 0.45;
    mx += (h.x - ent.x) / d * 38 * dt; my += (h.y - ent.y) / d * 38 * dt;
    if (Math.random() < dt * 12) addParticle({ x: ent.x + rand(-10, 10), y: ent.y + rad * 0.6, vx: rand(-10, 10), vy: rand(-20, -5), life: 0.5, max: 0.5, size: 2, color: '#e8c98a', type: 'dot', rot: 0, vr: 0 });
  }
  // 薄冰：實際速度慢慢追上想走的速度（打滑），放開搖桿也會繼續滑
  const want = dt > 0 ? [mx / dt, my / dt] : [0, 0];
  if (h && h.kind === 'ice') {
    const k = 1 - Math.exp(-2.2 * dt);
    ent.slideVX = (ent.slideVX || 0) + (want[0] - (ent.slideVX || 0)) * k;
    ent.slideVY = (ent.slideVY || 0) + (want[1] - (ent.slideVY || 0)) * k;
    if (Math.hypot(want[0], want[1]) < 1) { const f = Math.exp(-0.7 * dt); ent.slideVX *= f; ent.slideVY *= f; }
    mx = ent.slideVX * dt; my = ent.slideVY * dt;
  } else { ent.slideVX = want[0]; ent.slideVY = want[1]; }
  return [mx, my, h];
}
// 虛空裂隙：走進一個，從另一個出來
function tryRift(ent, h, rad) {
  if (!h || h.kind !== 'rift' || !h.pair || (ent.riftCD || 0) > 0) return false;
  if (Math.hypot(ent.x - h.x, ent.y - h.y) > h.base * 0.65) return false;
  const out = h.pair, a = Math.atan2(ent.slideVY || 0.01, ent.slideVX || 1);
  burst(ent.x, ent.y, 14, '#b48cff', 40, 160, 0.5, 3);
  ent.x = out.x + Math.cos(a) * (out.base + rad + 6); ent.y = out.y + Math.sin(a) * (out.base + rad + 6);
  moveEntity(ent, 0, 0, rad);
  ent.riftCD = 1.2;
  burst(ent.x, ent.y, 14, '#ff7ad9', 40, 160, 0.5, 3);
  Sfx.play('rift', ent === player ? { player: true } : { x: ent.x, y: ent.y });
  return true;
}
// 依輪廓畫出（可縮放、往中心收）的形狀路徑
function hzPath(h, f, grow) {
  ctx.beginPath();
  h.pts.forEach(([px, py], i) => {
    const dx = px - h.x, dy = py - h.y, d = Math.hypot(dx, dy) || 1, k = f + (grow || 0) / d;
    const X = h.x + dx * k, Y = h.y + dy * k;
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
}
function drawHazards(v) {
  const t = game.time;
  const c0x = Math.floor(v.x0 / CHUNK), c1x = Math.floor(v.x1 / CHUNK), c0y = Math.floor(v.y0 / CHUNK), c1y = Math.floor(v.y1 / CHUNK);
  for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
    const ch = chunks.get(ck(cx, cy));
    if (!ch || !ch.hazards) continue;
    for (const h of ch.hazards) {
      const ext = h.stain ? h.stain.r : h.r;
      if (h.x + ext + 30 < v.x0 || h.x - ext - 30 > v.x1 || h.y + ext + 30 < v.y0 || h.y - ext - 30 > v.y1) continue;
      if (h.kind === 'sand') {
        // 流沙：和沙地同色系，外圍淡淡過渡、往中心越來越深
        ctx.fillStyle = 'rgba(150,110,55,0.22)'; hzPath(h, 1, 14); ctx.fill();
        ctx.fillStyle = 'rgba(150,110,55,0.3)'; hzPath(h, 1, 6); ctx.fill();
        ctx.fillStyle = '#c29455'; hzPath(h, 1, 0); ctx.fill();
        ctx.fillStyle = '#b3854a'; hzPath(h, 0.72, 0); ctx.fill();
        ctx.fillStyle = '#9f7440'; hzPath(h, 0.45, 0); ctx.fill();
        ctx.save(); hzPath(h, 1, 0); ctx.clip();
        ctx.translate(h.x, h.y); ctx.rotate(h.ang); ctx.scale(h.stretch, 1);
        ctx.strokeStyle = 'rgba(95,62,28,0.38)'; ctx.lineWidth = 2.2 / h.stretch * 1.4;
        for (let k = 1; k <= 4; k++) { const rot = t * (0.5 + k * 0.22) + k; ctx.beginPath(); ctx.arc(0, 0, h.base * k / 4.4, rot, rot + 4.0); ctx.stroke(); }
        ctx.restore();
        ctx.fillStyle = 'rgba(70,45,20,0.6)'; circle(h.x, h.y, 4); ctx.fill();
        ctx.fillStyle = 'rgba(120,90,55,0.8)';                     // 坑邊的小石子
        for (let k = 0; k < 7; k++) { const p = h.pts[(h.seed + k * 8) % h.pts.length]; circle(p[0] + ((h.seed * (k + 1)) % 7) - 3, p[1] + ((h.seed * (k + 2)) % 7) - 3, 1.8); ctx.fill(); }
      } else if (h.kind === 'ice') {
        // 結冰池塘：外緣一圈積雪過渡到雪地
        ctx.fillStyle = 'rgba(255,255,255,0.75)'; hzPath(h, 1, 10); ctx.fill();
        ctx.fillStyle = '#f6fafc'; hzPath(h, 1, 4); ctx.fill();
        const g = ctx.createLinearGradient(h.x - h.r, h.y - h.r, h.x + h.r, h.y + h.r);
        g.addColorStop(0, '#d8eef8'); g.addColorStop(1, '#a8d2e8');
        ctx.fillStyle = g; hzPath(h, 1, 0); ctx.fill();
        ctx.fillStyle = 'rgba(110,170,205,0.3)'; hzPath(h, 0.55, 0); ctx.fill();
        ctx.save(); hzPath(h, 1, 0); ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 4;                 // 反光
        for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(h.x - h.r + k * 40, h.y + h.r * 0.2 + k * 30); ctx.lineTo(h.x - h.r * 0.2 + k * 40, h.y - h.r * 0.6 + k * 30); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(110,165,200,0.65)'; ctx.lineWidth = 1.4;              // 冰裂紋
        for (let k = 0; k < 6; k++) {
          const a = h.seed * 0.37 + k * 1.1, L = h.base * (0.5 + ((h.seed + k * 13) % 10) / 20);
          ctx.beginPath(); ctx.moveTo(h.x + Math.cos(a) * 8, h.y + Math.sin(a) * 8);
          ctx.lineTo(h.x + Math.cos(a + 0.25) * L * 0.5, h.y + Math.sin(a + 0.25) * L * 0.5); ctx.lineTo(h.x + Math.cos(a - 0.1) * L, h.y + Math.sin(a - 0.1) * L); ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = 'rgba(140,190,215,0.8)'; ctx.lineWidth = 1.5; hzPath(h, 1, 0); ctx.stroke();
      } else if (h.kind === 'lava') {
        // 熔岩流：燒焦的地面 → 黑色岩殼 → 發光的岩漿
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,100,30,${0.12 + 0.05 * Math.sin(t * 3 + h.seed)})`; hzPath(h, 1, 22); ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgba(25,12,8,0.55)'; hzPath(h, 1, 12); ctx.fill();
        ctx.fillStyle = '#2a120a'; hzPath(h, 1, 5); ctx.fill();
        ctx.fillStyle = '#c4320e'; hzPath(h, 1, 0); ctx.fill();
        ctx.fillStyle = '#ff6a1c'; hzPath(h, 0.75, 0); ctx.fill();
        ctx.fillStyle = `rgba(255,${(200 + 30 * Math.sin(t * 2 + h.seed)) | 0},110,0.95)`; hzPath(h, 0.42, 0); ctx.fill();
        ctx.save(); hzPath(h, 1, 0); ctx.clip();
        ctx.fillStyle = 'rgba(40,16,8,0.75)';                                          // 漂浮的冷卻岩塊
        for (let k = 0; k < 3; k++) {
          const ph = (t * 0.08 + k * 0.33 + h.seed * 0.001) % 1, a = h.ang + (k - 1) * 0.35;
          const along = (ph - 0.5) * 2 * h.base * h.stretch * 0.8;
          circle(h.x + Math.cos(h.ang) * along + Math.cos(a + 1.57) * (k - 1) * 8, h.y + Math.sin(h.ang) * along + Math.sin(a + 1.57) * (k - 1) * 8, 3 + (k % 2) * 2); ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,240,180,0.85)';                                     // 冒泡
        for (let k = 0; k < 4; k++) {
          const ph = (t * 0.7 + k * 0.27 + h.seed * 0.01) % 1, along = ((h.seed * (k + 3)) % 100 / 100 - 0.5) * h.base * h.stretch;
          ctx.globalAlpha = 1 - ph; circle(h.x + Math.cos(h.ang) * along, h.y + Math.sin(h.ang) * along, 2 + ph * 4); ctx.fill(); ctx.globalAlpha = 1;
        }
        ctx.restore();
      } else if (h.kind === 'rift') {
        // 裂隙周圍的紫黑色侵蝕痕跡，讓傳送門融進虛空地面
        ctx.fillStyle = 'rgba(30,14,55,0.45)'; hzPath(h.stain, 1, 8); ctx.fill();
        ctx.fillStyle = 'rgba(55,25,95,0.5)'; hzPath(h.stain, 1, 0); ctx.fill();
        ctx.fillStyle = 'rgba(90,45,150,0.35)'; hzPath(h.stain, 0.6, 0); ctx.fill();
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(180,140,255,0.18)'; circle(h.x, h.y, h.base + 16); ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#0a0612'; circle(h.x, h.y, h.base * 0.75); ctx.fill();
        for (let k = 0; k < 3; k++) {
          ctx.strokeStyle = k % 2 ? '#ff7ad9' : '#b48cff'; ctx.lineWidth = 3;
          const rot = t * (2 + k * 0.6) * (k % 2 ? -1 : 1) + k * 2;
          ctx.beginPath(); ctx.arc(h.x, h.y, h.base * (0.5 + k * 0.22), rot, rot + 3.6); ctx.stroke();
        }
        ctx.fillStyle = '#ffffff'; circle(h.x, h.y, 2.5); ctx.fill();
      }
    }
  }
}

/* =========================================================
 * 大魔王：虛淵領主（第 5、10、15… 關出現）
 *   先擊倒一半的小怪 → 大魔王現身 → 擊敗牠才算過關
 *   招式都有預警，也都能用閃避／格擋／迅影時刻破解
 * ========================================================= */
const BOSS_TIERS = [
  { name: '虛淵領主',     accent: '#9a6bff', reward: { kind: 'weapon', id: 'abyssBlade' } },
  { name: '狂暴虛淵領主', accent: '#ff4f6a', reward: { kind: 'bow', id: 'abyssStarBow' } },
  { name: '遠古虛淵領主', accent: '#ffc94f', reward: { kind: 'weapon', id: 'ancientAbyssSword' } },
];
function makeBossType(n) {
  const tier = Math.max(1, Math.floor(n / 5));
  const d = BOSS_TIERS[Math.min(tier, BOSS_TIERS.length) - 1];
  return {
    role: 'boss', name: tier > BOSS_TIERS.length ? '深淵' + BOSS_TIERS[0].name : d.name, data: d, tier,
    size: 92, hp: Math.round(960 * (1 + 0.9 * (tier - 1)) * (NET.on ? 1.3 : 1)), speed: 62 * (1 + 0.08 * (tier - 1)),   // 血量 960 / 1824 / 2688
    damage: 2 + tier, orbDmg: 1 + Math.floor(tier / 2), orbSpeed: 170 + 20 * tier,
    armor: true, knockResist: 0.05, ranged: false, reach: 0, sight: 99999, lose: 99999,
    colorPatrol: d.accent, colorChase: d.accent, shape: 'circle', elite: 0, drop: null,
  };
}
const bossAlive = () => enemies.find(e => e.boss && !e.dead);
function spawnBoss() {
  lvl.bossSpawned = true;
  let T = makeBossType(lvl.n);
  if (lateActive() && lvl.n === 19) T = Object.assign({}, T, {name:'熔岩督軍',hp:Math.round(T.hp * .3),damage:4,orbDmg:2,data:Object.assign({},T.data,{accent:'#ff8a3d'})});
  const p = player;
  let x = p.x + 380, y = p.y;
  for (let k = 0; k < 24; k++) {
    const a = Math.random() * TAU, d = rand(340, 420);
    const tx = p.x + Math.cos(a) * d, ty = p.y + Math.sin(a) * d;
    ensureChunks(tx, ty, 120);
    if (!solidsInBox(tx - 60, ty - 60, tx + 60, ty + 60, []).some(s => circleRectOverlap(tx, ty, T.size / 2 + 10, s)) && !hazardAt(tx, ty, T.size / 2 + 10)) { x = tx; y = ty; break; }
  }
  const e = makeEnemy(T, x, y);
  Object.assign(e, { boss: true, state: 'intro', stateT: 1.8, invulnT: 1.8, phase: 1, atkCD: 2.8, summonCD: 6, slamR: 125, windMax: 1 });
  enemies.push(e);
  game.banner = { title: lateActive() && lvl.n === 19 ? '熔岩督軍出現！' : '大魔王出現！', sub: T.name, t: 3 };
  game.shake = Math.max(game.shake, 8); game.flash = 0.4;
  Sfx.play('bossWarn', { player: true }); Sfx.play('bossRoar', { player: true });
  showHint('boss', '紅圈震地要跑出圈外或閃避；直線突進可用盾完美格擋讓牠暈眩；紫色光彈可以用盾反彈', 9);
}
function chooseBossSkill(e, d) {
  const opts = ['dash', 'orbs'];
  if (d < 170) opts.push('slam', 'slam');
  else opts.push('dash');
  if (e.phase === 2 && e.summonCD <= 0 && enemies.filter(x => !x.dead && !x.boss).length < 3) opts.push('summon', 'summon');
  const pick = opts[(Math.random() * opts.length) | 0], p2 = e.phase === 2;
  if (pick === 'slam') { e.state = 'slamWind'; e.stateT = p2 ? 0.75 : 0.95; Sfx.play('bossWarn', { x: e.x, y: e.y }); }
  if (pick === 'dash') { e.state = 'dashWind'; e.stateT = p2 ? 0.6 : 0.8; }
  if (pick === 'orbs') { e.state = 'orbWind'; e.stateT = 0.7; }
  if (pick === 'summon') { e.state = 'summonWind'; e.stateT = 0.9; e.summonCD = 14; }
  e.windMax = e.stateT;
  e.atkCD = e.stateT + (p2 ? 1.1 : 1.7);
}
function bossSlam(e) {
  const p = player, R = e.slamR;
  e.state = 'recover'; e.stateT = 0.8;
  game.shake = Math.max(game.shake, 10);
  Sfx.play('bossSlam', { x: e.x, y: e.y });
  ring(e.x, e.y, e.t.data.accent, 20); ring(e.x, e.y, '#ff5a6a', 50);
  burst(e.x, e.y + 10, 30, e.t.data.accent, 80, 320, 0.6, 4);
  if (netHostOn() && netMateAlive()) netWorld({ k: 'bs', id: e.nid, x: r1(e.x), y: r1(e.y), r: R, d: e.t.damage });   // 震地也會打到隊友
  if (game.mode !== 'play' || p.dead) return;
  const since = game.time - p.dodgeStartT;     // 重擊前一刻閃避 → 迅影時刻
  if (!game.flurry && since >= 0 && since <= PC.perfectDodgeWindow && Math.hypot(p.dodgeSX - e.x, p.dodgeSY - e.y) <= R + 30) { startFlurry(e); return; }
  const d = Math.hypot(p.x - e.x, p.y - e.y);
  if (d > R + p.r) return;
  if (p.dodgeT > 0) { addText(p.x, p.y - 34, '閃過！', '#9fd8ff', 16); return; }
  if (damagePlayer(e.t.damage, e.x, e.y, 'enemy')) { p.kx += (p.x - e.x) / (d || 1) * 300; p.ky += (p.y - e.y) / (d || 1) * 300; }
}
function bossContact(e) {                        // 突進撞到亞特
  const p = player, ang = Math.atan2(e.y - p.y, e.x - p.x);
  if (p.dodgeT > 0 || game.flurry || game.ult || p.dead) return;
  if (p.shieldUp && Math.abs(angleDiff(p.facing, ang)) <= PC.shieldHalfArc) {
    if (p.shieldT <= PC.perfectWindow + 0.08) { perfectParry(e); e.stateT = 2.6; e.kx *= 0.3; e.ky *= 0.3; return; }
    if (p.stamina >= 30) {
      p.stamina -= 30; p.regenWait = PC.regenDelay;
      p.kx -= Math.cos(ang) * 380; p.ky -= Math.sin(ang) * 380;
      addText(p.x, p.y - 34, '格擋', '#bdf3ff', 16); Sfx.play('block', { player: true });
      e.state = 'recover'; e.stateT = 0.7;
      return;
    }
    p.stamina = 0; p.staminaFlash = 0.8; addText(p.x, p.y - 50, '破防！', '#ffd166', 18);
  }
  if (damagePlayer(e.t.damage, e.x, e.y, 'enemy')) { p.kx -= Math.cos(ang) * 260; p.ky -= Math.sin(ang) * 260; }
}
function bossOrbs(e, offset) {
  const n = e.phase === 2 ? 16 : 12;
  for (let i = 0; i < n; i++) {
    const a = (i + offset) / n * TAU;
    spawnArrow(e.x + Math.cos(a) * (e.rad + 6), e.y + Math.sin(a) * (e.rad + 6), a, e.t.orbSpeed, e.t.orbDmg, 'enemy', null);
    const o = arrows[arrows.length - 1]; o.orb = true; o.life = 4.5;
  }
  Sfx.play('bossOrb', { x: e.x, y: e.y });
}
function bossSummon(e) {
  for (let k = 0; k < 3; k++) {
    const a = k / 3 * TAU + Math.random(), x = e.x + Math.cos(a) * (e.rad + 40), y = e.y + Math.sin(a) * (e.rad + 40);
    const m = makeEnemy(lvl.types[k === 2 ? 'archer' : 'melee'], x, y);
    m.state = 'chase'; m.alertT = 0.7; enemies.push(m);
    burst(x, y, 14, e.t.data.accent, 40, 160, 0.5, 3);
  }
  Sfx.play('bossWarn', { x: e.x, y: e.y });
}
function bossDefeated(e) {
  e.dying = true; e.hp = 0; e.state = 'dying'; e.stateT = 2.4; e.kx = e.ky = 0;
  game.runBosses = (game.runBosses || 0) + 1;
  game.slowT = 1.2; game.flash = 0.8; game.shake = 14; game.flurry = null;
  Sfx.play('bossDie', { player: true });
  burst(e.x, e.y, 60, e.t.data.accent, 80, 360, 1.2, 5);
  for (const x of enemies) if (!x.dead && !x.boss && !(lateActive() && lvl.n === 19 && x.lateGuard)) { x.dead = true; burst(x.x, x.y, 10, 'rgba(236,236,236,1)', 30, 120, 0.6, 6, 'smoke'); }
  for (const a of arrows) if (a.owner === 'enemy') a.life = 0;   // 敵方光彈消散（不替換陣列，避免箭矢迴圈中出錯）
  lvl.bossReward = grantBossReward(e);
  if (netHostOn()) netWorld({ k: 'brw' });              // 隊友也拿到一樣的魔王獎勵
  game.banner = { title: `擊敗 ${e.t.name}！`, sub: lvl.bossReward.join('　'), t: 4.2 };
}
// 擊敗大魔王的獎勵：專屬寶物、最大生命 +2 顆心、箭矢 +30、無影斬冷卻永久縮短 30 秒
function grantBossReward(e) {
  const r = e.t.data.reward, lines = [], p = player;
  const it = makeItem(r.kind, r.id, 'legend'), S = itemStats(it);   // 魔王寶物：必定是傳說
  (r.kind === 'weapon' ? inv.melee : inv.bows).push(it);
  if (r.kind === 'bow' && !inv.bowEq) inv.bowEq = it.uid;
  lines.push(`傳說　${S.name}（攻 ${S.atk}）`);
  p.maxHp = Math.min(PC.maxHpCap, p.maxHp + 4); p.hp = p.maxHp;
  lines.push('最大生命 +2 顆心');
  inv.arrows = Math.min(PC.maxArrows, inv.arrows + 30); lines.push('箭矢 +30');
  if (inv.ultimate) {
    inv.ultMax = Math.max(90, ultMax() - 30); game.ultCD = 0;
    lines.push(`無影斬冷卻縮短為 ${fmtTime(inv.ultMax)}`);
  }
  if (inv.vacuum) {
    inv.vacMax = Math.max(90, vacMax() - 30); game.vacCD = 0;
    lines.push(`吸怪器冷卻縮短為 ${fmtTime(inv.vacMax)}`);
  }
  return lines;
}
function updateBoss(e, dt) {
  const p = player, T = e.t, tg = NET.on ? netTarget(e) : player;     // 連線：魔王追最近的人
  const dx = tg.x - e.x, dy = tg.y - e.y, d = Math.hypot(dx, dy) || 0.001;
  const sp = T.speed * (e.phase === 2 ? 1.3 : 1) * (e.slowT > 0 ? 0.75 : 1);
  tickStatus(e, dt);
  e.stateT -= dt; e.atkCD -= dt; e.summonCD -= dt; e.hurtFlash -= dt; e.fireInvuln -= dt; e.invulnT -= dt;
  let mx = 0, my = 0;
  const canAct = game.mode === 'play' && !tg.dead;
  switch (e.state) {
    case 'intro': if (e.stateT <= 0) e.state = 'idle'; break;
    case 'idle':
      e.face = Math.atan2(dy, dx);
      if (d > 130) { mx = dx / d * sp * dt; my = dy / d * sp * dt; }
      if (canAct && e.atkCD <= 0) chooseBossSkill(e, d);
      break;
    case 'slamWind': if (e.stateT <= 0) bossSlam(e); break;
    case 'dashWind':
      if (e.stateT > 0.15) e.face = Math.atan2(dy, dx);
      if (e.stateT <= 0) { e.state = 'dash'; e.stateT = 0.5; e.dashHit = false; e.dashN = (e.dashN || 0) + 1; Sfx.play('bossDash', { x: e.x, y: e.y }); }
      break;
    case 'dash': {
      const v = 680 * (e.phase === 2 ? 1.15 : 1);
      mx = Math.cos(e.face) * v * dt; my = Math.sin(e.face) * v * dt;
      if (Math.random() < dt * 60) addParticle({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0.3, max: 0.3, size: e.rad * 0.8, color: T.data.accent, type: 'smoke', rot: 0, vr: 0 });
      if (!e.dashHit && Math.hypot(p.x - e.x, p.y - e.y) < e.rad + p.r + 4) { e.dashHit = true; bossContact(e); }
      if (e.stateT <= 0 && e.state === 'dash') { e.state = 'recover'; e.stateT = 0.7; }
      break;
    }
    case 'orbWind':
      if (e.stateT <= 0) {
        bossOrbs(e, 0);
        if (e.phase === 2) { e.state = 'orbWind2'; e.stateT = 0.45; } else { e.state = 'recover'; e.stateT = 0.6; }
      }
      break;
    case 'orbWind2': if (e.stateT <= 0) { bossOrbs(e, 0.5); e.state = 'recover'; e.stateT = 0.6; } break;
    case 'summonWind': if (e.stateT <= 0) { bossSummon(e); e.state = 'recover'; e.stateT = 0.6; } break;
    case 'roar': case 'recover': case 'stunned': case 'hurt': case 'chase': case 'windup': case 'patrol':
      if (e.stateT <= 0) e.state = 'idle';
      break;
    case 'dying':
      if (Math.random() < dt * 30) burst(e.x + rand(-e.rad, e.rad), e.y + rand(-e.rad, e.rad), 6, Math.random() < 0.5 ? T.data.accent : '#ffffff', 40, 200, 0.5, 3);
      if (e.stateT <= 0) {
        e.dead = true;
        burst(e.x, e.y, 90, T.data.accent, 100, 420, 1.2, 5); ring(e.x, e.y, '#ffffff', 30);
        game.shake = 16; game.flash = 1;
        if (game.mode === 'play') {
          if (lateActive() && lvl.n === 19) { lvl.late.bossDead = true; checkLateClear(); }
          else levelClear();
        }
      }
      return;
  }
  // 血量剩一半：怒吼進入第二階段
  if (e.phase === 1 && e.hp <= T.hp * 0.5) {
    e.phase = 2; e.state = 'roar'; e.stateT = 1.6; e.invulnT = 1.6; e.atkCD = 2.2;
    game.shake = Math.max(game.shake, 12); game.flash = 0.5;
    Sfx.play('bossRoar', { player: true });
    ring(e.x, e.y, T.data.accent, 30);
    game.banner = { title: `${T.name}憤怒了！`, sub: '弓箭無效！速度變快、光彈加倍，還會召喚手下', t: 2.6 };
    if (d < 320 && !p.dead && tg === p) { p.kx += dx / d * 700; p.ky += dy / d * 700; }
  }
  mx += e.kx * dt; my += e.ky * dt;
  const kd = Math.exp(-6 * dt); e.kx *= kd; e.ky *= kd;
  moveEntity(e, mx, my, e.rad);
  if (!p.dead) {                                  // 魔王很重：是亞特被推開，不是魔王
    const ddx = p.x - e.x, ddy = p.y - e.y, dd = Math.hypot(ddx, ddy), minD = e.rad + p.r;
    if (dd < minD) moveEntity(p, (dd > 0.001 ? ddx / dd : 1) * (minD - dd), (dd > 0.001 ? ddy / dd : 0) * (minD - dd), p.r);
  }
  const c = checkFireContact(e, e.rad - 6);
  if (c) damageEnemy(e, 1 + Math.floor(lvl.n / 2), 'fire', 0);
  const bh = hazardAt(e.x, e.y, -e.rad * 0.3);          // 魔王很耐燙：熔岩只扣 5%
  if (bh && bh.kind === 'lava') damageEnemy(e, Math.max(1, Math.ceil(e.t.hp * 0.05)), 'fire', 0);
}
function drawBoss(e) {
  const T = e.t, acc = T.data.accent, R = e.rad, t = game.time;
  const introK = e.state === 'intro' ? 1 - clamp(e.stateT / 1.8, 0, 1) : 1;
  const x = e.x, y = e.y + (e.state === 'dying' ? 0 : Math.sin(t * 2) * 3);
  // 招式預警
  if (e.state === 'slamWind') {
    const k = 1 - clamp(e.stateT / e.windMax, 0, 1);
    ctx.fillStyle = `rgba(255,40,60,${0.12 + 0.2 * k})`; circle(e.x, e.y, e.slamR); ctx.fill();
    ctx.strokeStyle = `rgba(255,90,100,${0.6 + 0.4 * Math.sin(t * 20)})`; ctx.lineWidth = 3; circle(e.x, e.y, e.slamR); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,230,150,0.9)'; ctx.lineWidth = 2; circle(e.x, e.y, Math.max(1, e.slamR * k)); ctx.stroke();
  }
  if (e.state === 'dashWind') {
    const k = 1 - clamp(e.stateT / e.windMax, 0, 1);
    ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.face);
    ctx.fillStyle = `rgba(255,40,60,${0.12 + 0.2 * k})`; ctx.fillRect(0, -R, 420, R * 2);
    ctx.strokeStyle = 'rgba(255,90,100,0.8)'; ctx.lineWidth = 2; ctx.strokeRect(0, -R, 420, R * 2);
    ctx.fillStyle = 'rgba(255,230,150,0.85)';
    for (let i = 0; i < 5; i++) { const cx0 = ((t * 260 + i * 84) % 420); ctx.beginPath(); ctx.moveTo(cx0, -12); ctx.lineTo(cx0 + 14, 0); ctx.lineTo(cx0, 12); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
  if (e.state === 'orbWind' || e.state === 'orbWind2' || e.state === 'summonWind') {
    ctx.strokeStyle = acc; ctx.lineWidth = 3; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 25);
    circle(x, y, R + 10 + (1 - clamp(e.stateT / e.windMax, 0, 1)) * 18); ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(e.x, e.y + R - 4, R * 1.05, R * 0.35, 0, 0, TAU); ctx.fill();
  ctx.save();
  ctx.globalAlpha = introK * (e.state === 'dying' ? (Math.floor(t * 16) % 2 ? 0.5 : 1) : 1);
  // 環繞的碎片
  ctx.fillStyle = acc;
  for (let i = 0; i < 6; i++) {
    const a = t * (e.phase === 2 ? 2.4 : 1.2) + i * TAU / 6, sx = x + Math.cos(a) * (R + 18), sy = y + Math.sin(a) * (R + 18) * 0.55;
    ctx.beginPath(); ctx.moveTo(sx, sy - 7); ctx.lineTo(sx + 5, sy + 5); ctx.lineTo(sx - 5, sy + 5); ctx.closePath(); ctx.fill();
  }
  // 王冠尖刺
  for (const k of [-1, 0, 1]) {
    ctx.beginPath(); ctx.moveTo(x + k * 22 - 9, y - R + 10); ctx.lineTo(x + k * 22, y - R - 16 - (k === 0 ? 10 : 0)); ctx.lineTo(x + k * 22 + 9, y - R + 10); ctx.closePath();
    ctx.fill(); ctx.strokeStyle = '#140c24'; ctx.lineWidth = 2; ctx.stroke();
  }
  // 身體
  let body;
  if (e.hurtFlash > 0) body = '#ffffff';
  else if (e.state === 'stunned') body = '#34466e';
  else { body = ctx.createRadialGradient(x - R * 0.3, y - R * 0.4, R * 0.2, x, y, R); body.addColorStop(0, '#4a3a70'); body.addColorStop(1, '#140c24'); }
  ctx.fillStyle = body; circle(x, y, R); ctx.fill();
  ctx.strokeStyle = acc; ctx.lineWidth = 4; ctx.stroke();
  if (e.phase === 2) {                            // 第二階段：身上的裂痕發光
    ctx.strokeStyle = acc; ctx.lineWidth = 2.5; ctx.globalAlpha *= 0.6 + 0.4 * Math.sin(t * 8);
    for (let i = 0; i < 4; i++) {
      const a = i * TAU / 4 + 0.6; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * R * 0.45, y + Math.sin(a) * R * 0.45);
      ctx.lineTo(x + Math.cos(a + 0.25) * R * 0.7, y + Math.sin(a + 0.25) * R * 0.7); ctx.lineTo(x + Math.cos(a) * R * 0.95, y + Math.sin(a) * R * 0.95); ctx.stroke();
    }
    ctx.globalAlpha = introK;
  }
  // 巨大的獨眼（看著亞特）
  const lookX = Math.cos(e.face) * R * 0.14, lookY = Math.sin(e.face) * R * 0.1;
  const blink = (t % 4.3) < 0.12 && e.state !== 'stunned';
  ctx.fillStyle = '#f4ecff'; ctx.beginPath(); ctx.ellipse(x, y - R * 0.05, R * 0.42, blink ? R * 0.04 : R * 0.27, 0, 0, TAU); ctx.fill();
  if (!blink) {
    ctx.fillStyle = e.state === 'stunned' ? '#8899bb' : acc; circle(x + lookX, y - R * 0.05 + lookY, R * 0.17); ctx.fill();
    ctx.fillStyle = '#0a0612'; circle(x + lookX * 1.2, y - R * 0.05 + lookY * 1.2, R * 0.08); ctx.fill();
  }
  if (e.state === 'stunned') {
    ctx.fillStyle = '#ffe27a';
    for (let k = 0; k < 4; k++) { const a = t * 4 + k * TAU / 4; circle(x + Math.cos(a) * R * 0.8, y - R - 14 + Math.sin(a) * 5, 4); ctx.fill(); }
  }
  ctx.restore();
}


/* =========================================================
 * 吸怪器（第 6 關一開始，亞特右邊的箱子裡取得）
 *   畫面右側冒出一張臉（朝左）：張大嘴 → 把畫面內的怪物全部吸進去 →
 *   閉嘴 → 嘟嘴把怪物掉落的物資吐到亞特面前。冷卻 3 分鐘；每打倒一隻魔王縮短 30 秒。
 * ========================================================= */
const VAC = { cooldown: 180, fw: 318, fh: 318, mouth: [0.15, 0.89], pucker: [0.09, 0.81] };   // 張到最大的嘴巴中心（第 04 格已加大）
const vacImg = typeof Image !== 'undefined' ? new Image() : {};   // 沒有 Image 的環境（測試）就不畫臉
vacImg.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAACfAAAAE+CAMAAAD/U1NVAAAB/lBMVEWTal+jmJrTZ1TanJPa1dSSJhqEfYFHPUG2imjDvcH75LNODQW7vMF5UTfHLR31gT3Ym218eoPhUB2hXDS+wMF+gYVcWWEeICE/OUK/wL7+xH78/PwpGBT9tHdMKyFYMyb8qm05IhtoOSkcEhBHJhzQdEwTCgnHa0aJSTL3h053Qy/7lln9u4K3ZUSpWTmXUzjvekVuKBLoaTTRVyr5m2OSNRfvdDxLGg3RZjj8xY+pOheySCSIKxK2Yj01JiSyQhypXUHHTCQnDAZxMxnkWyj61arJRxv5+PaOiIetqKhRSEfZglZvaGfKxcW5tbWKOyRoWFSZlJQ6MzP2yqyIeXV5dXXJubVaVFRnHAyYWUOqOySomZXma0X80Zy1dFH8oF7vqIzvimTx6ubw18rYcjzOwbtRQTuPgnuzh27NimuRZlBwYlzVUh3Tlm1aMB3uuaiWQR2sopvQppJjLiHuysOsKhL25NjMmYzNq6aueWooHSHFPBRlXWFlS0XrmoXkVRwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADR0gTWAAAAgHRSTlP///////////////////////////////////8A/v///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////zZUD+kAAQAASURBVHja7P39ix1ZtiUIZjJFJQ9yfiio7pkhDTvYuedeszAwM6kaSg6JXS4SQ7p7uD6RQgg1AfMqMwJeQAzZ0XRPB5n/+9jea+999rF7XZJLLoUUGR5V7+XL0Iff4+dj7bXXXut3f/osvp4+27/t69kz/jWVfO334U+/ffHXy/2zfQh1Xe+b/Tt+Vfvflk2+Hp7aZW/5+sNvy4ZjW+1v8LWc2s1mU22e/LZwv3399vXb129fn/7rd5/Ht/F8t1MkV+3e6Wuz2/z2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';
const vOut = k => 1 - (1 - k) * (1 - k), vIO = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);   // 吸怪器自己的緩動
const vacMax = () => (inv && inv.vacMax) || VAC.cooldown;
let pickupCapture = null;                            // 吞下怪物時，掉落物先存在嘴裡
function vacFaceRect() {                              // 臉在畫面上的位置（螢幕座標）
  const v = game.vac, h = Math.min(VH * 0.38, 290), w = h * VAC.fw / VAC.fh;          // 比原本小約 30%
  const slide = v ? v.slide : 1;
  return { x: VW - SAFE.r - w * 0.8 + slide * (w + 60), y: Math.max(SAFE.t + 60, VH * 0.5 - h * 0.88), w, h };   // 往右靠（後腦勺稍微出畫面），嘴巴在畫面中段
}
function vacMouthWorld(pucker) {
  const r = vacFaceRect(), m = pucker ? VAC.pucker : VAC.mouth;
  return { x: cam.x + r.x + r.w * m[0], y: cam.y + r.y + r.h * m[1] };
}
function tryVacuum() {
  const p = player;
  if (!inv.vacuum || game.vac || game.ult || p.dead || game.mode !== 'play') return;
  if (game.vacCD > 0) { addText(p.x, p.y - 44, `吸怪器冷卻中 ${fmtTime(game.vacCD)}`, '#9ff0d0', 16); Sfx.play('denied', { player: true }); return; }
  const targets = enemies.filter(e => !e.dead && !e.dying && !e.boss && onScreen(e) && !(e.sucked && e.sucked.gst));
  if (!targets.length) {
    addText(p.x, p.y - 44, bossAlive() && onScreen(bossAlive()) ? '大魔王吸不動！' : '畫面內沒有怪物', '#9ff0d0', 16);
    Sfx.play('denied', { player: true }); return;
  }
  game.flurry = null;
  game.vac = { phase: 'appear', t: 0, slide: 1, frame: 0, targets, loot: [], eaten: 0, spitT: 0, spat: 0 };
  Sfx.play('vacAppear', { player: true });
}
function vacPhase(v, ph) { v.phase = ph; v.t = 0; }
function endVacuum() {
  if (!game.vac) return;
  for (const e of enemies) if (e.sucked && !e.sucked.gst) e.sucked = null;
  if (netGuest()) { for (const h of game.vac.loot) netGiveLoot(h, null); game.vac.loot = []; }     // 隊友：掉落物直接收進自己的背包
  for (const h of game.vac.loot) { h.x = player.x + rand(-30, 30); h.y = player.y + rand(-30, 30); pickups.push(h); }   // 還沒吐完的直接放在亞特旁邊
  game.vac = null; game.vacCD = vacMax();
}
function eatMonster(e) {
  const v = game.vac;
  pickupCapture = [];
  killEnemy(e);                                       // 算擊倒數；掉落物被存進嘴裡
  if (v) v.loot.push(...pickupCapture); else for (const h of pickupCapture) pickups.push(h);
  pickupCapture = null;
  if (v) v.eaten++;
  Sfx.play('vacGulp', { player: true });
}
function updateSucked(e, dt) {                        // 被吸住的怪物：旋轉、縮小、飛進嘴裡（穿過障礙物）
  if (e.sucked.gst) { if (!netMateIn()) { e.sucked = null; return; } }      // 連線：被隊友的吸怪器吸住
  else if (!game.vac) { e.sucked = null; return; }
  const m = e.sucked.gst ? { x: NET.mate.x + NET.vacOff.ox, y: NET.mate.y + NET.vacOff.oy } : vacMouthWorld(false), s = e.sucked;
  s.t += dt;
  const dx = m.x - e.x, dy = m.y - e.y, d = Math.hypot(dx, dy) || 1;
  const step = Math.min(d, (140 + s.t * 1100) * dt);
  e.x += dx / d * step; e.y += dy / d * step;
  s.spin += dt * (5 + s.t * 16);
  s.sc = clamp(d / 280, 0.12, 1);
  if (s.gst) { if (d < 20 || s.t > 5) netEatForGuest(e); return; }
  if (d < 20) eatMonster(e);
}
function spitOne(v) {
  const p = player, m = vacMouthWorld(true);
  const a = Math.atan2(m.y - p.y, m.x - p.x);          // 落在亞特面前（朝臉的那一側）
  const tx = p.x + Math.cos(a) * 64 + rand(-36, 36), ty = p.y + Math.sin(a) * 64 + rand(-30, 30);
  burst(m.x, m.y, 8, '#ffffff', 40, 160, 0.35, 3);
  if (!v.loot.length) return;
  const h = v.loot.shift();
  if (netGuest()) { netGiveLoot(h, m); return; }
  h.x = m.x; h.y = m.y; h.vx = (tx - m.x) * 5; h.vy = (ty - m.y) * 5; h.air = 0.7; h.airMax = 0.7; h.t = 0;
  pickups.push(h);
  Sfx.play('vacSpit', { player: true });
}
function updateVacuum(dt) {
  const v = game.vac;
  if (!v) return;
  if (player.dead) { endVacuum(); return; }
  v.t += dt;
  if (v.phase === 'appear') {
    v.slide = 1 - vOut(Math.min(1, v.t / 0.4)); v.frame = 0;
    if (v.t >= 0.45) vacPhase(v, 'open');
  } else if (v.phase === 'open') {                    // 01 → 04：嘴巴越張越大
    v.frame = Math.min(3, 1 + Math.floor(v.t / 0.13));
    if (v.t >= 0.42) {
      vacPhase(v, 'suck');
      for (const e of v.targets) if (!e.dead && !e.dying) e.sucked = { t: 0, sc: 1, spin: 0 };
      if (netGuest()) netGuestVacStart(v);
      Sfx.play('vacSuck', { player: true });
      const b = bossAlive(); if (b && onScreen(b)) addText(b.x, b.y - b.rad - 30, '吸不動！', '#cccccc', 16);
    }
  } else if (v.phase === 'suck') {
    v.frame = 3;
    const m = vacMouthWorld(false);
    if (netGuest()) netGuestVacArrows();
    else for (const a of arrows) {                     // 怪物射出的箭也一起吸掉
      if (a.owner !== 'enemy' || a.x < cam.x || a.x > cam.x + VW || a.y < cam.y || a.y > cam.y + VH) continue;
      const dx = m.x - a.x, dy = m.y - a.y, d = Math.hypot(dx, dy) || 1;
      a.vx = dx / d * 700; a.vy = dy / d * 700; if (d < 24) a.life = 0;
    }
    if ((v.t > 2.4 && !enemies.some(e => e.sucked && !e.sucked.gst && !e.dead)) || v.t > 4.8) {        // 張大嘴至少吸 2.4 秒（比原本多約 1.5 秒）
      if (!netGuest()) for (const e of enemies) if (e.sucked && !e.sucked.gst && !e.dead) eatMonster(e);
      vacPhase(v, 'gulp'); Sfx.play('vacClose', { player: true });
    }
  } else if (v.phase === 'gulp') {                    // 05：閉上嘴、臉頰鼓一下
    v.frame = 4;
    if (v.t >= 0.4) vacPhase(v, 'spit');
  } else if (v.phase === 'spit') {                    // 06 → 08：嘟嘴，一件一件吐出來
    if (v.t < 0.3) v.frame = 5 + Math.min(2, Math.floor(v.t / 0.1));
    else {
      v.spitT -= dt;
      if (v.spitT <= 0 && (v.loot.length || v.spat === 0)) { spitOne(v); v.spat++; v.spitT = 0.16; }
      v.frame = v.spitT > 0.08 ? 7 : 6;
      if (!v.loot.length && v.spitT <= 0.02 && v.t > 1.1) vacPhase(v, 'leave');          // 吐完再多停一下
    }
  } else if (v.phase === 'leave') {
    v.frame = 4; v.slide = vIO(Math.min(1, v.t / 0.4));
    if (v.t >= 0.42) endVacuum();
  }
}
function drawVacuum() {
  const v = game.vac;
  if (!v || !vacImg.complete || !vacImg.naturalWidth) return;
  const r = vacFaceRect();
  if (v.phase === 'suck') {                            // 吸氣的氣流線
    const mx = r.x + r.w * VAC.mouth[0], my = r.y + r.h * VAC.mouth[1];
    ctx.save(); ctx.lineCap = 'round';
    for (let i = 0; i < 18; i++) {
      const a = Math.PI * (0.55 + (i * 0.618) % 0.9), d = ((game.time * 900 + i * 137) % 640) + 40;
      ctx.strokeStyle = `rgba(220,255,240,${0.15 + 0.5 * (1 - d / 680)})`; ctx.lineWidth = 2 + (i % 3);
      ctx.beginPath(); ctx.moveTo(mx + Math.cos(a) * d, my + Math.sin(a) * d * 0.8); ctx.lineTo(mx + Math.cos(a) * (d - 70), my + Math.sin(a) * (d - 70) * 0.8); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(200,255,235,0.6)'; ctx.lineWidth = 3;
    for (let k = 0; k < 3; k++) { const rr2 = ((game.time * 120 + k * 26) % 78) + 6; ctx.globalAlpha = 1 - rr2 / 84; circle(mx, my, rr2); ctx.stroke(); }
    ctx.restore();
  }
  const bulge = v.phase === 'gulp' ? 1 + 0.05 * Math.sin(Math.min(1, v.t / 0.4) * Math.PI) : 1;
  const shake = v.phase === 'suck' ? (Math.random() - 0.5) * 4 : 0;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.translate(r.x + r.w / 2 + shake, r.y + r.h / 2); ctx.scale(bulge, bulge);
  ctx.drawImage(vacImg, v.frame * VAC.fw, 0, VAC.fw, VAC.fh, -r.w / 2, -r.h / 2, r.w, r.h);
  ctx.restore();
}
// ---- 第 6 關一開始：亞特右邊的神秘箱子（打開學會吸怪器）----
function placeSkillChest() {
  const x = SPAWN.x + 190, y = SPAWN.y;
  ensureChunks(x, y, 200);
  for (const ch of chunks.values()) ch.solids = ch.solids.filter(s => !circleRectOverlap(x, y, 60, s));
  pickups.push({ x, y, kind: 'skillchest', life: 1e9, t: 0, vx: 0, vy: 0 });
  lvl.holdSpawn = true; lvl.chestPlaced = true;                               // 打開之前畫面內不會有怪物
  showHint(null, '右邊有一個神秘的箱子，走過去打開它', 7);
}
function openSkillChest(h) {
  h.opened = true; h.life = 5; h.t = 0;
  inv.vacuum = true; lvl.holdSpawn = NET.on ? netChestsLeft() : false; lvl.spawnT = 2.5;
  burst(h.x, h.y - 10, 50, '#7fe8c4', 80, 320, 1.0, 4); ring(h.x, h.y, '#c8fff0', 24);
  game.flash = Math.max(game.flash, 0.35);
  Sfx.play('chestOpen', { player: true }); Sfx.play('pickupLegend', { player: true });
  game.banner = { title: '習得　吸怪器', sub: '按下後，右邊冒出的臉會把畫面內的怪物全部吸進去，再把掉落物吐給你', t: 4 };
  showHint(null, '吸怪器的按鈕在「舉盾」上方（鍵盤 V）。畫面內有怪物時才能用，冷卻 3 分鐘', 9);
}
function drawSkillChest(h, y) {
  const x = h.x, t = h.t;
  if (!h.opened) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(0, y - 200, 0, y);
    g.addColorStop(0, 'rgba(120,240,200,0)'); g.addColorStop(1, `rgba(120,240,200,${0.3 + 0.12 * Math.sin(t * 4)})`);
    ctx.fillStyle = g; ctx.fillRect(x - 12, y - 200, 24, 200); ctx.restore();
    ctx.font = 'bold 22px "PingFang TC", sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    const qy = y - 40 + Math.sin(t * 3) * 4; ctx.strokeText('？', x, qy); ctx.fillStyle = '#c8fff0'; ctx.fillText('？', x, qy);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(x, y + 12, 18, 5, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1d4a40'; rr(x - 17, y - 6, 34, 20, 3); ctx.fill();
  ctx.fillStyle = '#4fc4a0'; rr(x - 15, y - 4, 30, 16, 2); ctx.fill();
  ctx.fillStyle = '#2f8a72'; ctx.fillRect(x - 15, y + 2, 30, 3); ctx.fillRect(x - 3, y - 4, 6, 16);
  if (h.opened) {
    ctx.fillStyle = '#1d4a40'; rr(x - 17, y - 22, 34, 10, 3); ctx.fill();
    ctx.fillStyle = '#4fc4a0'; rr(x - 15, y - 20, 30, 7, 2); ctx.fill();
    ctx.fillStyle = `rgba(200,255,240,${Math.max(0, 0.9 - t * 0.3)})`; ctx.fillRect(x - 13, y - 8, 26, 5);
  } else {
    ctx.fillStyle = '#1d4a40'; rr(x - 18, y - 16, 36, 13, 4); ctx.fill();
    ctx.fillStyle = '#6fe0bc'; rr(x - 16, y - 14, 32, 9, 3); ctx.fill();
    ctx.fillStyle = '#e8fff8'; ctx.fillRect(x - 3, y - 8, 6, 6);
  }
}

/* =========================================================
 * 無影斬（第一關結局取得，第二關起可用）
 *   血紅雙眼 → 時間變慢 → 高舉刀 → 化為白煙消失 →
 *   出現在畫面內每一個敵人身邊自動狂砍，直到全部斬殺。冷卻 3 分鐘。
 * ========================================================= */
const ULT = { cooldown: 180, charge: 0.95, travel: 0.13, slashGap: 0.09, hits: 4, timeScale: 0.04, maxTargets: 4 };
const ultMax = () => (inv && inv.ultMax) || ULT.cooldown;      // 擊敗大魔王可以縮短冷卻
// 畫面內離亞特最近的敵人（射箭自動瞄準用）
function nearestOnScreen(p) {
  let best = null, bd = Infinity;
  for (const e of enemies) {
    if (e.dead || e.dying || !onScreen(e)) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function onScreen(e) {
  const sx = e.x - cam.x, sy = e.y - cam.y;
  return sx > -e.rad && sx < VW + e.rad && sy > -e.rad && sy < VH + e.rad;
}
const fmtTime = s => { const c = Math.ceil(s); return `${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}`; };   // 179.8 秒 → 3:00
function smokePuff(x, y) {
  burst(x, y - 10, 16, 'rgba(236,236,236,1)', 30, 120, 0.55, 7, 'smoke');
  burst(x, y - 10, 8, '#ffffff', 60, 160, 0.3, 2);
  Sfx.play('smoke', { player: true });
}
function tryUltimate() {
  const p = player;
  if (!inv.ultimate || game.ult || game.vac || p.dead || game.mode !== 'play') return;
  if (game.ultCD > 0) { addText(p.x, p.y - 44, `無影斬冷卻中 ${fmtTime(game.ultCD)}`, '#ffd166', 16); Sfx.play('denied', { player: true }); return; }
  const targets = enemies.filter(e => !e.dead && !e.dying && onScreen(e));
  if (!targets.length) { addText(p.x, p.y - 44, '畫面內沒有敵人', '#ffd166', 16); Sfx.play('denied', { player: true }); return; }
  // 依「最近的下一個」排出斬殺順序
  const order = []; let cx = p.x, cy = p.y;
  while (targets.length) {
    let bi = 0, bd = Infinity;
    targets.forEach((e, i) => { const d = Math.hypot(e.x - cx, e.y - cy); if (d < bd) { bd = d; bi = i; } });
    const e = targets.splice(bi, 1)[0]; order.push(e); cx = e.x; cy = e.y;
  }
  order.length = Math.min(order.length, ULT.maxTargets);           // 不論畫面內有幾隻，最多斬殺 4 隻
  game.flurry = null; p.aiming = false; p.shieldUp = false; p.attackT = 0; p.dodgeT = 0; p.kx = p.ky = 0;
  if (p.sheathed) p.sheathed = false;
  p.facing = Math.atan2(order[0].y - p.y, order[0].x - p.x);
  game.ult = { phase: 'charge', t: 0, targets: order, idx: -1, hit: 0, target: null };
  if (NET.on) netFreeze(order, 5);                  // 連線：世界不變慢，改成把要斬的怪物定住
  game.banner = null;                               // 收起關卡標題，讓「無影斬」大字清楚出現
  game.flash = 0.25;
  Sfx.play('ultCharge', { player: true });
}
function nextUltTarget(u) {
  while (++u.idx < u.targets.length) { if (!u.targets[u.idx].dead) return u.targets[u.idx]; }
  return null;
}
function endUltimate() {
  const p = player;
  if (NET.on && game.ult) netFreeze(game.ult.targets, 0);
  if (p.ultHidden) { p.ultHidden = false; smokePuff(p.x, p.y); }
  game.ult = null; game.ultCD = ultMax();
  p.rageT = 0.8; p.attackT = 0; p.invuln = Math.max(p.invuln, 0.4);
  game.shake = Math.max(game.shake, 6); game.flash = Math.max(game.flash, 0.3);
  Sfx.play('ultEnd', { player: true });
}
function updateUltimate(dt) {
  const u = game.ult, p = player;
  u.t += dt; p.rageT = 1;
  if (p.attackT > 0) p.attackT -= dt;
  if (game.mode !== 'play') { endUltimate(); return; }   // 斬到最後一隻就過關了
  if (u.phase === 'charge') {
    // 血紅雙眼、高舉刀；身邊冒出紅色殺氣
    if (Math.random() < dt * 18) addParticle({ x: p.x + (Math.random() < 0.5 ? -1 : 1) * rand(16, 24), y: p.y - rand(0, 34), vx: rand(-8, 8), vy: rand(-60, -30), life: 0.5, max: 0.5, size: rand(1.5, 3), color: Math.random() < 0.5 ? '#ff2a3a' : '#2a0610', type: 'dot', rot: 0, vr: 0 });
    if (u.t >= ULT.charge) { smokePuff(p.x, p.y); p.ultHidden = true; u.phase = 'travel'; u.t = 0; }
    return;
  }
  if (u.phase === 'travel') {
    if (u.t < ULT.travel) return;
    const e = nextUltTarget(u);
    if (!e) { endUltimate(); return; }
    // 出現在敵人身邊（從上一個位置的方向切入）
    const a = Math.atan2(p.y - e.y, p.x - e.x) + rand(-0.6, 0.6);
    p.x = e.x + Math.cos(a) * (e.rad + p.r + 6); p.y = e.y + Math.sin(a) * (e.rad + p.r + 6);
    moveEntity(p, 0, 0, p.r);
    p.facing = Math.atan2(e.y - p.y, e.x - p.x);
    p.ultHidden = false; smokePuff(p.x, p.y);
    u.target = e; u.phase = 'slash'; u.t = 0; u.hit = 0;
    return;
  }
  if (u.phase === 'slash') {
    const e = u.target;
    if (u.hit < ULT.hits && u.t >= ULT.slashGap * (u.hit + 0.5)) {
      u.hit++;
      const last = u.hit >= ULT.hits;
      const ang = Math.atan2(e.y - p.y, e.x - p.x);
      p.facing = ang; p.swingDir = ang + rand(-0.7, 0.7); p.attackT = PC.attackActive;
      if (!e.dead) {
        const dmg = e.boss ? Math.ceil(e.t.hp * 0.04)                                   // 大魔王：每刀約 4%，不會被秒殺
          : last ? Math.max(1, e.hp) : Math.max(1, Math.min(e.hp - 1, Math.ceil(e.t.hp * 0.2)));
        (netGuest() ? netHit : damageEnemy)(e, dmg, 'ult', ang);
      }
      const sa = rand(0, Math.PI);                     // 劃過敵人的刀光
      addParticle({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0.22, max: 0.22, size: 34 + e.rad, color: '#ffffff', type: 'streak', rot: sa, vr: 0 });
      burst(e.x, e.y, 8, last ? '#ff2a3a' : '#ffd6dc', 80, 240, 0.3, 3);
      game.shake = Math.max(game.shake, last ? 7 : 4);
      Sfx.play('ultSlash', { player: true });
    }
    if ((u.hit >= ULT.hits && u.t >= ULT.slashGap * ULT.hits + 0.1) || (e.dead && u.hit >= 1 && u.t >= ULT.slashGap * (u.hit + 0.5) + 0.06)) {
      smokePuff(p.x, p.y); p.ultHidden = true; u.phase = 'travel'; u.t = 0;
    }
  }
}

// ---- 迅影時刻 ----
function startFlurry(e) {
  const p = player;
  game.flurry = { target: e, phase: 'ready', window: PC.flurryWindow, hits: 0, idle: 0 };
  e.state = 'recover'; e.stateT = Math.max(e.stateT, 1.0); e.lungeT = 0;
  if (NET.on) { if (netGuest()) netAct({ a: 'freeze', id: e.nid, t: PC.flurryWindow + 2 }); else e.frozenT = PC.flurryWindow + 2; }
  p.attackT = 0; p.attackQueue = 0; p.aiming = false;
  game.flash = 0.5;
  Sfx.play('flurryStart', { player: true });
  ring(p.x, p.y, '#9fe3ff', 14);
  addText(p.x, p.y - 46, '迅影時刻！', '#9fe3ff', 26);
  showHint('flurry', '迅影時刻！快按攻擊，衝到敵人面前連砍三刀', 3);
}
function flurrySlash() {
  const f = game.flurry, p = player, e = f.target;
  if (!e || e.dead) { endFlurry(); return; }
  const d = Math.hypot(e.x - p.x, e.y - p.y), want = e.rad + p.r + 8;
  const a = Math.atan2(e.y - p.y, e.x - p.x);
  if (d > want) {                       // 直接衝到敵人面前（留下殘影）
    const sx = p.x, sy = p.y;
    moveEntity(p, Math.cos(a) * (d - want), Math.sin(a) * (d - want), p.r);
    for (let k = 1; k <= 6; k++) p.trail.push({ x: sx + (p.x - sx) * k / 6, y: sy + (p.y - sy) * k / 6, life: 0.25 });
  }
  p.facing = p.swingDir = Math.atan2(e.y - p.y, e.x - p.x);
  p.attackT = PC.attackActive; p.attackCD = 0; p.attackHit.clear();
  f.hits++; f.idle = 0; f.phase = 'slashing';
  Sfx.play('flurrySlash', { player: true });
  game.shake = Math.max(game.shake, 5);
}
function updateFlurry(rdt) {
  const f = game.flurry;
  if (!f) return;
  if (f.phase === 'ready') { f.window -= rdt; if (f.window <= 0) endFlurry(); return; }
  f.idle += rdt;
  if (player.attackT <= 0 && (f.hits >= PC.flurryHits || f.target.dead || f.idle > 1.4)) endFlurry();
}
function endFlurry() {
  if (NET.on && game.flurry && game.flurry.target) {
    const t = game.flurry.target;
    if (netGuest()) netAct({ a: 'unfreeze', id: t.nid }); else t.frozenT = 0;
  }
  game.flurry = null;
  game.flash = Math.max(game.flash, 0.2);
}

/* =========================================================
 * 11. 敵人 AI
 *  近戰：patrol → 發現主角變色 → chase → windup（蓄力）→ 出手 → recover
 *  射手：保持距離、左右移動 → windup（拉弓，紅色瞄準線）→ 射箭 → recover
 * ========================================================= */
function makeType(role, n) {
  const B = ROLES[role], th = themeOf(n), look = th.roles[role];
  const mul = 1 + 0.45 * (n - 1);
  return Object.assign({}, B, {
    role, name: ELITE_PREFIX[eliteOf(n)] + look.name, colorPatrol: look.patrol, colorChase: look.chase, shape: th.shape, elite: eliteOf(n),
    hp: Math.round(B.hp * mul * (NET.on ? 1.3 : 1)),
    damage: B.damage + Math.floor((n - 1) / (role === 'archer' ? 3 : 2)),
    chaseSpeed: B.chaseSpeed * Math.min(1.35, 1 + 0.05 * (n - 1)),
    windup: Math.max(B.windup * 0.75, B.windup * (1 - 0.03 * (n - 1))),
    arrowSpeed: B.arrowSpeed ? B.arrowSpeed * Math.min(1.4, 1 + 0.04 * (n - 1)) : 0,
    drop: role === 'archer' ? th.drops.bow : role === 'brute' ? th.drops.heavy : th.drops.light,
  });
}
function makeEnemy(T, x, y) {
  const e = {
    t: T, x, y, rad: T.size / 2, hp: T.hp, home: { x, y },
    state: 'patrol', stateT: 0, target: { x, y }, waitT: Math.random(),
    kx: 0, ky: 0, face: Math.random() * TAU, hurtFlash: 0, fireInvuln: 0,
    atkCD: 0.5, lungeT: 0, alertT: 0, stuckT: 0, lastX: x, lastY: y, dead: false,
    bob: Math.random() * TAU, strafeT: 0, strafeDir: 1,
  };
  pickPatrolTarget(e);
  return e;
}
function pickPatrolTarget(e) {
  if (player && Math.random() < 0.55) {
    // 一半機率朝主角的大方向游蕩，讓無限世界裡的怪物會慢慢靠近
    const tp = NET.on ? netTarget(e) : player;
    const a = Math.atan2(tp.y - e.y, tp.x - e.x) + rand(-0.7, 0.7), d = rand(100, 220);
    e.target.x = e.x + Math.cos(a) * d; e.target.y = e.y + Math.sin(a) * d;
    e.home.x = e.target.x; e.home.y = e.target.y;
  } else {
    const a = Math.random() * TAU, d = 40 + Math.random() * 140;
    e.target.x = e.home.x + Math.cos(a) * d; e.target.y = e.home.y + Math.sin(a) * d;
  }
  e.stuckT = 0; e.lastX = e.x; e.lastY = e.y;
}

function updateEnemies(dt) {
  let p = player;
  let canSee = game.mode === 'play' && !p.dead;
  for (const e of enemies) {
    if (e.dead) continue;
    if (e.boss) { updateBoss(e, dt); continue; }
    if (e.sucked) { updateSucked(e, dt); continue; }
    if (NET.on) {                                   // 連線：被迅影時刻定住的怪物不動；目標是最近的玩家
      if (e.frozenT > 0) { e.frozenT -= dt; e.hurtFlash -= dt; e.fireInvuln -= dt; continue; }
      p = netTarget(e); e.tgtMate = p !== player;
      canSee = game.mode === 'play' && !p.dead;
    }
    const T = e.t;
    e.stateT -= dt; e.hurtFlash -= dt; e.fireInvuln -= dt; e.atkCD -= dt; e.alertT -= dt; e.lungeT -= dt; e.strafeT -= dt;
    e.riftCD = Math.max(0, (e.riftCD || 0) - dt);
    tickStatus(e, dt);
    if (e.dead) continue;
    const dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 0.001;
    let mx = 0, my = 0;

    switch (e.state) {
      case 'patrol': {
        if (canSee && d < T.sight) { e.state = 'chase'; e.alertT = 0.7; Sfx.play('alert', { x: e.x, y: e.y }); break; }
        if (e.waitT > 0) { e.waitT -= dt; break; }
        const tx = e.target.x - e.x, ty = e.target.y - e.y, td = Math.hypot(tx, ty);
        if (td < 6) { e.waitT = 0.4 + Math.random() * 1.2; pickPatrolTarget(e); break; }
        mx = tx / td * T.speed * dt; my = ty / td * T.speed * dt;
        e.face = Math.atan2(ty, tx);
        e.stuckT += dt;
        if (e.stuckT > 0.8) {
          if (Math.hypot(e.x - e.lastX, e.y - e.lastY) < 12) pickPatrolTarget(e);
          e.stuckT = 0; e.lastX = e.x; e.lastY = e.y;
        }
        break;
      }
      case 'chase': {
        if (!canSee || d > T.lose) { e.state = 'patrol'; pickPatrolTarget(e); break; }
        e.face = Math.atan2(dy, dx);
        if (T.ranged) {
          const sp = T.chaseSpeed * dt;
          if (d < T.keepMin) { mx = -dx / d * sp; my = -dy / d * sp; }          // 太近：後退
          else if (d > T.keepMax) { mx = dx / d * sp; my = dy / d * sp; }       // 太遠：靠近
          else {                                                                // 適中：左右游走
            if (e.strafeT <= 0) { e.strafeDir = Math.random() < 0.5 ? -1 : 1; e.strafeT = rand(0.8, 1.8); }
            mx = -dy / d * sp * 0.5 * e.strafeDir; my = dx / d * sp * 0.5 * e.strafeDir;
          }
          if (e.atkCD <= 0 && d <= T.shootRange) { e.state = 'windup'; e.stateT = T.windup; Sfx.play('bowDraw', { x: e.x, y: e.y }); }
        } else {
          if (d <= T.reach - 10 && e.atkCD <= 0) { e.state = 'windup'; e.stateT = T.windup; e.wx = e.x; e.wy = e.y; e.cued = false; Sfx.play('windup', { x: e.x, y: e.y }); break; }
          if (d > e.rad + p.r + 4) { mx = dx / d * T.chaseSpeed * dt; my = dy / d * T.chaseSpeed * dt; }
        }
        break;
      }
      case 'windup': {
        if (canSee && (!T.ranged || e.stateT > 0.2)) e.face = Math.atan2(dy, dx);   // 射手最後 0.2 秒鎖定方向
        if (!T.ranged && !e.cued && e.stateT < 0.18) { e.cued = true; Sfx.play('cue', { x: e.x, y: e.y }); }   // 「叮」＝現在閃避或舉盾
        if (e.stateT <= 0) {
          // 先切到硬直，再出手；若被完美格擋或迅影時刻，會在出手函式中改狀態
          e.state = 'recover'; e.stateT = T.ranged ? 0.4 : 0.55; e.atkCD = T.atkCooldown * (T.ranged ? rand(0.9, 1.3) : 1);
          if (T.ranged) enemyShoot(e); else enemyStrike(e);
        }
        break;
      }
      case 'recover': case 'hurt': case 'stunned': {
        if (e.stateT <= 0) {
          if (canSee) e.state = 'chase';
          else { e.state = 'patrol'; pickPatrolTarget(e); }
        }
        break;
      }
    }

    if (e.lungeT > 0 && !T.ranged) { mx += Math.cos(e.face) * 260 * dt; my += Math.sin(e.face) * 260 * dt; }
    if (e.slowT > 0) { mx *= 0.6; my *= 0.6; }            // 寒霜：變慢
    let eh;
    [mx, my, eh] = applyTerrain(e, mx, my, dt, e.rad);
    if (eh && eh.kind === 'lava') damageEnemy(e, Math.max(1, Math.ceil(e.t.hp * 0.2)), 'fire', Math.atan2(e.y - eh.y, e.x - eh.x));
    tryRift(e, eh, e.rad);
    mx += e.kx * dt; my += e.ky * dt;
    const kd = Math.exp(-8 * dt); e.kx *= kd; e.ky *= kd;
    moveEntity(e, mx, my, e.rad);

    if (!p.dead) {        // 不與主角重疊
      const ddx = e.x - p.x, ddy = e.y - p.y, dd = Math.hypot(ddx, ddy), minD = e.rad + p.r;
      if (dd < minD) {
        const nx = dd > 0.001 ? ddx / dd : 1, ny = dd > 0.001 ? ddy / dd : 0;
        moveEntity(e, nx * (minD - dd), ny * (minD - dd), e.rad);
      }
    }
    if (NET.on) netPushFromOther(e, p);
    const c = checkFireContact(e, e.rad - 2);
    if (c) damageEnemy(e, 1 + Math.floor(lvl.n / 2), 'fire', Math.atan2(e.y - (c.gy * CELL + CELL / 2), e.x - (c.gx * CELL + CELL / 2)));
  }
  // 怪物互相推開
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i]; if (a.dead) continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j]; if (b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), minD = a.rad + b.rad;
      if (d < minD) {
        const nx = d > 0.001 ? dx / d : 1, ny = d > 0.001 ? dy / d : 0, push = (minD - d) / 2;
        moveEntity(a, -nx * push, -ny * push, a.rad);
        moveEntity(b, nx * push, ny * push, b.rad);
      }
    }
  }
}

// 近戰怪出手的瞬間
function enemyStrike(e) {
  e.lungeT = 0.12;
  Sfx.play('enemySwing', { x: e.x, y: e.y });
  if (NET.on && e.tgtMate) { netStrikeMate(e); return; }
  resolveStrike(e, e.x, e.y, e.wx, e.wy, e.t.reach, e.t.damage);
}
// 判斷怪物這一擊有沒有打中自己的亞特（e 可以是 null：連線時隊友那邊看不到那隻怪物）
function resolveStrike(e, ex, ey, wx, wy, reach, damage) {
  const p = player;
  if (game.mode !== 'play' || p.dead || game.flurry) return;
  // 迅影時刻：在出手前 0.3 秒內、從攻擊範圍內閃避
  const since = game.time - p.dodgeStartT;
  // 以「蓄力開始時的位置」或「現在位置」判斷：閃避起點是否在攻擊範圍內（閃避穿過敵人把牠擠開也算）
  const startD = Math.min(Math.hypot(p.dodgeSX - ex, p.dodgeSY - ey),
                          wx !== undefined ? Math.hypot(p.dodgeSX - wx, p.dodgeSY - wy) : Infinity);
  if (since >= 0 && since <= PC.perfectDodgeWindow && startD <= reach + 25) {
    if (e) startFlurry(e);
    return;
  }
  const d = Math.hypot(p.x - ex, p.y - ey);
  if (d > reach) return;                           // 揮空
  if (p.dodgeT > 0) { addText(p.x, p.y - 34, '閃過！', '#9fd8ff', 16); return; }
  const angToEnemy = Math.atan2(ey - p.y, ex - p.x);
  if (p.shieldUp && Math.abs(angleDiff(p.facing, angToEnemy)) <= PC.shieldHalfArc) {
    if (p.shieldT <= PC.perfectWindow && e) { perfectParry(e); return; }
    if (p.stamina >= PC.blockCost) {
      p.stamina -= PC.blockCost; p.regenWait = PC.regenDelay;
      p.kx -= Math.cos(angToEnemy) * 160; p.ky -= Math.sin(angToEnemy) * 160;
      if (e) { e.kx -= Math.cos(angToEnemy) * 140; e.ky -= Math.sin(angToEnemy) * 140; }
      burst(p.x + Math.cos(angToEnemy) * 22, p.y + Math.sin(angToEnemy) * 22, 8, '#bdf3ff', 60, 180, 0.3, 3);
      Sfx.play('block', { player: true });
      addText(p.x, p.y - 34, '格擋', '#bdf3ff', 16);
      game.shake = Math.max(game.shake, 3);
      return;
    }
    p.stamina = 0; p.staminaFlash = 0.8;
    addText(p.x, p.y - 50, '破防！', '#ffd166', 18);
  }
  damagePlayer(damage, ex, ey, 'enemy');
}
function enemyShoot(e) {
  const T = e.t;
  Sfx.play('bowShot', { x: e.x, y: e.y, pitch: 0.8 });
  for (const s of e.elite ? [-0.2, 0, 0.2] : [0]) spawnArrow(e.x + Math.cos(e.face + s) * (e.rad + 4), e.y + Math.sin(e.face + s) * (e.rad + 4), e.face + s, T.arrowSpeed, T.damage, 'enemy', null);
}
function perfectParry(e) {
  const p = player;
  e.state = 'stunned'; e.stateT = 2.2; e.lungeT = 0;
  const a = Math.atan2(e.y - p.y, e.x - p.x);
  e.kx = Math.cos(a) * 300; e.ky = Math.sin(a) * 300;
  p.stamina = Math.min(PC.maxStamina, p.stamina + 10);
  game.slowT = 0.35; game.flash = 0.6; game.shake = Math.max(game.shake, 6);
  Sfx.play('parry', { player: true });
  ring(p.x + Math.cos(a) * 24, p.y + Math.sin(a) * 24, '#ffe27a', 12);
  burst(p.x + Math.cos(a) * 24, p.y + Math.sin(a) * 24, 16, '#ffe27a', 100, 300, 0.45, 3);
  addText(p.x, p.y - 44, '完美格擋！', '#ffe27a', 24);
  if (netGuest()) netAct({ a: 'parry', id: e.nid });
}

// ---- 生怪：無限世界中在畫面外產生怪物 ----
const SCR_SPAWN = [];
function pickRole() {
  if (lateActive() && lvl.n === 16) return [['melee','melee','brute'],['archer','melee','archer'],['brute','archer','melee']][lvl.late.wave - 1][lvl.spawned % 3];
  if (lvl.n === 1 && lvl.spawned === 1) return 'archer';      // 第一關第二隻一定是射手，早點拿到弓
  const r = Math.random(), pb = Math.min(0.12 + 0.03 * lvl.n, 0.3), pa = 0.25;
  return r < pb ? 'brute' : r < pb + pa ? 'archer' : 'melee';
}
function trySpawnEnemy(minD, maxD, elite, center, role) {
  const T = lvl.types[role || pickRole()], ctr = center || player;
  for (let k = 0; k < 10; k++) {
    const a = Math.random() * TAU, d = rand(minD, maxD);
    const x = ctr.x + Math.cos(a) * d, y = ctr.y + Math.sin(a) * d;
    ensureChunks(x, y, 64);
    const near = solidsInBox(x - T.size, y - T.size, x + T.size, y + T.size, SCR_SPAWN);
    if (near.some(s => circleRectOverlap(x, y, T.size / 2 + 6, s))) continue;
    if (hazardAt(x, y, T.size / 2 + 10)) continue;          // 怪物不會生成在熔岩或流沙上
    const c = grass.get(gk(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (c && c.state === 'burning') continue;
    if (NET.on && netSeenByAnyone(x, y, T.size)) continue;
    const e = makeEnemy(T, x, y);
    if (elite) makeElite(e);
    enemies.push(e);
    lvl.spawned++;
    return true;
  }
  return false;
}
function updateSpawner(dt) {
  if (game.mode !== 'play') return;
  for (const e of enemies) {
    if (!e.dead && !e.boss && !e.elite && (NET.on ? netNearestDist(e.x, e.y) : Math.hypot(e.x - player.x, e.y - player.y)) > DESPAWN_DIST) { e.dead = true; e.despawned = true; }
  }
  if (enemies.some(e => e.dead)) enemies = enemies.filter(e => !e.dead);   // 迅影目標仍保有引用，updateFlurry 會依 dead 結束
  if (lateActive()) { updateLateSpawner(dt); return; }
  if (lvl.holdSpawn) return;                          // 第 6 關箱子打開前不生怪
  lvl.spawnT -= dt;
  const alive = enemies.length;
  if (lvl.spawnT <= 0 && alive < lvl.maxAlive && lvl.kills + alive < lvl.target) {
    lvl.spawnT = 0.8;
    const ctr = NET.on ? netSpawnCenter() : player;
    const half = (ctr === player ? Math.hypot(VW, VH) : Math.hypot(NET.mateView.w, NET.mateView.h)) / 2;
    trySpawnEnemy(half + 80, half + 420, false, ctr);
  }
  // 精英怪：依擊倒進度出現（第 3 關起）
  if (lvl.elitesSpawned < lvl.elitesDue.length && lvl.kills >= lvl.elitesDue[lvl.elitesSpawned] && !lvl.bossSpawned) {
    const ctr = NET.on ? netSpawnCenter() : player;
    const half = (ctr === player ? Math.hypot(VW, VH) : Math.hypot(NET.mateView.w, NET.mateView.h)) / 2;
    if (trySpawnEnemy(half + 40, half + 260, true, ctr)) {
      lvl.elitesSpawned++;
      showHint(null, '精英怪出現了！打倒牠會掉落金色寶箱', 4);
      showHint('elite', '精英怪體型更大、血量更多。順著金色箭頭找到牠！', 7);
      Sfx.play('elite', { player: true });
    }
  }
}

/* =========================================================
 * 12. 箭矢（敵我共用）
 * ========================================================= */
const SCR_ARROW = [];
function updateArrows(dt) {
  const p = player;
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.life -= dt;
    let dead = a.life <= 0;
    const tx = a.vx * dt, ty = a.vy * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(tx, ty) / 8));     // 每步 ≤ 8px，避免穿過敵人
    const near = solidsInBox(Math.min(a.x, a.x + tx) - 2, Math.min(a.y, a.y + ty) - 2,
                             Math.max(a.x, a.x + tx) + 2, Math.max(a.y, a.y + ty) + 2, SCR_ARROW).slice();
    for (let s = 0; s < steps && !dead; s++) {
      a.x += tx / steps; a.y += ty / steps;
      let hitS = null;
      for (const o of near) if (!o.broken && pointInRect(a.x, a.y, o)) { hitS = o; break; }
      if (hitS) {
        if (hitS.kind === 'stone') hitStone(hitS, a.x, a.y);           // 射中火爆石也會噴火花
        else if (hitS.kind === 'crate' && a.owner === 'player') breakCrate(hitS);
        else { burst(a.x, a.y, 4, '#d8cfb8', 30, 90, 0.3, 2); Sfx.play('thunk', { x: a.x, y: a.y }); }
        dead = true; break;
      }
      if (a.fire) {
        const c = grass.get(gk(Math.floor(a.x / CELL), Math.floor(a.y / CELL)));
        if (c && c.state === 'grass') ignite(c);
      }
      if (a.owner === 'player') {
        for (const e of enemies) {
          if (e.dead || (a.hit && a.hit.has(e))) continue;
          if (Math.hypot(e.x - a.x, e.y - a.y) < e.rad + 4) {
            damageEnemy(e, a.dmg * (a.fx ? rollCrit(a.fx, e) : 1), a.reflected ? 'reflect' : a.fire ? 'firearrow' : 'arrow', Math.atan2(a.vy, a.vx));   // 盾反彈回去的不算弓箭
            const immune = e.boss && e.phase === 2 && !a.reflected; // 第二階段的魔王：弓射出的箭被彈開，詞綴效果也不會發動
            if (a.fx && !immune) applyHitFx(e, a.fx, a.dmg, a.guest);
            if (a.pierce && !immune) (a.hit || (a.hit = new Set())).add(e);
            else { dead = true; break; }
          }
        }
      } else if (!p.dead && Math.hypot(p.x - a.x, p.y - a.y) < p.r + (a.orb ? 7 : 3)) {
        const r = arrowHitPlayer(a);
        if (r === 'reflect') break;
        if (r !== 'pass') dead = true;
      }
    }
    if (dead) arrows.splice(i, 1);
  }
}
function arrowHitPlayer(a) {
  const p = player;
  if (p.dodgeT > 0 || game.flurry || game.ult || p.invuln > 0 || game.mode !== 'play') return 'pass';
  const from = Math.atan2(-a.vy, -a.vx);
  if (p.shieldUp && Math.abs(angleDiff(p.facing, from)) <= PC.shieldHalfArc) {
    if (p.shieldT <= PC.perfectWindow) {        // 完美格擋：把箭反彈回去
      a.owner = 'player'; a.reflected = true; a.vx = -a.vx * 1.4; a.vy = -a.vy * 1.4; a.dmg = a.dmg * 3 + 2; a.life = 1.6;
      a.x = p.x + Math.cos(from) * (p.r + 6); a.y = p.y + Math.sin(from) * (p.r + 6);
      addText(p.x, p.y - 44, '反彈！', '#ffe27a', 22);
      Sfx.play('parry', { player: true });
      ring(a.x, a.y, '#ffe27a', 8); game.slowT = 0.2;
      return 'reflect';
    }
    p.stamina = Math.max(0, p.stamina - 6); p.regenWait = PC.regenDelay;
    burst(a.x, a.y, 6, '#bdf3ff', 40, 140, 0.3, 3);
    Sfx.play('block', { player: true });
    addText(p.x, p.y - 34, '格擋', '#bdf3ff', 16);
    return 'blocked';
  }
  damagePlayer(a.dmg, a.x - a.vx * 0.05, a.y - a.vy * 0.05, 'arrow');
  return 'hit';
}

/* =========================================================
 * 13. 火花與燃燒
 * ========================================================= */
function emitSparks(s) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, n = 14;
  if (NET.on && netCapOK(cx, cy)) netCap(['sp', s.x, s.y, s.w, s.h]);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rand(-0.2, 0.2), sp = rand(130, 290), life = rand(0.8, 1.25);
    sparks.push({ x: cx + Math.cos(a) * 20, y: cy + Math.sin(a) * 20, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life });
  }
}
function updateSparks(dt) {
  for (const s of flashingStones) { s.flash -= dt; if (s.flash <= 0) flashingStones.delete(s); }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx * dt; s.y += s.vy * dt;
    const f = Math.exp(-2.4 * dt); s.vx *= f; s.vy *= f;
    s.life -= dt;
    if (s.life > 0 && !netGuest()) {
      const c = grass.get(gk(Math.floor(s.x / CELL), Math.floor(s.y / CELL)));
      if (c && c.state === 'grass') ignite(c);                  // 火花點燃草叢
      for (const e of enemies) {
        if (!e.dead && Math.hypot(e.x - s.x, e.y - s.y) < e.rad + 3) { damageEnemy(e, 1 + Math.floor(lvl.n / 2), 'fire', Math.atan2(s.vy, s.vx)); s.life = 0; break; }
      }
    }
    if (s.life <= 0) sparks.splice(i, 1);
  }
}
function ignite(c) {
  if (c.state !== 'grass') return;
  c.state = 'burning'; c.t = 2.6 + Math.random() * 0.9;
  burningCells.push(c);
  if (NET.on) netWorld({ k: 'c', x: c.gx, y: c.gy, s: 1 });
  Sfx.play('ignite', { x: c.gx * CELL, y: c.gy * CELL });
  burst(c.gx * CELL + CELL / 2, c.gy * CELL + CELL / 2, 4, '#ffb347', 20, 80, 0.5, 3, 'ember');
}
const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function updateFire(dt) {
  if (netGuest()) { netGuestFire(dt); return; }
  fireTick -= dt;
  if (fireTick <= 0) {                // 每 0.2 秒有機率延燒到上下左右
    fireTick = 0.2;
    for (const c of burningCells.slice()) {
      for (const [ox, oy] of NEIGH) {
        const n = grass.get(gk(c.gx + ox, c.gy + oy));
        if (n && n.state === 'grass' && Math.random() < 0.2) ignite(n);
      }
    }
  }
  if (burningCells.length && Math.random() < dt * 14) {           // 燃燒的劈啪聲
    const c = burningCells[(Math.random() * burningCells.length) | 0];
    Sfx.play('crackle', { x: c.gx * CELL, y: c.gy * CELL });
  }
  for (let i = burningCells.length - 1; i >= 0; i--) {
    const c = burningCells[i];
    c.t -= dt;
    if (Math.random() < dt * 9) {
      addParticle({ x: c.gx * CELL + rand(4, CELL - 4), y: c.gy * CELL + rand(4, CELL - 4), vx: rand(-10, 10), vy: rand(-50, -20),
        life: 0.7, max: 0.7, size: rand(2, 4), color: Math.random() < 0.5 ? '#ffd166' : '#ff7a2f', type: 'ember', rot: 0, vr: 0 });
    }
    if (c.t <= 0) {                   // 燒毀成灰燼
      c.state = 'ash'; c.t = 7;
      burningCells.splice(i, 1); ashCells.push(c);
      if (NET.on) netWorld({ k: 'c', x: c.gx, y: c.gy, s: 2 });
      burst(c.gx * CELL + CELL / 2, c.gy * CELL + CELL / 2, 2, 'rgba(90,90,90,1)', 10, 40, 1.0, 6, 'smoke');
    }
  }
  for (let i = ashCells.length - 1; i >= 0; i--) {
    const c = ashCells[i];
    c.t -= dt;
    if (c.t <= 0) { if (grass.get(c.key) === c) { grass.delete(c.key); if (NET.on) netWorld({ k: 'c', x: c.gx, y: c.gy, s: 0 }); } ashCells.splice(i, 1); }
  }
}

/* =========================================================
 * 14. 掉落物與背包
 * ========================================================= */
function addPickup(o) { const h = Object.assign({ t: 0, life: 25, vx: rand(-70, 70), vy: rand(-70, 70) }, o); (pickupCapture || pickups).push(h); }
function dropFood(x, y, meat) { addPickup({ x, y, kind: 'food', heal: meat ? 4 : 2, name: meat ? '烤肉' : '蘋果' }); }
function dropArrows(x, y, n) { addPickup({ x, y, kind: 'arrows', count: n }); }
// 掉落裝備：已經有同款普通品質時改掉箭矢，避免背包塞滿重複的東西
function dropGear(x, y, kind, base, rarity) {
  const list = kind === 'weapon' ? inv.melee : inv.bows;
  if (rarity === 'common' && list.some(raw => { const it = asItem(raw, kind); return it.base === base && it.rarity === 'common'; })) { dropArrows(x, y, 3); return; }
  addPickup({ x, y, kind, item: makeItem(kind, base, rarity), life: 60 });
}
function dropLoot(e) {
  const T = e.t;
  if (e.elite) addPickup({ x: e.x, y: e.y, kind: 'goldchest', life: 180, vx: 0, vy: 0 });   // 精英怪掉落金色寶箱
  if (T.role === 'archer') {         // 第一次一定掉他的弓；之後 30% 機率掉一把（稀有度隨機）
    const owned = inv.bows.some(raw => asItem(raw, 'bow').base === T.drop);
    if (!owned || Math.random() < 0.3) dropGear(e.x, e.y, 'bow', T.drop, rollRarity());
    dropArrows(e.x + 8, e.y, 3);
    return;
  }
  if (Math.random() < (T.role === 'brute' ? 0.45 : 0.16)) { dropGear(e.x, e.y, 'weapon', T.drop, rollRarity()); return; }
  const r = Math.random();
  if (r < 0.35) dropFood(e.x, e.y, T.role === 'brute');
  else if (r < 0.6) dropArrows(e.x, e.y, 2);
}
function updatePickups(dt) {
  const p = player;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const h = pickups[i];
    h.t += dt; h.life -= dt;
    h.x += h.vx * dt; h.y += h.vy * dt;
    if (h.air > 0) { h.air -= dt; h.t += dt; const f0 = Math.exp(-5 * dt); h.vx *= f0; h.vy *= f0; continue; }   // 吐出來還在空中
    const f = Math.exp(-5 * dt); h.vx *= f; h.vy *= f;
    if (h.life <= 0) { pickups.splice(i, 1); continue; }
    if (p.dead || game.mode !== 'play') continue;
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (h.kind === 'goldchest') { if (!h.opened && d < p.r + 26) openGoldChest(h); continue; }
    if (h.kind === 'skillchest') {
      if (!h.opened && d < p.r + 28) { if (NET.on && inv.vacuum) netChestTaken(h); else openSkillChest(h); }
      continue;
    }
    if (h.fullT > 0) { h.fullT -= dt; continue; }
    if (h.lockBy === 'host' && game.time < h.lockUntil) continue;      // 自己剛丟出去的東西：5 秒內只有隊友能撿
    const wants = h.kind !== 'food' || p.hp < p.maxHp;
    if (wants && d < 70 && d > 1) { h.x += (p.x - h.x) / d * 220 * dt; h.y += (p.y - h.y) / d * 220 * dt; }   // 磁吸
    if (!wants || d >= p.r + 12) continue;
    if (collectPickup(h) === false) continue;            // 背包滿了：留在地上
    pickups.splice(i, 1);
  }
}
function collectPickup(h) {
  const p = player;
  if (h.kind === 'food') {
    p.hp = Math.min(p.maxHp, p.hp + h.heal);
    Sfx.play('pickupFood', { player: true });
    addText(p.x, p.y - 30, `${h.name} +${h.heal}`, '#ff7a8a', 18);
    burst(h.x, h.y, 10, '#ff7a8a', 40, 140, 0.5, 3);
  } else if (h.kind === 'arrows') {
    inv.arrows = Math.min(PC.maxArrows, inv.arrows + h.count);
    Sfx.play('pickupArrows', { player: true });
    addText(p.x, p.y - 30, `箭矢 +${h.count}`, '#ffd666', 18);
  } else if (h.kind === 'weapon' || h.kind === 'bow') {
    const list = h.kind === 'weapon' ? inv.melee : inv.bows;
    if (list.length >= BAG_MAX[h.kind]) {
      addText(p.x, p.y - 34, '背包滿了！到背包丟掉一些吧', '#ffd166', 15); h.fullT = 2.5;
      return false;
    }
    const it = h.item || makeItem(h.kind, h.id, 'common');
    if (h.gift) { inv.nextUid = (inv.nextUid || 1) + 1; it.uid = inv.nextUid; }      // 別人丟出來的東西：換一個自己背包的編號
    list.push(it);
    if (h.kind === 'bow' && !inv.bowEq) inv.bowEq = it.uid;
    const S = itemStats(it), R0 = RARITY[it.rarity];
    Sfx.play(it.rarity === 'legend' ? 'pickupLegend' : 'pickupItem', { player: true });
    addText(p.x, p.y - 34, `${it.rarity !== 'common' ? R0.name + '　' : ''}${S.name}（攻 ${S.atk}）`, R0.color, 18);
    if (h.kind === 'weapon') showHint('weapon', '拿到新武器了！點搖桿上方的「背包」就能換上', 6);
    else showHint('bow', '拿到弓了！按住「射箭」拖曳小圓點瞄準，放開就射出', 7);
    if (it.rarity !== 'common') showHint('affix', '藍色是稀有、金色是傳說，會帶有特殊效果。打開背包就能看到', 7);
  }
}

/* =========================================================
 * 裝備：每一把都是獨立的物品（稀有度＋隨機詞綴）
 *   普通（白）：沒有詞綴　稀有（藍）：1 個詞綴、攻擊 +15%　傳說（金）：2 個詞綴、攻擊 +35%
 * ========================================================= */
const RARITY = {
  common: { name: '普通', color: '#e8e8e8', mul: 1, n: 0 },
  rare:   { name: '稀有', color: '#6fb6ff', mul: 1.15, n: 1 },
  legend: { name: '傳說', color: '#ffc94f', mul: 1.35, n: 2 },
};
const MELEE_AFFIX = {
  fire:  { name: '烈焰', desc: '烈焰：打中會燒傷敵人' },
  frost: { name: '寒霜', desc: '寒霜：打中會讓敵人變慢' },
  swift: { name: '疾風', desc: '疾風：揮擊速度變快' },
  vamp:  { name: '吸血', desc: '吸血：打中有機會回復生命' },
  crit:  { name: '暴擊', desc: '暴擊：25% 機率造成兩倍傷害' },
  reach: { name: '長柄', desc: '長柄：攻擊距離 +20%' },
};
const BOW_AFFIX = {
  fire:    { name: '烈焰', desc: '烈焰：火焰箭，會燒傷敵人' },
  frost:   { name: '寒霜', desc: '寒霜：箭會讓敵人變慢' },
  pierce:  { name: '穿透', desc: '穿透：箭會穿透敵人' },
  triple:  { name: '連射', desc: '連射：一次射出三支箭' },
  crit:    { name: '暴擊', desc: '暴擊：25% 機率造成兩倍傷害' },
  thrifty: { name: '回收', desc: '回收：35% 機率不消耗箭矢' },
};
const BAG_MAX = { weapon: 24, bow: 12 };
function makeItem(kind, base, rarity) {
  const table = kind === 'weapon' ? MELEE_AFFIX : BOW_AFFIX;
  const native = kind === 'bow' ? BOWS[base].special : null;           // 弓本身的特性不會重複出現在詞綴
  const pool = Object.keys(table).filter(a => a !== native);
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
  inv.nextUid = (inv.nextUid || 1) + 1;
  return { uid: inv.nextUid, kind, base, rarity, affixes: pool.slice(0, RARITY[rarity].n) };
}
// 舊格式（只有種類代號）也能讀，當成普通品質
const asItem = (it, kind) => (typeof it === 'string' ? { uid: it, kind, base: it, rarity: 'common', affixes: [] } : it);
function itemName(it) {
  const t = it.kind === 'weapon' ? MELEE_AFFIX : BOW_AFFIX, b = (it.kind === 'weapon' ? WEAPONS : BOWS)[it.base].name;
  return it.affixes.length ? it.affixes.map(a => t[a].name).join('') + '的' + b : b;
}
function itemStats(it) {
  const mul = RARITY[it.rarity].mul, fx = new Set(it.affixes);
  if (it.kind === 'weapon') {
    const b = WEAPONS[it.base];
    return { name: itemName(it), atk: Math.round(b.atk * mul), range: Math.round(b.range * (fx.has('reach') ? 1.2 : 1)), cd: b.cd * (fx.has('swift') ? 0.77 : 1), fx, rarity: it.rarity };
  }
  const b = BOWS[it.base];
  if (b.special) fx.add(b.special);
  return { name: itemName(it), atk: Math.round(b.atk * mul), speed: b.speed, special: b.special, fx, rarity: it.rarity };
}
function itemLines(it) {                               // 背包卡片上的說明
  const s = itemStats(it), t = it.kind === 'weapon' ? MELEE_AFFIX : BOW_AFFIX, out = [];
  if (it.kind === 'weapon') out.push(`速度 ${speedWord(s.cd)}　距離 ${rangeWord(s.range)}`);
  else out.push(s.special ? SPECIAL_TEXT[s.special] : '標準的弓');
  for (const a of it.affixes) out.push(t[a].desc);
  return out;
}
const findItem = (list, uid, kind) => { for (const raw of list) { const it = asItem(raw, kind); if (it.uid === uid) return it; } return null; };
const curW = () => itemStats(findItem(inv.melee, inv.meleeEq, 'weapon') || asItem('traveler', 'weapon'));
const curB = () => { if (!inv.bowEq) return null; const it = findItem(inv.bows, inv.bowEq, 'bow'); return it ? itemStats(it) : null; };
// 稀有度：越後面的關卡越容易出傳說；金色寶箱必定稀有以上
function rollRarity(guaranteed) {
  const legend = Math.min(0.22, 0.03 + 0.012 * lvl.n), r = Math.random();
  if (guaranteed) return r < 0.3 + legend ? 'legend' : 'rare';
  return r < legend ? 'legend' : r < legend + 0.3 ? 'rare' : 'common';
}
// 打中時的詞綴效果（近戰與箭共用）
function applyHitFx(e, fx, atk, byGuest) {
  if (fx.has('vamp') && Math.random() < 0.2 && (byGuest || player.hp < player.maxHp)) {   // 吸血：最後一擊也算
    if (byGuest) netWorld({ k: 'vp' });
    else { player.hp += 1; addText(player.x, player.y - 42, '+1', '#ff7a8a', 15); }
  }
  if (!e || e.dead || e.dying) return;
  if (fx.has('fire')) { e.burnT = 2.6; e.burnDmg = Math.max(1, Math.round(atk * 0.25)); }
  if (fx.has('frost')) e.slowT = 2.2;
}
const rollCrit = (fx, e) => {
  if (!fx.has('crit') || Math.random() >= 0.25) return 1;
  addText(e.x, e.y - e.rad - 26, '暴擊！', '#ffc94f', 17);
  return 2;
};
// 燒傷與變慢（每隻敵人每幀）
function tickStatus(e, dt) {
  if (e.slowT > 0) e.slowT -= dt;
  if (e.burnT > 0) {
    e.burnT -= dt;
    if (e.fireInvuln <= 0) damageEnemy(e, e.burnDmg || 1, 'burn', 0);
    if (Math.random() < dt * 12) addParticle({ x: e.x + rand(-e.rad, e.rad) * 0.6, y: e.y - rand(0, e.rad), vx: rand(-10, 10), vy: rand(-50, -25), life: 0.45, max: 0.45, size: rand(2, 3.5), color: Math.random() < 0.5 ? '#ff8c42' : '#ffd166', type: 'dot', rot: 0, vr: 0 });
  }
}

/* ---- 精英怪：第 3 關起出現，打倒掉落金色寶箱 ---- */
const eliteCount = n => (n >= 11 ? 3 : n >= 6 ? 2 : n >= 3 ? 1 : 0);
function makeElite(e) {
  const T = e.t;
  e.t = Object.assign({}, T, { hp: T.hp * 4, size: Math.round(T.size * 1.35), damage: T.damage + 1, knockResist: T.knockResist * 0.5,
    armor: true, chaseSpeed: T.chaseSpeed * 1.08, name: '精英' + (T.name || '') });
  e.hp = e.t.hp; e.rad = e.t.size / 2; e.elite = true; e.markColor = '#ffc94f';
  return e;
}
function openGoldChest(h) {
  h.opened = true; h.life = 6; h.t = 0;
  const bow = Math.random() < 0.35;
  const kind = bow ? 'bow' : 'weapon', base = bow ? lvl.types.archer.drop : (Math.random() < 0.5 ? lvl.types.melee.drop : lvl.types.brute.drop);
  addPickup({ x: h.x, y: h.y - 6, kind, item: makeItem(kind, base, rollRarity(true)), life: 90, vx: rand(-50, 50), vy: rand(40, 70) });
  dropArrows(h.x - 10, h.y, 8); dropFood(h.x + 10, h.y, true);
  burst(h.x, h.y - 10, 40, '#ffc94f', 80, 300, 0.9, 4); ring(h.x, h.y, '#ffe27a', 20);
  game.flash = Math.max(game.flash, 0.25);
  Sfx.play('chestOpen', { player: true });
  addText(h.x, h.y - 40, '金色寶箱！', '#ffc94f', 20);
}
function drawGoldChest(h, y) {
  const x = h.x, t = h.t;
  if (!h.opened) {                                    // 遠遠就看得到的金色光柱
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(0, y - 200, 0, y);
    g.addColorStop(0, 'rgba(255,210,90,0)'); g.addColorStop(1, `rgba(255,210,90,${0.32 + 0.12 * Math.sin(t * 4)})`);
    ctx.fillStyle = g; ctx.fillRect(x - 12, y - 200, 24, 200);
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(x, y + 12, 18, 5, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#5a3a10'; rr(x - 17, y - 6, 34, 20, 3); ctx.fill();
  ctx.fillStyle = '#e8b84a'; rr(x - 15, y - 4, 30, 16, 2); ctx.fill();
  ctx.fillStyle = '#b8862a'; ctx.fillRect(x - 15, y + 2, 30, 3); ctx.fillRect(x - 3, y - 4, 6, 16);
  if (h.opened) {                                     // 打開的箱蓋與裡面的光
    ctx.fillStyle = '#5a3a10'; rr(x - 17, y - 22, 34, 10, 3); ctx.fill();
    ctx.fillStyle = '#e8b84a'; rr(x - 15, y - 20, 30, 7, 2); ctx.fill();
    ctx.fillStyle = `rgba(255,240,170,${Math.max(0, 0.9 - t * 0.3)})`; ctx.fillRect(x - 13, y - 8, 26, 5);
  } else {
    ctx.fillStyle = '#5a3a10'; rr(x - 18, y - 16, 36, 13, 4); ctx.fill();
    ctx.fillStyle = '#f2c95a'; rr(x - 16, y - 14, 32, 9, 3); ctx.fill();
    ctx.fillStyle = '#fff3b0'; ctx.fillRect(x - 3, y - 8, 6, 6);
    if (Math.floor(t * 3) % 3 === 0) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 9, y - 13, 2, 2); }
  }
}

// ---- 背包畫面 ----
const speedWord = cd => (cd <= 0.32 ? '快' : cd <= 0.45 ? '中' : '慢');
const rangeWord = r => (r >= 76 ? '長' : r >= 64 ? '中' : '短');
const bagState = { tab: 'melee', page: 0 };
function itemButton(name, big, lines, equipped, onClick, opt) {
  opt = opt || {};
  const b = document.createElement('div');
  b.className = 'item' + (equipped ? ' on' : '') + (opt.rarity ? ' r-' + opt.rarity : '');
  b.setAttribute('role', 'button');
  if (opt.tag) { const tg = document.createElement('b'); tg.className = 'tag'; tg.textContent = opt.tag; b.appendChild(tg); }
  const n = document.createElement('strong'); n.textContent = name; b.appendChild(n);
  const g = document.createElement('div'); g.className = 'big'; g.textContent = big; b.appendChild(g);
  for (const l of lines) { const sp = document.createElement('span'); sp.textContent = l; b.appendChild(sp); }
  if (equipped) { const t = document.createElement('em'); t.textContent = '裝備中'; b.appendChild(t); }
  if (opt.onDiscard) {                               // 丟掉：要按兩次，避免不小心丟錯
    const dropTxt = NET.on ? '丟在地上' : '丟掉', sureTxt = NET.on ? '確定丟在地上？' : '確定丟掉？';
    const x = document.createElement('button'); x.className = 'discard'; x.textContent = dropTxt;
    x.addEventListener('click', ev => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (x.dataset && x.dataset.armed) { opt.onDiscard(); return; }
      if (x.dataset) x.dataset.armed = '1';
      x.textContent = sureTxt; x.className = 'discard armed';
      setTimeout(() => { if (x.dataset) delete x.dataset.armed; x.textContent = dropTxt; x.className = 'discard'; }, 2500);
    });
    b.appendChild(x);
  }
  b.addEventListener('click', onClick);
  return b;
}
// 依畫面大小決定每頁幾格（iPad 橫向：3 欄 × 2 列）
function bagLayout() {
  const w = bagGrid.clientWidth || window.innerWidth, h = bagGrid.clientHeight || window.innerHeight * 0.55;
  const cols = w >= 700 ? 3 : 2, rows = h >= 280 ? 2 : 1;
  return { cols, rows, per: cols * rows };
}
function renderBag() {
  const W = curW(), B = curB();
  bagStats.textContent = `裝備中：${W.name}${B ? '、' + B.name : ''}　箭矢 ${inv.arrows} 支　生命 ${player.hp / 2} / ${player.maxHp / 2} 顆心`;
  $('tabMelee').textContent = `近戰武器（${inv.melee.length}/${BAG_MAX.weapon}）`;
  $('tabBow').textContent = `弓（${inv.bows.length}/${BAG_MAX.bow}）`;
  $('tabMelee').classList.toggle('on', bagState.tab === 'melee');
  $('tabBow').classList.toggle('on', bagState.tab === 'bow');
  const isMelee = bagState.tab === 'melee';
  const kind = isMelee ? 'weapon' : 'bow', list = isMelee ? inv.melee : inv.bows;
  const ids = list.map(raw => asItem(raw, kind)).sort((a, b) => itemStats(b).atk - itemStats(a).atk);
  const { cols, rows, per } = bagLayout();
  const pages = Math.max(1, Math.ceil(ids.length / per));
  bagState.page = clamp(bagState.page, 0, pages - 1);
  bagGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  bagGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  bagGrid.innerHTML = '';
  if (!ids.length) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = '還沒有弓。擊敗拿著弓的射手，就能拿到他的弓。';
    bagGrid.appendChild(p);
  }
  const shown = ids.slice(bagState.page * per, bagState.page * per + per);
  for (const it of shown) {
    const S = itemStats(it), eq = isMelee ? inv.meleeEq === it.uid : inv.bowEq === it.uid;
    bagGrid.appendChild(itemButton(S.name, `攻擊 ${S.atk}`, itemLines(it), eq,
      () => { if (isMelee) inv.meleeEq = it.uid; else inv.bowEq = it.uid; Sfx.play('ui', { player: true }); renderBag(); },
      { rarity: it.rarity, tag: it.rarity !== 'common' ? RARITY[it.rarity].name : '',
        onDiscard: eq ? null : () => {
          const i = list.findIndex(raw => asItem(raw, kind).uid === it.uid);
          if (i >= 0) list.splice(i, 1);
          if (NET.on && i >= 0) netDropItem(it, kind);      // 連線：掉在地上給隊友撿
          Sfx.play('ui', { player: true }); renderBag();
        } }));
  }
  if (ids.length) for (let k = shown.length; k < per; k++) { const d = document.createElement('div'); d.className = 'slot'; bagGrid.appendChild(d); }
  pageInfo.textContent = `第 ${bagState.page + 1} / ${pages} 頁`;
  $('prevPage').disabled = bagState.page <= 0;
  $('nextPage').disabled = bagState.page >= pages - 1;
}
$('tabMelee').addEventListener('click', () => { bagState.tab = 'melee'; bagState.page = 0; Sfx.play('ui', { player: true }); renderBag(); });
$('tabBow').addEventListener('click', () => { bagState.tab = 'bow'; bagState.page = 0; Sfx.play('ui', { player: true }); renderBag(); });
$('prevPage').addEventListener('click', () => { bagState.page--; Sfx.play('ui', { player: true }); renderBag(); });
$('nextPage').addEventListener('click', () => { bagState.page++; Sfx.play('ui', { player: true }); renderBag(); });
function openBag() {
  if (game.mode !== 'play' || game.paused) return;
  game.paused = true; resetInputs();
  player.aiming = false;
  bagScreen.classList.remove('hidden');   // 先顯示，才量得到格子區的實際大小
  renderBag();
}
function closeBag() {
  bagScreen.classList.add('hidden');
  game.paused = false; resetInputs();
}

/* ===== v1.0.2：單人關卡存檔（完成關卡後才保存；離線可用） ===== */
const SAVE_KEY = 'ater-adventure-checkpoint-v1';
const SAVE_VERSION = 1;
function readCheckpoint() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== SAVE_VERSION || !Number.isInteger(data.nextLevel) ||
        data.nextLevel < 2 || data.nextLevel > 20 || !data.inv ||
        !Array.isArray(data.inv.melee) || !Array.isArray(data.inv.bows) ||
        typeof data.maxHp !== 'number' || !Number.isFinite(data.maxHp)) return null;
    return data;
  } catch (err) { console.warn('存檔讀取失敗', err); return null; }
}
function clearCheckpoint() {
  try { localStorage.removeItem(SAVE_KEY); } catch (err) { console.warn('無法清除存檔', err); }
  refreshContinueButton();
}
function refreshContinueButton() {
  const btn = $('continueBtn');
  if (!btn) return;
  const save = readCheckpoint();
  btn.hidden = !save;
  const hint = $('titleSaveHint');
  if (hint) hint.hidden = !save;
  const start = $('startBtn');
  if (start) {
    start.textContent = save ? '重新開始遊戲' : '開始新冒險';
    start.classList.toggle('title-action-primary', !save);
    start.classList.toggle('title-action-secondary', !!save);
  }
  if (save) btn.textContent = `繼續冒險 · 第 ${save.nextLevel} 關`;
}
function writeCheckpoint(completedLevel) {
  if (NET.on) return;                       // 多人遊戲由房主同步，不使用單人存檔
  if (completedLevel >= FINAL_LEVEL) { clearCheckpoint(); return; }
  const bonus = Math.min(PC.maxHpCap, player.maxHp + 2);
  const inventory = JSON.parse(JSON.stringify(inv));
  if (completedLevel === 1) inventory.ultimate = true; // 第一關過場獲得無影斬
  const data = {
    version: SAVE_VERSION, nextLevel: completedLevel + 1, inv: inventory,
    maxHp: bonus, runKills: game.runKills || 0,
    runBosses: game.runBosses || 0, runTime: game.runTime || 0,
    savedAt: Date.now()
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); }
  catch (err) { console.warn('關卡已完成，但存檔寫入失敗', err); }
  refreshContinueButton();
}
function continueCheckpoint() {
  const save = readCheckpoint();
  if (!save || NET.on) return false;
  inv = JSON.parse(JSON.stringify(save.inv));
  player = makePlayer();
  player.maxHp = Math.max(PC.startHp, Math.min(PC.maxHpCap, save.maxHp));
  game.ultCD = 0; game.ult = null; game.vacCD = 0; game.vac = null;
  game.seenHint = {};
  game.runKills = save.runKills; game.runBosses = save.runBosses; game.runTime = save.runTime;
  startLevel(save.nextLevel);
  return true;
}

/* =========================================================
 * 15. 關卡流程
 * ========================================================= */
function startLevel(n) {
  worldSeed = (Math.random() * 1e9) | 0;
  chunks = new Map(); grass = new Map();
  enemies = []; arrows = []; sparks = []; particles = []; texts = []; pickups = []; burningCells = []; ashCells = [];
  fireTick = 0; game.flurry = null; game.slowT = 0; game.shake = 0; game.flash = 0; game.hints = [];
  game.speech = null; game.bannerAt = 0; game.fadeAt = 0; game.ult = null; game.vac = null; lvl.holdSpawn = false;
  lvl.chestPlaced = false; lvl.cleared = false; lvl.chestPos = null;
  if (player) player.ultHidden = false;
  game.theme = themeOf(n);
  lvl.n = n; lvl.kills = 0; lvl.target = killTargetOf(n); lvl.maxAlive = Math.min(4 + n, 10);
  if (NET.on) lvl.maxAlive = Math.round(lvl.maxAlive * 1.5);         // 兩人時怪物多一點
  lvl.spawnT = 2; lvl.spawned = 0; lvl.bossSpawned = false; lvl.bossReward = null;
  lvl.late = !NET.on && n >= 16 && n <= 20 ? {wave:1, rest:0, captains:0, guards:0, bossDead:false, elapsed:0, supplyAt:15} : null;
  const ne = lvl.late ? 0 : eliteCount(n);                           // 精英怪在擊倒進度 1/(n+1)、2/(n+1)… 時出現
  lvl.elitesDue = Array.from({ length: ne }, (_, i) => Math.max(1, Math.round(lvl.target * (i + 1) / (ne + 1)))); lvl.elitesSpawned = 0;
  Sfx.musicReset();
  lvl.types = { melee: makeType('melee', n), brute: makeType('brute', n), archer: makeType('archer', n) };
  resetPlayerTransient(player);
  lvl.snapshot = { inv: JSON.parse(JSON.stringify(inv)), maxHp: player.maxHp };
  ensureChunks(SPAWN.x, SPAWN.y, GEN_RADIUS);
  if (NET.on) netPlaceChests(n);                      // 連線：有幾個人（還沒有吸怪器）就放幾個箱子
  else if (n === 6 && !inv.vacuum) placeSkillChest();     // 狂暴的第一關：亞特右邊的神秘箱子，打開前沒有怪物
  const off = Math.hypot(VW, VH) / 2;              // 開場的怪物生成在畫面外，慢慢走過來
  if (!lvl.holdSpawn && !lateActive()) { trySpawnEnemy(off + 60, off + 300); trySpawnEnemy(off + 60, off + 300); }
  snapCamera();
  if (netHostOn()) netHostLevelEvent(false);          // 告訴隊友：一起進入這一關
}
function levelBanner() {
  const hz = HAZARD_OF_THEME[(lvl.n - 1) % THEMES.length];
  if (hz) showHint('hz-' + hz, HAZARD_HINT[hz], 8);
  Sfx.play('levelStart', { player: true });
  game.banner = { title: `第 ${lvl.n} 關　${levelName(lvl.n)}`, sub: lateActive() ? lateGoal(lvl.n) : isBossLevel(lvl.n) ? `擊倒 ${lvl.target} 隻怪物後，大魔王將會現身` : `擊倒 ${lvl.target} 隻怪物`, t: 3.5 };
  if (lvl.n === 1) {
    showHint(null, '揮劍敲擊右邊的火爆石，火花會點燃草叢', 8);
    showHint(null, '敵人揮擊的前一刻閃避，就能觸發迅影時刻', 8);
  }
}
function newRun() {
  inv = newInventory();
  game.ultCD = 0; game.ult = null; game.vacCD = 0; game.vac = null;
  player = makePlayer();
  game.seenHint = {};
  game.runKills = 0; game.runBosses = 0; game.runTime = 0;
  if (NET.on) NET.newRunFlag = true;                  // 連線：通關後再玩一次，兩個人一起從頭開始
  startLevel(1);
}
function retryLevel() {
  inv = JSON.parse(JSON.stringify(lvl.snapshot.inv));
  game.ultCD = 0; game.ult = null; game.vacCD = 0; game.vac = null;
  const maxHp = lvl.snapshot.maxHp;
  player = makePlayer(); player.maxHp = maxHp;
  if (NET.on) NET.retryFlag = true;
  startLevel(lvl.n);
}
function levelClear() {
  game.mode = 'levelclear'; game.endT = 2.2; game.flurry = null; lvl.cleared = true;
  if (netHostOn()) netWorld({ k: 'cl', n: lvl.n });
  writeCheckpoint(lvl.n);
  resetInputs();
  Sfx.play('levelClear', { player: true });
  game.banner = { title: `第 ${lvl.n} 關完成！`, sub: lvl.bossReward ? '大魔王的寶物已經收進背包' : '這片土地安靜下來了', t: 2.4 };
  if (lvl.n === 1) {                                 // 第一關：畫面慢慢變黑，接著播放結局動畫
    game.endT = 3.4;
    game.fadeAt = game.time + 1.2; game.fadeDucked = false;
  }
}
// 第一關結局動畫播完（或跳過）→ 直接傳送到第二關
function playChapter1Ending() {
  game.mode = 'between'; game.cutscene = true;
  Sfx.setSlow(false);
  playChapter1End(() => {
    game.cutscene = false; game.fadeAt = 0;
    if (netGuest()) { inv.ultimate = true; Sfx.duck(false); netGuestAfterCutscene(); return; }   // 隊友：等房主一起前往第 2 關
    const grow = player.maxHp < PC.maxHpCap;
    player.maxHp = Math.min(PC.maxHpCap, player.maxHp + 2);
    inv.ultimate = true;                             // 捏碎「無影斬」珠子：習得無影斬
    startLevel(2);
    startPlay();
    Sfx.duck(false);
    showHint(null, grow ? '通過燼野的第一道試煉：最大生命 +1 顆心' : '通過燼野的第一道試煉：生命全部回滿', 5);
    showHint(null, '習得「無影斬」：畫面內有敵人時按下，自動斬殺最近的 4 個敵人（冷卻 3 分鐘）', 8);
  });
}
function showLevelScreen() {
  game.mode = 'between';
  const next = lvl.n + 1, th = themeOf(next);
  const grow = player.maxHp < PC.maxHpCap;
  levelTitle.textContent = `第 ${lvl.n} 關完成`;
  levelText.textContent = (lvl.bossReward ? `擊敗大魔王的獎勵：${lvl.bossReward.join('、')}。` : '') +
    `${grow ? '最大生命 +1 顆心，' : ''}生命全部回滿。下一關是「${levelName(next)}」，怪物長得不一樣，也更強，需要擊倒 ${killTargetOf(next)} 隻` +
    (isBossLevel(next) ? '，之後大魔王會現身。' : '。');
  if (!NET.on && next >= 16 && next <= 20) levelText.textContent = `${grow ? '最大生命 +1 顆心，' : ''}生命全部回滿。下一關：${levelName(next)}。${lateGoal(next)}。`;
  $('levelBtn').textContent = `前往第 ${next} 關`;
  levelScreen.classList.remove('hidden');
}
function endGame(result) {
  if (game.mode !== 'play') return;
  game.mode = 'ending'; game.endT = 1.6; game.result = result; game.flurry = null;
  resetInputs();
}
function showEnd() {
  game.mode = 'over';
  endTitle.textContent = NET.on ? '兩個人都倒下了' : '亞特倒下了';
  endText.textContent = `第 ${lvl.n} 關，擊倒 ${lvl.kills} / ${lvl.target} 隻怪物。` + (NET.on ? '任何一個人按「重新挑戰本關」，兩個人就會一起重來。' : '試著在敵人出手前一刻閃避或舉盾。');
  if (lateActive()) endText.textContent = `第 ${lvl.n} 關：${lateProgress()}。可以重新挑戰本關。`;
  $('retryBtn').textContent = '重新挑戰本關';
  $('restartAllBtn').style.display = NET.on ? 'none' : '';
  endScreen.classList.remove('hidden');
}
function hideAllOverlays() {
  [startScreen, endScreen, pauseScreen, levelScreen, bagScreen, $('helpScreen'), $('netScreen')].forEach(el => el.classList.add('hidden'));
  NET.uiOpen = false;
}
// intro：序章結束後的第一次進場——亞特收著刀、先說話，關卡標題稍後才出現
function startPlay(opts) {
  resetInputs();
  game.mode = 'play'; game.paused = false;
  hideAllOverlays();
  if (opts && opts.intro) {
    player.sheathed = true;
    player.drawAfter = game.time + 3.6;            // 先把這句話說完，才會因為看到怪物而拔刀
    say('咦，這裡是哪裡？', 0.5, 3.1);
    game.bannerAt = game.time + 3.8;
  } else {
    player.sheathed = false;
    levelBanner();
  }
}
// 亞特頭上的對話框
function say(text, delay, dur) { game.speech = { text, t0: game.time + (delay || 0), t1: game.time + (delay || 0) + (dur || 2) }; }
// 看到怪物（或先按了攻擊）時拔出旅人短劍
function drawKnife(seen) {
  const p = player;
  p.sheathed = false;
  Sfx.play('unsheathe', { player: true });
  burst(p.x + 10, p.y - 10, 12, '#fff2c4', 40, 150, 0.45, 2);
  if (seen) say('是怪物！', 0, 1.8);
}
function pauseGame() {
  if (game.mode !== 'play') return;
  game.paused = true; resetInputs(); player.aiming = false;
  $('restartBtn').style.display = NET.on ? 'none' : '';      // 連線時不能一個人重來
  pauseScreen.classList.remove('hidden');
}
function resumeGame() { game.paused = false; resetInputs(); pauseScreen.classList.add('hidden'); }

function tryFullscreenLandscape() {
  const el = document.documentElement;
  try {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) { const r = req.call(el); if (r && typeof r.catch === 'function') r.catch(() => {}); }
  } catch (err) { /* 不支援就略過 */ }
  try {
    if (screen.orientation && screen.orientation.lock) { const r = screen.orientation.lock('landscape'); if (r && r.catch) r.catch(() => {}); }
  } catch (err) { /* 不支援就略過 */ }
}
$('continueBtn').addEventListener('click', () => {
  if (startScreen.classList.contains('hidden')) return;
  Sfx.unlock(); loadSavedMusic(); tryFullscreenLandscape();
  if (!continueCheckpoint()) return;
  startPlay();
});
function beginFreshAdventure() {
  Sfx.unlock(); loadSavedMusic(); tryFullscreenLandscape();
  clearCheckpoint(); // 只有玩家按下明確按鈕並通過確認後才清除
  $('newRunConfirm').classList.add('hidden');
  startScreen.classList.add('hidden');
  newRun();
  playPrologue(() => startPlay({ intro: true }));
}
$('startBtn').addEventListener('click', () => {
  if (startScreen.classList.contains('hidden')) return;
  if (readCheckpoint()) {
    $('newRunConfirm').classList.remove('hidden');
    $('cancelNewRunBtn').focus();
    return;
  }
  beginFreshAdventure();
});
$('cancelNewRunBtn').addEventListener('click', () => {
  $('newRunConfirm').classList.add('hidden');
  $('startBtn').focus();
});
$('confirmNewRunBtn').addEventListener('click', () => {
  if (startScreen.classList.contains('hidden')) return;
  beginFreshAdventure();
});
$('helpBtn').addEventListener('click', () => { pauseScreen.classList.add('hidden'); $('helpScreen').classList.remove('hidden'); });
$('helpBackBtn').addEventListener('click', () => { $('helpScreen').classList.add('hidden'); pauseScreen.classList.remove('hidden'); });
$('resumeBtn').addEventListener('click', resumeGame);
// ---- 音量滑桿：拖動時即時生效；音效滑桿會播一聲打擊聲讓你試聽 ----
function showVol(id, v) {
  const pct = Math.round(v * 100);
  $(id).value = pct;
  $(id).style.setProperty('--fill', pct + '%');
  $(id + 'Out').textContent = pct + '%';
}
function refreshAudioButtons() { showVol('sfxVol', Sfx.st.sfxVol); showVol('musicVol', Sfx.st.musicVol); }
let lastPreview = 0;
$('sfxVol').addEventListener('input', e => {
  Sfx.unlock();
  Sfx.setSfxVol(e.target.value / 100); showVol('sfxVol', Sfx.st.sfxVol);
  const now = performance.now();
  if (now - lastPreview > 180) { lastPreview = now; Sfx.play('hit', { player: true }); }
});
$('musicVol').addEventListener('input', e => {
  Sfx.unlock();
  Sfx.setMusicVol(e.target.value / 100); showVol('musicVol', Sfx.st.musicVol);
});
refreshAudioButtons();

// ---- 自訂背景音樂：從 iPad 選檔案，存在這台裝置的瀏覽器裡（IndexedDB），不會包進遊戲 ----
const MusicStore = {
  open() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('no idb')); return; }
      const r = indexedDB.open('ater-music', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async op(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('files', mode), req = fn(tx.objectStore('files'));
      tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error);
    });
  },
  save(name, data) { return this.op('readwrite', st => st.put({ name, data }, 'bgm')); },
  load() { return this.op('readonly', st => st.get('bgm')); },
  clear() { return this.op('readwrite', st => st.delete('bgm')); },
};
function setMusicNote(text) { $('musicNote').textContent = text; }
function refreshMusicNote() {
  setMusicNote(Sfx.customName ? `目前播放：${Sfx.customName}` : '目前播放：原創英雄主題');
  $('defaultMusicBtn').style.display = Sfx.customName ? '' : 'none';
}
function readFileBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(file); });
}
$('musicFile').addEventListener('click', () => Sfx.unlock());
$('musicFile').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { setMusicNote('檔案太大了（超過 60MB），請換一個短一點的檔案'); return; }
  setMusicNote('讀取中…');
  try {
    const data = await readFileBuffer(file);
    const name = file.name.replace(/\.[^.]+$/, '');
    const sec = await Sfx.setCustom(data, name);
    try { await MusicStore.save(name, data); } catch (err) { /* 存不了就只在這次遊玩有效 */ }
    refreshMusicNote();
    setMusicNote(`目前播放：${name}（${Math.round(sec)} 秒，會自動循環）`);
  } catch (err) {
    setMusicNote('這個檔案無法播放，請改用 mp3 或 m4a 檔');
  }
});
$('defaultMusicBtn').addEventListener('click', async () => {
  Sfx.clearCustom();
  try { await MusicStore.clear(); } catch (err) { /* 略過 */ }
  refreshMusicNote();
});
// 開始遊戲時，把上次選的音樂載回來
let savedMusicTried = false;
async function loadSavedMusic() {
  if (savedMusicTried) return;
  savedMusicTried = true;
  try {
    const rec = await MusicStore.load();
    if (rec && rec.data) { await Sfx.setCustom(rec.data, rec.name); refreshMusicNote(); }
  } catch (err) { /* 沒有存過或讀不到 */ }
}
refreshMusicNote();
$('restartBtn').addEventListener('click', () => { retryLevel(); startPlay(); });
$('retryBtn').addEventListener('click', () => {
  tryFullscreenLandscape();
  if (netGuest()) { netAct({ a: 'retry', n: lvl.n }); $('retryBtn').textContent = '等待房主…'; return; }
  retryLevel(); startPlay();
});
$('restartAllBtn').addEventListener('click', () => { tryFullscreenLandscape(); clearCheckpoint(); newRun(); startPlay(); });
// iOS Safari/PWA：在觸控結束時直接處理，避免 touchmove 後 click 未產生。
// preventDefault 避免同一次觸控再合成第二個 click；滑鼠/鍵盤仍走 click。
const closeBagButton = $('closeBagBtn');
closeBagButton.addEventListener('touchend', e => {
  if (e.cancelable) e.preventDefault();
  const touch = e.changedTouches[0];
  if (!touch) return;
  const r = closeBagButton.getBoundingClientRect();
  if (touch.clientX < r.left || touch.clientX > r.right ||
      touch.clientY < r.top || touch.clientY > r.bottom) return;
  if (!bagScreen.classList.contains('hidden')) closeBag();
}, { passive: false });
closeBagButton.addEventListener('click', () => {
  if (!bagScreen.classList.contains('hidden')) closeBag();
});
$('levelBtn').addEventListener('click', () => {
  if (netGuest()) { netAct({ a: 'next', n: lvl.n }); $('levelBtn').textContent = '等待房主…'; return; }
  player.maxHp = Math.min(PC.maxHpCap, player.maxHp + 2);
  startLevel(lvl.n + 1);
  startPlay();
});

/* =========================================================
 * 16. 畫面尺寸與方向
 * ========================================================= */
let ignoreOrientation = false;
function deviceIsPortrait() {           // 優先看「裝置」方向，不看預覽面板的長寬比
  if (ignoreOrientation) return false;
  try { if (screen.orientation && typeof screen.orientation.type === 'string') return screen.orientation.type.indexOf('portrait') === 0; } catch (err) { /* 略過 */ }
  if (typeof window.orientation === 'number') return Math.abs(window.orientation) !== 90;
  return window.innerHeight > window.innerWidth;
}
function resize() {
  VW = window.innerWidth; VH = window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(VW * DPR); canvas.height = Math.round(VH * DPR);
  const cs = getComputedStyle(probe);
  SAFE.t = parseFloat(cs.paddingTop) || 0; SAFE.r = parseFloat(cs.paddingRight) || 0;
  SAFE.b = parseFloat(cs.paddingBottom) || 0; SAFE.l = parseFloat(cs.paddingLeft) || 0;
  layoutUI();
  const portrait = deviceIsPortrait();
  if (portrait !== game.portrait) { game.portrait = portrait; resetInputs(); }
  rotateHint.classList.toggle('hidden', !game.portrait);
  if (player) snapCamera();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
try { if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', () => setTimeout(resize, 150)); } catch (err) { /* 略過 */ }
$('ignoreRotateBtn').addEventListener('click', () => { ignoreOrientation = true; resize(); });

function snapCamera() { cam.x = player.x - VW / 2; cam.y = player.y - VH / 2; }
function updateCamera(dt) {
  const k = 1 - Math.exp(-10 * dt);
  const f = NET.on && player.dead && netMateAlive() ? NET.mate : player;
  cam.x += (f.x - VW / 2 - cam.x) * k; cam.y += (f.y - VH / 2 - cam.y) * k;
}

/* =========================================================
 * 17. 繪圖
 * ========================================================= */
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }
function heartPath(x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.4);
  ctx.bezierCurveTo(x - s, y - s * 0.2, x - s * 0.5, y - s * 0.95, x, y - s * 0.45);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.95, x + s, y - s * 0.2, x, y + s * 0.4);
  ctx.closePath();
}
// 不同關卡的怪物外形
function shapePath(shape, x, y, h, face) {
  if (shape === 'square') { rr(x - h, y - h, h * 2, h * 2, Math.max(4, h * 0.3)); return; }
  ctx.beginPath();
  if (shape === 'circle') { ctx.arc(x, y, h * 1.05, 0, TAU); return; }
  let pts;
  if (shape === 'diamond') pts = [[0, -1.25], [1.25, 0], [0, 1.25], [-1.25, 0]].map(([a, b]) => [x + a * h, y + b * h]);
  else if (shape === 'hex') { pts = []; for (let k = 0; k < 6; k++) { const a = k * TAU / 6 + Math.PI / 6; pts.push([x + Math.cos(a) * h * 1.12, y + Math.sin(a) * h * 1.12]); } }
  else { pts = [0, 2.3, -2.3].map((o, i) => [x + Math.cos(face + o) * h * (i ? 1.15 : 1.35), y + Math.sin(face + o) * h * (i ? 1.15 : 1.35)]); }
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
  ctx.closePath();
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#16241a'; ctx.fillRect(0, 0, VW, VH);
  if (!player) return;
  const sx = game.shake > 0 ? (Math.random() * 2 - 1) * game.shake : 0;
  const sy = game.shake > 0 ? (Math.random() * 2 - 1) * game.shake : 0;
  ctx.save();
  ctx.translate(Math.round(-cam.x + sx), Math.round(-cam.y + sy));
  const v = { x0: cam.x - 80, y0: cam.y - 80, x1: cam.x + VW + 80, y1: cam.y + VH + 80 };
  drawGround(v); drawGrass(v); drawHazards(v); drawSolids(v); drawPickups(); drawSparks(); drawArrows();
  drawEnemies(v); if (NET.on) drawMate(); drawPlayer(); drawParticles(); drawTexts();
  ctx.restore();

  if (game.flurry) {                    // 迅影時刻：世界染上冷色
    ctx.fillStyle = 'rgba(40,80,170,0.18)'; ctx.fillRect(0, 0, VW, VH);
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.3, VW / 2, VH / 2, Math.max(VW, VH) * 0.7);
    g.addColorStop(0, 'rgba(10,20,60,0)'); g.addColorStop(1, 'rgba(10,20,60,0.45)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
  }
  if (game.ult) {
    ctx.fillStyle = 'rgba(70,0,12,0.28)'; ctx.fillRect(0, 0, VW, VH);
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.25, VW / 2, VH / 2, Math.max(VW, VH) * 0.7);
    g.addColorStop(0, 'rgba(40,0,6,0)'); g.addColorStop(1, 'rgba(40,0,6,0.65)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
    if (game.ult.phase === 'charge') {
      const a = Math.min(1, game.ult.t / 0.25) * (1 - Math.max(0, (game.ult.t - 0.7) / 0.25));
      ctx.save(); ctx.globalAlpha = clamp(a, 0, 1);
      ctx.font = '900 64px "PingFang TC", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(255,40,60,0.95)'; ctx.shadowBlur = 24;
      ctx.fillStyle = '#ffe6ea'; ctx.fillText('無影斬', VW / 2, VH * 0.3);
      ctx.restore();
    }
  }
  if (game.flash > 0) { ctx.fillStyle = `rgba(255,236,160,${game.flash * 0.35})`; ctx.fillRect(0, 0, VW, VH); }
  if (game.mode === 'play' && player.hp <= 3) {
    const pulse = 0.25 + 0.15 * Math.sin(game.time * 6);
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, 'rgba(180,0,0,0)'); g.addColorStop(1, `rgba(180,0,0,${pulse})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
  }
  drawVacuum();
  if (game.mode !== 'title') { drawOffscreenMarkers(); if (NET.on) netMateMarker(); drawHUD(); if (NET.on) netHud(); drawSpeech(); drawBanner(); drawAudioNotice(); }
  if (game.mode === 'play') drawControls();
  if (game.fadeAt) {                                 // 破完第一關後畫面慢慢變黑
    const a = clamp((game.time - game.fadeAt) / 1.8, 0, 1);
    if (a > 0) { ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fillRect(0, 0, VW, VH); }
  }
}

function drawGround(v) {
  const th = game.theme, T = 64;
  ctx.fillStyle = th.ground[0];
  ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
  const tx0 = Math.floor(v.x0 / T), tx1 = Math.floor(v.x1 / T), ty0 = Math.floor(v.y0 / T), ty1 = Math.floor(v.y1 / T);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const h = hash2(tx, ty);
      if (h < 0.3) { ctx.fillStyle = th.ground[1]; ctx.fillRect(tx * T, ty * T, T, T); }
      else if (h > 0.82) { ctx.fillStyle = th.ground[2]; ctx.fillRect(tx * T, ty * T, T, T); }
      if (h > 0.93) { ctx.fillStyle = h > 0.965 ? th.deco[0] : th.deco[1]; circle(tx * T + 20 + h * 20, ty * T + 30, 3); ctx.fill(); }
    }
  }
}
function drawGrass(v) {
  const th = game.theme;
  const gx0 = Math.floor(v.x0 / CELL), gx1 = Math.floor(v.x1 / CELL), gy0 = Math.floor(v.y0 / CELL), gy1 = Math.floor(v.y1 / CELL);
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const c = grass.get(gk(gx, gy));
      if (!c) continue;
      const x = gx * CELL, y = gy * CELL;
      if (c.state === 'grass') {
        ctx.fillStyle = c.seed % 3 === 0 ? th.grass[0] : th.grass[1];
        ctx.fillRect(x, y, CELL, CELL);
        const sway = Math.sin(game.time * 2 + c.seed) * 2;
        ctx.fillStyle = th.grass[2];
        for (let k = 0; k < 3; k++) {
          const bx = x + 4 + ((c.seed * (k + 3)) % 18);
          ctx.beginPath(); ctx.moveTo(bx, y + CELL - 5); ctx.lineTo(bx + 4 + sway, y + 6 + k * 3); ctx.lineTo(bx + 8, y + CELL - 5); ctx.fill();
        }
      } else if (c.state === 'burning') {
        const f = 0.5 + 0.5 * Math.sin(game.time * 22 + c.seed);
        ctx.fillStyle = `rgb(${(200 + f * 55) | 0},${(38 + f * 40) | 0},28)`;
        ctx.fillRect(x, y, CELL, CELL);
        ctx.fillStyle = `rgba(255,${(190 + f * 50) | 0},90,0.95)`;
        ctx.beginPath(); ctx.moveTo(x + 6, y + CELL - 3); ctx.lineTo(x + CELL / 2 + (f - 0.5) * 6, y + 1 + f * 6); ctx.lineTo(x + CELL - 6, y + CELL - 3); ctx.fill();
      } else {
        ctx.fillStyle = `rgba(42,34,30,${0.6 * Math.min(1, c.t / 3)})`;
        ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
      }
    }
  }
  if (burningCells.length) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const c of burningCells) {
      const x = c.gx * CELL + CELL / 2, y = c.gy * CELL + CELL / 2;
      if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
      ctx.fillStyle = 'rgba(255,120,40,0.12)'; circle(x, y, 30); ctx.fill();
    }
    ctx.restore();
  }
}
const SCR_DRAW = [];
function drawSolids(v) {
  const th = game.theme;
  for (const s of solidsInBox(v.x0, v.y0, v.x1, v.y1, SCR_DRAW)) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(s.x + 3, s.y + 6, s.w, s.h, 7); ctx.fill();
    if (s.kind === 'rock') {
      ctx.fillStyle = th.rock[0]; rr(s.x, s.y, s.w, s.h, 8); ctx.fill();
      ctx.fillStyle = th.rock[1]; rr(s.x + 4, s.y + 4, s.w - 8, s.h * 0.42, 6); ctx.fill();
      ctx.strokeStyle = th.rock[2]; ctx.lineWidth = 2; rr(s.x, s.y, s.w, s.h, 8); ctx.stroke();
    } else if (s.kind === 'crate') {
      ctx.fillStyle = '#b07a3e'; ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = '#6e4620'; ctx.lineWidth = 3; ctx.strokeRect(s.x + 1.5, s.y + 1.5, s.w - 3, s.h - 3);
      ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(s.x + 4, s.y + 4); ctx.lineTo(s.x + s.w - 4, s.y + s.h - 4);
      ctx.moveTo(s.x + s.w - 4, s.y + 4); ctx.lineTo(s.x + 4, s.y + s.h - 4); ctx.stroke();
    } else {
      const glow = 0.55 + 0.45 * Math.sin(game.time * 3 + s.x * 0.01);
      ctx.fillStyle = (s.flash || 0) > 0 ? '#fff1cf' : '#5b2618'; rr(s.x, s.y, s.w, s.h, 7); ctx.fill();
      ctx.strokeStyle = `rgba(255,${(110 + 80 * glow) | 0},40,${0.55 + 0.45 * glow})`; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x + 7, s.y + 9); ctx.lineTo(s.x + 16, s.y + 17); ctx.lineTo(s.x + 11, s.y + 28);
      ctx.moveTo(s.x + 29, s.y + 6); ctx.lineTo(s.x + 21, s.y + 18); ctx.lineTo(s.x + 28, s.y + 30);
      ctx.stroke();
      ctx.strokeStyle = '#2a0f08'; ctx.lineWidth = 2; rr(s.x, s.y, s.w, s.h, 7); ctx.stroke();
    }
  }
}
function drawSwordIcon(x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = color; ctx.fillRect(-s * 0.12, -s, s * 0.24, s * 1.3);
  ctx.fillStyle = '#7a4a22'; ctx.fillRect(-s * 0.4, s * 0.3, s * 0.8, s * 0.16); ctx.fillRect(-s * 0.1, s * 0.4, s * 0.2, s * 0.45);
  ctx.restore();
}
function drawBowIcon(x, y, s) {
  ctx.strokeStyle = '#a8703a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x - s * 0.3, y, s, -1.1, 1.1); ctx.stroke();
  ctx.strokeStyle = '#f1ead2'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x - s * 0.3 + Math.cos(-1.1) * s, y + Math.sin(-1.1) * s); ctx.lineTo(x - s * 0.3 + Math.cos(1.1) * s, y + Math.sin(1.1) * s); ctx.stroke();
}
function drawPickups() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const h of pickups) {
    if (h.life < 3 && Math.floor(h.life * 8) % 2 === 0) continue;
    const y = h.y + Math.sin(h.t * 4) * 3 - (h.air > 0 ? Math.sin((1 - h.air / h.airMax) * Math.PI) * 60 : 0);   // 吐出來的拋物線
    if (h.kind === 'food') {
      if (h.heal >= 4) {
        ctx.fillStyle = '#a0522d'; ctx.beginPath(); ctx.ellipse(h.x, y, 11, 8, -0.4, 0, TAU); ctx.fill();
        ctx.fillStyle = '#f5ecd7'; circle(h.x + 10, y - 7, 3.5); ctx.fill();
      } else {
        ctx.fillStyle = '#e8413a'; circle(h.x, y, 9); ctx.fill();
        ctx.fillStyle = '#5fbf4a'; ctx.beginPath(); ctx.ellipse(h.x + 4, y - 10, 5, 2.5, -0.5, 0, TAU); ctx.fill();
      }
    } else if (h.kind === 'arrows') {
      ctx.strokeStyle = '#e8dcc0'; ctx.lineWidth = 2.5;
      for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(h.x - 10, y + k * 5 + 4); ctx.lineTo(h.x + 10, y + k * 5 - 4); ctx.stroke(); }
      ctx.fillStyle = '#ffd666'; ctx.font = 'bold 12px "PingFang TC", sans-serif'; ctx.fillText('×' + h.count, h.x, y - 16);
    } else if (h.kind === 'goldchest') {
      drawGoldChest(h, y);
    } else if (h.kind === 'skillchest') {
      drawSkillChest(h, y);
    } else {
      const it = h.item || asItem(h.id, h.kind), R0 = RARITY[it.rarity];
      const pulse = 0.5 + 0.5 * Math.sin(h.t * 5);
      const rgb = it.rarity === 'legend' ? '255,201,79' : it.rarity === 'rare' ? '111,182,255' : '255,226,122';
      if (it.rarity === 'legend') {                     // 傳說：金色光柱
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createLinearGradient(0, y - 120, 0, y);
        g.addColorStop(0, 'rgba(255,201,79,0)'); g.addColorStop(1, `rgba(255,201,79,${0.25 + 0.1 * pulse})`);
        ctx.fillStyle = g; ctx.fillRect(h.x - 8, y - 120, 16, 120); ctx.restore();
      }
      ctx.fillStyle = `rgba(${rgb},${0.18 + 0.15 * pulse})`; circle(h.x, y, 20); ctx.fill();
      if (h.kind === 'weapon') drawSwordIcon(h.x, y, 13, '#dfe6f0'); else drawBowIcon(h.x, y, 12);
      const name = itemName(it);
      ctx.font = 'bold 13px "PingFang TC", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(name, h.x, y - 28); ctx.fillStyle = it.rarity === 'common' ? '#ffe27a' : R0.color; ctx.fillText(name, h.x, y - 28);
    }
  }
}
function drawSparks() {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const s of sparks) {
    const a = clamp(s.life / s.max, 0, 1);
    ctx.fillStyle = `rgba(255,170,60,${0.35 * a})`; circle(s.x, s.y, 7); ctx.fill();
    ctx.fillStyle = `rgba(255,245,180,${a})`; circle(s.x, s.y, 2.6); ctx.fill();
  }
  ctx.restore();
}
function drawArrows() {
  for (const a of arrows) {
    if (a.orb) {                                    // 大魔王的虛空光彈（被反彈後變金色）
      const col = a.owner === 'player' ? '255,226,122' : '170,110,255';
      ctx.fillStyle = `rgba(${col},0.3)`; circle(a.x, a.y, 11); ctx.fill();
      ctx.fillStyle = `rgb(${col})`; circle(a.x, a.y, 6); ctx.fill();
      ctx.fillStyle = '#ffffff'; circle(a.x - 2, a.y - 2, 2); ctx.fill();
      continue;
    }
    const sp = Math.hypot(a.vx, a.vy) || 1, ux = a.vx / sp, uy = a.vy / sp;
    if (a.fire) { ctx.fillStyle = 'rgba(255,140,40,0.35)'; circle(a.x, a.y, 8); ctx.fill(); }
    ctx.strokeStyle = a.owner === 'player' ? '#f1e6c8' : '#ff9a7a'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x - ux * 18, a.y - uy * 18); ctx.lineTo(a.x, a.y); ctx.stroke();
    ctx.fillStyle = a.owner === 'player' ? '#cfd8e6' : '#ff5a4a';
    ctx.beginPath(); ctx.moveTo(a.x + ux * 5, a.y + uy * 5); ctx.lineTo(a.x - uy * 4, a.y + ux * 4); ctx.lineTo(a.x + uy * 4, a.y - ux * 4); ctx.fill();
  }
}
function drawEnemies(v) {
  let vacPend = false;                              // 被吸住的怪物：旋轉＋縮小（畫完下一隻前還原）
  for (const e of enemies) {
    if (vacPend) { ctx.restore(); vacPend = false; }
    if (e.dead || e.x < v.x0 || e.x > v.x1 || e.y < v.y0 || e.y > v.y1) continue;
    if (e.boss) { drawBoss(e); continue; }
    if (e.sucked) { ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.sucked.spin); ctx.scale(e.sucked.sc, e.sucked.sc); ctx.translate(-e.x, -e.y); vacPend = true; }
    const T = e.t, h = e.rad;
    if (e.elite) {                                     // 精英：金色光環
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,201,79,${0.16 + 0.08 * Math.sin(game.time * 4 + e.bob)})`; circle(e.x, e.y, h + 12); ctx.fill();
      ctx.restore();
    }
    const bob = (e.state === 'patrol' || e.state === 'chase') ? Math.sin(game.time * 7 + e.bob) * 1.5 : 0;
    const x = e.x, y = e.y + bob;
    const fx = Math.cos(e.face), fy = Math.sin(e.face), px = -fy, py = fx;

    if (e.state === 'windup') {
      if (T.ranged) {             // 射手：紅色瞄準虛線
        ctx.setLineDash([10, 8]);
        ctx.strokeStyle = e.stateT < 0.2 ? 'rgba(255,240,150,0.9)' : 'rgba(255,70,50,0.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x + fx * (h + 6), y + fy * (h + 6)); ctx.lineTo(x + fx * 420, y + fy * 420); ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = e.stateT < 0.18 ? 'rgba(255,240,150,0.7)' : 'rgba(255,80,60,0.35)';
        ctx.lineWidth = 2; circle(e.x, e.y, T.reach); ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(e.x, e.y + h - 2, h * 0.9, h * 0.35, 0, 0, TAU); ctx.fill();

    let color = e.state === 'patrol' ? T.colorPatrol : T.colorChase;
    if (e.state === 'stunned') color = '#6aa6d8';
    if (e.hurtFlash > 0) color = '#ffffff';
    if (T.elite) {            // 變種怪物：身上的尖刺（越後面的關卡越多）
      ctx.fillStyle = T.elite >= 2 ? '#ffd166' : '#2a1a2a';
      const n = 4 + T.elite * 2;
      for (let k = 0; k < n; k++) {
        const a = k * TAU / n + game.time * 0.5;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * (h + 9), y + Math.sin(a) * (h + 9));
        ctx.lineTo(x + Math.cos(a + 0.25) * h * 0.9, y + Math.sin(a + 0.25) * h * 0.9);
        ctx.lineTo(x + Math.cos(a - 0.25) * h * 0.9, y + Math.sin(a - 0.25) * h * 0.9);
        ctx.fill();
      }
    }
    ctx.fillStyle = color; shapePath(T.shape, x, y, h, e.face); ctx.fill();
    if (T.role === 'brute') { ctx.fillStyle = 'rgba(255,255,255,0.2)'; shapePath(T.shape, x, y - h * 0.15, h * 0.55, e.face); ctx.fill(); }
    if (e.state === 'windup' && !T.ranged) {
      const urgent = e.stateT < 0.18;
      ctx.strokeStyle = urgent ? '#fff27a' : `rgba(255,255,255,${0.5 + 0.5 * Math.sin(game.time * 30)})`;
      ctx.lineWidth = urgent ? 4 : 3; shapePath(T.shape, x, y, h + 3, e.face); ctx.stroke();
    } else { ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2; shapePath(T.shape, x, y, h, e.face); ctx.stroke(); }

    // 射手手上的弓
    if (T.ranged) {
      const bx = x + fx * (h + 2), by = y + fy * (h + 2);
      ctx.strokeStyle = '#8b5a2b'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(bx - fx * 8, by - fy * 8, 14, e.face - 1.1, e.face + 1.1); ctx.stroke();
      const e1x = bx - fx * 8 + Math.cos(e.face - 1.1) * 14, e1y = by - fy * 8 + Math.sin(e.face - 1.1) * 14;
      const e2x = bx - fx * 8 + Math.cos(e.face + 1.1) * 14, e2y = by - fy * 8 + Math.sin(e.face + 1.1) * 14;
      const pull = e.state === 'windup' ? 10 * (1 - clamp(e.stateT / T.windup, 0, 1)) : 0;
      ctx.strokeStyle = '#f1ead2'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(e1x, e1y); ctx.lineTo(bx - fx * (2 + pull), by - fy * (2 + pull)); ctx.lineTo(e2x, e2y); ctx.stroke();
    }
    // 眼睛
    for (const side of [-1, 1]) {
      const ex = x + fx * h * 0.35 + px * h * 0.38 * side, ey = y + fy * h * 0.35 + py * h * 0.38 * side;
      ctx.fillStyle = e.state === 'stunned' ? '#dfe9f5' : '#fff8e0'; circle(ex, ey, h * 0.2); ctx.fill();
      if (e.state !== 'stunned') { ctx.fillStyle = '#1b1020'; circle(ex + fx * 1.5, ey + fy * 1.5, h * 0.1); ctx.fill(); }
    }
    if (e.alertT > 0 || e.state === 'windup') {
      ctx.font = 'bold 22px "PingFang TC", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 4; ctx.strokeStyle = '#1b1020';
      ctx.strokeText('！', x, y - h - 20); ctx.fillStyle = e.state === 'windup' ? '#ff5a4a' : '#ffe066'; ctx.fillText('！', x, y - h - 20);
    }
    if (e.state === 'stunned') {
      ctx.fillStyle = '#ffe27a';
      for (let k = 0; k < 3; k++) { const a = game.time * 4 + k * TAU / 3; circle(x + Math.cos(a) * h * 0.9, y - h - 8 + Math.sin(a) * 4, 3.5); ctx.fill(); }
    }
    if (e.slowT > 0) { ctx.strokeStyle = 'rgba(159,216,255,0.85)'; ctx.lineWidth = 2; circle(x, y, h + 3); ctx.stroke(); }   // 寒霜：冰藍外圈
    if (e.elite) {                                     // 精英：王冠＋標籤＋一直顯示的金色血條
      ctx.fillStyle = '#ffc94f'; ctx.strokeStyle = '#5a3a10'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 10, y - h - 14); ctx.lineTo(x - 10, y - h - 22); ctx.lineTo(x - 5, y - h - 17); ctx.lineTo(x, y - h - 25); ctx.lineTo(x + 5, y - h - 17); ctx.lineTo(x + 10, y - h - 22); ctx.lineTo(x + 10, y - h - 14); ctx.closePath(); ctx.fill(); ctx.stroke();
      const w = h * 2.2, bx = x - w / 2, by = y - h - 10;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx, by, w, 5);
      ctx.fillStyle = '#ffc94f'; ctx.fillRect(bx, by, w * Math.max(0, e.hp / T.hp), 5);
    } else if (e.hp < T.hp) {
      const w = h * 2, bx = x - h, by = y - h - 10;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(bx, by, w, 4);
      ctx.fillStyle = '#ff6b5a'; ctx.fillRect(bx, by, w * Math.max(0, e.hp / T.hp), 4);
    }
  }
  if (vacPend) ctx.restore();
}
/* =========================================================
 * 亞特的像素角色：頭部依參考圖逐格描繪，身體部件分開繪製以便做動畫
 *   方向：down（正面）、up（背面）、side（側面，往左時鏡像）
 *   動作：idle（呼吸 2 格）、walk（走路 4 格）、swing（揮刀 3 格）、aim（拉弓）
 * ========================================================= */
const HERO = (() => {
  const W = 32, H = 36;
  const PAL = {
    K: '#2b1414', h: '#dcb877', H: '#bf9a5f', d: '#977048', b: '#8e4a2c', n: '#5b3724',
    r: '#3a2620', s: '#f6caa2', S: '#e3977b', w: '#ffffff', e: '#0b0b0b',
    g: '#9aa05c', G: '#6d7341', o: '#58603a', B: '#4a2c1e', L: '#7b4a24', l: '#a8703a',
    m: '#d6d8e0', M: '#8d909c', y: '#e8c070',
  };
  // ---- 頭部：帽子（第 0–12 列）＋臉（第 13–20 列）----
  const HAT = [
    '............KKKKKKKK............',
    '..........KKdHHhhhhHKK..........',
    '.........KddHHHhhhhhHHK.........',
    '........KdHHHHHhhhhhHHHK........',
    '.......KddHHHHHHhhhHHHHHK.......',
    '.......KdHHHHHHHHHHHHHHdK.......',
    '......KddHHHHHHHHHHHHHHddK......',
    '......KbbbbbbbbbbbbbbbbbbK......',
    '......KnbbbbbbbbbbbbbbbbnK......',
    '...KKKddHHHHHHHHHhhhhhhhhhKKK...',
    '..KddddHHHHHHHHHHHhhhhhhhhhhhK..',
    '.KdddddHHHHHHHHHHHHHHHhhhhhhhhK.',
    '.KKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.',
  ];
  const FACE = {
    down: [
      '.....KrrrrrSSSSSSSSSSSSSSSK.....',
      '.....KrrrsseewssssseewssssK.....',
      '.....KrrssseeessssseeessssK.....',
      '.....KrsssseeessssseeessssK.....',
      '.....KsssSSeeessssseeeSSssK.....',
      '.....KSssSSssssssssssSSssSK.....',
      '......KSSssssssssssssssSSK......',
      '.......KKSSSSSSSSSSSSSSKK.......',
    ],
    side: [
      '.....KrrrrrrrrSSSSSSSSSSSK......',
      '.....KrrrrrrsssssssseewssK......',
      '.....KrrrrrssssssssseeessK......',
      '.....KrrrrsSsssssssseeessK......',
      '.....KrrrsSSsssssSSsssssK.......',
      '.....KrrssssssssssssssssK.......',
      '......KSrssssssssssssSSK........',
      '.......KKSSSSSSSSSSSSKK.........',
    ],
    up: [
      '.....KrrnrrrrnrrrrrnrrrrrrK.....',
      '.....KrnrrrrnrrrrrnrrrrnrrK.....',
      '.....KnrrrrnrrrrrnrrrrnrrrK.....',
      '.....KrrrrnrrrrrnrrrrnrrrrK.....',
      '.....KrrrnrrrrrnrrrrnrrrrrK.....',
      '.....KSrrrrrrrrrrrrrrrrrrSK.....',
      '......KSSSSSSSSSSSSSSSSSK.......',
      '.......KKSSSSSSSSSSSSSSKK.......',
    ],
  };
  // ---- 身體（第 21–27 列，x 從 8 開始，寬 16）----
  const TORSO = {
    down: [
      'KGggggGKKGggggGK',
      'KGgggggGGgggggGK',
      'KGgGGGgGGgGGGgGK',
      'KGgGgGgGGgGgGgGK',
      'KGggggggGggggggK',
      'KnLLnnnyynnnnnnK',
      'KooooooooooooooK',
    ],
    up: [
      'KGgggggggggggggK',
      'KGgKLLLLLLLLKggK',
      'KGgKLllllllLKggK',
      'KGgKLLLLLLLLKggK',
      'KGgKLllllllLKggK',
      'KnnKKKKKKKKKKnnK',
      'KooooooooooooooK',
    ],
    side: [
      '..KGgggggggGK...',
      '..KGgggggggGK...',
      '..KGggGGGggGK...',
      '..KGggGgGggGK...',
      '..KGgggggggGK...',
      '..KnnnnnnnnnK...',
      '..KoooooooooK...',
    ],
  };
  const LEG = ['KoooK', 'KoooK', 'KoooK', 'KBBBK', 'KBBBK', 'KKKKK'];
  const ARM_L = ['.KKK', 'KGgK', 'KGgK', 'KssK', 'KsSK', '.KK.'];
  const ARM_R = ['KKK.', 'KgGK', 'KgGK', 'KssK', 'KSsK', '.KK.'];
  const ARM_UP = ['KKK', 'KsK', 'KsK', 'KgK', 'KgK', 'KKK'];        // 舉起的手（揮刀前）
  const ARM_SIDE = ['KKKK', 'KgGK', 'KgGK', 'KssK', 'KSsK', '.KK.'];
  const ARM_FWD = ['KKKKKK', 'KgggsK', 'KKKKKK'];                       // 向前伸直（側面拉弓）
  const MACHETE_DOWN = [[6, 28, 'L'], [5, 29, 'L'], [4, 30, 'm'], [3, 31, 'm'], [2, 32, 'm'], [5, 30, 'M'], [4, 31, 'M'], [3, 32, 'M'], [1, 33, 'm']];

  function grid() { return Array.from({ length: H }, () => new Array(W).fill(null)); }
  function stamp(g, rows, ox, oy, flip) {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[flip ? row.length - 1 - x : x];
        const gy = oy + y, gx = ox + x;
        if (ch !== '.' && gy >= 0 && gy < H && gx >= 0 && gx < W) g[gy][gx] = ch;
      }
    });
  }
  function dot(g, x, y, ch) { if (y >= 0 && y < H && x >= 0 && x < W) g[y][x] = ch; }
  // 外框：任何空格只要旁邊有上色的像素（且不是外框）就補上深色描邊
  function outline(g) {
    const add = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (g[y][x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const v = g[y + dy] && g[y + dy][x + dx];
        if (v && v !== 'K') { add.push([x, y]); break; }
      }
    }
    for (const [x, y] of add) g[y][x] = 'K';
  }

  // dir: down/up/side（side＝面向右）；pose: idle/walk/swing/aim；phase: 動畫格
  function build(dir, pose, phase, opts) {
    const unarmed = !!(opts && opts.unarmed);    // 還沒拿到刀的版本（動畫用）
    const g = grid();
    let bob = 0, legA = 0, legB = 0, legAx = 0, legBx = 0, armA = 0, armB = 0;
    if (pose === 'idle') bob = phase % 2;
    if (pose === 'walk') {
      bob = phase % 2 === 1 ? -1 : 0;
      if (phase === 0) { legA = -1; armA = 1; armB = -1; legAx = 1; legBx = -1; }
      if (phase === 2) { legB = -1; armA = -1; armB = 1; legAx = -1; legBx = 1; }
    }
    // 腿
    if (dir === 'side') {
      stamp(g, LEG, 12 + legAx * 2, 28 + legA, false);
      stamp(g, LEG, 15 + legBx * 2, 28 + legB, false);
    } else {
      stamp(g, LEG, 10, 28 + legA, false);
      stamp(g, LEG, 17, 28 + legB, false);
    }
    const ub = bob;   // 上半身的上下起伏
    // 背面：手臂在身體後方先畫
    stamp(g, TORSO[dir], 8, 21 + ub, false);
    stamp(g, HAT, 0, 0 + ub, false);
    stamp(g, FACE[dir], 0, 13 + ub, false);
    // 手臂
    if (dir === 'side') {
      if (pose === 'aim') {
        stamp(g, ARM_FWD, 18, 23 + ub, false);
      } else if (pose === 'swing') {
        if (phase === 0) stamp(g, ARM_UP, 13, 17 + ub, false);
        else if (phase === 1) stamp(g, ARM_FWD, 18, 22 + ub, false);
        else stamp(g, ARM_SIDE, 16, 23 + ub, false);
      } else {
        stamp(g, ARM_SIDE, 14 + armA, 22 + ub, false);
        if (pose !== 'aim' && !unarmed) {        // 手上拿著的開山刀（往前下方）
          const hx = 15 + armA, hy = 27 + ub;
          dot(g, hx + 2, hy, 'L'); dot(g, hx + 3, hy, 'L');
          for (let k = 0; k < 5; k++) { dot(g, hx + 4 + k, hy + Math.floor(k / 2), 'm'); dot(g, hx + 4 + k, hy + 1 + Math.floor(k / 2), 'M'); }
        }
      }
    } else {
      const weaponLeft = dir === 'down';                 // 正面：拿刀的手在畫面左邊；背面在右邊
      const wArmX = weaponLeft ? 5 : 23, oArmX = weaponLeft ? 23 : 5;
      const wArm = weaponLeft ? ARM_L : ARM_R, oArm = weaponLeft ? ARM_R : ARM_L;
      if (pose === 'aim') {
        // 雙手往前（正面在胸前、背面看不到手掌）
        stamp(g, ARM_L, 7, 21 + ub, false); stamp(g, ARM_R, 21, 21 + ub, false);
        if (dir === 'down') { dot(g, 13, 25 + ub, 's'); dot(g, 14, 25 + ub, 's'); dot(g, 17, 25 + ub, 's'); dot(g, 18, 25 + ub, 's'); }
      } else if (pose === 'swing') {
        stamp(g, oArm, oArmX, 22 + ub, false);
        if (phase === 0) stamp(g, ARM_UP, weaponLeft ? 6 : 23, 16 + ub, false);
        else if (phase === 1) stamp(g, ARM_FWD, weaponLeft ? 2 : 24, 23 + ub, !weaponLeft);
        else stamp(g, wArm, wArmX, 23 + ub, false);
      } else {
        stamp(g, wArm, wArmX, 22 + ub + (weaponLeft ? armA : armB), false);
        stamp(g, oArm, oArmX, 22 + ub + (weaponLeft ? armB : armA), false);
        if (unarmed) { /* 空手 */ } else if (dir === 'down') {
          const dy = ub + armA;
          for (const [x, y, c] of MACHETE_DOWN) dot(g, x, y + dy, c);
        } else {                      // 背面：刀從右手垂下
          const dy = ub + armB;
          dot(g, 25, 28 + dy, 'L'); dot(g, 26, 29 + dy, 'L');
          for (let k = 0; k < 4; k++) { dot(g, 27 + (k > 1 ? 1 : 0), 30 + k + dy, 'm'); dot(g, 26 + (k > 1 ? 1 : 0), 30 + k + dy, 'M'); }
        }
      }
    }
    outline(g);
    return g;
  }
  return { W, H, PAL, build };
})();

/* ---- 亞特像素圖的快取：每種方向／動作／格數只畫一次 ---- */
const HERO_SCALE = 1.5;                 // 1 像素 = 1.5 世界單位（iPad 上剛好是 3 個實體像素，邊緣銳利）
const heroCache = new Map();
function pixelCanvas(rows, getColor) {
  const h = rows.length, w = rows[0].length;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cx = c.getContext('2d');
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = rows[y][x];
    if (!ch || ch === '.') continue;
    cx.fillStyle = getColor(ch); cx.fillRect(x, y, 1, 1);
  }
  return c;
}
// 隊友的亞特戴藍色帽子（畫隊友時 heroAlt 是 true）
let heroAlt = false;
const MATE_PAL = { h: '#9cc8ff', H: '#6a9ee8', d: '#4a73b8', b: '#2c4f8c' };
function heroCanvas(dir, pose, phase, tint, unarmed, rage) {
  const key = dir + '|' + pose + '|' + phase + '|' + (tint || '') + (unarmed ? '|u' : '') + (rage ? '|r' : '') + (heroAlt ? '|m' : '');
  if (heroCache.has(key)) return heroCache.get(key);
  let c = null;
  try {
    const g = HERO.build(dir, pose, phase, { unarmed });
    if (rage) for (let y = 0; y < 21; y++) for (let x = 0; x < HERO.W; x++) if (g[y][x] === 'e') g[y][x] = 'R';   // 血紅色的眼睛
    c = pixelCanvas(g, ch => tint || (ch === 'R' ? '#e01f2a' : (heroAlt && MATE_PAL[ch]) || HERO.PAL[ch]));
  } catch (err) { c = null; }
  heroCache.set(key, c);
  return c;
}
// 揮刀時另外畫一把會旋轉的開山刀（握柄在左、刀尖朝右）
const MACHETE_ART = [
  '....KKKKKKKKKK..',
  'KKKKKmmmmmmmmmK.',
  'KLLLKmmmmmmmmmmK',
  'KKKKKMMMMMMMMMK.',
  '....KKKKKKKKKK..',
];
let macheteImg;
function machete() {
  if (macheteImg === undefined) { try { macheteImg = pixelCanvas(MACHETE_ART, ch => HERO.PAL[ch]); } catch (err) { macheteImg = null; } }
  return macheteImg;
}
// 面向角度 → 四個方向
function heroDir(f) {
  const c = Math.cos(f), sn = Math.sin(f);
  if (Math.abs(c) > Math.abs(sn) * 1.15) return c > 0 ? 'right' : 'left';
  return sn > 0 ? 'down' : 'up';
}
// 依目前狀態選動作與格數
function heroPose(p) {
  const W = curW();
  if (game.ult && game.ult.phase === 'charge') return ['swing', 0];          // 無影斬：高舉刀
  if (p.attackT > 0) { const prog = 1 - p.attackT / PC.attackActive; return ['swing', prog < 0.3 ? 0 : prog < 0.7 ? 1 : 2]; }
  if (!game.flurry && W.cd - p.attackCD < 0.26 && p.attackCD > 0) return ['swing', 2];     // 收刀前停一下，動作更明顯
  if (p.aiming || p.shieldUp) return ['aim', 0];
  if (p.dodgeT > 0) return ['walk', 0];
  if ((p.moveSpeed || 0) > 25) return ['walk', Math.floor((p.walkDist || 0) / 9) % 4];
  return ['idle', Math.floor(game.time * 2) % 2];
}
function blitHero(img, x, y, flip) {
  const w = HERO.W * HERO_SCALE, h = HERO.H * HERO_SCALE;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y + 11 - 34 * HERO_SCALE));   // 讓腳底對齊碰撞圓的下緣
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, 0, w, h);
  ctx.restore();
}

function drawPlayer() {
  const p = player;
  const x = p.x, y = p.y, r = p.r, f = p.facing, fx = Math.cos(f), fy = Math.sin(f);
  const W = curW();
  const dir = heroDir(p.attackT > 0 ? p.swingDir : f);
  const sdir = dir === 'left' || dir === 'right' ? 'side' : dir, flip = dir === 'left';
  const [pose, phase] = heroPose(p);
  ctx.imageSmoothingEnabled = false;

  // 閃避殘影（藍色剪影）
  const ghost = heroCanvas(sdir, 'walk', 0, '#7cc4ff');
  for (const t of p.trail) {
    ctx.globalAlpha = Math.min(1, t.life / 0.22) * 0.4;
    if (ghost) blitHero(ghost, t.x, t.y, flip); else { ctx.fillStyle = '#7cc4ff'; circle(t.x, t.y, r); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  if (p.dead && NET.on && !p.ultHidden) { drawGhost(p, sdir, flip); return; }   // 連線時倒下：變成魂魄等隊友
  if (p.dead || p.ultHidden) return;                // 化為白煙時看不到人

  // 瞄準虛線
  if (p.aiming) {
    ctx.setLineDash([12, 9]); ctx.lineDashOffset = -game.time * 40;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x + fx * (r + 14), y - 6 + fy * 18); ctx.lineTo(x + fx * PC.aimLine, y + fy * PC.aimLine); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; circle(x + fx * PC.aimLine, y + fy * PC.aimLine, 4); ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath(); ctx.ellipse(x, y + r - 3, r * 1.05, r * 0.4, 0, 0, TAU); ctx.fill();

  // 揮刀扇形與旋轉的開山刀
  let prog = 0, a1 = 0;
  if (p.attackT > 0) {
    prog = 1 - p.attackT / PC.attackActive;
    const ease = 1 - (1 - prog) * (1 - prog), a0 = p.swingDir - PC.attackHalfArc;
    a1 = a0 + PC.attackHalfArc * 2 * ease;
    ctx.fillStyle = game.ult ? 'rgba(255,70,90,0.35)' : game.flurry ? 'rgba(160,230,255,0.35)' : 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.arc(x, y - 4, W.range, a0, a1); ctx.closePath(); ctx.fill();
  }
  const drawBlade = () => {
    const mc = machete();
    if (!(p.attackT > 0) || !mc) return;
    const big = W.cd > 0.5 ? 1.3 : 1;            // 重武器刀身較大
    const S = HERO_SCALE * big;
    ctx.save();
    ctx.translate(x + Math.cos(a1) * 6, y - 6 + Math.sin(a1) * 6);
    ctx.rotate(a1);
    ctx.drawImage(mc, 0, -2.5 * S, 16 * S, 5 * S);
    ctx.restore();
  };
  // 拉弓
  const drawBow = () => {
    if (!p.aiming) return;
    const bx = x + fx * (r + 2), by = y - 6 + fy * 10;          // 弓拿在胸前的高度
    ctx.strokeStyle = '#2b1414'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(bx - fx * 8, by - fy * 8, 15, f - 1.1, f + 1.1); ctx.stroke();
    ctx.strokeStyle = '#a8703a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(bx - fx * 8, by - fy * 8, 15, f - 1.1, f + 1.1); ctx.stroke();
    const pull = Math.min(1, p.aimT / 0.3) * 10;
    const ex1 = bx - fx * 8 + Math.cos(f - 1.1) * 15, ey1 = by - fy * 8 + Math.sin(f - 1.1) * 15;
    const ex2 = bx - fx * 8 + Math.cos(f + 1.1) * 15, ey2 = by - fy * 8 + Math.sin(f + 1.1) * 15;
    const nx = bx - fx * (2 + pull), ny = by - fy * (2 + pull);
    ctx.strokeStyle = '#f1ead2'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(ex1, ey1); ctx.lineTo(nx, ny); ctx.lineTo(ex2, ey2); ctx.stroke();
    // 搭在弦上的箭
    ctx.strokeStyle = '#f1e6c8'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(nx + fx * 22, ny + fy * 22); ctx.stroke();
  };
  const behind = dir === 'up';                    // 背對畫面時，武器在身體後面
  if (behind) { drawBlade(); drawBow(); }

  // 角色本體
  ctx.save();
  if (p.invuln > 0 && Math.floor(game.time * 20) % 2 === 0) ctx.globalAlpha = 0.4;
  const un = !!p.sheathed, rage = (p.rageT || 0) > 0;
  const img = heroCanvas(sdir, pose, phase, undefined, un, rage);
  if (img) {
    if (game.ult) {                               // 無影斬：全身冒出紅色殺氣
      const red = heroCanvas(sdir, pose, phase, '#c4162a', un);
      if (red) { const a0 = ctx.globalAlpha; ctx.globalAlpha = a0 * (0.6 + 0.4 * Math.sin(game.time * 20)); for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) blitHero(red, x + ox, y + oy, flip); ctx.globalAlpha = a0; }
    }
    if (game.flurry) {                            // 迅影時刻：角色周圍發出冷光
      const glow = heroCanvas(sdir, pose, phase, '#9fe3ff', un);
      if (glow) for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) blitHero(glow, x + ox, y + oy, flip);
    }
    blitHero(img, x, y, flip);
    if (p.hurtFlash > 0) {                        // 受傷閃紅
      const hurt = heroCanvas(sdir, pose, phase, '#ff5050', un);
      if (hurt) { const a = ctx.globalAlpha; ctx.globalAlpha = a * 0.75; blitHero(hurt, x, y, flip); ctx.globalAlpha = a; }
    }
  } else {                                        // 備援：畫布不可用時用圓形代表
    ctx.fillStyle = p.hurtFlash > 0 ? '#ff7070' : '#2f7fd0'; circle(x, y, r); ctx.fill();
  }
  ctx.restore();
  if (!behind) { drawBlade(); drawBow(); }
  // 無影斬蓄力：把刀高高舉起（刀尖朝上、閃著寒光）
  if (game.ult && game.ult.phase === 'charge' && machete()) {
    const k = Math.min(1, game.ult.t / 0.35), S2 = HERO_SCALE * (W.cd > 0.5 ? 1.3 : 1);
    ctx.save();
    ctx.translate(x + (flip ? 3 : -3), y - 40 - k * 8);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(machete(), 0, -2.5 * S2, 16 * S2, 5 * S2);
    ctx.restore();
    if (Math.floor(game.time * 12) % 2) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 1, y - 72 - k * 8, 3, 3); }
  }

  if (p.shieldUp) {
    const perfect = p.shieldT <= PC.perfectWindow;
    ctx.fillStyle = perfect ? 'rgba(255,226,122,0.25)' : 'rgba(120,220,255,0.18)';
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.arc(x, y - 4, r + 14, f - 1.0, f + 1.0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = perfect ? '#ffe27a' : '#8be3ff'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x, y - 4, r + 11, f - 1.0, f + 1.0); ctx.stroke();
  }
  if (p.stamina < PC.maxStamina - 0.5 || p.staminaFlash > 0) {
    const wx = x + 32, wy = y - 30, ratio = p.stamina / PC.maxStamina;
    ctx.lineWidth = 5; ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; circle(wx, wy, 9); ctx.stroke();
    const warn = p.staminaFlash > 0 && Math.floor(game.time * 12) % 2 === 0;
    ctx.strokeStyle = warn ? '#ff5a5a' : (ratio < PC.dodgeCost / PC.maxStamina ? '#f4c542' : '#5be37d');
    ctx.beginPath(); ctx.arc(wx, wy, 9, -Math.PI / 2, -Math.PI / 2 + TAU * ratio); ctx.stroke();
  }
}
function drawParticles() {
  for (const q of particles) {
    const a = clamp(q.life / q.max, 0, 1);
    ctx.globalAlpha = a;
    if (q.type === 'leaf') {
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      ctx.fillStyle = q.color; ctx.fillRect(-q.size / 2, -q.size / 4, q.size, q.size / 2); ctx.restore();
    } else if (q.type === 'ring') { ctx.strokeStyle = q.color; ctx.lineWidth = 3; circle(q.x, q.y, q.size); ctx.stroke(); }
    else if (q.type === 'streak') {          // 無影斬的刀光
      ctx.strokeStyle = 'rgba(255,60,80,0.7)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(q.x - Math.cos(q.rot) * q.size, q.y - Math.sin(q.rot) * q.size); ctx.lineTo(q.x + Math.cos(q.rot) * q.size, q.y + Math.sin(q.rot) * q.size); ctx.stroke();
      ctx.strokeStyle = q.color; ctx.lineWidth = 2.5; ctx.stroke();
    }
    else if (q.type === 'smoke') { ctx.globalAlpha = a * 0.5; ctx.fillStyle = q.color; circle(q.x, q.y, q.size + (1 - a) * 8); ctx.fill(); }
    else { ctx.fillStyle = q.color; circle(q.x, q.y, q.size); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
}
function drawTexts() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const t of texts) {
    ctx.globalAlpha = clamp(t.life / t.max * 1.5, 0, 1);
    ctx.font = `bold ${t.size}px "PingFang TC", sans-serif`;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(t.text, t.x, t.y);
    ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}
// 畫面外的怪物：在螢幕邊緣顯示方向箭頭
function drawOffscreenMarkers() {
  const m = 30;
  for (const e of enemies) {
    if (e.dead) continue;
    const sx = e.x - cam.x, sy = e.y - cam.y;
    if (sx > -e.rad && sx < VW + e.rad && sy > -e.rad && sy < VH + e.rad) continue;
    const cx = VW / 2, cy = VH / 2, dx = sx - cx, dy = sy - cy;
    const k = Math.min((VW / 2 - m - SAFE.l) / Math.abs(dx || 1e-6), (VH / 2 - m - SAFE.t) / Math.abs(dy || 1e-6));
    const mx = cx + dx * k, my = cy + dy * k, a = Math.atan2(dy, dx);
    const dist = Math.hypot(e.x - player.x, e.y - player.y);
    ctx.globalAlpha = clamp(1.4 - dist / 1400, 0.3, 0.9);
    ctx.fillStyle = e.markColor || e.t.colorChase;
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(a) * 11, my + Math.sin(a) * 11);
    ctx.lineTo(mx + Math.cos(a + 2.5) * 9, my + Math.sin(a + 2.5) * 9);
    ctx.lineTo(mx + Math.cos(a - 2.5) * 9, my + Math.sin(a - 2.5) * 9);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  for (const h of pickups) {                          // 還沒打開的金色寶箱
    if (h.kind !== 'goldchest' || h.opened) continue;
    const sx = h.x - cam.x, sy = h.y - cam.y;
    if (sx > 0 && sx < VW && sy > 0 && sy < VH) continue;
    const cx = VW / 2, cy = VH / 2, dx = sx - cx, dy = sy - cy;
    const k = Math.min((VW / 2 - m - SAFE.l) / Math.abs(dx || 1e-6), (VH / 2 - m - SAFE.t) / Math.abs(dy || 1e-6));
    const mx = cx + dx * k, my = cy + dy * k;
    ctx.globalAlpha = 0.95; ctx.fillStyle = '#5a3a10'; rr(mx - 11, my - 8, 22, 16, 3); ctx.fill();
    ctx.fillStyle = '#f2c95a'; rr(mx - 9, my - 6, 18, 12, 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
// 生命列只使用左側狀態區；超出寬度便切換為愛心與數字。
function healthHUDLayout(width, safe, maxHp) {
  const usable = Math.max(1, width - safe.l - safe.r);
  const column = Math.min(240, usable * .28);
  const hearts = maxHp / 2, gap = hearts > 7 ? 30 : 36, size = hearts > 7 ? 13 : 15;
  return {column, hearts, gap, size, compact: (Math.ceil(hearts) - 1) * gap + size * 2 > column};
}
function fitHUDText(text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(text.slice(0, end) + '…').width > width) end--;
  return text.slice(0,end) + '…';
}
function drawHUD() {
  const p = player;
  const x0 = SAFE.l + 26, y0 = SAFE.t + 30;
  const health = healthHUDLayout(VW, SAFE, p.maxHp);
  const {hearts, gap, size:hs} = health;
  if (health.compact) {
    ctx.fillStyle = p.hp > 0 ? '#ff5f73' : 'rgba(0,0,0,.45)';
    heartPath(x0,y0,15);ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.8)';ctx.lineWidth=1.5;heartPath(x0,y0,15);ctx.stroke();
    ctx.textAlign='left';ctx.textBaseline='middle';
    ctx.font='bold 19px "PingFang TC", sans-serif';ctx.lineWidth=4;ctx.strokeStyle='rgba(0,0,0,.8)';
    const life = `${Math.max(0,p.hp) / 2} / ${hearts}`;
    let lifeFont=19;
    while(lifeFont>10 && ctx.measureText(life).width>health.column-30) {lifeFont--;ctx.font=`bold ${lifeFont}px "PingFang TC", sans-serif`;} 
    ctx.strokeText(life,x0+25,y0-2);ctx.fillStyle=p.hp<=4?'#ff8a95':'#f1ead2';ctx.fillText(life,x0+25,y0-2);
  } else for (let i = 0; i < hearts; i++) {
    const hx = x0 + i * gap, hy = y0, v = clamp(p.hp - i * 2, 0, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; heartPath(hx, hy, hs); ctx.fill();
    if (v > 0) {
      ctx.save();
      if (v === 1) { ctx.beginPath(); ctx.rect(hx - 20, hy - 20, 20, 40); ctx.clip(); }
      ctx.fillStyle = '#ff5f73'; heartPath(hx, hy, hs); ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; heartPath(hx, hy, hs); ctx.stroke();
  }
  const bx = x0 - 14, by = y0 + 24, bw = Math.min(180, health.column - 40), bh = 12, ratio = p.stamina / PC.maxStamina;
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; rr(bx, by, bw, bh, 6); ctx.fill();
  const warn = p.staminaFlash > 0 && Math.floor(game.time * 12) % 2 === 0;
  ctx.fillStyle = warn ? '#ff5a5a' : (ratio < PC.dodgeCost / PC.maxStamina ? '#f4c542' : '#5be37d');
  if (ratio > 0.01) { rr(bx, by, Math.max(bh, bw * ratio), bh, 6); ctx.fill(); }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5; rr(bx, by, bw, bh, 6); ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 12px "PingFang TC", sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText('體力', bx + bw + 8, by + bh / 2);
  // 目前裝備
  const W = curW(), B = curB();
  const eq = `劍：${W.name}（攻 ${W.atk}）　弓：${B ? `${B.name}（攻 ${B.atk}）` : '無'}`;
  ctx.font = 'bold 13px "PingFang TC", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  const equipment = fitHUDText(eq, Math.max(100,(VW-SAFE.l-SAFE.r)*.55));
  ctx.strokeText(equipment, bx, by + 30); ctx.fillStyle = '#f1ead2'; ctx.fillText(equipment, bx, by + 30);

  // 關卡進度
  const cx = SAFE.l + (VW-SAFE.l-SAFE.r)/2, ty = SAFE.t + 22;
  const titleWidth = Math.max(80,Math.min(420, VW-SAFE.l-SAFE.r-2*(health.column+30)));
  ctx.textAlign = 'center';
  ctx.font = 'bold 16px "PingFang TC", sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  const boss = bossAlive();
  const title = lateActive() ? `第 ${lvl.n} 關　${lateProgress()}` : boss ? `第 ${lvl.n} 關　${levelName(lvl.n)}　大魔王` : `第 ${lvl.n} 關　${levelName(lvl.n)}　擊倒 ${lvl.kills} / ${lvl.target}`;
  const shortTitle = lateActive() ? title : `第 ${lvl.n} 關　${boss ? '大魔王' : `擊倒 ${lvl.kills} / ${lvl.target}`}`;
  const header = fitHUDText(titleWidth < 340 ? shortTitle : title,titleWidth);
  ctx.strokeText(header, cx, ty); ctx.fillStyle = '#f1ead2'; ctx.fillText(header, cx, ty);
  const pw = Math.min(220,titleWidth);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; rr(cx - pw / 2, ty + 14, pw, 7, 3.5); ctx.fill();
  const progress = lateActive() ? lateFraction() : lvl.kills / lvl.target;
  ctx.fillStyle = '#ff9b3d'; if (progress > 0) { rr(cx - pw / 2, ty + 14, Math.max(7, pw * Math.min(1, progress)), 7, 3.5); ctx.fill(); }
  if (boss) {                                       // 大魔王血條
    const bw = Math.min(titleWidth, 520), bx2 = cx - bw / 2, by2 = ty + 42;
    const intro = boss.state === 'intro' ? 1 - clamp(boss.stateT / 1.8, 0, 1) : 1;
    ctx.font = 'bold 15px "PingFang TC", sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    const nm = fitHUDText(boss.t.name + (boss.phase === 2 ? '（憤怒）' : ''),titleWidth);
    ctx.strokeText(nm, cx, by2 - 9); ctx.fillStyle = boss.t.data.accent; ctx.fillText(nm, cx, by2 - 9);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; rr(bx2, by2, bw, 12, 6); ctx.fill();
    ctx.fillStyle = boss.invulnT > 0 && Math.floor(game.time * 12) % 2 ? '#ffffff' : boss.t.data.accent;
    const ratio = Math.max(0, boss.hp / boss.t.hp) * intro;
    if (ratio > 0) { rr(bx2, by2, Math.max(12, bw * ratio), 12, 6); ctx.fill(); }
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(cx - 1, by2 - 2, 2, 16);          // 50%：進入第二階段
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5; rr(bx2, by2, bw, 12, 6); ctx.stroke();
  }

  // 迅影時刻提示
  if (game.flurry) {
    const f = game.flurry;
    const msg = f.phase === 'ready' ? '迅影時刻！按攻擊衝刺連斬' : `迅影連斬 ${f.hits} / ${PC.flurryHits}`;
    ctx.font = 'bold 22px "PingFang TC", sans-serif'; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(10,20,60,0.8)';
    ctx.strokeText(msg, cx, VH * 0.24); ctx.fillStyle = '#9fe3ff'; ctx.fillText(msg, cx, VH * 0.24);
  }
  // 提示訊息
  if (game.hints.length && game.mode === 'play') {
    const h = game.hints[0];
    ctx.globalAlpha = clamp(h.t, 0, 1);
    ctx.font = 'bold 15px "PingFang TC", sans-serif';
    const w = ctx.measureText(h.text).width + 36, hy = SAFE.t + (bossAlive() ? 92 : 62);
    ctx.fillStyle = 'rgba(20,35,26,0.88)'; rr(cx - w / 2, hy, w, 32, 16); ctx.fill();
    ctx.fillStyle = '#ffcf8a'; ctx.fillText(h.text, cx, hy + 16);
    ctx.globalAlpha = 1;
  }
}
// 聲音被系統暫停時（例如來電、Siri、切換 App），提示玩家點一下恢復
function drawAudioNotice() {
  if (!Sfx.started || Sfx.running || game.mode === 'title') return;
  const msg = '聲音被系統暫停了，點一下畫面就會恢復';
  ctx.font = 'bold 15px "PingFang TC", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(msg).width + 36, y = VH - SAFE.b - 30;
  ctx.fillStyle = 'rgba(20,35,26,0.9)'; rr(VW / 2 - w / 2, y - 16, w, 32, 16); ctx.fill();
  ctx.fillStyle = '#ffcf8a'; ctx.fillText(msg, VW / 2, y);
}
function drawSpeech() {
  const sp = game.speech;
  if (!sp || game.time < sp.t0 || game.time > sp.t1 || player.dead) return;
  const a = Math.min(clamp((game.time - sp.t0) / 0.15, 0, 1), clamp((sp.t1 - game.time) / 0.2, 0, 1));
  const hx = player.x - cam.x, hy = player.y - 48 - cam.y;
  ctx.save(); ctx.globalAlpha = a;
  ctx.font = 'bold 17px "PingFang TC", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(sp.text).width + 28, h = 34, bx = clamp(hx - w / 2, 8, VW - w - 8), by = hy - h - 12;
  ctx.fillStyle = '#fffdf6'; ctx.strokeStyle = '#2b1414'; ctx.lineWidth = 2.5;
  rr(bx, by, w, h, 15); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(hx - 8, by + h - 1); ctx.lineTo(hx, by + h + 11); ctx.lineTo(hx + 8, by + h - 1); ctx.fill(); ctx.stroke();
  ctx.fillRect(hx - 7, by + h - 4, 14, 5);
  ctx.fillStyle = '#2b1414'; ctx.fillText(sp.text, bx + w / 2, by + h / 2 + 1);
  ctx.restore();
}
function drawBanner() {
  const b = game.banner;
  if (!b || b.t <= 0) return;
  ctx.globalAlpha = clamp(b.t, 0, 1);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '900 34px "PingFang TC", sans-serif'; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeText(b.title, VW / 2, VH * 0.22); ctx.fillStyle = '#ff9b3d'; ctx.fillText(b.title, VW / 2, VH * 0.22);
  ctx.font = 'bold 18px "PingFang TC", sans-serif'; ctx.lineWidth = 4;
  ctx.strokeText(b.sub, VW / 2, VH * 0.22 + 38); ctx.fillStyle = '#f1ead2'; ctx.fillText(b.sub, VW / 2, VH * 0.22 + 38);
  ctx.globalAlpha = 1;
}
function drawControls() {
  const p = player;
  // 搖桿
  ctx.globalAlpha = joy.id !== null ? 1 : 0.6;
  ctx.fillStyle = 'rgba(255,255,255,0.10)'; circle(joy.baseX, joy.baseY, joy.radius); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 3; ctx.stroke();
  const kx = joy.baseX + joy.kx * joy.radius, ky = joy.baseY + joy.ky * joy.radius;
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; circle(kx, ky, joy.knobR); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.globalAlpha = 1;
  // 背包鈕
  ctx.fillStyle = 'rgba(80,60,30,0.55)'; circle(bagBtn.x, bagBtn.y, bagBtn.r); ctx.fill();
  ctx.strokeStyle = 'rgba(255,214,150,0.9)'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 14px "PingFang TC", sans-serif'; ctx.fillStyle = '#ffe9c4'; ctx.fillText('背包', bagBtn.x, bagBtn.y);
  // 四顆按鈕
  for (const b of buttons) {
    if (b.key === 'ult' && !inv.ultimate) continue;
    if (b.key === 'vac' && !inv.vacuum) continue;
    let pressed = b.touches.size > 0;
    if (b.key === 'shield') pressed = pressed || p.shieldUp;
    if (b.key === 'shoot') pressed = pressed || p.aiming;
    if (b.key === 'ult') pressed = pressed || !!game.ult;
    if (b.key === 'vac') pressed = pressed || !!game.vac;
    const ultBlocked = b.key === 'ult' && (game.ultCD > 0 || !enemies.some(e => !e.dead && onScreen(e)));
    const vacBlocked = b.key === 'vac' && (game.vacCD > 0 || !enemies.some(e => !e.dead && !e.boss && onScreen(e)));
    const disabled = (b.key === 'dodge' && p.stamina < PC.dodgeCost) || (b.key === 'shoot' && (!inv.bowEq || inv.arrows <= 0)) || (ultBlocked && !game.ult) || (vacBlocked && !game.vac);
    ctx.globalAlpha = disabled ? 0.45 : 1;
    ctx.fillStyle = `rgba(${b.rgb},${pressed ? 0.55 : 0.26})`;
    circle(b.x, b.y, pressed ? b.r * 0.94 : b.r); ctx.fill();
    ctx.strokeStyle = `rgba(${b.rgb},0.95)`; ctx.lineWidth = 3; ctx.stroke();
    const ly = b.key === 'shoot' || (b.key === 'ult' && game.ultCD > 0) || (b.key === 'vac' && game.vacCD > 0) ? b.y - 8 : b.y;
    ctx.font = `bold ${Math.round(b.r * 0.42)}px "PingFang TC", sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.strokeText(b.label, b.x, ly); ctx.fillStyle = '#ffffff'; ctx.fillText(b.label, b.x, ly);
    if (b.key === 'ult' && game.ultCD > 0) {      // 冷卻：扇形遮罩＋剩餘時間
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.arc(b.x, b.y, b.r, -Math.PI / 2, -Math.PI / 2 + TAU * (game.ultCD / ultMax())); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 13px "PingFang TC", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(fmtTime(game.ultCD), b.x, b.y + 14); ctx.fillStyle = '#ffd6dc'; ctx.fillText(fmtTime(game.ultCD), b.x, b.y + 14);
    } else if (b.key === 'ult' && !ultBlocked && !game.ult) {   // 可以使用時外圈發光
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(game.time * 5);
      ctx.strokeStyle = 'rgba(255,80,100,0.9)'; ctx.lineWidth = 4; circle(b.x, b.y, b.r + 7); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (b.key === 'vac' && game.vacCD > 0) {      // 吸怪器冷卻
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.arc(b.x, b.y, b.r, -Math.PI / 2, -Math.PI / 2 + TAU * (game.vacCD / vacMax())); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 13px "PingFang TC", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(fmtTime(game.vacCD), b.x, b.y + 14); ctx.fillStyle = '#c8fff0'; ctx.fillText(fmtTime(game.vacCD), b.x, b.y + 14);
    } else if (b.key === 'vac' && !vacBlocked && !game.vac) {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(game.time * 5);
      ctx.strokeStyle = 'rgba(110,240,190,0.9)'; ctx.lineWidth = 4; circle(b.x, b.y, b.r + 7); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (b.key === 'shoot') {            // 射箭字下方顯示剩餘箭矢
      const sub = inv.bowEq ? `×${inv.arrows}` : '無弓';
      ctx.font = 'bold 13px "PingFang TC", sans-serif';
      ctx.strokeText(sub, b.x, b.y + 13); ctx.fillStyle = '#fff2c4'; ctx.fillText(sub, b.x, b.y + 13);
      if (p.aiming && aimStick.id !== null) {
        // 瞄準範圍外圈＋可 360° 拖曳的小圓點
        ctx.globalAlpha = 1;
        ctx.strokeStyle = `rgba(${b.rgb},0.45)`; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
        circle(b.x, b.y, aimStick.radius); ctx.stroke(); ctx.setLineDash([]);
        let kx = 0, ky = 0;
        if (aimStick.engaged) {
          const len = Math.hypot(aimStick.dx, aimStick.dy) || 1, k = Math.min(len, aimStick.radius) / len;
          kx = aimStick.dx * k; ky = aimStick.dy * k;
        } else {                          // 尚未拖曳：圓點朝目前瞄準方向微微偏移
          kx = Math.cos(p.facing) * 8; ky = Math.sin(p.facing) * 8;
        }
        if (kx || ky) {
          ctx.strokeStyle = 'rgba(255,240,190,0.8)'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + kx, b.y + ky); ctx.stroke();
        }
        ctx.fillStyle = '#fff2c4'; circle(b.x + kx, b.y + ky, 13); ctx.fill();
        ctx.strokeStyle = 'rgba(80,50,10,0.9)'; ctx.lineWidth = 2.5; ctx.stroke();
      }
    }
    if (b.key === 'attack' && p.attackCD > 0 && !game.flurry) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 6, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(p.attackCD / curW().cd, 0, 1)); ctx.stroke();
    }
    if (b.key === 'attack' && game.flurry) {
      ctx.strokeStyle = `rgba(159,227,255,${0.6 + 0.4 * Math.sin(game.time * 20)})`; ctx.lineWidth = 5;
      circle(b.x, b.y, b.r + 8); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // 暫停鈕
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; circle(pauseBtn.x, pauseBtn.y, pauseBtn.r); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(pauseBtn.x - 7, pauseBtn.y - 8, 5, 16); ctx.fillRect(pauseBtn.x + 2, pauseBtn.y - 8, 5, 16);
}

/* =========================================================
 * 序章動畫：山頂的石頭（第一次開始遊戲時播放）
 *   用自己的畫布疊在遊戲上方；第一次呼叫時才建立素材，失敗就直接進遊戲
 * ========================================================= */
function createPrologue() {
/* =========================================================
 * 序章動畫：山頂的石頭
 *   畫面先畫在 320×180 的低解析緩衝區（像素風），再放大到螢幕；
 *   文字、對話框畫在螢幕解析度，保持清晰。
 *   時間軸以秒為單位，影像與聲音都對齊同一個時鐘。
 * ========================================================= */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);           // t 在 [a,b] 的進度
const easeIO = k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const easeOut = k => 1 - (1 - k) * (1 - k);
const hash = (x, y) => (((Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663)) >>> 0) % 1000) / 1000;
const END = 59.6;                                                    // 動畫總長（秒）

// ---------- 畫布 ----------
const LW = 320, LH = 180;
const screen = document.getElementById('prologueCanvas'), sctx = screen.getContext('2d');
const buf = document.createElement('canvas'); buf.width = LW; buf.height = LH;
const b = buf.getContext('2d');
let SW = 0, SH = 0, DPR = 1, S = 1, OX = 0, OY = 0;
function resize() {
  SW = window.innerWidth; SH = window.innerHeight; DPR = Math.min(window.devicePixelRatio || 1, 2);
  screen.width = Math.round(SW * DPR); screen.height = Math.round(SH * DPR);
  S = Math.min(SW / LW, SH / LH); OX = (SW - LW * S) / 2; OY = (SH - LH * S) / 2;
}
window.addEventListener('resize', resize);
resize();

function pixelCanvas(rows, color) {
  const h = rows.length, w = rows[0].length, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const ch = rows[yy][xx];
    if (!ch || ch === '.') continue;
    x.fillStyle = color(ch); x.fillRect(xx, yy, 1, 1);
  }
  return c;
}
const heroCache = new Map();
function heroImg(pose, phase, unarmed, tint) {
  const k = pose + phase + (unarmed ? 'u' : 'a') + (tint || '');
  if (!heroCache.has(k)) heroCache.set(k, pixelCanvas(HERO.build('side', pose, phase, { unarmed }), ch => tint || HERO.PAL[ch]));
  return heroCache.get(k);
}

// ---------- 道具像素圖 ----------
const STONE = [
  '.....KKKKKK.....',
  '...KKaaaaaaKK...',
  '..KaaaqqqqaaaK..',
  '.KaaqqquqqqqaaK.',
  '.KaqqququqqqqaK.',
  'KaqqquqqququqqaK',
  'KqqqqququqqquqqK',
  'KqqqqqquqqquqqqK',
  'KzqqqqqqqqqqqqzK',
  '.KzzqqqqqqqqzzK.',
  '..KKzzzzzzzzKK..',
  '....KKKKKKKK....',
];
const STONE_PAL = { K: '#22242a', a: '#a2a5ae', q: '#7c8089', z: '#5b5e67', u: '#5c6b78' };
const stoneImg = pixelCanvas(STONE, ch => STONE_PAL[ch]);
const runePixels = [];
STONE.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'u') runePixels.push([x, y]); }));
const KNIFE = ['KKKK........', 'KLLKmmmmmmK.', 'KKKKMMMMMMMK', '....KKKKKKK.'];
const knifeImg = pixelCanvas(KNIFE, ch => HERO.PAL[ch]);
const NOTE = ['KKKKKKKK', 'KppppppK', 'KpxxxxpK', 'KpxxxppK', 'KppppppK', 'KKKKKKKK'];
const NOTE_PAL = { K: '#6b5a3a', p: '#efe2c0', x: '#b03a30' };
const noteImg = pixelCanvas(NOTE, ch => NOTE_PAL[ch]);

// ---------- 地形（山坡＋山頂），只算一次 ----------
const WW = 1000, WH = 460, PLATEAU = 197;
function surf(x) {
  const slope = 400 - x * 0.375 + Math.sin(x / 23) * 2.2 + Math.sin(x / 9.3) * 1.1;
  const top = PLATEAU + Math.sin(x / 37) * 0.8;
  if (x < 540) return slope;
  if (x < 580) { const k = (x - 540) / 40; return slope * (1 - k) + top * k; }
  return top;
}
const terrain = (() => {
  const c = document.createElement('canvas'); c.width = WW; c.height = WH;
  const x = c.getContext('2d'), img = x.createImageData(WW, WH), d = img.data;
  const put = (px, py, hex) => {
    if (px < 0 || py < 0 || px >= WW || py >= WH) return;
    const i = (py * WW + px) * 4, v = parseInt(hex.slice(1), 16);
    d[i] = v >> 16; d[i + 1] = (v >> 8) & 255; d[i + 2] = v & 255; d[i + 3] = 255;
  };
  for (let px = 0; px < WW; px++) {
    const top = Math.round(surf(px));
    for (let py = top; py < WH; py++) {
      const depth = py - top, h = hash(px, py);
      let col;
      if (depth === 0) col = hash(px, 7) > 0.3 ? '#86ad4c' : '#9a9da5';
      else if (depth < 3) col = hash(px, 9) > 0.4 ? '#5e8a37' : '#7d8088';
      else if ((py + Math.floor(px * 0.37)) % 13 === 0) col = '#4e5158';
      else col = h < 0.15 ? '#696c74' : h > 0.86 ? '#8c8f97' : '#777a82';
      if (depth > 70 && hash(px, py + 3) < 0.5) col = '#5d6067';
      put(px, py, col);
    }
    // 草叢與小花
    if (hash(px, 3) > 0.82) { put(px, top - 1, '#86ad4c'); if (hash(px, 4) > 0.5) put(px, top - 2, '#9cc25a'); }
    if (hash(px, 5) > 0.975) put(px, top - 2, hash(px, 6) > 0.5 ? '#f3e3a1' : '#e9a6c4');
  }
  x.putImageData(img, 0, 0);
  return c;
})();
// 遠山（兩層，視差捲動）
const mountains = (() => {
  const w = 900, h = 180, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'), img = x.createImageData(w, h), d = img.data;
  const layer = (base, amp, f1, f2, col, snow) => {
    const v = parseInt(col.slice(1), 16), sv = 0xe8eef8;
    for (let px = 0; px < w; px++) {
      const ridge = Math.round(base - amp * (0.55 * Math.sin(px / f1) + 0.3 * Math.sin(px / f2 + 1.7) + 0.15 * Math.sin(px / 7.1)));
      for (let py = Math.max(0, ridge); py < h; py++) {
        const i = (py * w + px) * 4, cc = snow && py - ridge < 3 && ridge < base - amp * 0.45 ? sv : v;
        d[i] = cc >> 16; d[i + 1] = (cc >> 8) & 255; d[i + 2] = cc & 255; d[i + 3] = 255;
      }
    }
  };
  layer(95, 40, 61, 27, '#8697bd', true);
  layer(128, 26, 43, 19, '#5d6f95', false);
  x.putImageData(img, 0, 0);
  return c;
})();

// =========================================================
// 時間軸：亞特在每個時間點的位置與動作
// =========================================================
const BUBBLES = [
  { t0: 9.0, t1: 12.6, text: '呼……呼……就快到了……！', kind: 'say' },
  { t0: 14.2, t1: 17.6, text: '終於……登上山頂了！', kind: 'shout' },
  { t0: 21.7, t1: 23.2, text: '哎喲！', kind: 'shout' },
  { t0: 23.3, t1: 24.0, text: '嗯？', kind: 'say' },
  { t0: 24.7, t1: 27.0, text: '這是……一把小刀？還有一張紙條？', kind: 'say' },
  { t0: 32.9, t1: 35.0, text: '正好拿來防身！', kind: 'say' },
  { t0: 35.6, t1: 36.5, text: '？', kind: 'mark' },
  { t0: 36.7, t1: 40.4, text: '不要摸……？可是……真的好想摸摸看。', kind: 'think' },
  { t0: 43.4, t1: 46.4, text: '咦？！身體……在發光？！', kind: 'shout' },
];
const NARRATION = [
  { t0: 3.2, t1: 7.6, text: '探險家亞特，已經爬了整整三天的山。' },
  { t0: 53.6, t1: 56.0, text: '就這樣，亞特被傳送到了一個陌生的地方——' },
];

function heroAt(t) {
  const h = { x: 60, y: 0, pose: 'idle', phase: Math.floor(t * 2) % 2, unarmed: t < 31.2, visible: t < 49.85, glow: 0, crouch: 0 };
  const walk = (a, b2, x0, x1) => { const k = seg(t, a, b2); h.x = lerp(x0, x1, k); if (t > a && t < b2) { h.pose = 'walk'; h.phase = Math.floor(h.x / 5) % 4; } };
  if (t < 7.5) walk(2.5, 7.5, 60, 300);
  else if (t < 8.6) h.x = 300;
  else if (t < 13) walk(8.6, 13, 300, 560);
  else if (t < 14.2) walk(13, 14.2, 560, 600);
  else if (t < 19) h.x = 600;
  else if (t < 21.5) walk(19, 21.5, 600, 650);
  else if (t < 22.0) { h.x = lerp(650, 646, easeOut(seg(t, 21.5, 22))); h.crouch = Math.sin(seg(t, 21.5, 22) * Math.PI) * 2; }
  else if (t < 30) h.x = 646;
  else if (t < 30.6) walk(30, 30.6, 646, 655);
  else if (t < 31.6) { h.x = 655; h.pose = 'aim'; h.crouch = Math.sin(seg(t, 30.6, 31.6) * Math.PI) * 3; }
  else if (t < 41) h.x = 655;
  else if (t < 41.8) walk(41, 41.8, 655, 670);
  else { h.x = 670; if (t > 41.95) h.pose = 'aim'; }
  if (t > 42.4) h.glow = easeIO(seg(t, 42.4, 49.6));
  h.y = surf(h.x) + h.crouch - (t > 46.8 ? easeIO(seg(t, 46.8, 49.8)) * 7 : 0);   // 傳送前身體浮起
  return h;
}
function stoneAt(t) {
  const k = seg(t, 21.5, 22.1);
  return { x: lerp(660, 684, easeOut(k)), y: PLATEAU - 12 + 1 - Math.sin(k * Math.PI) * 4 };
}
function runeGlow(t) {
  let g = 0.25 + 0.15 * Math.sin(t * 2.5);
  if (t > 35) g = Math.max(g, 0.45 + 0.25 * Math.sin(t * 4));
  if (t > 42.25) g = 1;
  if (t > 50.2) g = lerp(1, 0.12, seg(t, 50.2, 51.5));
  return g;
}
function cameraAt(t) {
  if (t >= 24) return { x: 594, y: PLATEAU - 64, z: 2 };
  const follow = hx => ({ x: Math.max(0, hx - 120), y: surf(hx) - 118, z: 1 });
  const h = heroAt(t), f = follow(h.x);
  if (t < 13) return f;
  const k = easeIO(seg(t, 13, 15.5)), fixed = { x: 520, y: PLATEAU - 128, z: 1 };
  return { x: lerp(f.x, fixed.x, k), y: lerp(f.y, fixed.y, k), z: 1 };
}

// ---------- 粒子 ----------
let parts = [], lastT = 0;
function emit(o) { if (parts.length < 900) parts.push(o); }
function updateParticles(t, dt) {
  const h = heroAt(t);
  if (t > 7.6 && t < 8.6 && Math.random() < dt * 4) emit({ x: h.x + 7, y: h.y - 26, vx: 6, vy: -8, g: 60, life: 0.6, max: 0.6, c: '#9fd8ff', s: 1 });
  if (t > 42.5 && t < 49.8) {                          // 藍光粒子繞著身體往上飄
    const rate = 30 + h.glow * 160;
    for (let n = 0; n < rate * dt; n++) {
      const a = Math.random() * TAU, r = 6 + Math.random() * 10;
      emit({ x: h.x + Math.cos(a) * r, y: h.y - 4 - Math.random() * 30, vx: -Math.sin(a) * 10, vy: -18 - Math.random() * 25 * (1 + h.glow), g: 0, life: 0.9, max: 0.9, c: Math.random() < 0.3 ? '#ffffff' : '#7fe0ff', s: Math.random() < 0.2 ? 2 : 1 });
    }
  }
  for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g || 0) * dt; p.life -= dt; }
  parts = parts.filter(p => p.life > 0);
}
// 一次性的爆發粒子（踢石頭、撿刀、碰石頭、傳送）
const BURSTS = [
  { t: 21.5, x: 662, y: PLATEAU - 2, n: 14, c: '#b9a888', sp: 30, up: 20 },
  { t: 31.2, x: 662, y: PLATEAU - 4, n: 16, c: '#fff2b0', sp: 26, up: 30 },
  { t: 42.3, x: 684, y: PLATEAU - 8, n: 22, c: '#9fefff', sp: 50, up: 30 },
  { t: 49.85, x: 670, y: PLATEAU - 18, n: 90, c: '#d8f8ff', sp: 70, up: 60 },
];
let burstDone = new Set();
function runBursts(t) {
  BURSTS.forEach((bs, i) => {
    if (t >= bs.t && !burstDone.has(i)) {
      burstDone.add(i);
      for (let k = 0; k < bs.n; k++) {
        const a = Math.random() * TAU, sp = Math.random() * bs.sp;
        emit({ x: bs.x, y: bs.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - bs.up * Math.random(), g: 40, life: 0.8 + Math.random() * 0.5, max: 1.2, c: bs.c, s: Math.random() < 0.3 ? 2 : 1 });
      }
    }
  });
}

// =========================================================
// 繪製
// =========================================================
function skyColors(t) {
  const k = seg(t, 2.5, 20);
  const top = [lerp(0x2c, 0x5b, k), lerp(0x3a, 0x8f, k), lerp(0x6e, 0xd0, k)];
  const hor = [lerp(0xf4, 0xf7, k), lerp(0xa4, 0xe2, k), lerp(0x6a, 0xb0, k)];
  return [top, hor];
}
function pixelDisc(cx, cy, r, col) {
  b.fillStyle = col;
  for (let y = -r; y <= r; y++) { const w = Math.floor(Math.sqrt(r * r - y * y)); b.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1); }
}
const CLOUDS = [[40, 30, 1], [160, 18, 0.8], [260, 42, 1.2], [420, 26, 0.9], [560, 36, 1.1], [700, 20, 0.8]];
function drawCloud(x, y, s) {
  b.fillStyle = 'rgba(255,255,255,0.85)';
  b.fillRect(Math.round(x), Math.round(y), Math.round(26 * s), 5);
  b.fillRect(Math.round(x + 5 * s), Math.round(y - 4), Math.round(14 * s), 4);
  b.fillRect(Math.round(x + 9 * s), Math.round(y - 7), Math.round(7 * s), 3);
  b.fillStyle = 'rgba(210,220,240,0.7)'; b.fillRect(Math.round(x + 2), Math.round(y + 5), Math.round(22 * s), 2);
}

function renderBuffer(t) {
  const cam = cameraAt(t), z = cam.z;
  let shx = 0, shy = 0;
  if (t > 44 && t < 49.9) { const a = easeIO(seg(t, 44, 49.6)) * 2.2; shx = (Math.random() * 2 - 1) * a; shy = (Math.random() * 2 - 1) * a; }
  if (t > 21.5 && t < 21.8) { shx = (Math.random() * 2 - 1); }
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.imageSmoothingEnabled = false;
  // 天空
  const [top, hor] = skyColors(t);
  for (let y = 0; y < LH; y++) {
    const k = y / LH;
    b.fillStyle = `rgb(${lerp(top[0], hor[0], k) | 0},${lerp(top[1], hor[1], k) | 0},${lerp(top[2], hor[2], k) | 0})`;
    b.fillRect(0, y, LW, 1);
  }
  // 太陽（山頂場景慢慢升起）
  const sunY = t < 13 ? 112 : lerp(112, 58, easeIO(seg(t, 13, 20)));
  const sunX = 250 - (t < 24 ? 0 : 40);
  b.globalAlpha = 0.25; pixelDisc(sunX, sunY, 17, '#ffe7a8'); b.globalAlpha = 0.4; pixelDisc(sunX, sunY, 12, '#fff0c4'); b.globalAlpha = 1;
  pixelDisc(sunX, sunY, 8, '#fff6dc');
  // 雲（視差＋飄移）
  for (const [cx, cy, cs] of CLOUDS) {
    const x = ((cx - cam.x * 0.08 + t * 3) % 400 + 400) % 400 - 40;
    drawCloud(x, cy - Math.max(0, (cam.y - 70) * 0.05), cs);
  }
  // 遠山
  const my = Math.round(20 - (cam.y - 70) * 0.12);
  b.drawImage(mountains, Math.round(-((cam.x * 0.15) % 450)), my);
  // 近處世界（地形、道具、亞特）
  b.setTransform(z, 0, 0, z, Math.round((-cam.x + shx) * z), Math.round((-cam.y + shy) * z));
  b.drawImage(terrain, 0, 0);
  // 飛鳥
  if (t > 13 && t < 21) {
    for (let i = 0; i < 2; i++) {
      const bx = 520 + (t - 13) * 28 + i * 14, by = 92 + i * 6 + Math.sin(t * 3 + i) * 2, flap = Math.floor(t * 6 + i) % 2;
      b.fillStyle = '#2b2e3a';
      b.fillRect(Math.round(bx - 2), Math.round(by - flap), 2, 1); b.fillRect(Math.round(bx), Math.round(by), 1, 1); b.fillRect(Math.round(bx + 1), Math.round(by - flap), 2, 1);
    }
  }
  const st = stoneAt(t);
  // 刀（撿起前）與紙條（被風吹走前）
  if (t < 31.2) b.drawImage(knifeImg, 662, PLATEAU - 4);
  let noteX = 674, noteY = PLATEAU - 6;
  if (t > 50.6) { const k = t - 50.6; noteX += k * 34; noteY -= k * 16 + Math.sin(k * 7) * 3; }
  const noteFlip = t > 50.6 && Math.floor(t * 8) % 2 === 0;
  if (noteFlip) { b.save(); b.translate(Math.round(noteX + 8), Math.round(noteY)); b.scale(-1, 1); b.drawImage(noteImg, 0, 0); b.restore(); }
  else b.drawImage(noteImg, Math.round(noteX), Math.round(noteY));
  // 地上的魔法陣
  const h = heroAt(t);
  if (t > 42.5 && t < 50.2) {
    const r = lerp(8, 24, easeOut(seg(t, 42.5, 45))), n = 28, alpha = t > 49.8 ? seg(50.2 - t + 49.8, 49.8, 50.2) : 1;
    b.globalAlpha = 0.85 * alpha;
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + t * 1.6;
      b.fillStyle = i % 4 === 0 ? '#ffffff' : '#7fe0ff';
      b.fillRect(Math.round(670 + Math.cos(a) * r), Math.round(PLATEAU - 1 + Math.sin(a) * r * 0.32), 1, 1);
    }
    b.globalAlpha = 1;
  }
  // 亞特
  if (h.visible) {
    const img = heroImg(h.pose, h.phase, h.unarmed);
    const hx = Math.round(h.x - 16), hy = Math.round(h.y - 34);
    b.globalAlpha = 0.25; b.fillStyle = '#000'; b.fillRect(Math.round(h.x - 9), Math.round(surf(h.x) - 1), 18, 2); b.globalAlpha = 1;
    if (h.glow > 0) {
      const glow = heroImg(h.pose, h.phase, h.unarmed, '#7fe0ff');
      const pulse = 0.55 + 0.45 * Math.sin(t * (8 + h.glow * 18));
      b.globalAlpha = clamp(h.glow * 1.2, 0, 1) * pulse;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0]]) b.drawImage(glow, hx + ox, hy + oy);
      b.globalAlpha = 1;
    }
    b.drawImage(img, hx, hy);
    if (h.glow > 0.05) {                       // 全身逐漸被藍光吞沒
      const tint = heroImg(h.pose, h.phase, h.unarmed, '#bff3ff');
      b.globalAlpha = clamp(h.glow * 0.85, 0, 0.85); b.drawImage(tint, hx, hy); b.globalAlpha = 1;
    }
  }
  // 石頭（畫在刀上面：踢開前把刀蓋住）
  b.drawImage(stoneImg, Math.round(st.x), Math.round(st.y));
  const rg = runeGlow(t);
  for (const [rx, ry] of runePixels) {
    b.fillStyle = `rgba(110,225,255,${rg})`; b.fillRect(Math.round(st.x) + rx, Math.round(st.y) + ry, 1, 1);
  }
  if (rg > 0.6) { b.globalAlpha = (rg - 0.6) * 0.6; pixelDisc(st.x + 8, st.y + 6, 10, '#7fe0ff'); b.globalAlpha = 1; }
  // 粒子
  for (const p of parts) {
    b.globalAlpha = clamp(p.life / p.max, 0, 1);
    b.fillStyle = p.c; b.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
  }
  b.globalAlpha = 1;
  // 光柱
  if (t > 49.3 && t < 50.8) {
    const k = t < 49.85 ? seg(t, 49.3, 49.85) : 1 - seg(t, 49.85, 50.8);
    const w = 3 + k * 14;
    b.globalAlpha = 0.55 * k; b.fillStyle = '#9fefff'; b.fillRect(Math.round(670 - w / 2), cam.y - 10, Math.round(w), Math.round(PLATEAU - cam.y + 10));
    b.globalAlpha = 0.9 * k; b.fillStyle = '#ffffff'; b.fillRect(Math.round(670 - w / 6), cam.y - 10, Math.max(1, Math.round(w / 3)), Math.round(PLATEAU - cam.y + 10));
    b.globalAlpha = 1;
  }
  b.setTransform(1, 0, 0, 1, 0, 0);
  return cam;
}

// ---------- 螢幕解析度的文字層 ----------
function rrect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
const FONT = '"PingFang TC","Noto Sans TC","Heiti TC","Microsoft JhengHei",sans-serif';
function toScreen(cam, wx, wy) { return [OX + (wx - cam.x) * cam.z * S, OY + (wy - cam.y) * cam.z * S]; }
function drawBubble(cam, h, bb, t) {
  const a = Math.min(seg(t, bb.t0, bb.t0 + 0.15), 1 - seg(t, bb.t1 - 0.15, bb.t1));
  if (a <= 0) return;
  const [hx, hy] = toScreen(cam, h.x, h.y - 37);
  const fs = Math.max(15, Math.round(S * (bb.kind === 'mark' ? 9 : 5.4)));
  sctx.font = `${bb.kind === 'shout' ? 900 : 700} ${fs}px ${FONT}`;
  const tw = sctx.measureText(bb.text).width, pad = fs * 0.7;
  const w = tw + pad * 2, hh = fs + pad * 1.3;
  const bx = clamp(hx - w / 2 + fs * 2, OX + 8, OX + LW * S - w - 8), by = hy - hh - fs * 1.3;
  const pop = 0.85 + 0.15 * easeOut(seg(t, bb.t0, bb.t0 + 0.18));
  sctx.save();
  sctx.globalAlpha = a;
  sctx.translate(bx + w / 2, by + hh / 2); sctx.scale(pop, pop); sctx.translate(-(bx + w / 2), -(by + hh / 2));
  if (bb.kind === 'mark') {
    sctx.lineWidth = 6; sctx.strokeStyle = '#1b1020'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.strokeText(bb.text, hx + fs * 0.6, hy - fs * 0.6); sctx.fillStyle = '#ffe066'; sctx.fillText(bb.text, hx + fs * 0.6, hy - fs * 0.6);
    sctx.restore(); return;
  }
  sctx.fillStyle = bb.kind === 'think' ? 'rgba(235,240,255,0.96)' : '#fffdf6';
  sctx.strokeStyle = '#2b1414'; sctx.lineWidth = Math.max(2, S * 0.7);
  rrect(sctx, bx, by, w, hh, hh * 0.45); sctx.fill(); sctx.stroke();
  if (bb.kind === 'think') {             // 思考泡泡：一串小圓圈
    for (const [k, r] of [[0.35, 0.16], [0.7, 0.1]]) {
      const cx = lerp(bx + w * 0.35, hx, k), cy = lerp(by + hh, hy, k);
      sctx.beginPath(); sctx.arc(cx, cy, fs * r * 1.6, 0, TAU); sctx.fill(); sctx.stroke();
    }
  } else {                                // 說話泡泡：尖角指向亞特
    const tx = clamp(hx, bx + hh * 0.5, bx + w - hh * 0.5);
    sctx.beginPath(); sctx.moveTo(tx - fs * 0.45, by + hh - 1); sctx.lineTo(tx, by + hh + fs * 0.75); sctx.lineTo(tx + fs * 0.45, by + hh - 1);
    sctx.fill(); sctx.stroke();
    sctx.fillRect(tx - fs * 0.4, by + hh - sctx.lineWidth * 1.5, fs * 0.8, sctx.lineWidth * 1.6);
  }
  sctx.fillStyle = '#2b1414'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  sctx.fillText(bb.text, bx + w / 2, by + hh / 2 + fs * 0.04);
  sctx.restore();
}
function drawNarration(n, t) {
  const a = Math.min(seg(t, n.t0, n.t0 + 0.5), 1 - seg(t, n.t1 - 0.5, n.t1));
  if (a <= 0) return;
  const fs = Math.max(16, Math.round(S * 5.6));
  sctx.globalAlpha = a;
  sctx.font = `700 ${fs}px ${FONT}`; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  const y = OY + LH * S - fs * 1.6;
  const g = sctx.createLinearGradient(0, y - fs * 1.6, 0, OY + LH * S);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.7)');
  sctx.fillStyle = g; sctx.fillRect(OX, y - fs * 1.6, LW * S, OY + LH * S - (y - fs * 1.6));
  sctx.lineWidth = 4; sctx.strokeStyle = 'rgba(0,0,0,0.6)'; sctx.strokeText(n.text, SW / 2, y);
  sctx.fillStyle = '#f1ead2'; sctx.fillText(n.text, SW / 2, y);
  sctx.globalAlpha = 1;
}
function drawNoteCloseup(t) {                    // 紙條特寫「千萬不要摸」
  const a = Math.min(seg(t, 27.2, 27.6), 1 - seg(t, 29.6, 30.0));
  if (a <= 0) return;
  const w = Math.min(LW * S * 0.5, 460), h = w * 0.62, cx = SW / 2, cy = OY + LH * S * 0.44;
  sctx.save(); sctx.globalAlpha = a;
  sctx.fillStyle = 'rgba(0,0,0,0.35)'; sctx.fillRect(OX, OY, LW * S, LH * S);
  sctx.translate(cx, cy + (1 - easeOut(seg(t, 27.2, 27.7))) * 30); sctx.rotate(-0.04);
  sctx.fillStyle = '#efe2c0'; sctx.strokeStyle = '#6b5a3a'; sctx.lineWidth = 3;
  sctx.beginPath(); sctx.moveTo(-w / 2, -h / 2); sctx.lineTo(w / 2 - 14, -h / 2 + 4); sctx.lineTo(w / 2, h / 2 - 6); sctx.lineTo(-w / 2 + 10, h / 2); sctx.closePath();
  sctx.fill(); sctx.stroke();
  sctx.strokeStyle = 'rgba(107,90,58,0.25)'; sctx.lineWidth = 1.5;
  for (let i = -2; i <= 2; i++) { sctx.beginPath(); sctx.moveTo(-w * 0.38, i * h * 0.16 + h * 0.08); sctx.lineTo(w * 0.38, i * h * 0.16 + h * 0.06); sctx.stroke(); }
  sctx.fillStyle = '#a8322a'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  sctx.font = `900 ${Math.round(w * 0.14)}px ${FONT}`;
  sctx.fillText('千萬不要摸', 0, 0);
  sctx.restore();
}
function drawItemBanner(t) {                     // 獲得 旅人短劍
  const a = Math.min(seg(t, 31.8, 32.1), 1 - seg(t, 34.1, 34.5));
  if (a <= 0) return;
  const fs = Math.max(18, Math.round(S * 6.4)), y = OY + LH * S * 0.86;     // 放在畫面下方，避免擋住對話框
  sctx.save(); sctx.globalAlpha = a;
  sctx.font = `900 ${fs}px ${FONT}`; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  const text = '獲得　旅人短劍', w = sctx.measureText(text).width + fs * 3.2, hgt = fs * 1.9;
  sctx.fillStyle = 'rgba(20,35,26,0.88)'; rrect(sctx, SW / 2 - w / 2, y - hgt / 2, w, hgt, hgt / 2); sctx.fill();
  sctx.strokeStyle = 'rgba(255,226,122,0.8)'; sctx.lineWidth = 2; sctx.stroke();
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(knifeImg, SW / 2 - w / 2 + fs * 0.6, y - fs * 0.35, fs * 1.6, fs * 0.55);
  sctx.fillStyle = '#ffe27a'; sctx.fillText(text, SW / 2 + fs * 0.6, y);
  sctx.restore();
}
function drawTitle(t) {
  const a = Math.min(seg(t, 0.3, 0.9), 1 - seg(t, 2.0, 2.5));
  if (a > 0) {
    sctx.globalAlpha = a; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.font = `700 ${Math.round(S * 6)}px ${FONT}`; sctx.fillStyle = '#a8bfa0'; sctx.fillText('序章', SW / 2, SH / 2 - S * 10);
    sctx.font = `900 ${Math.round(S * 13)}px ${FONT}`; sctx.fillStyle = '#ff9b3d'; sctx.fillText('山頂的石頭', SW / 2, SH / 2 + S * 6);
    sctx.globalAlpha = 1;
  }
}
function drawFinale(t) {
  const a = Math.min(seg(t, 56.0, 56.3), 1 - seg(t, 59.2, END));
  if (a <= 0) return;
  sctx.save(); sctx.globalAlpha = a; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  const k = easeOut(seg(t, 56, 56.6)), fs = Math.round(S * (24 + (1 - k) * 8));
  sctx.font = `900 ${fs}px ${FONT}`;
  sctx.shadowColor = 'rgba(255,120,40,0.9)'; sctx.shadowBlur = S * 6 * (0.6 + 0.4 * Math.sin(t * 5));
  sctx.fillStyle = '#ff9b3d'; sctx.fillText('燼野', SW / 2, SH / 2 - S * 4);
  sctx.shadowBlur = 0;
  sctx.font = `700 ${Math.round(S * 5.4)}px ${FONT}`; sctx.fillStyle = '#f1ead2';
  sctx.globalAlpha = a * seg(t, 56.8, 57.4);
  sctx.fillText('亞特的冒險：燼野之境', SW / 2, SH / 2 + S * 18);
  sctx.restore();
}
function blackFade(t) {
  let k = 0;
  if (t < 2.5) k = 1; else if (t < 3.4) k = 1 - seg(t, 2.5, 3.4);
  if (t > 23.75 && t < 24.35) k = Math.max(k, 1 - Math.abs(t - 24.05) / 0.3);     // 切換到特寫
  if (t > 52.6) k = Math.max(k, seg(t, 52.6, 53.4));
  return k;
}

function render(t) {
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, SW, SH);
  const cam = renderBuffer(t);
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(buf, OX, OY, LW * S, LH * S);
  // 傳送白光
  if (t > 49.6 && t < 51) {
    const k = t < 49.9 ? seg(t, 49.6, 49.9) : 1 - seg(t, 49.9, 51);
    sctx.fillStyle = `rgba(225,250,255,${k})`; sctx.fillRect(OX, OY, LW * S, LH * S);
  }
  const h = heroAt(t);
  for (const bb of BUBBLES) if (t >= bb.t0 && t <= bb.t1) drawBubble(cam, h, bb, t);
  if (t > 21.5 && t < 22.5) {                       // 「叩！」
    const [sx, sy] = toScreen(cam, 668, PLATEAU - 16);
    sctx.globalAlpha = 1 - seg(t, 22.1, 22.5); sctx.font = `900 ${Math.round(S * 7)}px ${FONT}`;
    sctx.textAlign = 'center'; sctx.lineWidth = 5; sctx.strokeStyle = '#1b1020';
    sctx.strokeText('叩！', sx + S * 8, sy - seg(t, 21.5, 22.5) * S * 6); sctx.fillStyle = '#fff2c4';
    sctx.fillText('叩！', sx + S * 8, sy - seg(t, 21.5, 22.5) * S * 6); sctx.globalAlpha = 1;
  }
  drawNoteCloseup(t);
  drawItemBanner(t);
  const fk = blackFade(t);
  if (fk > 0) { sctx.fillStyle = `rgba(0,0,0,${fk})`; sctx.fillRect(0, 0, SW, SH); }
  for (const n of NARRATION) drawNarration(n, t);
  drawTitle(t);
  drawFinale(t);
}

/* =========================================================
 * 聲音：整段動畫的音效與配樂在開始播放時一次排好時間，
 *       跟畫面共用同一個時鐘，所以永遠對得上。
 * ========================================================= */
let ac = null, mix, revIn, noiseBuf, bus = null, T0 = 0;
function initAudio() {
  Sfx.unlock();                                   // 與遊戲共用同一個音訊環境
  const base = Sfx.ctx;
  if (!base) return false;
  if (!ac) {
    ac = base;
    mix = ac.createGain(); mix.gain.value = 0.55;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    const lim = ac.createWaveShaper(), lc = new Float32Array(1025);
    for (let i = 0; i < 1025; i++) { const x = i * 2 / 1024 - 1; lc[i] = 0.95 * Math.tanh(1.6 * x) / Math.tanh(1.6); }
    lim.curve = lc;
    mix.connect(comp); comp.connect(lim); lim.connect(ac.destination);
    const len = Math.floor(ac.sampleRate * 2.6), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4); }
    const conv = ac.createConvolver(); conv.buffer = ir;
    revIn = ac.createGain(); const revOut = ac.createGain(); revOut.gain.value = 0.38;
    revIn.connect(conv); conv.connect(revOut); revOut.connect(mix);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }
  // 音量跟著暫停選單的「音樂音量」滑桿
  mix.gain.value = 0.55 * Math.min(1.5, Sfx.st.musicVol / 0.8);
  return true;
}
// 每次播放都用一組新的輸出（跳過／重播時整組淡出拔掉）
function newBus() {
  const g = ac.createGain(); g.connect(mix);
  const r = ac.createGain(); r.connect(revIn);
  return { g, r };
}
function killBus(bb) {
  if (!bb) return;
  const now = ac.currentTime;
  for (const n of [bb.g, bb.r]) { n.gain.cancelScheduledValues(now); n.gain.setValueAtTime(n.gain.value, now); n.gain.linearRampToValueAtTime(0, now + 0.3); }
  setTimeout(() => { try { bb.g.disconnect(); bb.r.disconnect(); } catch (err) { /* 略過 */ } }, 600);
}
function env(g, t, vol, attack, dur, hold) {
  vol = Math.max(0.0002, vol);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  if (hold) g.gain.setValueAtTime(vol, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + (hold || 0) + 0.01));
}
function out(g, o) {
  g.connect(bus.g);
  if (o.rev) { const s = ac.createGain(); s.gain.value = o.rev; g.connect(s); s.connect(bus.r); return s; }
  return null;
}
// 聲音播完就拔除，讓音訊系統的負擔隨動畫進行遞減
function autoClean(src, nodes) { src.onended = () => { for (const n of nodes) { if (n) { try { n.disconnect(); } catch (err) { /* 已拔除 */ } } } }; }
// at＝動畫時間軸上的秒數
function tone(at, o) {
  const t = T0 + at, osc = ac.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide || o.dur));
  if (o.detune) osc.detune.value = o.detune;
  let node = osc, f = null;
  if (o.lp) { f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; node.connect(f); node = f; }
  const g = ac.createGain(); env(g, t, o.vol, o.attack || 0.005, o.dur, o.hold);
  node.connect(g); const sg = out(g, o);
  osc.start(t); osc.stop(t + o.dur + (o.hold || 0) + 0.05);
  autoClean(osc, [osc, f, g, sg]);
}
function noise(at, o) {
  const t = T0 + at, src = ac.createBufferSource(), f = ac.createBiquadFilter();
  src.buffer = noiseBuf; f.type = o.ft || 'bandpass'; f.Q.value = o.q || 1;
  f.frequency.setValueAtTime(o.f0, t);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide || o.dur));
  const g = ac.createGain(); env(g, t, o.vol, o.attack || 0.004, o.dur, o.hold);
  src.connect(f); f.connect(g); const sg = out(g, o);
  src.start(t, Math.random() * 0.5, o.dur + (o.hold || 0) + 0.05);
  autoClean(src, [src, f, g, sg]);
}
const bell = (at, f, v, rev) => { tone(at, { f0: f, dur: 0.9, vol: 0.1 * v, rev: rev || 0.4 }); tone(at, { f0: f * 2.76, dur: 0.3, vol: 0.03 * v }); };
const brass = (at, f, dur, v, rev) => { for (const det of [-7, 7]) tone(at, { type: 'sawtooth', f0: f, detune: det, lp: 1800, attack: 0.06, hold: Math.max(0, dur - 0.2), dur: 0.25, vol: 0.075 * v, rev }); };
const boom = (at, v, rev) => { tone(at, { f0: 95, f1: 50, glide: 0.3, dur: 0.7, vol: 0.6 * v, rev }); noise(at, { ft: 'lowpass', f0: 500, dur: 0.14, vol: 0.3 * v }); };
const pad = (at, notes, dur, v, lp) => { for (const f of notes) for (const det of [-8, 8]) tone(at, { type: 'sawtooth', f0: f, detune: det, lp: lp || 1200, attack: 0.6, hold: Math.max(0, dur - 1.2), dur: 0.6, vol: 0.018 * v, rev: 0.3 }); };
const C5 = 523.25, hz = s => C5 * Math.pow(2, s / 12);

function scheduleAll(steps) {
  // ---- 風聲（整段循環，依場景變大變小）----
  const wind = ac.createBufferSource(); wind.buffer = noiseBuf; wind.loop = true;
  const wf = ac.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 650; wf.Q.value = 0.5;
  const wg = ac.createGain(); wg.gain.value = 0;
  wind.connect(wf); wf.connect(wg); wg.connect(bus.g);
  const W = [[2.4, 0], [4, 0.13], [13, 0.12], [15, 0.08], [24, 0.05], [42, 0.04], [50.4, 0.05], [51, 0.22], [52.8, 0.2], [55, 0]];
  wg.gain.setValueAtTime(0, T0);
  for (const [at, v] of W) wg.gain.linearRampToValueAtTime(v, T0 + at);
  for (let at = 5; at < 50; at += 1.7) wf.frequency.linearRampToValueAtTime(500 + Math.random() * 400, T0 + at);
  wind.start(T0 + 2.4); wind.stop(T0 + 56);

  // ---- 腳步聲 ----
  for (const at of steps) noise(at, { ft: 'lowpass', f0: 420, dur: 0.07, vol: 0.16 });

  // ---- 登山主題（原創，C 大調）----
  const beat = 60 / 84, bar = beat * 4, m0 = 2.6;
  const MEL = [
    [[0, 1], [4, 1], [7, 2]], [[9, 1.5], [7, 0.5], [4, 2]], [[2, 1], [4, 1], [7, 1], [9, 1]],
    [[7, 4]], [[9, 1], [12, 1], [14, 2]], [[12, 3], [null, 1]],
  ];
  const CH = [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14], [5, 9, 12], [0, 4, 7]];
  MEL.forEach((notes, i) => {
    const bt = m0 + i * bar;
    pad(bt, CH[i].map(s => hz(s - 12)), bar + 0.4, i >= 4 ? 1.3 : 1);
    tone(bt, { type: 'triangle', f0: hz(CH[i][0] - 24), dur: beat * 1.8, vol: 0.22 });
    tone(bt + beat * 2, { type: 'triangle', f0: hz(CH[i][0] - 24), dur: beat * 1.8, vol: 0.18 });
    let p = bt;
    for (const [s, d] of notes) {
      if (s !== null) { tone(p, { type: 'triangle', f0: hz(s), dur: d * beat * 0.95, attack: 0.04, vol: 0.13, rev: 0.45 }); tone(p, { f0: hz(s + 12), dur: d * beat * 0.6, vol: 0.025 }); }
      p += d * beat;
    }
  });
  // 登頂：號角＋定音鼓
  const summit = m0 + 4 * bar;
  boom(summit, 0.8, 0.4); noise(summit, { ft: 'highpass', f0: 5000, dur: 1.8, vol: 0.12, rev: 0.4 });
  [349.2, 440, 523.3].forEach(f => brass(summit, f, 2.6, 0.8, 0.4));
  pad(19.7, [261.6, 329.6, 392, 587.3], 4.5, 1);
  // ---- 好奇的撥弦（特寫）----
  const pent = [0, 2, 4, 7, 9, 12];
  for (let at = 24.4, i = 0; at < 34.6; at += beat, i++) {
    const s = pent[(i * 3 + (i >> 2)) % pent.length];
    tone(at, { type: 'triangle', f0: hz(s), dur: 0.22, vol: 0.075, rev: 0.25 });
  }
  // ---- 事件音效 ----
  const pop = at => tone(at, { f0: 900, f1: 1200, dur: 0.06, vol: 0.05 });
  for (const bb of BUBBLES) pop(bb.t0);
  // 踢到石頭
  tone(21.5, { f0: 210, f1: 80, dur: 0.12, vol: 0.55 }); noise(21.5, { f0: 1800, q: 2, dur: 0.05, vol: 0.4 }); noise(21.5, { ft: 'highpass', f0: 3000, dur: 0.02, vol: 0.4 });
  for (const at of [21.68, 21.86, 22.02]) { noise(at, { f0: 1500 + Math.random() * 800, q: 3, dur: 0.035, vol: 0.25 }); tone(at, { f0: 160, f1: 90, dur: 0.06, vol: 0.2 }); }
  tone(23.3, { type: 'square', f0: 700, f1: 900, dur: 0.08, vol: 0.03 });
  // 紙條
  for (let k = 0; k < 4; k++) noise(27.2 + k * 0.05, { ft: 'highpass', f0: 3000 + k * 400, dur: 0.04, vol: 0.18 });
  tone(27.3, { f0: 220, dur: 1.6, vol: 0.12, rev: 0.5, attack: 0.2 }); tone(27.3, { f0: 233, dur: 1.6, vol: 0.08, attack: 0.2 });
  // 撿起刀
  noise(30.8, { ft: 'lowpass', f0: 900, dur: 0.15, vol: 0.2 });
  tone(31.2, { type: 'square', f0: 1800, f1: 1200, dur: 0.05, vol: 0.05 });
  [523, 659, 784, 1047].forEach((f, i) => bell(31.25 + i * 0.08, f, 1.2, 0.45));
  brass(31.6, 1047, 0.6, 0.6, 0.4);
  // ---- 神秘：低音嗡鳴＋小調和聲 ----
  tone(35, { f0: 55, dur: 0.8, hold: 14, attack: 2.5, vol: 0.09 });
  tone(35, { f0: 82.4, dur: 0.8, hold: 14, attack: 3, vol: 0.05 });
  pad(35.2, [220, 261.6, 329.6, 493.9], 7.2, 1.1, 800);
  tone(35.6, { type: 'square', f0: 660, f1: 990, dur: 0.12, vol: 0.04 });
  for (const at of [36.4, 37.9, 39.1, 40.4, 41.3]) bell(at, [1760, 2093, 2349, 2637][Math.floor(at) % 4], 0.5, 0.6);
  // 摸到石頭
  noise(42.3, { ft: 'highpass', f0: 4000, dur: 0.08, vol: 0.4 }); tone(42.3, { f0: 1320, f1: 2640, dur: 0.3, vol: 0.08, rev: 0.5 });
  // ---- 發光：聲音一路往上衝 ----
  noise(42.5, { f0: 200, f1: 4500, glide: 7.3, dur: 7.3, attack: 6.5, vol: 0.35, q: 1.2, rev: 0.3 });
  tone(42.5, { type: 'sawtooth', f0: 55, f1: 220, glide: 7.3, dur: 7.3, attack: 3, vol: 0.06, lp: 900 });
  const scale = [0, 2, 3, 5, 7, 8, 10];
  for (let at = 42.6, i = 0, gap = 0.42; at < 49.7; at += gap, i++, gap = Math.max(0.07, gap * 0.93)) {
    const s = scale[i % 7] + 12 * Math.floor(i / 7);
    tone(at, { f0: 220 * Math.pow(2, s / 12), dur: 0.18, vol: 0.05 + i * 0.0015, rev: 0.4 });
  }
  for (const at of [44, 45.4, 46.5, 47.4, 48.1, 48.65, 49.05, 49.35, 49.6]) boom(at, 0.55, 0.2);
  // 傳送
  noise(49.85, { ft: 'lowpass', f0: 7000, f1: 90, dur: 1.4, vol: 0.6, rev: 0.7 });
  noise(49.7, { f0: 300, f1: 6000, dur: 0.25, attack: 0.15, vol: 0.35 });
  boom(49.85, 1.3, 0.6);
  [440, 554.4, 659.3, 880, 1318.5].forEach(f => tone(49.9, { f0: f, dur: 2.6, attack: 0.02, vol: 0.06, rev: 0.7 }));
  bell(51.3, 1760, 0.6, 0.7);
  // ---- 結尾：燼野 ----
  pad(53.4, [146.8, 174.6, 220], 6.2, 1.3, 700);
  tone(53.4, { f0: 73.4, dur: 0.8, hold: 5.5, attack: 1.5, vol: 0.09 });
  [146.8, 174.6, 220, 293.7].forEach(f => brass(56, f, 2.8, 1.1, 0.5));
  boom(56, 1.2, 0.5); noise(56, { ft: 'highpass', f0: 4500, dur: 2.4, vol: 0.18, rev: 0.5 });
}
// 依時間軸算出所有腳步聲的時間點
function computeSteps() {
  const steps = []; let last = -1;
  for (let t = 0; t < END; t += 1 / 60) {
    const h = heroAt(t);
    if (h.pose === 'walk' && h.phase % 2 === 0 && h.phase !== last) steps.push(t);
    last = h.pose === 'walk' ? h.phase : -1;
  }
  return steps;
}

/* ---- 播放控制（遊戲內版本）---- */
const skipBtn = document.getElementById('prologueSkip');
let playing = false, clockStart = 0, useAudio = false, doneCb = null, rafId = 0;
function now() { return useAudio ? ac.currentTime - T0 : (performance.now() - clockStart) / 1000; }
function finish() {
  if (!playing) return;
  playing = false;
  if (useAudio) killBus(bus);
  bus = null;
  skipBtn.classList.add('hidden'); screen.style.display = 'none';
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
  const cb = doneCb; doneCb = null;
  if (cb) cb();
}
function loop() {
  if (!playing) return;
  let t = now();
  if (useAudio && ac.state !== 'running') t = lastT;      // 聲音被系統暫停時，畫面也停住等待
  const dt = clamp(t - lastT, 0, 0.05);
  runBursts(t); updateParticles(t, dt); lastT = t;
  render(Math.max(0, t));
  if (t >= END) { finish(); return; }
  rafId = requestAnimationFrame(loop);
}
skipBtn.addEventListener('click', finish);
function start(done) {
  doneCb = done;
  screen.style.display = 'block'; skipBtn.classList.remove('hidden');
  resize();
  useAudio = initAudio() && !!ac;
  parts = []; burstDone = new Set(); lastT = 0;
  if (useAudio) {
    killBus(bus); bus = newBus();
    T0 = ac.currentTime + 0.15;
    try { scheduleAll(computeSteps()); } catch (err) { /* 聲音失敗也照樣播畫面 */ }
  }
  clockStart = performance.now() + 150;
  playing = true;
  rafId = requestAnimationFrame(loop);
}
return { start, skip: finish, get playing() { return playing; }, _debug: { render, END } };
}
let prologue = null;
function playPrologue(done) {
  try { if (!prologue) prologue = createPrologue(); prologue.start(done); }
  catch (err) { if (window.console) console.warn('序章無法播放，直接進入遊戲：', err); done(); }   // 任何問題都不能卡住遊戲
}

/* =========================================================
 * 第一關結局動畫：被選中之人（破完第一關後播放，取得無影斬）
 * ========================================================= */
function createChapter1End() {
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);           // t 在 [a,b] 的進度
const easeIO = k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const easeOut = k => 1 - (1 - k) * (1 - k);
const hash = (x, y) => (((Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663)) >>> 0) % 1000) / 1000;
const END = 64.6;                                                    // 故事時間的總長（秒）
// 剪接：拿掉原本「我好像懂了」的思考停頓（故事時間 43.4–46.6 秒），之後的內容整段提前
const CUT_AT = 44.2, CUT_LEN = 2.4;              // 握著珠子約 1.8 秒（42.4 抓到 → 44.2 捏碎）
const toStory = r => (r < CUT_AT ? r : r + CUT_LEN);                  // 實際播放秒數 → 故事時間
const toReal = s => (s < CUT_AT ? s : s < CUT_AT + CUT_LEN ? null : s - CUT_LEN);   // 被剪掉的時間回傳 null
const END_REAL = END - CUT_LEN;                                       // 實際播放長度 62.2 秒

// ---------- 畫布 ----------
const LW = 320, LH = 180;
const screen = document.getElementById('prologueCanvas'), sctx = screen.getContext('2d');
const buf = document.createElement('canvas'); buf.width = LW; buf.height = LH;
const b = buf.getContext('2d');
let SW = 0, SH = 0, DPR = 1, S = 1, OX = 0, OY = 0;
function resize() {
  SW = window.innerWidth; SH = window.innerHeight; DPR = Math.min(window.devicePixelRatio || 1, 2);
  screen.width = Math.round(SW * DPR); screen.height = Math.round(SH * DPR);
  S = Math.min(SW / LW, SH / LH); OX = (SW - LW * S) / 2; OY = (SH - LH * S) / 2;
}
window.addEventListener('resize', resize);
resize();

function pixelCanvas(rows, color) {
  const h = rows.length, w = rows[0].length, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const ch = rows[yy][xx];
    if (!ch || ch === '.') continue;
    x.fillStyle = color(ch); x.fillRect(xx, yy, 1, 1);
  }
  return c;
}



// ---------- 螢幕解析度的文字層 ----------
function rrect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
const FONT = '"PingFang TC","Noto Sans TC","Heiti TC","Microsoft JhengHei",sans-serif';
function toScreen(cam, wx, wy) { return [OX + (wx - cam.x) * cam.z * S, OY + (wy - cam.y) * cam.z * S]; }
function drawBubble(cam, h, bb, t) {
  const a = Math.min(seg(t, bb.t0, bb.t0 + 0.15), 1 - seg(t, bb.t1 - 0.15, bb.t1));
  if (a <= 0) return;
  const [hx, hy] = toScreen(cam, h.x, h.y - 37);
  const fs = Math.max(15, Math.round(S * (bb.kind === 'mark' ? 9 : 5.4)));
  sctx.font = `${bb.kind === 'shout' ? 900 : 700} ${fs}px ${FONT}`;
  const tw = sctx.measureText(bb.text).width, pad = fs * 0.7;
  const w = tw + pad * 2, hh = fs + pad * 1.3;
  const prefer = bb.side === 'left' ? hx - w + fs * 1.4 : hx - w / 2 + fs * 2;      // 面板在右邊時，對話框改往左邊長
  const bx = clamp(prefer, OX + 8, OX + LW * S - w - 8), by = hy - hh - fs * 1.3;
  const pop = 0.85 + 0.15 * easeOut(seg(t, bb.t0, bb.t0 + 0.18));
  sctx.save();
  sctx.globalAlpha = a;
  sctx.translate(bx + w / 2, by + hh / 2); sctx.scale(pop, pop); sctx.translate(-(bx + w / 2), -(by + hh / 2));
  if (bb.kind === 'mark') {
    sctx.lineWidth = 6; sctx.strokeStyle = '#1b1020'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.strokeText(bb.text, hx + fs * 0.6, hy - fs * 0.6); sctx.fillStyle = '#ffe066'; sctx.fillText(bb.text, hx + fs * 0.6, hy - fs * 0.6);
    sctx.restore(); return;
  }
  sctx.fillStyle = bb.kind === 'think' ? 'rgba(235,240,255,0.96)' : '#fffdf6';
  sctx.strokeStyle = '#2b1414'; sctx.lineWidth = Math.max(2, S * 0.7);
  rrect(sctx, bx, by, w, hh, hh * 0.45); sctx.fill(); sctx.stroke();
  if (bb.kind === 'think') {             // 思考泡泡：一串小圓圈
    for (const [k, r] of [[0.35, 0.16], [0.7, 0.1]]) {
      const cx = lerp(bx + w * 0.35, hx, k), cy = lerp(by + hh, hy, k);
      sctx.beginPath(); sctx.arc(cx, cy, fs * r * 1.6, 0, TAU); sctx.fill(); sctx.stroke();
    }
  } else {                                // 說話泡泡：尖角指向亞特
    const tx = clamp(hx, bx + hh * 0.5, bx + w - hh * 0.5);
    sctx.beginPath(); sctx.moveTo(tx - fs * 0.45, by + hh - 1); sctx.lineTo(tx, by + hh + fs * 0.75); sctx.lineTo(tx + fs * 0.45, by + hh - 1);
    sctx.fill(); sctx.stroke();
    sctx.fillRect(tx - fs * 0.4, by + hh - sctx.lineWidth * 1.5, fs * 0.8, sctx.lineWidth * 1.6);
  }
  sctx.fillStyle = '#2b1414'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  sctx.fillText(bb.text, bx + w / 2, by + hh / 2 + fs * 0.04);
  sctx.restore();
}
/* =========================================================
 * 第一關結局動畫：被選中之人
 *   場景：戰鬥過後的苔原燼野（俯視角，與遊戲畫面一致）
 * ========================================================= */
const heroCache = new Map();
// 表情：normal / shock（眼睛瞪大、眉毛上揚，嘴巴不張開）/ rage（殺氣：血紅色的眼睛）
const RED_EYE = '#e01f2a';
function heroImg(pose, phase, tint, face) {
  const k = pose + phase + (tint || '') + (face || '');
  if (!heroCache.has(k)) {
    const g = HERO.build('side', pose, phase, {});
    const ub = pose === 'idle' ? phase % 2 : pose === 'walk' && phase % 2 === 1 ? -1 : 0;
    if (face === 'shock') {
      for (let x = 20; x <= 22; x++) { g[13 + ub][x] = 'K'; for (let y = 14; y <= 16; y++) g[y + ub][x] = 'w'; }
      g[15 + ub][21] = 'e';
    }
    if (face === 'rage') for (let y = 0; y < 21; y++) for (let x = 0; x < 32; x++) if (g[y][x] === 'e') g[y][x] = 'R';
    heroCache.set(k, pixelCanvas(g, ch => tint || (ch === 'R' ? RED_EYE : HERO.PAL[ch])));
  }
  return heroCache.get(k);
}
// ---- 寶箱與「無影斬」珠子 ----
const CHEST_CLOSED = [
  '..KKKKKKKKKKKKKK..', '.KwwwwwwwwwwwwwwK.', 'KwWWWYWWWWWWYWWWwK', 'KWWWWYWWWWWWYWWWWK', 'KYYYYYYYKKYYYYYYYK',
  'KKKKKKKKYYKKKKKKKK', 'KWWWWYWWYYWWYWWWWK', 'KWWWWYWWKKWWYWWWWK', 'KwWWWYWWWWWWYWWWwK', 'KWWWWYWWWWWWYWWWWK',
  'KWWWWYWWWWWWYWWWWK', 'KYYYYYYYYYYYYYYYYK', '.KKKKKKKKKKKKKKKK.',
];
const CHEST_OPEN = ['..KKKKKKKKKKKKKK..', '.KwwwwwwwwwwwwwwK.', 'KYYYYYYYYYYYYYYYYK', 'KKKKKKKKKKKKKKKKKK', 'KggggggggggggggggK', 'KKKKKKKKYYKKKKKKKK'].concat(CHEST_CLOSED.slice(6));
const CHEST_PAL = { K: '#2b1414', W: '#9a5a2a', w: '#c07a3c', Y: '#e8c070', g: '#fff1b0' };
const chestClosed = pixelCanvas(CHEST_CLOSED, ch => CHEST_PAL[ch]);
const chestOpen = pixelCanvas(CHEST_OPEN, ch => CHEST_PAL[ch]);
const ORB = ['..KKKK..', '.KrRRrK.', 'KrRhRRrK', 'KRRRRbRK', 'KRRbbRRK', 'KrRRRRrK', '.KrRRrK.', '..KKKK..'];
const orbImg = pixelCanvas(ORB, ch => ({ K: '#14040a', r: '#5a0a12', R: '#c4162a', h: '#ff8a9a', b: '#14040a' })[ch]);

function pixelDisc(cx, cy, r, col) {
  b.fillStyle = col;
  for (let y = -r; y <= r; y++) { const w = Math.floor(Math.sqrt(r * r - y * y)); b.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1); }
}
// ---------- 背景：戰鬥過後的苔原燼野（只畫一次）----------
const LANE = 122;                                   // 亞特走路的地面高度（腳底）
const FIRE_STONES = [[100, 58], [212, 150]];
const bg = (() => {
  const c = document.createElement('canvas'); c.width = LW; c.height = LH;
  const x = c.getContext('2d');
  const G = ['#4e8442', '#548b47', '#497d3d'];
  for (let ty = 0; ty < LH; ty += 16) for (let tx = 0; tx < LW; tx += 16) {
    const h = hash(tx, ty); x.fillStyle = h < 0.3 ? G[1] : h > 0.82 ? G[2] : G[0]; x.fillRect(tx, ty, 16, 16);
    if (h > 0.93) { x.fillStyle = h > 0.965 ? '#f3e3a1' : '#e9a6c4'; x.fillRect(tx + 6 + (h * 8 | 0), ty + 8, 2, 2); }
  }
  // 草叢（有些燒成灰）
  const patch = (x0, y0, cols, rows, burnt) => {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const h = hash(x0 + i * 13, y0 + j * 7);
      if (h < 0.18) continue;
      const px = x0 + i * 12, py = y0 + j * 12, ash = burnt && hash(i, j + x0) < burnt;
      if (ash) { x.fillStyle = 'rgba(42,34,30,0.75)'; x.fillRect(px + 1, py + 1, 10, 10); x.fillStyle = 'rgba(80,70,60,0.6)'; x.fillRect(px + 3, py + 4, 3, 2); continue; }
      x.fillStyle = h > 0.6 ? '#3a772e' : '#3f7f32'; x.fillRect(px, py, 12, 12);
      x.fillStyle = '#66b04d';
      for (let k = 0; k < 3; k++) { const bx = px + 2 + ((h * 97 * (k + 3)) | 0) % 8; x.fillRect(bx, py + 3 + k, 1, 7 - k); x.fillRect(bx + 1, py + 5 + k, 1, 5 - k); }
    }
  };
  patch(8, 6, 7, 4, 0);
  patch(226, 10, 7, 5, 0.55);                       // 燒過的草叢
  patch(36, 138, 9, 4, 0.2);
  patch(232, 140, 6, 4, 0);
  // 岩石
  const rock = (rx, ry, w, h) => {
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(rx + 2, ry + 3, w, h);
    x.fillStyle = '#4e5158'; x.fillRect(rx - 1, ry, w + 2, h); x.fillRect(rx, ry - 1, w, h + 2);
    x.fillStyle = '#7d8189'; x.fillRect(rx, ry, w, h);
    x.fillStyle = '#9a9ea6'; x.fillRect(rx + 2, ry + 2, w - 4, Math.round(h * 0.4));
  };
  rock(120, 26, 22, 16); rock(296, 140, 18, 14); rock(10, 152, 16, 12); rock(178, 66, 14, 12);
  // 火爆石底色（裂縫每幀另外畫，會發光）
  for (const [fx, fy] of FIRE_STONES) {
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(fx + 2, fy + 3, 12, 12);
    x.fillStyle = '#2a0f08'; x.fillRect(fx - 1, fy, 14, 12); x.fillRect(fx, fy - 1, 12, 14);
    x.fillStyle = '#5b2618'; x.fillRect(fx, fy, 12, 12);
  }
  // 木箱（一個完好、一個被打破）
  x.fillStyle = '#6e4620'; x.fillRect(165, 16, 12, 12); x.fillStyle = '#b07a3e'; x.fillRect(166, 17, 10, 10);
  x.fillStyle = '#6e4620'; for (let k = 0; k < 10; k++) { x.fillRect(166 + k, 17 + k, 1, 1); x.fillRect(175 - k, 17 + k, 1, 1); }
  for (const [dx, dy] of [[58, 96], [63, 99], [55, 101], [67, 95], [61, 92]]) { x.fillStyle = '#b07a3e'; x.fillRect(dx, dy, 3, 2); x.fillStyle = '#6e4620'; x.fillRect(dx, dy + 2, 3, 1); }
  return c;
})();

// =========================================================
// 時間軸
// =========================================================
const PAGES = [
  { t0: 10.2, t1: 15.7, lines: ['你已成為被選中之人'] },
  { t0: 16.0, t1: 20.3, lines: ['你將接受燼野的試煉'] },
  { t0: 20.6, t1: 24.8, lines: ['若不接受', '你的心臟將在 0.1 秒後停止'], warn: true },
  { t0: 25.0, t1: 31.6, buttons: true },
  { t0: 31.6, t1: 60.4, lines: ['已接受'] },
];
const PANEL = { x: 154, y: 54, w: 146, h: 70, t0: 9.3, t1: 60.4 };       // 面板浮在亞特眼前（低解析座標）
const PANEL_UP = { x: 182, y: 4, w: 118, h: 56 };                         // 按下接受後縮小、往上讓出地面
function panelRect(t) {
  const k = easeIO(seg(t, 32.0, 32.8));
  return { x: lerp(PANEL.x, PANEL_UP.x, k), y: lerp(PANEL.y, PANEL_UP.y, k), w: lerp(PANEL.w, PANEL_UP.w, k), h: lerp(PANEL.h, PANEL_UP.h, k) };
}
const CHEST_X = 192, OPEN_X = 172;                                         // 寶箱位置、亞特開箱時站的位置
const TOUCH_X = 158;                                                       // 亞特走到這裡伸手按「接受」
const TYPE_GAP = 0.06;                                                       // 逐字打出的間隔
const BUBBLES = [
  { t0: 2.0, t1: 5.8, text: '終於打完了……', kind: 'say' },
  { t0: 12.2, t1: 12.9, text: '！', kind: 'mark' },
  { t0: 13.0, t1: 15.6, text: '咦，這是什麼？', kind: 'say', side: 'left' },
  { t0: 25.6, t1: 26.7, text: '！？', kind: 'mark' },
  { t0: 27.2, t1: 30.5, text: '好吧……看來不接受也沒辦法了。', kind: 'say', side: 'left' },
  { t0: 34.4, t1: 35.6, text: '寶箱？', kind: 'say', side: 'left' },
  { t0: 36.9, t1: 38.4, text: '這是……一顆珠子？', kind: 'say', side: 'left' },
];
function heroAt(t) {
  const h = { x: -20, y: LANE, pose: 'idle', phase: Math.floor(t * 2) % 2, face: '', visible: t < 61.15, glow: 0, crouch: 0, aura: 0 };
  const walk = (a, b2, x0, x1) => { const k = seg(t, a, b2); h.x = lerp(x0, x1, k); if (t > a && t < b2) { h.pose = 'walk'; h.phase = Math.floor(h.x / 5) % 4; } };
  if (t < 9.0) walk(1.0, 9.0, -20, 140);
  else if (t < 30.6) h.x = 140;
  else if (t < 31.0) walk(30.6, 31.0, 140, TOUCH_X);
  else if (t < 31.6) { h.x = TOUCH_X; h.pose = 'aim'; }
  else if (t < 35.2) h.x = TOUCH_X;
  else if (t < 35.6) walk(35.2, 35.6, TOUCH_X, OPEN_X);
  else {
    h.x = OPEN_X;
    if ((t > 35.85 && t < 36.4) || (t > 41.8 && t < 46.7)) h.pose = 'aim';      // 打開寶箱／冷靜地伸手抓住珠子、握著
  }
  if (t > 25.5 && t < 27.0) { h.face = 'shock'; h.phase = 0; }
  if (t > 25.5 && t < 26.1) h.crouch = -Math.sin(seg(t, 25.5, 26.1) * Math.PI) * 6;   // 嚇得跳起來
  if (t > 46.6 && t < 54.2) h.face = 'rage';                                          // 捏碎珠子後：血紅色的眼睛
  // 殺氣：慢慢浮起 → 停留 → 落回地面
  h.aura = t > 46.8 && t < 53.6 ? Math.min(1, seg(t, 46.8, 47.6)) * (1 - seg(t, 52.6, 53.6)) : 0;
  const lift = t < 51.5 ? easeIO(seg(t, 47.5, 50.0)) * 10 : (1 - easeIO(seg(t, 51.5, 52.8))) * 10;
  if (t > 56.2) h.glow = easeIO(seg(t, 56.2, 60.9));
  h.y = LANE + h.crouch - lift - (t > 58.9 ? easeIO(seg(t, 58.9, 61.1)) * 7 : 0);
  return h;
}
const cam = { x: 0, y: 0, z: 1 };

// ---------- 粒子 ----------
let parts = [], lastT = 0;
function emit(o) { if (parts.length < 900) parts.push(o); }
function updateParticles(t, dt) {
  const h = heroAt(t);
  if (Math.random() < dt * 3) emit({ x: 230 + Math.random() * 80, y: 20 + Math.random() * 50, vx: 2, vy: -10, g: 0, life: 1.6, max: 1.6, c: 'rgba(120,110,100,0.8)', s: 2 });   // 燒過草叢的餘煙
  if (Math.random() < dt * 2) emit({ x: Math.random() * LW, y: Math.random() * LH, vx: 6, vy: -2, g: 0, life: 2, max: 2, c: '#fff7c8', s: 1 });                                   // 花粉
  if (t > 25.6 && t < 27 && Math.random() < dt * 5) emit({ x: h.x + 9, y: h.y - 30, vx: 4, vy: -6, g: 70, life: 0.7, max: 0.7, c: '#9fd8ff', s: 1 });                        // 冷汗
  if (t > 36.2 && t < 38.2 && Math.random() < dt * 30) emit({ x: CHEST_X - 6 + Math.random() * 12, y: LANE - 12, vx: (Math.random() - 0.5) * 10, vy: -25 - Math.random() * 20, g: 0, life: 0.9, max: 0.9, c: Math.random() < 0.5 ? '#fff1b0' : '#ffd166', s: 1 });
  if (h.aura > 0) {                                   // 黑紅色的殺氣繞著身體往上竄
    for (let n = 0; n < (25 + 55 * h.aura) * dt; n++) {
      const a = Math.random() * TAU, r = 11 + Math.random() * 9;         // 分布在身體外圍，不蓋住臉
      const roll = Math.random();
      emit({ x: h.x + Math.cos(a) * r, y: h.y - 2 - Math.random() * 32, vx: -Math.sin(a) * 14, vy: -14 - Math.random() * 26, g: 0, life: 0.8, max: 0.8,
        c: roll < 0.3 ? '#2a0610' : roll < 0.75 ? '#8a0f1a' : '#ff2a3a', s: Math.random() < 0.25 ? 2 : 1 });
    }
  }
  if (t > 56.4 && t < 61.1) {
    const rate = 30 + h.glow * 160;
    for (let n = 0; n < rate * dt; n++) {
      const a = Math.random() * TAU, r = 6 + Math.random() * 10;
      emit({ x: h.x + Math.cos(a) * r, y: h.y - 4 - Math.random() * 30, vx: -Math.sin(a) * 10, vy: -18 - Math.random() * 25 * (1 + h.glow), g: 0, life: 0.9, max: 0.9, c: Math.random() < 0.3 ? '#ffffff' : '#7fe0ff', s: Math.random() < 0.2 ? 2 : 1 });
    }
  }
  for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g || 0) * dt; p.life -= dt; }
  parts = parts.filter(p => p.life > 0);
}
const BURSTS = [
  { t: 9.3, x: 227, y: 89, n: 26, c: '#9fefff', sp: 60, up: 10 },
  { t: 31.3, x: TOUCH_X + 8, y: LANE - 10, n: 18, c: '#e8fbff', sp: 40, up: 10 },
  { t: 34.0, x: CHEST_X, y: LANE - 4, n: 30, c: '#bff3ff', sp: 50, up: 20 },
  { t: 46.6, x: OPEN_X + 9, y: LANE - 12, n: 36, c: '#ff2a3a', sp: 60, up: 20 },
  { t: 46.6, x: OPEN_X + 9, y: LANE - 12, n: 24, c: '#1a0508', sp: 45, up: 20 },
  { t: 52.7, x: OPEN_X, y: LANE - 16, n: 60, c: '#8a0f1a', sp: 80, up: 10 },
  { t: 61.15, x: OPEN_X, y: LANE - 18, n: 90, c: '#d8f8ff', sp: 70, up: 60 },
];
let burstDone = new Set();
function runBursts(t) {
  BURSTS.forEach((bs, i) => {
    if (t >= bs.t && !burstDone.has(i)) {
      burstDone.add(i);
      for (let k = 0; k < bs.n; k++) {
        const a = Math.random() * TAU, sp = Math.random() * bs.sp;
        emit({ x: bs.x, y: bs.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - bs.up * Math.random(), g: 40, life: 0.8 + Math.random() * 0.5, max: 1.2, c: bs.c, s: Math.random() < 0.3 ? 2 : 1 });
      }
    }
  });
}

// ---------- 低解析畫面 ----------
function renderBuffer(t) {
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.imageSmoothingEnabled = false;
  let shx = 0, shy = 0;
  if (t > 46.6 && t < 47.0) { shx = (Math.random() * 2 - 1) * 2; shy = (Math.random() * 2 - 1) * 2; }
  if (t > 57.5 && t < 61.2) { const a = easeIO(seg(t, 57.5, 60.9)) * 2; shx = (Math.random() * 2 - 1) * a; shy = (Math.random() * 2 - 1) * a; }
  if (t > 25.5 && t < 25.8) shy = (Math.random() * 2 - 1) * 1.5;
  b.setTransform(1, 0, 0, 1, Math.round(shx), Math.round(shy));
  b.drawImage(bg, 0, 0);
  // 火爆石的發光裂縫
  for (const [fx, fy] of FIRE_STONES) {
    const gl = 0.55 + 0.45 * Math.sin(t * 3 + fx);
    b.fillStyle = `rgba(255,${(110 + 80 * gl) | 0},40,${0.6 + 0.4 * gl})`;
    for (const [cx, cy] of [[2, 3], [3, 4], [4, 5], [4, 6], [3, 7], [8, 2], [7, 3], [7, 4], [8, 5], [8, 6], [9, 7]]) b.fillRect(fx + cx, fy + cy, 1, 1);
  }
  // 地上的魔法陣
  const h = heroAt(t);
  // 寶箱（傳送過來 → 打開）
  if (t > 33.9) {
    const drop = t < 34.0 ? 0 : Math.max(0, (1 - seg(t, 34.0, 34.25)) * 6);
    b.globalAlpha = 0.3; b.fillStyle = '#000'; b.fillRect(CHEST_X - 9, LANE - 1, 18, 2); b.globalAlpha = 1;
    b.drawImage(t > 36.2 ? chestOpen : chestClosed, CHEST_X - 9, LANE - 13 - Math.round(drop));
    if (t > 36.2 && t < 39) {                       // 寶箱裡透出的金光
      b.globalAlpha = 0.35 * (1 - seg(t, 37.5, 39)); b.fillStyle = '#fff1b0';
      b.fillRect(CHEST_X - 7, LANE - 40, 14, 30); b.globalAlpha = 1;
    }
  }
  // 寶箱傳送過來的光柱
  if (t > 32.6 && t < 34.6) {
    const k = t < 34.0 ? seg(t, 32.6, 34.0) : 1 - seg(t, 34.0, 34.6), w = 2 + k * 10;
    b.globalAlpha = 0.5 * k; b.fillStyle = '#9fefff'; b.fillRect(Math.round(CHEST_X - w / 2), -10, Math.round(w), LANE + 8);
    b.globalAlpha = 0.9 * k; b.fillStyle = '#ffffff'; b.fillRect(Math.round(CHEST_X - w / 6), -10, Math.max(1, Math.round(w / 3)), LANE + 8);
    b.globalAlpha = 1;
  }
  // 「無影斬」珠子：從寶箱浮起 → 亞特伸手抓住 → 捏碎
  if (t > 36.6 && t < 46.6) {
    let ox = CHEST_X - 4, oy = LANE - 22 - easeOut(seg(t, 36.6, 37.4)) * 10 + Math.sin(t * 3) * 1.5;
    if (t > 42.15) { const k = easeOut(seg(t, 42.15, 42.4)); ox = lerp(ox, OPEN_X + 6, k); oy = lerp(oy, LANE - 15, k); }   // 一把抓住
    if (t > CUT_AT - 0.4 && t < CUT_AT) { ox += (Math.random() - 0.5) * 1.2; }                                             // 捏碎前最後 0.4 秒才握緊、顫動
    b.globalAlpha = 0.35 + 0.15 * Math.sin(t * 5); pixelDisc(ox + 4, oy + 4, 7, '#ff2a3a'); b.globalAlpha = 1;
    b.drawImage(orbImg, Math.round(ox), Math.round(oy));
  }
  if (t > 56.4 && t < 61.6) {
    const r = lerp(8, 24, easeOut(seg(t, 56.4, 58.5))), n = 28, alpha = t > 61.1 ? 1 - seg(t, 61.1, 61.6) : 1;
    b.globalAlpha = 0.85 * alpha;
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + t * 1.6;
      b.fillStyle = i % 4 === 0 ? '#ffffff' : '#7fe0ff';
      b.fillRect(Math.round(OPEN_X + Math.cos(a) * r), Math.round(LANE - 1 + Math.sin(a) * r * 0.45), 1, 1);
    }
    b.globalAlpha = 1;
  }
  // 殺氣籠罩時地上的暗紅色陰影
  if (h.aura > 0) { b.globalAlpha = 0.45 * h.aura; pixelDisc(h.x, LANE, 13, '#3a0610'); b.globalAlpha = 1; }
  if (h.visible && h.x > -40) {
    const img = heroImg(h.pose, h.phase, '', h.face);
    const hx = Math.round(h.x - 16), hy = Math.round(h.y - 34);
    b.globalAlpha = 0.28; b.fillStyle = '#000'; b.fillRect(Math.round(h.x - 10), LANE - 1, 20, 3); b.globalAlpha = 1;
    if (h.glow > 0) {
      const glow = heroImg(h.pose, h.phase, '#7fe0ff', h.face);
      const pulse = 0.55 + 0.45 * Math.sin(t * (8 + h.glow * 18));
      b.globalAlpha = clamp(h.glow * 1.2, 0, 1) * pulse;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0]]) b.drawImage(glow, hx + ox, hy + oy);
      b.globalAlpha = 1;
    }
    if (h.aura > 0) {
      const pulse = 0.6 + 0.4 * Math.sin(t * 9);
      for (const [tint, off, al] of [['#1a0508', 2, 0.8], ['#c4162a', 1, 1]]) {
        const ai = heroImg(h.pose, h.phase, tint, h.face);
        b.globalAlpha = h.aura * pulse * al;
        for (const [ox, oy] of [[-off, 0], [off, 0], [0, -off], [0, off]]) b.drawImage(ai, hx + ox, hy + oy);
      }
      b.globalAlpha = 1;
    }
    b.drawImage(img, hx, hy);
    if (h.glow > 0.05) { b.globalAlpha = clamp(h.glow * 0.85, 0, 0.85); b.drawImage(heroImg(h.pose, h.phase, '#bff3ff', h.face), hx, hy); b.globalAlpha = 1; }
  }
  // 粒子
  for (const p of parts) { b.globalAlpha = clamp(p.life / p.max, 0, 1); b.fillStyle = p.c; b.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s); }
  b.globalAlpha = 1;
  // 光柱
  if (t > 60.6 && t < 62.1) {
    const k = t < 61.15 ? seg(t, 60.6, 61.15) : 1 - seg(t, 61.15, 62.1), w = 3 + k * 14;
    b.globalAlpha = 0.55 * k; b.fillStyle = '#9fefff'; b.fillRect(Math.round(OPEN_X - w / 2), -10, Math.round(w), LANE + 10);
    b.globalAlpha = 0.9 * k; b.fillStyle = '#ffffff'; b.fillRect(Math.round(OPEN_X - w / 6), -10, Math.max(1, Math.round(w / 3)), LANE + 10);
    b.globalAlpha = 1;
  }
  b.setTransform(1, 0, 0, 1, 0, 0);
}

// ---------- 發光的藍色面板（螢幕解析度，文字清晰）----------
function panelOpen(t) {                              // 0→1 展開，1→0 收起
  if (t < PANEL.t0 || t > PANEL.t1) return 0;
  if (t < PANEL.t0 + 0.8) return easeOut(seg(t, PANEL.t0, PANEL.t0 + 0.8));
  if (t > PANEL.t1 - 0.6) return 1 - easeIO(seg(t, PANEL.t1 - 0.6, PANEL.t1));
  return 1;
}
function drawPanel(t) {
  const k = panelOpen(t);
  if (k <= 0) return;
  const pr = panelRect(t);
  const px = OX + pr.x * S, pw = pr.w * S, cy = OY + (pr.y + pr.h / 2) * S;
  const ph = Math.max(2, pr.h * S * k), py = cy - ph / 2;
  const flick = t < PANEL.t0 + 1.1 ? (Math.random() < 0.25 ? 0.55 : 1) : 1;
  const page = PAGES.find(p => t >= p.t0 && t < p.t1);
  const warn = page && page.warn;
  const main = warn ? '255,120,120' : '120,225,255';
  sctx.save();
  sctx.globalAlpha = flick;
  // 外框光暈
  sctx.shadowColor = `rgba(${main},0.9)`; sctx.shadowBlur = S * 7;
  sctx.fillStyle = warn ? 'rgba(60,10,20,0.72)' : 'rgba(8,40,70,0.72)';
  rrect(sctx, px, py, pw, ph, S * 3); sctx.fill();
  sctx.shadowBlur = 0;
  sctx.strokeStyle = `rgba(${main},0.95)`; sctx.lineWidth = Math.max(2, S * 0.8);
  rrect(sctx, px, py, pw, ph, S * 3); sctx.stroke();
  if (k < 0.98) { sctx.restore(); return; }
  // 掃描線
  sctx.save(); rrect(sctx, px, py, pw, ph, S * 3); sctx.clip();
  sctx.fillStyle = `rgba(${main},0.07)`;
  for (let y = py + ((t * 40 * S) % (S * 3)); y < py + ph; y += S * 3) sctx.fillRect(px, y, pw, S * 0.8);
  sctx.restore();
  // 標題列
  const fsS = Math.max(12, Math.round(S * 4));
  sctx.font = `800 ${fsS}px ${FONT}`; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  sctx.fillStyle = `rgba(${main},0.9)`;
  sctx.fillText(warn ? (Math.floor(t * 4) % 2 ? '！ 警告 ！' : '') : '◇ 燼野的訊息 ◇', px + pw * 0.45, py + S * 7);
  sctx.fillRect(px + pw * 0.08, py + S * 12, pw * 0.84, Math.max(1, S * 0.4));
  // 換頁時的雜訊閃爍
  const flip = PAGES.some(p => t > p.t0 - 0.12 && t < p.t0 + 0.18);
  if (flip) { sctx.fillStyle = `rgba(${main},0.35)`; for (let i = 0; i < 6; i++) sctx.fillRect(px, py + Math.random() * ph, pw, S * (0.5 + Math.random() * 2)); }
  if (page) {
    const fs = Math.max(16, Math.round(S * 7.2));
    if (page.lines) {
      let typed = Math.floor((t - page.t0 - 0.25) / TYPE_GAP);
      sctx.font = `900 ${page.lines.length > 1 ? Math.round(fs * 0.86) : fs}px ${FONT}`;
      sctx.fillStyle = warn ? '#ffd6d6' : '#e8fbff';
      sctx.shadowColor = `rgba(${main},0.9)`; sctx.shadowBlur = S * 3;
      page.lines.forEach((line, i) => {
        const chars = [...line], n = clamp(typed, 0, chars.length);
        typed -= chars.length;
        const ly = py + ph * (page.lines.length > 1 ? 0.46 + i * 0.27 : 0.58);
        let txt = chars.slice(0, n).join('');
        if (n < chars.length && n >= 0 && Math.floor(t * 8) % 2) txt += '▌';
        sctx.fillText(txt, px + pw / 2, ly);
      });
      sctx.shadowBlur = 0;
    }
    if (page.buttons) {
      const bw = pw * 0.36, bh = S * 15, by = py + ph * 0.79 - bh / 2;          // 按鈕在下方，亞特伸手剛好碰得到
      const pressed = t > 31.3, glow = 0.6 + 0.4 * Math.sin(t * 6);
      [['接受', px + pw * 0.24, true], ['不接受', px + pw * 0.72, false]].forEach(([label, cx, yes]) => {
        const hot = yes && pressed;
        sctx.fillStyle = hot ? 'rgba(220,250,255,0.95)' : yes ? `rgba(120,225,255,${0.22 + 0.12 * glow})` : 'rgba(255,255,255,0.08)';
        sctx.strokeStyle = yes ? 'rgba(160,240,255,0.95)' : 'rgba(200,210,220,0.5)'; sctx.lineWidth = Math.max(2, S * 0.7);
        rrect(sctx, cx - bw / 2, by, bw, bh, bh / 2); sctx.fill(); sctx.stroke();
        sctx.font = `900 ${Math.round(fs * 0.8)}px ${FONT}`;
        sctx.fillStyle = hot ? '#0b3a52' : yes ? '#e8fbff' : 'rgba(220,225,230,0.7)';
        sctx.fillText(label, cx, by + bh / 2 + 1);
        if (hot) {                                   // 按下去的波紋
          const r = seg(t, 31.3, 32.0);
          sctx.strokeStyle = `rgba(200,250,255,${1 - r})`; sctx.lineWidth = S;
          rrect(sctx, cx - bw / 2 - r * S * 8, by - r * S * 8, bw + r * S * 16, bh + r * S * 16, bh / 2 + r * S * 8); sctx.stroke();
        }
      });
    }
  }
  // 頁數圓點
  const idx = PAGES.findIndex(p => t >= p.t0 && t < p.t1);
  for (let i = 0; i < PAGES.length; i++) {
    sctx.fillStyle = i === idx ? `rgba(${main},1)` : `rgba(${main},0.3)`;
    sctx.beginPath(); sctx.arc(px + pw - S * 6 - (PAGES.length - 1 - i) * S * 4, py + S * 7, S * 1.1, 0, TAU); sctx.fill();
  }
  sctx.restore();
}

function blackFade(t) {
  let k = 0;
  if (t < 1.0) k = 1 - seg(t, 0, 1.0);
  if (t > 63.1) k = Math.max(k, seg(t, 63.1, 64.3));
  return k;
}
// 珠子特寫：上面寫著「無影斬」
function drawOrbCloseup(t) {
  const a = Math.min(seg(t, 38.6, 39.0), 1 - seg(t, 41.2, 41.6));
  if (a <= 0) return;
  const cx = SW / 2, cy = OY + LH * S * 0.46, r = Math.min(LW * S, LH * S * 1.6) * 0.17 * (0.9 + 0.1 * easeOut(seg(t, 38.6, 39.1)));
  sctx.save(); sctx.globalAlpha = a;
  sctx.fillStyle = 'rgba(0,0,0,0.55)'; sctx.fillRect(OX, OY, LW * S, LH * S);
  const g1 = sctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.9);
  g1.addColorStop(0, 'rgba(255,40,60,0.55)'); g1.addColorStop(1, 'rgba(255,40,60,0)');
  sctx.fillStyle = g1; sctx.beginPath(); sctx.arc(cx, cy, r * 1.9, 0, TAU); sctx.fill();
  const g2 = sctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  g2.addColorStop(0, '#ff8a9a'); g2.addColorStop(0.35, '#c4162a'); g2.addColorStop(1, '#2a0408');
  sctx.fillStyle = g2; sctx.beginPath(); sctx.arc(cx, cy, r, 0, TAU); sctx.fill();
  sctx.strokeStyle = '#14040a'; sctx.lineWidth = Math.max(3, S); sctx.stroke();
  // 珠子裡翻騰的黑氣
  sctx.save(); sctx.beginPath(); sctx.arc(cx, cy, r * 0.96, 0, TAU); sctx.clip();
  for (let i = 0; i < 5; i++) {
    const ang = t * (0.8 + i * 0.3) + i * 1.3;
    sctx.fillStyle = 'rgba(20,4,8,0.35)';
    sctx.beginPath(); sctx.ellipse(cx + Math.cos(ang) * r * 0.4, cy + Math.sin(ang * 1.3) * r * 0.35, r * 0.5, r * 0.18, ang, 0, TAU); sctx.fill();
  }
  sctx.restore();
  sctx.font = `900 ${Math.round(r * 0.5)}px ${FONT}`; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';   // 三個字，字級略小才放得進珠子
  sctx.shadowColor = 'rgba(255,60,80,0.95)'; sctx.shadowBlur = r * 0.35;
  sctx.fillStyle = '#ffe6ea'; sctx.fillText('無影斬', cx + (Math.random() - 0.5) * 2, cy + (Math.random() - 0.5) * 2);
  sctx.restore();
}
// 習得　無影斬
function drawSkillBanner(t) {
  const a = Math.min(seg(t, 53.8, 54.2), 1 - seg(t, 56.0, 56.4));
  if (a <= 0) return;
  const fs = Math.max(18, Math.round(S * 7)), y = OY + LH * S * 0.86;
  sctx.save(); sctx.globalAlpha = a;
  sctx.font = `900 ${fs}px ${FONT}`; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  const text = '習得　無影斬', w = sctx.measureText(text).width + fs * 2.4, hgt = fs * 1.9;
  sctx.fillStyle = 'rgba(30,6,10,0.9)'; rrect(sctx, SW / 2 - w / 2, y - hgt / 2, w, hgt, hgt / 2); sctx.fill();
  sctx.strokeStyle = 'rgba(255,60,80,0.85)'; sctx.lineWidth = 2; sctx.stroke();
  sctx.shadowColor = 'rgba(255,40,60,0.9)'; sctx.shadowBlur = fs * 0.5;
  sctx.fillStyle = '#ffd6dc'; sctx.fillText(text, SW / 2, y);
  sctx.restore();
}
function render(t) {
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, SW, SH);
  renderBuffer(t);
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(buf, OX, OY, LW * S, LH * S);
  // 面板展開瞬間的閃光
  if (t > 9.3 && t < 10.0) { sctx.fillStyle = `rgba(180,240,255,${0.35 * (1 - seg(t, 9.3, 10))})`; sctx.fillRect(OX, OY, LW * S, LH * S); }
  drawPanel(t);
  // 亞特站在投影面板的前面：面板出現期間把他再畫一次在面板上層（伸手按鈕時手會蓋在按鈕上）
  const hh = heroAt(t);
  if (panelOpen(t) > 0 && hh.visible && t < 32.8) {          // 面板移到上方後就不會擋到他
    sctx.drawImage(heroImg(hh.pose, hh.phase, '', hh.face), OX + Math.round(hh.x - 16) * S, OY + Math.round(hh.y - 34) * S, 32 * S, 36 * S);
  }
  drawOrbCloseup(t);
  drawSkillBanner(t);
  if (t > 46.55 && t < 47.0) { sctx.fillStyle = `rgba(255,40,60,${0.45 * (1 - seg(t, 46.55, 47.0))})`; sctx.fillRect(OX, OY, LW * S, LH * S); }
  if (t > 60.9 && t < 62.3) {
    const k = t < 61.2 ? seg(t, 60.9, 61.2) : 1 - seg(t, 61.2, 62.3);
    sctx.fillStyle = `rgba(225,250,255,${k})`; sctx.fillRect(OX, OY, LW * S, LH * S);
  }
  const h = heroAt(t);
  for (const bb of BUBBLES) if (t >= bb.t0 && t <= bb.t1) drawBubble(cam, h, bb, t);
  const fk = blackFade(t);
  if (fk > 0) { sctx.fillStyle = `rgba(0,0,0,${fk})`; sctx.fillRect(0, 0, SW, SH); }
}

/* =========================================================
 * 聲音：整段動畫的音效與配樂在開始播放時一次排好時間，
 *       跟畫面共用同一個時鐘，所以永遠對得上。
 * ========================================================= */
let ac = null, mix, revIn, noiseBuf, bus = null, T0 = 0;
function initAudio() {
  Sfx.unlock();                                   // 與遊戲共用同一個音訊環境
  const base = Sfx.ctx;
  if (!base) return false;
  if (!ac) {
    ac = base;
    mix = ac.createGain(); mix.gain.value = 0.55;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    const lim = ac.createWaveShaper(), lc = new Float32Array(1025);
    for (let i = 0; i < 1025; i++) { const x = i * 2 / 1024 - 1; lc[i] = 0.95 * Math.tanh(1.6 * x) / Math.tanh(1.6); }
    lim.curve = lc;
    mix.connect(comp); comp.connect(lim); lim.connect(ac.destination);
    const len = Math.floor(ac.sampleRate * 2.6), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4); }
    const conv = ac.createConvolver(); conv.buffer = ir;
    revIn = ac.createGain(); const revOut = ac.createGain(); revOut.gain.value = 0.38;
    revIn.connect(conv); conv.connect(revOut); revOut.connect(mix);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }
  // 音量跟著暫停選單的「音樂音量」滑桿
  mix.gain.value = 0.55 * Math.min(1.5, Sfx.st.musicVol / 0.8);
  return true;
}
// 每次播放都用一組新的輸出（跳過／重播時整組淡出拔掉）
function newBus() {
  const g = ac.createGain(); g.connect(mix);
  const r = ac.createGain(); r.connect(revIn);
  return { g, r };
}
function killBus(bb) {
  if (!bb) return;
  const now = ac.currentTime;
  for (const n of [bb.g, bb.r]) { n.gain.cancelScheduledValues(now); n.gain.setValueAtTime(n.gain.value, now); n.gain.linearRampToValueAtTime(0, now + 0.3); }
  setTimeout(() => { try { bb.g.disconnect(); bb.r.disconnect(); } catch (err) { /* 略過 */ } }, 600);
}
function env(g, t, vol, attack, dur, hold) {
  vol = Math.max(0.0002, vol);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  if (hold) g.gain.setValueAtTime(vol, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + (hold || 0) + 0.01));
}
function out(g, o) {
  g.connect(bus.g);
  if (o.rev) { const s = ac.createGain(); s.gain.value = o.rev; g.connect(s); s.connect(bus.r); return s; }
  return null;
}
// 聲音播完就拔除，讓音訊系統的負擔隨動畫進行遞減
function autoClean(src, nodes) { src.onended = () => { for (const n of nodes) { if (n) { try { n.disconnect(); } catch (err) { /* 已拔除 */ } } } }; }
// at＝動畫時間軸上的秒數
function tone(at, o) {
  const rr = toReal(at); if (rr === null) return;           // 落在被剪掉的時間裡就不播
  const t = T0 + rr, osc = ac.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide || o.dur));
  if (o.detune) osc.detune.value = o.detune;
  let node = osc, f = null;
  if (o.lp) { f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; node.connect(f); node = f; }
  const g = ac.createGain(); env(g, t, o.vol, o.attack || 0.005, o.dur, o.hold);
  node.connect(g); const sg = out(g, o);
  osc.start(t); osc.stop(t + o.dur + (o.hold || 0) + 0.05);
  autoClean(osc, [osc, f, g, sg]);
}
function noise(at, o) {
  const rr = toReal(at); if (rr === null) return;
  const t = T0 + rr, src = ac.createBufferSource(), f = ac.createBiquadFilter();
  src.buffer = noiseBuf; f.type = o.ft || 'bandpass'; f.Q.value = o.q || 1;
  f.frequency.setValueAtTime(o.f0, t);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide || o.dur));
  const g = ac.createGain(); env(g, t, o.vol, o.attack || 0.004, o.dur, o.hold);
  src.connect(f); f.connect(g); const sg = out(g, o);
  src.start(t, Math.random() * 0.5, o.dur + (o.hold || 0) + 0.05);
  autoClean(src, [src, f, g, sg]);
}
const bell = (at, f, v, rev) => { tone(at, { f0: f, dur: 0.9, vol: 0.1 * v, rev: rev || 0.4 }); tone(at, { f0: f * 2.76, dur: 0.3, vol: 0.03 * v }); };
const brass = (at, f, dur, v, rev) => { for (const det of [-7, 7]) tone(at, { type: 'sawtooth', f0: f, detune: det, lp: 1800, attack: 0.06, hold: Math.max(0, dur - 0.2), dur: 0.25, vol: 0.075 * v, rev }); };
const boom = (at, v, rev) => { tone(at, { f0: 95, f1: 50, glide: 0.3, dur: 0.7, vol: 0.6 * v, rev }); noise(at, { ft: 'lowpass', f0: 500, dur: 0.14, vol: 0.3 * v }); };
const pad = (at, notes, dur, v, lp) => { for (const f of notes) for (const det of [-8, 8]) tone(at, { type: 'sawtooth', f0: f, detune: det, lp: lp || 1200, attack: 0.6, hold: Math.max(0, dur - 1.2), dur: 0.6, vol: 0.018 * v, rev: 0.3 }); };
const C5 = 523.25, hz = s => C5 * Math.pow(2, s / 12);

function scheduleAll(steps) {
  // ---- 環境：微風＋遠處鳥鳴（戰鬥結束後的寧靜）----
  const wind = ac.createBufferSource(); wind.buffer = noiseBuf; wind.loop = true;
  const wf = ac.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 600; wf.Q.value = 0.5;
  const wg = ac.createGain(); wg.gain.value = 0;
  wind.connect(wf); wf.connect(wg); wg.connect(bus.g);
  wg.gain.setValueAtTime(0, T0);
  for (const [at, v] of [[0.5, 0.08], [9, 0.07], [10, 0.03], [46.6, 0.03], [47.4, 0.1], [52.6, 0.1], [53.6, 0.03], [61.9, 0.06], [62.3, 0.16], [64.1, 0.12], [64.8, 0]]) { const r = toReal(at); if (r !== null) wg.gain.linearRampToValueAtTime(v, T0 + r); }
  wind.start(T0 + 0.3); wind.stop(T0 + 65);
  for (const at of [1.8, 3.1, 5.6, 7.2]) { tone(at, { f0: 2600, f1: 3400, dur: 0.08, vol: 0.03, rev: 0.3 }); tone(at + 0.12, { f0: 2900, f1: 3800, dur: 0.07, vol: 0.025 }); }
  for (const at of steps) noise(at, { ft: 'lowpass', f0: 420, dur: 0.07, vol: 0.15 });

  // ---- 輕鬆的勝利小調（原創，C 大調）----
  const beat = 60 / 76, m0 = 0.8;
  const MEL = [[4, 1], [7, 1], [12, 2], [11, 1], [9, 1], [7, 2], [9, 1], [7, 1], [4, 1], [2, 1], [4, 4]];
  let p = m0;
  for (const [s, d] of MEL) { tone(p, { type: 'triangle', f0: hz(s), dur: d * beat * 0.95, attack: 0.04, vol: 0.11, rev: 0.45 }); p += d * beat; }
  pad(m0, [261.6, 329.6, 392], beat * 4 + 0.3, 1); pad(m0 + beat * 4, [349.2, 440, 523.3], beat * 4 + 0.3, 1);
  pad(m0 + beat * 8, [392, 493.9, 587.3], beat * 4 + 0.3, 1);
  for (let i = 0; i < 3; i++) tone(m0 + i * beat * 4, { type: 'triangle', f0: [130.8, 174.6, 196][i], dur: beat * 3.8, vol: 0.18 });

  // ---- 面板浮現：數位嗡鳴 ----
  noise(9.3, { f0: 300, f1: 5000, dur: 0.5, attack: 0.3, vol: 0.3 });
  tone(9.3, { f0: 110, f1: 55, dur: 0.6, vol: 0.4 });
  [880, 1320, 1760].forEach((f, i) => tone(9.55 + i * 0.07, { type: 'square', f0: f, dur: 0.07, vol: 0.035, lp: 4000 }));
  tone(9.9, { f0: 220, dur: 0.6, hold: 60.4 - CUT_LEN - 10.5, attack: 0.8, vol: 0.025 });               // 面板持續的低鳴（面板一直到傳送前都在）
  tone(9.9, { f0: 221.7, dur: 0.6, hold: 60.4 - CUT_LEN - 10.5, attack: 0.8, vol: 0.025 });
  pad(10.2, [220, 277.2, 329.6, 415.3], 5.4, 0.8, 900);
  // 逐字打出的「嗶」聲
  for (const pg of PAGES) {
    if (!pg.lines) continue;
    const n = pg.lines.reduce((a, l) => a + [...l].length, 0);
    for (let i = 0; i < n; i++) tone(pg.t0 + 0.25 + i * TYPE_GAP, { type: 'square', f0: pg.warn ? 520 : 1250, dur: 0.025, vol: 0.022, lp: 3000 });
    // 換頁的雜訊
    noise(pg.t0 - 0.1, { ft: 'highpass', f0: 3000, dur: 0.12, vol: 0.18 }); tone(pg.t0 - 0.05, { f0: 1800, f1: 600, dur: 0.12, vol: 0.05 });
  }
  noise(25.0 - 0.1, { ft: 'highpass', f0: 3000, dur: 0.12, vol: 0.18 });
  // 「咦，這是什麼？」與第二頁：好奇的鈴聲
  bell(12.2, 1320, 0.6);
  pad(16.0, [196, 246.9, 293.7, 370], 4.3, 0.9, 900);
  // 警告頁：低沉的嗡鳴＋心跳＋警示音
  tone(20.6, { type: 'sawtooth', f0: 55, dur: 0.6, hold: 3.6, attack: 0.5, vol: 0.06, lp: 500 });
  pad(20.6, [146.8, 174.6, 207.7], 4.2, 1.1, 600);
  for (const at of [21.4, 21.75, 22.9, 23.25]) boom(at, 0.45, 0.2);
  for (const at of [20.8, 21.1, 23.6, 23.9]) tone(at, { type: 'square', f0: at % 1 > 0.5 ? 880 : 660, dur: 0.12, vol: 0.035, lp: 3000 });
  // 按鈕出現
  [1047, 1319].forEach((f, i) => bell(25.05 + i * 0.08, f, 0.8, 0.4));
  // 嚇一跳：不和諧的銅管重擊
  [233.1, 277.2, 329.6].forEach(f => brass(25.55, f, 0.5, 1.1, 0.4)); boom(25.55, 0.9, 0.3);
  tone(25.6, { type: 'square', f0: 700, f1: 1100, dur: 0.1, vol: 0.04 });
  // 無奈：緩和的和弦
  pad(27.2, [174.6, 220, 261.6], 3.4, 0.9, 900);
  // 按下「接受」
  noise(31.3, { ft: 'highpass', f0: 3500, dur: 0.03, vol: 0.3 });
  [1047, 1568, 2093].forEach((f, i) => bell(31.32 + i * 0.07, f, 1, 0.5));
  // 面板縮小上移
  noise(32.0, { f0: 2500, f1: 800, dur: 0.6, attack: 0.2, vol: 0.12 });
  // ---- 寶箱傳送過來 ----
  noise(32.6, { f0: 300, f1: 5000, dur: 1.4, attack: 1.2, vol: 0.25, rev: 0.3 });
  [784, 988, 1175].forEach((f, i) => bell(33.2 + i * 0.18, f, 0.6, 0.5));
  boom(34.0, 0.7, 0.3); noise(34.0, { f0: 900, q: 1.5, dur: 0.15, vol: 0.35 });      // 寶箱落地
  // ---- 打開寶箱 ----
  tone(35.95, { type: 'sawtooth', f0: 180, f1: 300, dur: 0.3, vol: 0.05, lp: 1200 });  // 箱蓋嘎吱
  [523, 659, 784, 1047, 1319].forEach((f, i) => bell(36.2 + i * 0.07, f, 1.1, 0.5));
  noise(36.2, { ft: 'highpass', f0: 6000, dur: 1.4, vol: 0.06, rev: 0.5 });
  // ---- 珠子浮起：不祥的低音 ----
  tone(36.6, { f0: 55, dur: 0.8, hold: 9.6, attack: 1.5, vol: 0.08 });
  pad(36.7, [146.8, 155.6, 220], 5, 1, 700);                                          // 小二度的不和諧
  boom(38.6, 0.7, 0.4); boom(39.4, 0.5, 0.3);
  noise(38.6, { f0: 900, q: 6, dur: 2.6, attack: 0.6, vol: 0.08, rev: 0.6 });        // 像低語的雜音
  noise(42.15, { f0: 500, f1: 1400, dur: 0.25, attack: 0.05, vol: 0.16 });             // 一把抓住珠子
  tone(42.3, { f0: 110, f1: 82, dur: 0.6, vol: 0.18 });
  // ---- 捏碎珠子 ----
  noise(CUT_AT - 0.95, { f0: 200, f1: 3000, dur: 0.95, attack: 0.9, vol: 0.25 });   // 握緊時的蓄力聲，緊接著捏碎
  for (let k = 0; k < 4; k++) noise(46.6 + k * 0.03, { ft: 'highpass', f0: 3000 + k * 900, dur: 0.05, vol: 0.4 });
  boom(46.6, 1.3, 0.5); tone(46.6, { f0: 80, f1: 30, dur: 1.2, vol: 0.6 });
  // ---- 黑紅色的殺氣：低沉失真的嗡鳴＋心跳 ----
  tone(46.9, { type: 'sawtooth', f0: 55, dur: 0.8, hold: 5.4, attack: 0.8, vol: 0.07, lp: 420 });
  tone(46.9, { type: 'sawtooth', f0: 58.3, dur: 0.8, hold: 5.4, attack: 0.8, vol: 0.06, lp: 420 });
  pad(47.0, [73.4, 87.3, 103.8, 146.8], 5.8, 1.4, 600);
  noise(47.0, { ft: 'lowpass', f0: 300, f1: 1400, glide: 3, dur: 5.6, attack: 2.5, vol: 0.18 });
  for (const at of [47.6, 48.3, 49.4, 50.1, 51.2, 51.9]) boom(at, 0.55, 0.2);
  noise(52.6, { f0: 3000, f1: 200, dur: 1.2, attack: 0.1, vol: 0.25, rev: 0.6 });      // 殺氣散去
  // ---- 習得無影斬 ----
  [146.8, 174.6, 220, 293.7].forEach(f => brass(53.8, f, 1.8, 1.1, 0.5)); boom(53.8, 1.0, 0.5);
  tone(54.0, { f0: 3300, dur: 0.9, vol: 0.06, rev: 0.5 }); tone(54.0, { f0: 4870, dur: 0.6, vol: 0.04 });
  noise(53.9, { ft: 'highpass', f0: 2200, f1: 6500, dur: 0.3, attack: 0.06, vol: 0.3 });  // 刀鳴
  // ---- 傳送 ----
  noise(56.4, { f0: 200, f1: 4500, glide: 4.8, dur: 4.8, attack: 4.2, vol: 0.35, q: 1.2, rev: 0.3 });
  tone(56.4, { type: 'sawtooth', f0: 55, f1: 220, glide: 4.8, dur: 4.8, attack: 2, vol: 0.06, lp: 900 });
  const scale = [0, 2, 4, 5, 7, 9, 11];
  for (let at = 56.5, i = 0, gap = 0.36; at < 61.1; at += gap, i++, gap = Math.max(0.07, gap * 0.9)) {
    const sn = scale[i % 7] + 12 * Math.floor(i / 7);
    tone(at, { f0: 261.6 * Math.pow(2, sn / 12), dur: 0.18, vol: 0.05 + i * 0.002, rev: 0.4 });
  }
  for (const at of [57.9, 59.0, 59.8, 60.35, 60.7, 60.95]) boom(at, 0.5, 0.2);
  noise(61.15, { ft: 'lowpass', f0: 7000, f1: 90, dur: 1.4, vol: 0.6, rev: 0.7 });
  noise(61.0, { f0: 300, f1: 6000, dur: 0.25, attack: 0.15, vol: 0.35 });
  boom(61.15, 1.3, 0.6);
  [523.3, 659.3, 784, 1047, 1568].forEach(f => tone(61.2, { f0: f, dur: 2.6, attack: 0.02, vol: 0.055, rev: 0.7 }));
  bell(62.5, 1760, 0.6, 0.7);
  // 對話框的「啵」
  for (const bb of BUBBLES) tone(bb.t0, { f0: 900, f1: 1200, dur: 0.06, vol: 0.05 });
}
// 依時間軸算出所有腳步聲的時間點
function computeSteps() {
  const steps = []; let last = -1;
  for (let t = 0; t < END_REAL; t += 1 / 60) {
    const h = heroAt(toStory(t));
    if (h.pose === 'walk' && h.phase % 2 === 0 && h.phase !== last) steps.push(t);
    last = h.pose === 'walk' ? h.phase : -1;
  }
  return steps;
}
/* ---- 播放控制（遊戲內版本）---- */
const skipBtn = document.getElementById('prologueSkip');
let playing = false, clockStart = 0, useAudio = false, doneCb = null, rafId = 0;
function now() { return useAudio ? ac.currentTime - T0 : (performance.now() - clockStart) / 1000; }
function finish() {
  if (!playing) return;
  playing = false;
  if (useAudio) killBus(bus);
  bus = null;
  skipBtn.classList.add('hidden'); screen.style.display = 'none';
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
  const cb = doneCb; doneCb = null;
  if (cb) cb();
}
function loop() {
  if (!playing) return;
  let t = now();
  if (useAudio && ac.state !== 'running') t = lastT;      // 聲音被系統暫停時，畫面也停住等待
  const dt = clamp(t - lastT, 0, 0.05);
  runBursts(toStory(t)); updateParticles(toStory(t), dt); lastT = t;   // 畫面依故事時間（已剪接）
  render(toStory(Math.max(0, t)));
  if (t >= END_REAL) { finish(); return; }
  rafId = requestAnimationFrame(loop);
}
skipBtn.addEventListener('click', finish);
function start(done) {
  doneCb = done;
  screen.style.display = 'block'; skipBtn.classList.remove('hidden');
  resize();
  useAudio = initAudio() && !!ac;
  parts = []; burstDone = new Set(); lastT = 0;
  if (useAudio) {
    killBus(bus); bus = newBus();
    T0 = ac.currentTime + 0.15;
    try { scheduleAll(computeSteps()); } catch (err) { /* 聲音失敗也照樣播畫面 */ }
  }
  clockStart = performance.now() + 150;
  playing = true;
  rafId = requestAnimationFrame(loop);
}
return { start, skip: finish, get playing() { return playing; } };
}
let ch1End = null;
function playChapter1End(done) {
  try { if (!ch1End) ch1End = createChapter1End(); ch1End.start(done); }
  catch (err) { if (window.console) console.warn('第一關結局動畫無法播放，直接前往第二關：', err); done(); }
}

/* =========================================================
 * 19. 連線：兩台 iPad 一起玩（階段一）
 *   房主（建立房間的 iPad）負責整個世界：怪物、掉落物、地形變化、關卡進度。
 *   隊友（加入的 iPad）自己算自己的亞特（走路沒有延遲），
 *   把「揮劍打中誰、砍了哪些草、射了箭」等動作傳給房主；房主把隊友附近的世界傳回來。
 *   ・會一直變的東西（位置、血量）每次都傳最新狀態，掉幾個訊息沒關係。
 *   ・只發生一次的事（地形變化、過關、怪物出手、隊友的動作）都有編號，
 *     會一直重送到對方回覆「收到」為止，而且照順序、只執行一次。
 *   ・兩台 iPad 的時鐘不同：用來回測量算出時間差，畫面延後一點點播放，讓動作平順。
 *   沒有按連線時（NET.role 是 null），這一段完全不會執行，單人遊戲不受影響。
 * ========================================================= */
const NET_PROTO = 6;                      // 連線協定版本：兩台不同版本時會提醒重新整理（每次更新連線功能都要加 1）
const NET_VERSION = '連線版 v6（第 20 關打倒深淵魔王後通關，播放勝利煙火）';
const NET_TEXT = {
  intro: '兩台 iPad 一起玩：一台按「建立房間」，另一台按「加入房間」並輸入房號。兩台要連同一個 Wi-Fi。',
  lib: '下載不到連線元件。請確認這台 iPad 有連上網路（可以先用 Safari 打開任何網頁試試），然後再按一次。',
  server: '連不上配對伺服器。請確認這台 iPad 有連上網路，然後再按一次。如果一直不行，可能是這個 Wi-Fi 擋住了連線，換一個 Wi-Fi 試試。',
  wifi: '連不上對方的 iPad。請確認兩台 iPad 連的是同一個 Wi-Fi（不是訪客網路），兩台都沒有開 VPN 或「低數據模式」，然後再試一次。',
  noReply: '已經連到房主的 iPad，但房主的遊戲沒有回應。請房主確認遊戲畫面還開著、沒有鎖定螢幕，然後再試一次。',
  full: '這個房間已經有兩個人了。',
  ver: '兩台 iPad 的遊戲版本不一樣。請兩台都重新整理網頁（按網址列旁邊的重新載入），再試一次。',
  browser: '這個瀏覽器不支援連線，請改用 Safari 打開遊戲網址。',
  code: '房號是 4 個數字，請再檢查一次。',
  noRoom: c => `找不到房號 ${c}。請確認房號沒有打錯，而且房主的 iPad 還開著遊戲、沒有鎖定螢幕。`,
};
function netFresh() {
  return {
    role: null, on: false, peer: null, conn: null, connOpen: false, code: '', serverOk: false, ice: '',
    inbox: [], mate: null, mateBuf: [], lastRecv: 0, sent: 0, recv: 0, rtt: 0, rttList: [],
    offset: 0, offsetOk: false, offList: [], deadline: 0, byeWhy: '',
    interp: NET_CONFIG.interpDelay, lateList: [],
    revive: 0, pickReq: new Map(), vacOff: { ox: 0, oy: 0 }, mateGotVac: false, bossDashHit: 0,
    // 房主
    log: [], evId: 0, guestAck: 0, lastAct: 0, lastStQ: 0, fx: [], noCap: false, snapT: 0, snapQ: 0, nid: 0,
    spawnFlip: false, mateView: { w: 1024, h: 768 }, retryFlag: false,
    // 隊友
    snaps: [], lastSnapQ: 0, evGot: 0, evq: [], acts: [], actId: 0, stT: 0, stQ: 0, flush: false, pingT: 0, helloT: 0, fxQ: 0,
    enemyMap: new Map(), pickMap: new Map(), hiddenArrows: new Set(), ignoreArrows: new Set(),
    pendingLevel: null, clearBonus: false, inLevel: false, bossT: null,
  };
}
const NET = Object.assign(netFresh(), { status: '', statusKind: '', uiOpen: false, uiT: 0, diagOpen: false, joinOpen: false });
const netNow = () => performance.now() / 1000;
const netGuest = () => NET.on && NET.role === 'guest';
const netHostOn = () => NET.on && NET.role === 'host';
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
function netBytes(s) { let n = s.length; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) n += 2; return n; }
function netSend(o) {
  const c = NET.conn;
  if (!c || !c.open) return;
  try { c.send(o); NET.sent++; } catch (err) { /* 送不出去就算了，之後會重送 */ }
}

/* ---------- 隊友的亞特（畫在自己畫面上）---------- */
function netMakeMate() {
  const m = makePlayer();
  m.ready = false; m.n = 0; m.mode = ''; m.fl = false; m.trail = [];
  m.invStub = { melee: [{ uid: 1, kind: 'weapon', base: 'traveler', rarity: 'common', affixes: [] }], meleeEq: 1, bows: [], bowEq: null };
  return m;
}
function netPackMe() {
  const p = player, it = findItem(inv.melee, inv.meleeEq, 'weapon') || asItem('traveler', 'weapon');
  return { x: r1(p.x), y: r1(p.y), f: r2(p.facing), sd: r2(p.swingDir), at: r3(Math.max(0, p.attackT)), ac: r3(Math.max(0, p.attackCD)),
    ai: p.aiming ? 1 : 0, aT: r2(p.aimT || 0), sh: p.shieldUp ? 1 : 0, sT: r2(p.shieldT || 0), dg: r3(Math.max(0, p.dodgeT)),
    hp: p.hp, mh: p.maxHp, dd: p.dead ? 1 : 0, sb: p.sheathed ? 1 : 0, hf: r2(Math.max(0, p.hurtFlash)), iv: r2(Math.max(0, p.invuln)),
    wb: it.base, wr: it.rarity, fl: game.flurry ? 1 : 0, n: lvl.n, md: game.mode,
    vc: inv.vacuum ? 1 : 0, uh: p.ultHidden ? 1 : 0, rg: (p.rageT || 0) > 0 ? 1 : 0, ul: game.ult ? 1 : 0, uc: game.ult && game.ult.phase === 'charge' ? r2(game.ult.t) : -1,
    rv: r2(NET.revive) };
}
// 從時間緩衝裡找出 rT 前後的兩筆資料
function netPick(buf, rT) {
  let i = buf.length - 1;
  while (i > 0 && buf[i].t > rT) i--;
  const s0 = buf[i], s1 = buf[i + 1];
  if (!s1 || s0.t > rT) return [s0, null, 0];
  return [s0, s1, clamp((rT - s0.t) / Math.max(1e-6, s1.t - s0.t), 0, 1)];
}
function netUpdateMate(rT, dt) {
  const m = NET.mate, buf = NET.mateBuf;
  if (!m || !buf.length) return;
  while (buf.length > 2 && buf[1].t < rT - 1) buf.shift();
  const [s0, s1, k] = netPick(buf, rT), a = s0.d, b = s1 ? s1.d : null;
  const el = Math.max(0, rT - s0.t);
  const ox = m.x, oy = m.y;
  m.x = b ? lerpN(a.x, b.x, k) : a.x; m.y = b ? lerpN(a.y, b.y, k) : a.y;
  if (!m.ready) { m.trail = []; }
  else {
    const moved = Math.hypot(m.x - ox, m.y - oy);
    if (moved < 200) { m.walkDist = (m.walkDist || 0) + moved; m.moveSpeed = dt > 0 ? moved / dt : 0; }
  }
  m.facing = a.f; m.swingDir = a.sd;
  m.attackT = Math.max(0, a.at - el); m.attackCD = Math.max(0, a.ac - el);
  m.aiming = !!a.ai; m.aimT = a.aT + el; m.shieldUp = !!a.sh; m.shieldT = a.sT + el;
  m.dodgeT = Math.max(0, a.dg - el); m.hp = a.hp; m.maxHp = a.mh; m.dead = !!a.dd; m.sheathed = !!a.sb;
  m.hurtFlash = a.hf - el; m.invuln = a.iv - el; m.fl = !!a.fl; m.n = a.n; m.mode = a.md;
  m.stamina = PC.maxStamina; m.staminaFlash = 0; m.ultHidden = !!a.uh; m.rageT = a.rg ? 1 : 0;
  m.vc = !!a.vc; m.ul = !!a.ul; m.uc = a.uc === undefined ? -1 : a.uc; m.rv = a.rv || 0;
  if (m.ready && m.dead && !m._wasDead && !player.dead && m.n === lvl.n) showHint(null, '隊友倒下了！走到他旁邊站 3 秒就能把他救起來', 6);
  m._wasDead = m.dead;
  const st = m.invStub.melee[0];
  if (st.base !== a.wb || st.rarity !== a.wr) m.invStub.melee[0] = { uid: 1, kind: 'weapon', base: WEAPONS[a.wb] ? a.wb : 'traveler', rarity: RARITY[a.wr] ? a.wr : 'common', affixes: [] };
  for (let i = m.trail.length - 1; i >= 0; i--) { m.trail[i].life -= dt; if (m.trail[i].life <= 0) m.trail.splice(i, 1); }
  if (m.dodgeT > 0 || m.fl) m.trail.push({ x: m.x, y: m.y, life: m.fl ? 0.12 : 0.22 });
  m.ready = true;
}
function lerpN(a, b, k) { return a + (b - a) * k; }
// 畫面緩衝會跟著網路狀況自動調整：網路慢的時候多等一點，讓怪物出手和閃避的時機還是對得上
function netLate(v) { if (isFinite(v)) { NET.lateList.push(v); if (NET.lateList.length > 40) NET.lateList.shift(); } }
function netInterpTick(dt) {
  const a = NET.lateList.slice().sort((x, y) => x - y);
  const p90 = a.length ? a[Math.floor((a.length - 1) * 0.9)] : 0;
  const target = clamp(p90 + 0.04, NET_CONFIG.interpDelay, NET_CONFIG.maxInterpDelay);
  NET.interp += clamp(target - NET.interp, -0.15 * dt, 0.4 * dt);
}
const netMateIn = () => !!(NET.on && NET.mate && NET.mate.ready && NET.mate.n === lvl.n);
const netMateAlive = () => netMateIn() && !NET.mate.dead && NET.mate.mode === 'play';
// 怪物追最近、還活著的玩家
function netTarget(e) {
  if (!netMateAlive()) return player;
  const m = NET.mate;
  if (player.dead) return m;
  return Math.hypot(m.x - e.x, m.y - e.y) < Math.hypot(player.x - e.x, player.y - e.y) ? m : player;
}
// 離「任何一位玩家」最近的距離
function netNearestDist(x, y) {
  let d = Math.hypot(x - player.x, y - player.y);
  if (netMateIn()) d = Math.min(d, Math.hypot(x - NET.mate.x, y - NET.mate.y));
  return d;
}
function netSpawnCenter() {
  NET.spawnFlip = !NET.spawnFlip;
  return NET.spawnFlip && netMateAlive() ? NET.mate : player;
}
// 新怪物不會直接出現在任何一個人的畫面裡
function netSeenByAnyone(x, y, size) {
  const pad = size + 20;
  if (Math.abs(x - player.x) < VW / 2 + pad && Math.abs(y - player.y) < VH / 2 + pad) return true;
  if (netMateIn()) { const m = NET.mate, v = NET.mateView; if (Math.abs(x - m.x) < v.w / 2 + pad && Math.abs(y - m.y) < v.h / 2 + pad) return true; }
  return false;
}
// 怪物也不要跟「另一位」玩家重疊
function netPushFromOther(e, p) {
  const o = p === player ? (netMateAlive() ? NET.mate : null) : (player.dead ? null : player);
  if (!o) return;
  const dx = e.x - o.x, dy = e.y - o.y, dd = Math.hypot(dx, dy), minD = e.rad + o.r;
  if (dd < minD && dd > 0.001) moveEntity(e, dx / dd * (minD - dd), dy / dd * (minD - dd), e.rad);
}
function netRescale() {
  if (!lvl.types) return;
  lvl.types = { melee: makeType('melee', lvl.n), brute: makeType('brute', lvl.n), archer: makeType('archer', lvl.n) };
  lvl.maxAlive = Math.min(4 + lvl.n, 10);
  if (NET.on) lvl.maxAlive = Math.round(lvl.maxAlive * 1.5);
}
function netLocalDown() {
  NET.revive = 0;
  showHint(null, '你倒下了！隊友走到你旁邊站 3 秒就能把你救起來；兩個人都倒下要重來這一關', 8);
}
// ---- 背包丟掉的武器：掉在面前的地上，隊友可以撿；丟的人 5 秒內撿不回來 ----
function netDropItem(it, kind) {
  const p = player, a = p.facing || 0;
  const x = r1(p.x + Math.cos(a) * 40), y = r1(p.y + Math.sin(a) * 40), vx = r1(Math.cos(a) * 80), vy = r1(Math.sin(a) * 80);
  const item = JSON.parse(JSON.stringify(asItem(it, kind)));
  if (netGuest()) netAct({ a: 'give', kind, item, x, y, vx, vy });
  else netSpawnGift(kind, item, x, y, vx, vy, 'host');
  showHint(null, '東西放在地上了，隊友走過去就能撿。5 秒後你也可以撿回來', 4);
}
function netSpawnGift(kind, item, x, y, vx, vy, by) {
  addPickup({ x, y, kind, item, life: 180, vx: vx || 0, vy: vy || 0, gift: true, lockBy: by, lockUntil: game.time + 5 });
  burst(x, y, 8, '#ffe27a', 40, 140, 0.4, 3);
}
// ---- 第 6 關：吸怪器箱子，一人一個 ----
function netPlaceChests(n) {
  if (n !== 6) return;
  const need = (inv.vacuum ? 0 : 1) + (NET.mate && NET.mate.ready && !NET.mate.vc ? 1 : 0);
  NET.mateGotVac = !!(NET.mate && NET.mate.vc);
  if (!need) return;
  lvl.chestPos = [];
  for (let k = 0; k < need; k++) netAddChest(need === 1 ? 0 : (k === 0 ? -55 : 55));
  lvl.holdSpawn = true;
  showHint(null, need > 1 ? '右邊有兩個神秘的箱子，一人開一個' : '右邊有一個神秘的箱子，走過去打開它', 7);
}
function netAddChest(dy) {
  const used = (lvl.chestPos || []).length;
  if (dy === undefined) dy = used ? 110 : 0;
  const x = SPAWN.x + 190, y = SPAWN.y + dy;
  ensureChunks(x, y, 200);
  for (const ch of chunks.values()) ch.solids = ch.solids.filter(s => !circleRectOverlap(x, y, 60, s));
  pickups.push({ x, y, kind: 'skillchest', life: 1e9, t: 0, vx: 0, vy: 0 });
  (lvl.chestPos = lvl.chestPos || []).push([x, y]);
  lvl.chestPlaced = true; lvl.holdSpawn = true;
}
// 還有人沒拿到吸怪器（而且還有沒開的箱子）→ 繼續暫停出怪
function netChestsLeft() {
  const closed = pickups.some(h => h.kind === 'skillchest' && !h.opened);
  const someoneNeeds = !inv.vacuum || (netMateIn() && !NET.mateGotVac && !(NET.mate && NET.mate.vc));
  return closed && someoneNeeds;
}
function netChestTaken(h) {
  if (h._msgT > game.time) return;
  h._msgT = game.time + 2;
  addText(h.x, h.y - 44, '這個留給隊友', '#c8fff0', 16);
}
// ---- 大魔王打隊友（隊友那台判斷有沒有閃過、擋住）----
function netGuestBossSlam(ev, e) {
  const p = player;
  if (game.mode !== 'play' || p.dead || game.flurry || game.ult) return;
  const since = game.time - p.dodgeStartT;
  if (e && since >= 0 && since <= PC.perfectDodgeWindow && Math.hypot(p.dodgeSX - ev.x, p.dodgeSY - ev.y) <= ev.r + 30) { startFlurry(e); return; }
  const d = Math.hypot(p.x - ev.x, p.y - ev.y);
  if (d > ev.r + p.r) return;
  if (p.dodgeT > 0) { addText(p.x, p.y - 34, '閃過！', '#9fd8ff', 16); return; }
  if (damagePlayer(ev.d, ev.x, ev.y, 'enemy')) { p.kx += (p.x - ev.x) / (d || 1) * 300; p.ky += (p.y - ev.y) / (d || 1) * 300; }
}
function netGuestBossDash() {
  const p = player;
  if (p.dead || game.mode !== 'play') return;
  for (const e of enemies) {
    if (!e.boss || e.state !== 'dash' || !e.dashN || e.dashN === NET.bossDashHit) continue;
    if (Math.hypot(p.x - e.x, p.y - e.y) >= e.rad + p.r + 4) continue;
    NET.bossDashHit = e.dashN;
    if (p.dodgeT > 0 || game.flurry || game.ult) continue;
    const ang = Math.atan2(e.y - p.y, e.x - p.x);
    if (p.shieldUp && Math.abs(angleDiff(p.facing, ang)) <= PC.shieldHalfArc) {
      if (p.shieldT <= PC.perfectWindow + 0.08) {
        perfectParry(e);
        netAct({ a: 'bparry', id: e.nid });
        continue;
      }
      if (p.stamina >= 30) {
        p.stamina -= 30; p.regenWait = PC.regenDelay;
        p.kx -= Math.cos(ang) * 380; p.ky -= Math.sin(ang) * 380;
        addText(p.x, p.y - 34, '格擋', '#bdf3ff', 16); Sfx.play('block', { player: true });
        netAct({ a: 'bblock', id: e.nid });
        continue;
      }
      p.stamina = 0; p.staminaFlash = 0.8; addText(p.x, p.y - 50, '破防！', '#ffd166', 18);
    }
    if (damagePlayer(e.t.damage, e.x, e.y, 'enemy')) { p.kx -= Math.cos(ang) * 260; p.ky -= Math.sin(ang) * 260; }
  }
}
// 救援：倒下的人那台判斷隊友有沒有站在旁邊（自己的生命由自己這台決定）
function netReviveTick(dt) {
  const p = player;
  if (!p.dead || game.mode !== 'play') { NET.revive = 0; return; }
  const m = NET.mate, near = netMateAlive() && Math.hypot(m.x - p.x, m.y - p.y) < 70;
  NET.revive = clamp(NET.revive + (near ? dt / 3 : -dt / 1.5), 0, 1);
  if (NET.revive < 1) return;
  NET.revive = 0;
  p.dead = false; p.hp = Math.max(2, Math.floor(p.maxHp / 2)); p.invuln = 2; p.hurtFlash = 0;
  p.attackT = 0; p.dodgeT = 0; p.shieldUp = false; p.aiming = false; p.stamina = PC.maxStamina; p.kx = p.ky = 0;
  burst(p.x, p.y, 30, '#9fe0ff', 60, 220, 0.8, 4); ring(p.x, p.y, '#ffffff', 20);
  Sfx.play('pickupLegend', { player: true });
  addText(p.x, p.y - 40, '復活！', '#9fe0ff', 24);
  showHint(null, '隊友把你救起來了！', 4);
}
// 連線時用技能：把目標怪物定住（世界不會變慢）
function netFreeze(list, t) {
  for (const e of list || []) {
    if (!e || e.boss) continue;
    if (netGuest()) netAct({ a: t > 0 ? 'freeze' : 'unfreeze', id: e.nid, t });
    else if (t > 0) e.frozenT = t; else e.frozenT = 0;
  }
}
function netPackPick(h) {
  const o = { kind: h.kind };
  if (h.kind === 'food') { o.heal = h.heal; o.name = h.name; }
  else if (h.kind === 'arrows') o.count = h.count;
  else if (h.kind === 'weapon' || h.kind === 'bow') o.item = h.item || asItem(h.id, h.kind);
  return o;
}
// 隊友：把東西收進自己的背包（背包滿了就請房主放回地上）
function netGiveLoot(it, from) {
  if (!it || !it.kind) return;
  const p = player;
  const h = { x: p.x, y: p.y, kind: it.kind, heal: it.heal, name: it.name, count: it.count };
  if (it.item) { h.item = JSON.parse(JSON.stringify(it.item)); inv.nextUid = (inv.nextUid || 1) + 1; h.item.uid = inv.nextUid; }
  if (from) { burst(from.x, from.y, 8, '#ffffff', 40, 160, 0.35, 3); Sfx.play('vacSpit', { player: true }); }
  const ok = h.kind === 'food' && p.hp >= p.maxHp ? false : collectPickup(h);     // 生命已經滿了的食物也放回地上
  if (ok === false) netAct({ a: 'drop', x: r1(p.x + rand(-30, 30)), y: r1(p.y + rand(-30, 30)), it: { kind: it.kind, heal: it.heal, name: it.name, count: it.count, item: h.item } });
}
function netGuestPickups() {
  const p = player;
  if (p.dead || game.mode !== 'play' || !NET.inLevel) return;
  const now = netNow();
  const ask = h => {
    const t = NET.pickReq.get(h.nid);
    if (t !== undefined && now - t < 1.5) return;
    NET.pickReq.set(h.nid, now);
    netAct({ a: 'pick', id: h.nid });
  };
  for (const h of pickups) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (h.kind === 'skillchest') {
      if (h.opened || d >= p.r + 28) continue;
      if (inv.vacuum) netChestTaken(h); else ask(h);
      continue;
    }
    if (h.kind === 'goldchest') { if (!h.opened && d < p.r + 26) ask(h); continue; }
    if (d >= p.r + 12 || h.lock) continue;
    if (h.kind === 'food' && p.hp >= p.maxHp) continue;
    if (h.kind === 'weapon' || h.kind === 'bow') {
      const list = h.kind === 'weapon' ? inv.melee : inv.bows;
      if (list.length >= BAG_MAX[h.kind]) {
        if (!(h._fullT > now)) { addText(p.x, p.y - 34, '背包滿了！到背包丟掉一些吧', '#ffd166', 15); h._fullT = now + 2.5; }
        continue;
      }
    }
    ask(h);
  }
  if (NET.pickReq.size > 200) for (const [k, t] of NET.pickReq) if (now - t > 5) NET.pickReq.delete(k);
}
// 隊友的吸怪器：請房主把畫面內的怪物吸到自己嘴裡
function netGuestVacStart(v) {
  const mw = vacMouthWorld(false);
  const ids = v.targets.filter(e => !e.dead && !e.dying && !e.boss).map(e => e.nid);
  netAct({ a: 'vac', ids, ox: r1(mw.x - player.x), oy: r1(mw.y - player.y) });
}
function netGuestVacArrows() {
  for (const a of arrows) {
    if (a.owner !== 'enemy' || a.x < cam.x || a.x > cam.x + VW || a.y < cam.y || a.y > cam.y + VH || NET.hiddenArrows.has(a.nid)) continue;
    NET.hiddenArrows.add(a.nid); netAct({ a: 'gone', id: a.nid });
  }
}
// 房主：隊友的吸怪器吞掉怪物 → 算擊倒，掉落物送給隊友（金色寶箱放在隊友旁邊）
function netEatForGuest(e) {
  pickupCapture = [];
  killEnemy(e);
  const loot = pickupCapture; pickupCapture = null;
  const items = [];
  for (const h of loot) {
    if (h.kind === 'goldchest' || h.kind === 'skillchest') { h.x = NET.mate.x + rand(-40, 40); h.y = NET.mate.y + rand(-40, 40); pickups.push(h); }
    else items.push(netPackPick(h));
  }
  netWorld({ k: 'vl', items });
}

/* ---------- 房主：把畫面效果（聲音、粒子、數字）轉播給隊友 ---------- */
function netCapOK(x, y) {
  if (!netHostOn() || NET.noCap || !netMateIn()) return false;
  const m = NET.mate, v = NET.mateView;
  return Math.abs(x - m.x) < v.w / 2 + 160 && Math.abs(y - m.y) < v.h / 2 + 160;
}
function netCap(item) { if (NET.fx.length < 120) NET.fx.push(item); }
function netPlayFx(list) {
  for (const f of list || []) {
    try {
      if (f[0] === 's') Sfx.play(f[1], { x: f[2], y: f[3], big: !!f[4], pitch: f[5] || undefined, heavy: !!f[6] });
      else if (f[0] === 'b') burst(f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9] || undefined);
      else if (f[0] === 'r') ring(f[1], f[2], f[3], f[4]);
      else if (f[0] === 't') addText(f[1], f[2], f[3], f[4], f[5]);
      else if (f[0] === 'sp') emitSparks({ x: f[1], y: f[2], w: f[3], h: f[4] });
    } catch (err) { /* 單一效果失敗不影響遊戲 */ }
  }
}

/* ---------- 房主：世界變化紀錄（會一直重送到隊友收到）---------- */
function netWorld(ev) {
  if (!netHostOn()) return;
  ev.i = ++NET.evId; ev.t = r3(netNow());
  NET.log.push(ev);
}
function netHostLevelEvent(join) {
  // 剛加入的隊友從第 1 號開始收；換關時不能清掉還沒被確認的紀錄（不然隊友會一直等那一號）
  if (join) { NET.log = []; NET.evId = 0; }
  netWorld({ k: 'lv', n: lvl.n, seed: worldSeed, kills: lvl.kills, tg: lvl.target, chs: lvl.chestPos || null,
    j: join ? 1 : 0, sx: r1(player.x), sy: r1(player.y), rt: NET.retryFlag ? 1 : 0, nr: NET.newRunFlag ? 1 : 0,
    // 加入的人：愛心數量、技能、技能冷卻時間跟房主一樣（物資不複製）
    mh: player.maxHp, ul: inv.ultimate ? 1 : 0, vc: inv.vacuum ? 1 : 0, um: inv.ultMax || ULT.cooldown, vm: inv.vacMax || VAC.cooldown });
  NET.retryFlag = false; NET.newRunFlag = false;
  if (join) for (const ev of netWorldDiff()) netWorld(ev);
}
// 隊友中途加入：找出目前世界跟「剛生成時」不一樣的地方（被砍的草、燒過的地、打破的木箱）
function netWorldDiff() {
  const realC = chunks, realG = grass, out = [];
  try {
    for (const ch of realC.values()) {
      chunks = new Map(); grass = new Map();
      genChunk(ch.cx, ch.cy);
      const pc = chunks.get(ck(ch.cx, ch.cy));
      for (const s of pc.solids) {
        if (s.kind === 'crate' && !ch.solids.some(o => o.kind === 'crate' && o.x === s.x && o.y === s.y)) out.push({ k: 'cr', x: s.x + s.w / 2, y: s.y + s.h / 2 });
      }
      for (const [key, c] of grass) {
        const r = realG.get(key);
        if (!r) out.push({ k: 'c', x: c.gx, y: c.gy, s: 0 });
        else if (r.state === 'burning') out.push({ k: 'c', x: c.gx, y: c.gy, s: 1 });
        else if (r.state === 'ash') out.push({ k: 'c', x: c.gx, y: c.gy, s: 2 });
      }
    }
  } finally { chunks = realC; grass = realG; }
  return out;
}
function netStrikeMate(e) {
  if (!e.nid) e.nid = ++NET.nid;
  netWorld({ k: 'st', id: e.nid, x: r1(e.x), y: r1(e.y), wx: e.wx !== undefined ? r1(e.wx) : undefined, wy: e.wy !== undefined ? r1(e.wy) : undefined, r: e.t.reach, d: e.t.damage });
}

/* ---------- 房主：每秒送 15 次「隊友附近的世界」---------- */
function netHostSnap() {
  const m = NET.mate, now = netNow();
  const cx = netMateIn() ? m.x : player.x, cy = netMateIn() ? m.y : player.y;
  const en = [], ar = [], pk = [];
  for (const e of enemies) {
    if (e.dead) continue;
    if (!e.boss && Math.hypot(e.x - cx, e.y - cy) > 1700) continue;
    if (!e.nid) e.nid = ++NET.nid;
    let fl = 0;
    if (e.hurtFlash > 0) fl |= 1; if (e.slowT > 0) fl |= 2; if (e.alertT > 0) fl |= 4; if (e.burnT > 0) fl |= 8; if (e.dying) fl |= 32; if (e.sucked) fl |= 64;
    const row = [e.nid, e.boss ? 'boss' : e.t.role, e.elite ? 1 : 0, r1(e.x), r1(e.y), r2(e.face || 0), e.state, r3(e.stateT || 0), r2(e.hp), e.t.hp, fl];
    if (e.boss) row.push([e.phase || 1, r2(e.invulnT || 0), e.windMax || 1, e.slamR || 125, e.dashN || 0]);
    en.push(row);
  }
  for (const a of arrows) {
    if (Math.abs(a.x - cx) > 1200 || Math.abs(a.y - cy) > 1000) continue;
    if (!a.nid) a.nid = ++NET.nid;
    ar.push([a.nid, r1(a.x), r1(a.y), r1(a.vx), r1(a.vy), a.owner === 'enemy' ? 0 : 1, (a.fire ? 1 : 0) | (a.orb ? 2 : 0), a.dmg]);
  }
  for (const h of pickups) {
    const far = Math.abs(h.x - cx) > 1300 || Math.abs(h.y - cy) > 1100;
    if (far && !(h.kind === 'goldchest' && !h.opened)) continue;
    if (!h.nid) h.nid = ++NET.nid;
    let ex = 0;
    if (h.kind === 'food') ex = [h.heal, h.name];
    else if (h.kind === 'arrows') ex = h.count;
    else if (h.kind === 'weapon' || h.kind === 'bow') { const it = h.item || asItem(h.id, h.kind); ex = [it.base, it.rarity, it.affixes || []]; }
    else ex = h.opened ? 1 : 0;
    pk.push([h.nid, h.kind, r1(h.x), r1(h.y), r2(Math.min(h.life, 999)), ex, h.lockBy === 'guest' && game.time < h.lockUntil ? 1 : 0]);
  }
  const msg = { k: 's', q: ++NET.snapQ, t: r3(now), ak: NET.lastAct, lv: [lvl.n, lvl.kills, lvl.target], me: netPackMe(), en, ar, pk, fx: [], ev: [] };
  let bytes = netBytes(JSON.stringify(msg));
  for (const f of NET.fx) { const b = netBytes(JSON.stringify(f)) + 1; if (bytes + b > 9000) break; bytes += b; msg.fx.push(f); }
  NET.fx = [];
  for (const ev of NET.log) { const b = netBytes(JSON.stringify(ev)) + 1; if (bytes + b > 14000) break; bytes += b; msg.ev.push(ev); }
  netSend(msg);
}

/* ---------- 房主：處理隊友傳來的動作（照編號順序，只做一次）---------- */
function netFindEnemy(id) { for (const e of enemies) if (e.nid === id && !e.dead) return e; return null; }
function netHostAction(ac) {
  const m = NET.mate;
  switch (ac.a) {
    case 'hit': {
      const e = netFindEnemy(ac.id);
      if (!e || e.dying) return;
      NET.noCap = true;
      try { damageEnemy(e, ac.d, ac.s, ac.an); } finally { NET.noCap = false; }
      if (!e.dead && !e.dying && ac.fx) {
        if (ac.fx.indexOf('fire') >= 0) { e.burnT = 2.6; e.burnDmg = Math.max(1, Math.round((ac.at || 1) * 0.25)); }
        if (ac.fx.indexOf('frost') >= 0) e.slowT = 2.2;
      }
      return;
    }
    case 'stone': {
      const s = solidsInBox(ac.x - 2, ac.y - 2, ac.x + 2, ac.y + 2, []).find(o => o.kind === 'stone');
      if (s) { NET.noCap = true; try { hitStone(s, ac.x, ac.y); } finally { NET.noCap = false; } }
      return;
    }
    case 'crate': {
      const s = solidsInBox(ac.x - 2, ac.y - 2, ac.x + 2, ac.y + 2, []).find(o => o.kind === 'crate' && !o.broken);
      if (s) { NET.noCap = true; try { breakCrate(s); } finally { NET.noCap = false; } }
      return;
    }
    case 'cut': {
      const c = grass.get(gk(ac.x, ac.y));
      if (c && c.state === 'grass') { NET.noCap = true; try { cutGrass(c, ac.x * CELL + CELL / 2, ac.y * CELL + CELL / 2); } finally { NET.noCap = false; } }
      return;
    }
    case 'shoot': {
      spawnArrow(ac.x, ac.y, ac.ang, ac.sp, ac.dmg, 'player', null);
      const a = arrows[arrows.length - 1], fx = new Set(ac.fx || []);
      a.fire = fx.has('fire'); a.pierce = fx.has('pierce'); a.fx = fx; a.guest = true;
      NET.noCap = true; try { Sfx.play('bowShot', { x: ac.x, y: ac.y }); } finally { NET.noCap = false; }
      return;
    }
    case 'parry': {
      const e = netFindEnemy(ac.id);
      if (!e || e.boss) return;
      e.state = 'stunned'; e.stateT = 2.2; e.lungeT = 0;
      if (m) { const a = Math.atan2(e.y - m.y, e.x - m.x); e.kx = Math.cos(a) * 300; e.ky = Math.sin(a) * 300; }
      return;
    }
    case 'freeze': {
      const e = netFindEnemy(ac.id);
      if (!e || e.boss) return;
      e.frozenT = ac.t; e.state = 'recover'; e.stateT = Math.max(e.stateT, 1.0); e.lungeT = 0;
      return;
    }
    case 'unfreeze': { const e = netFindEnemy(ac.id); if (e) e.frozenT = 0; return; }
    case 'reflect': {
      const a = arrows.find(o => o.nid === ac.id);
      if (!a || a.owner !== 'enemy') return;
      a.owner = 'player'; a.reflected = true; a.guest = true; a.x = ac.x; a.y = ac.y; a.vx = ac.vx; a.vy = ac.vy; a.dmg = ac.dmg; a.life = 1.6;
      return;
    }
    case 'gone': { const i = arrows.findIndex(o => o.nid === ac.id && o.owner === 'enemy'); if (i >= 0) arrows.splice(i, 1); return; }
    case 'pick': {                                      // 隊友撿東西：誰先撿到就是誰的
      const i = pickups.findIndex(h => h.nid === ac.id);
      if (i < 0) return;
      const h = pickups[i];
      if (h.air > 0 || (h.lockBy === 'guest' && game.time < h.lockUntil)) return;
      if (h.kind === 'skillchest') {                   // 隊友開吸怪器箱子（每人只能開一個，隊友那邊已經檢查過）
        if (h.opened || NET.mateGotVac) return;
        NET.mateGotVac = true;
        h.opened = true; h.life = 5; h.t = 0;
        burst(h.x, h.y - 10, 50, '#7fe8c4', 80, 320, 1.0, 4); ring(h.x, h.y, '#c8fff0', 24);
        lvl.holdSpawn = netChestsLeft();
        if (!lvl.holdSpawn) lvl.spawnT = 2.5;
        netWorld({ k: 'vac1' });
        showHint(null, '隊友拿到吸怪器了！', 4);
        return;
      }
      if (h.kind === 'goldchest') { if (!h.opened) openGoldChest(h); return; }
      pickups.splice(i, 1);
      netWorld({ k: 'got', it: netPackPick(h) });
      return;
    }
    case 'drop': {                                      // 隊友背包滿了：放回地上
      const it = ac.it || {};
      addPickup({ x: ac.x, y: ac.y, kind: it.kind, heal: it.heal, name: it.name, count: it.count, item: it.item, life: 60, vx: 0, vy: 0 });
      return;
    }
    case 'vac': {                                       // 隊友的吸怪器
      NET.vacOff = { ox: ac.ox || 0, oy: ac.oy || 0 };
      for (const id of ac.ids || []) {
        const e = netFindEnemy(id);
        if (!e || e.boss || e.dying || e.sucked) continue;
        e.frozenT = 0; e.sucked = { t: 0, sc: 1, spin: 0, gst: true };
      }
      return;
    }
    case 'give': {                                      // 隊友從背包丟出來的武器
      if (!ac.item || (ac.kind !== 'weapon' && ac.kind !== 'bow')) return;
      netSpawnGift(ac.kind, ac.item, ac.x, ac.y, ac.vx, ac.vy, 'guest');
      return;
    }
    case 'newrun': if (game.mode === 'victory') restartFromVictory(); return;
    case 'bparry': {                                    // 隊友完美格擋魔王的突進
      const e = netFindEnemy(ac.id);
      if (!e || !e.boss || e.dying) return;
      e.state = 'stunned'; e.stateT = 2.6; e.lungeT = 0; e.kx *= 0.3; e.ky *= 0.3;
      return;
    }
    case 'bblock': { const e = netFindEnemy(ac.id); if (e && e.boss && e.state === 'dash') { e.state = 'recover'; e.stateT = 0.7; } return; }
    case 'next': {
      if (ac.n !== lvl.n || !lvl.cleared || game.cutscene || (lvl.n === 1)) return;
      if (game.mode !== 'between' && game.mode !== 'levelclear') return;
      player.maxHp = Math.min(PC.maxHpCap, player.maxHp + 2);
      startLevel(lvl.n + 1);
      startPlay();
      return;
    }
    case 'retry': {
      if (ac.n !== lvl.n || (game.mode !== 'over' && game.mode !== 'ending')) return;
      retryLevel(); startPlay();
      return;
    }
  }
}
function netHostMsg(msg) {
  if (msg.k === 'hi') { netHostHello(msg); return; }
  if (msg.k === 'bye') { netLost('隊友離開了連線，你可以繼續一個人玩。'); return; }
  if (msg.k !== 'g' || !NET.on) return;
  if (msg.q > NET.lastStQ) {
    NET.lastStQ = msg.q;
    if (msg.p) NET.mateBuf.push({ t: msg.t, d: msg.p });
    netLate(netNow() - msg.t);
    if (msg.vw > 0 && msg.vh > 0) NET.mateView = { w: msg.vw, h: msg.vh };
    if (typeof msg.rt === 'number') NET.rtt = msg.rt;
  }
  if (msg.ak > NET.guestAck) { NET.guestAck = msg.ak; NET.log = NET.log.filter(ev => ev.i > NET.guestAck); }
  for (const ac of msg.a || []) {
    if (ac.i <= NET.lastAct) continue;
    if (ac.i !== NET.lastAct + 1) break;               // 中間少了一個：等隊友重送
    NET.lastAct = ac.i;
    try { netHostAction(ac); } catch (err) { if (window.console) console.warn('net action', err); }
  }
}
function netHostHello(msg) {
  if (msg.v !== NET_PROTO) { netSend({ k: 'bye', why: 'ver' }); return; }
  if (!NET.on) {
    NET.on = true;
    NET.mate = netMakeMate(); NET.mateBuf = []; NET.lastAct = 0; NET.lastStQ = 0; NET.guestAck = 0; NET.fx = [];
    if (msg.vw > 0) NET.mateView = { w: msg.vw, h: msg.vh };
    netRescale();
    if (lvl.n === 6 && !msg.vc && !inv.vacuum && lvl.chestPlaced && game.mode === 'play') netAddChest();   // 第 6 關中途加入：補一個箱子給隊友
    netHostLevelEvent(true);
    netStatus('隊友加入了！現在是兩人一起玩。按「回到暫停選單」再按「繼續」回到遊戲。', 'ok');
    showHint(null, '隊友加入了！', 4);
  }
  netSend({ k: 'ok', v: NET_PROTO });
}
function netHostTick(rdt, now) {
  if (!NET.on) {                                      // 還在等配對伺服器：太久沒回應就告訴使用者
    if (NET.deadline && !NET.serverOk && now > NET.deadline) netFail(NET_TEXT.server);
    return;
  }
  if (now - NET.lastRecv > NET_CONFIG.lostTimeout) { netLost('隊友斷線了，你可以繼續一個人玩。'); return; }
  netInterpTick(rdt);
  netUpdateMate(now - NET.interp, rdt);
  if (game.mode === 'play' && player.dead && !netMateAlive()) { endGame('lose'); netWorld({ k: 'lose' }); }
  NET.snapT -= rdt;
  if (NET.snapT <= 0) { NET.snapT = Math.max(0, NET.snapT + 1 / NET_CONFIG.sendHz); netHostSnap(); }
}

/* ---------- 隊友：送出自己的狀態與動作 ---------- */
function netAct(a) {
  if (!netGuest()) return;
  a.i = ++NET.actId; NET.acts.push(a); NET.flush = true;
}
function netGuestSend() {
  const msg = { k: 'g', q: ++NET.stQ, t: r3(netNow() + NET.offset), ak: NET.evGot, p: NET.inLevel ? netPackMe() : null, a: [], vw: VW, vh: VH, rt: Math.round(NET.rtt) };
  let bytes = netBytes(JSON.stringify(msg));
  for (const a of NET.acts) { const b = netBytes(JSON.stringify(a)) + 1; if (bytes + b > 14000) break; bytes += b; msg.a.push(a); }
  netSend(msg);
}
// 隊友打中怪物：自己先看到效果，再請房主扣血
function netHit(e, amount, src, ang) {
  if (e.dead || e.dying) return;
  e.hurtFlash = 0.14;
  Sfx.play('hit', { x: e.x, y: e.y, big: src === 'flurry' || amount >= 8 });
  addText(e.x, e.y - e.rad - 12, '-' + amount, src === 'flurry' ? '#9fe3ff' : '#ffffff', src === 'flurry' ? 24 : 18);
  const W = curW();
  const fx = src === 'sword' || src === 'flurry' ? [...W.fx].filter(f => f === 'fire' || f === 'frost') : [];
  netAct({ a: 'hit', id: e.nid, d: amount, s: src, an: r3(ang), fx, at: W.atk });
}
// 隊友這邊檢查房主的怪物射來的箭（自己的閃避、舉盾、反彈都在自己這台算）
function netGuestArrowHits() {
  const p = player;
  if (p.dead || game.mode !== 'play') return;
  for (const a of arrows) {
    if (a.owner !== 'enemy' || NET.ignoreArrows.has(a.nid) || NET.hiddenArrows.has(a.nid)) continue;
    if (Math.hypot(p.x - a.x, p.y - a.y) >= p.r + (a.orb ? 7 : 3)) continue;
    const id = a.nid, r = arrowHitPlayer(a);
    if (r === 'pass') continue;
    if (r === 'reflect') { NET.ignoreArrows.add(id); netAct({ a: 'reflect', id, x: r1(a.x), y: r1(a.y), vx: r1(a.vx), vy: r1(a.vy), dmg: a.dmg }); }
    else { NET.hiddenArrows.add(id); netAct({ a: 'gone', id }); }
  }
}
function netGuestFire(dt) {
  for (const c of burningCells) {
    if (Math.random() < dt * 9) addParticle({ x: c.gx * CELL + rand(4, CELL - 4), y: c.gy * CELL + rand(4, CELL - 4), vx: rand(-10, 10), vy: rand(-50, -20),
      life: 0.7, max: 0.7, size: rand(2, 4), color: Math.random() < 0.5 ? '#ffd166' : '#ff7a2f', type: 'ember', rot: 0, vr: 0 });
  }
  for (const c of ashCells) c.t = Math.max(0, c.t - dt);
}

/* ---------- 隊友：收到房主的資料 ---------- */
function netGuestMsg(msg) {
  if (msg.k === 'po') {
    const now = netNow(), rtt = Math.max(0, now - msg.c);
    NET.offList.push({ rtt, off: msg.h + rtt / 2 - now });
    if (NET.offList.length > 12) NET.offList.shift();
    const best = NET.offList.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    NET.offset = best.off; NET.offsetOk = true;
    NET.rttList.push(rtt * 1000); if (NET.rttList.length > 6) NET.rttList.shift();
    NET.rtt = NET.rttList.reduce((a, b) => a + b, 0) / NET.rttList.length;
    return;
  }
  if (msg.k === 'bye') {
    NET.byeWhy = msg.why || '';
    const txt = msg.why === 'ver' ? NET_TEXT.ver : msg.why === 'full' ? NET_TEXT.full : '房主離開了連線。';
    if (NET.on) netLost(txt); else netFail(txt);
    return;
  }
  if (msg.k === 'ok') {
    if (NET.on) return;
    NET.on = true; NET.mate = netMakeMate(); NET.mateBuf = []; NET.inLevel = false;
    enemies = []; arrows = []; pickups = []; sparks = []; game.flurry = null; game.ult = null; game.vac = null;
    netStatus('連上了！正在進入房主的世界…', 'ok');
    return;
  }
  if (msg.k !== 's' || !NET.on) return;
  if (msg.q <= NET.lastSnapQ) return;
  NET.lastSnapQ = msg.q;
  if (!NET.offsetOk && !NET.offList.length) NET.offset = msg.t - netNow() + 0.02;     // 還沒測到時間差時先粗估
  NET.acts = NET.acts.filter(a => a.i > msg.ak);
  const nowH = netNow() + NET.offset;
  if (NET.offsetOk) netLate(nowH - msg.t);
  for (const ev of msg.ev || []) {
    if (ev.i <= NET.evGot) continue;
    if (ev.i !== NET.evGot + 1) break;
    NET.evq.push(ev); NET.evGot = ev.i;
    if (NET.offsetOk && ev.k === 'st') netLate(nowH - ev.t);
  }
  NET.snaps.push(msg);
  if (NET.snaps.length > 60) NET.snaps.shift();
  NET.mateBuf.push({ t: msg.t, d: msg.me });
  if (NET.mateBuf.length > 60) NET.mateBuf.shift();
}
function netGuestEvent(ev, rT) {
  switch (ev.k) {
    case 'lv': netApplyLevel(ev); return;
    case 'c': netCell(ev.x, ev.y, ev.s); return;
    case 'cr': netCrate(ev.x, ev.y); return;
    case 'st': {
      if (rT - ev.t > 0.35 || !NET.inLevel) return;           // 太舊的出手（例如剛加入時）不算
      resolveStrike(NET.enemyMap.get(ev.id) || null, ev.x, ev.y, ev.wx, ev.wy, ev.r, ev.d);
      return;
    }
    case 'cl': if (game.mode === 'play' && NET.inLevel && lvl.n === ev.n) { NET.clearBonus = true; levelClear(); } return;
    case 'lose': if (game.mode === 'play' && NET.inLevel) endGame('lose'); return;
    case 'got': netGiveLoot(ev.it, null); return;
    case 'vac1': {                                      // 隊友打開了自己的吸怪器箱子
      inv.vacuum = true; game.vacCD = 0;
      game.flash = Math.max(game.flash, 0.35);
      Sfx.play('chestOpen', { player: true }); Sfx.play('pickupLegend', { player: true });
      game.banner = { title: '習得　吸怪器', sub: '按下後，右邊冒出的臉會把畫面內的怪物全部吸進去，再把掉落物吐給你', t: 4 };
      showHint(null, '吸怪器的按鈕在「舉盾」上方（鍵盤 V）。畫面內有怪物時才能用，冷卻 3 分鐘', 9);
      return;
    }
    case 'brw': {                                       // 魔王被打倒：隊友也拿到一樣的獎勵
      const fake = { t: makeBossType(lvl.n) };
      const lines = grantBossReward(fake);
      game.runBosses = (game.runBosses || 0) + 1;
      lvl.bossReward = lines;
      game.flash = Math.max(game.flash, 0.5);
      Sfx.play('pickupLegend', { player: true });
      game.banner = { title: `擊敗 ${fake.t.name}！`, sub: lines.join('　'), t: 4.2 };
      return;
    }
    case 'bs': if (rT - ev.t <= 0.35 && NET.inLevel) netGuestBossSlam(ev, NET.enemyMap.get(ev.id) || null); return;
    case 'vl': {
      const v = game.vac;
      Sfx.play('vacGulp', { player: true });
      for (const it of ev.items || []) { if (v) { v.loot.push(it); v.eaten++; } else netGiveLoot(it, null); }
      return;
    }
    case 'vp': if (player.hp < player.maxHp && !player.dead) { player.hp += 1; addText(player.x, player.y - 42, '+1', '#ff7a8a', 15); } return;
  }
}
function netCell(gx, gy, s) {
  ensureChunks(gx * CELL + CELL / 2, gy * CELL + CELL / 2, 0);
  const k = gk(gx, gy);
  let c = grass.get(k);
  if (c) {
    let i = burningCells.indexOf(c); if (i >= 0) burningCells.splice(i, 1);
    i = ashCells.indexOf(c); if (i >= 0) ashCells.splice(i, 1);
  }
  if (s === 0) { if (c) grass.delete(k); return; }
  if (!c) { c = { key: k, gx, gy, state: 'grass', t: 0, seed: (gx * 7 + gy * 13) & 1023 }; grass.set(k, c); }
  if (s === 1) { c.state = 'burning'; c.t = 3; burningCells.push(c); }
  else { c.state = 'ash'; c.t = 7; ashCells.push(c); }
}
function netCrate(x, y) {
  ensureChunks(x, y, 0);
  const s = solidsInBox(x - 2, y - 2, x + 2, y + 2, []).find(o => o.kind === 'crate' && !o.broken);
  if (s) { s.broken = true; removeSolid(s); }
}
// 進入房主的關卡（剛加入、下一關、或兩人一起重來）
function netApplyLevel(ev) {
  if (victoryOn()) { victory.stop(); Sfx.duck(false); }
  if (ev.nr) {                                        // 通關後再玩一次：從頭開始，物資和愛心都重來
    inv = newInventory(); player = makePlayer(); game.seenHint = {};
    game.runKills = 0; game.runBosses = 0; game.runTime = 0; NET.clearBonus = false;
  }
  const bonus = NET.clearBonus && ev.n === lvl.n + 1 && !ev.rt;
  NET.clearBonus = false;
  if (ev.j && ev.mh) {                                // 剛加入：愛心、技能、技能冷卻時間跟房主一樣
    player.maxHp = Math.min(PC.maxHpCap, ev.mh);
    if (ev.ul) { inv.ultimate = true; inv.ultMax = ev.um; }
    if (ev.vc) { inv.vacuum = true; inv.vacMax = ev.vm; }
  }
  if (ev.rt && lvl.snapshot) {
    inv = JSON.parse(JSON.stringify(lvl.snapshot.inv));
    const mh = lvl.snapshot.maxHp;
    player = makePlayer(); player.maxHp = mh;
  } else if (bonus) {
    player.maxHp = Math.min(PC.maxHpCap, player.maxHp + 2);
  }
  game.cutscene = false; game.fadeAt = 0;
  if (game.fadeDucked) { game.fadeDucked = false; Sfx.duck(false); }
  worldSeed = ev.seed;
  chunks = new Map(); grass = new Map();
  enemies = []; arrows = []; sparks = []; particles = []; texts = []; pickups = []; burningCells = []; ashCells = [];
  fireTick = 0; game.flurry = null; game.slowT = 0; game.shake = 0; game.flash = 0; game.hints = [];
  game.speech = null; game.bannerAt = 0; game.ult = null; game.vac = null; game.ultCD = 0; game.vacCD = 0; lvl.holdSpawn = false;
  game.theme = themeOf(ev.n);
  lvl.n = ev.n; lvl.kills = ev.kills; lvl.target = ev.tg; lvl.bossSpawned = false; lvl.bossReward = null; lvl.cleared = false;
  lvl.types = { melee: makeType('melee', ev.n), brute: makeType('brute', ev.n), archer: makeType('archer', ev.n) };
  NET.bossT = null; NET.enemyMap.clear(); NET.pickMap.clear(); NET.hiddenArrows.clear(); NET.ignoreArrows.clear();
  NET.snaps = NET.snaps.filter(s => s.t >= ev.t);
  Sfx.musicReset();
  resetPlayerTransient(player);
  if (ev.j) { player.x = ev.sx + 40; player.y = ev.sy + 36; }
  else { player.x = SPAWN.x - 10; player.y = SPAWN.y + 52; }
  if (!ev.rt) lvl.snapshot = { inv: JSON.parse(JSON.stringify(inv)), maxHp: player.maxHp };
  ensureChunks(player.x, player.y, GEN_RADIUS);
  for (const [x, y] of ev.chs || []) {                // 第 6 關：房主那邊的神秘箱子周圍沒有岩石，這邊也一樣
    ensureChunks(x, y, 200);
    for (const ch of chunks.values()) ch.solids = ch.solids.filter(s => !circleRectOverlap(x, y, 60, s));
  }
  moveEntity(player, 0, 0, player.r);
  snapCamera();
  $('levelBtn').style.display = '';
  NET.inLevel = true;
  NET.uiOpen = false;
  startPlay();
  if (ev.j) showHint(null, '你進入房主的世界了！愛心和技能都跟房主一樣，一起打怪吧', 6);
  if (bonus) showHint(null, '過關獎勵：最大生命 +1 顆心，生命全部回滿', 5);
}
// 第一關結局動畫看完：如果房主已經前往下一關就跟上，不然就等一下
function netGuestAfterCutscene() {
  if (NET.pendingLevel) return;                       // 下一幀就會套用
  game.mode = 'between';
  levelTitle.textContent = '等待房主';
  levelText.textContent = '房主還在看動畫，看完就會一起前往第 2 關。';
  $('levelBtn').style.display = 'none';
  levelScreen.classList.remove('hidden');
}
function netMakeEnemyCopy(r) {
  const kind = r[1];
  let T = kind === 'boss' ? (NET.bossT || (NET.bossT = makeBossType(lvl.n))) : (lvl.types[kind] || lvl.types.melee);
  const e = { nid: r[0], t: T, x: r[3], y: r[4], rad: T.size / 2, hp: r[8], face: r[5], state: r[6], stateT: r[7], hurtFlash: 0, alertT: 0, slowT: 0,
    bob: (r[0] * 1.7) % TAU, dead: false, kx: 0, ky: 0, lungeT: 0, fireInvuln: 0, sucked: null, home: { x: r[3], y: r[4] }, target: { x: r[3], y: r[4] } };
  if (kind === 'boss') Object.assign(e, { boss: true, phase: 1, invulnT: 0, slamR: 125, windMax: 1 });
  if (r[2]) makeElite(e);
  return e;
}
// 依時間把房主的世界平順地畫出來
function netGuestWorld(dt) {
  const rT = netNow() + NET.offset - NET.interp;
  // 只發生一次的事：照順序、到了該發生的時間才執行
  while (NET.evq.length) {
    const ev = NET.evq[0];
    if (NET.pendingLevel) {
      if ((game.cutscene && game.mode !== 'victory') || (game.mode === 'levelclear' && lvl.n === 1)) break;
      const lv = NET.pendingLevel; NET.pendingLevel = null; netApplyLevel(lv);
      continue;
    }
    if (ev.t > rT) break;
    NET.evq.shift();
    if (ev.k === 'lv' && NET.inLevel && ((game.cutscene && game.mode !== 'victory') || (game.mode === 'levelclear' && lvl.n === 1))) { NET.pendingLevel = ev; continue; }
    try { netGuestEvent(ev, rT); } catch (err) { if (window.console) console.warn('net event', err); }
  }
  if (NET.pendingLevel && !game.cutscene && !(game.mode === 'levelclear' && lvl.n === 1)) { const lv = NET.pendingLevel; NET.pendingLevel = null; netApplyLevel(lv); }
  if (!NET.inLevel) return;
  netUpdateMate(rT, dt);
  const buf = NET.snaps.filter(s => s.lv[0] === lvl.n);
  if (!buf.length) return;
  while (NET.snaps.length > 3 && NET.snaps[1].t < rT - 1.5) NET.snaps.shift();
  const [s0, s1, k] = netPick(buf, rT);
  for (const s of buf) if (s.q > NET.fxQ && s.t <= rT) { NET.fxQ = s.q; netPlayFx(s.fx); }
  if (s0.lv[1] > lvl.kills) game.runKills = (game.runKills || 0) + (s0.lv[1] - lvl.kills);     // 通關紀錄：兩人合計擊倒數
  lvl.kills = s0.lv[1]; lvl.target = s0.lv[2];
  const el = Math.max(0, rT - s0.t);
  // 怪物
  const next = s1 ? new Map(s1.en.map(r => [r[0], r])) : null, seen = new Set();
  for (const r of s0.en) {
    const id = r[0];
    seen.add(id);
    let e = NET.enemyMap.get(id);
    if (!e) { e = netMakeEnemyCopy(r); NET.enemyMap.set(id, e); }
    const n = next && next.get(id);
    e.x = n ? lerpN(r[3], n[3], k) : r[3]; e.y = n ? lerpN(r[4], n[4], k) : r[4];
    e.face = r[5]; e.state = r[6]; e.stateT = r[7] - el; e.hp = r[8];
    if (r[9] !== e.t.hp) e.t = Object.assign({}, e.t, { hp: r[9] });
    const fl = r[10];
    e.hurtFlash = fl & 1 ? Math.max(e.hurtFlash, 0.08) : e.hurtFlash - dt;
    e.slowT = fl & 2 ? 1 : 0; e.alertT = fl & 4 ? 1 : 0; e.dying = !!(fl & 32);
    if (fl & 8 && Math.random() < dt * 12) addParticle({ x: e.x + rand(-e.rad, e.rad) * 0.6, y: e.y - rand(0, e.rad), vx: rand(-10, 10), vy: rand(-50, -25), life: 0.45, max: 0.45, size: rand(2, 3.5), color: Math.random() < 0.5 ? '#ff8c42' : '#ffd166', type: 'dot', rot: 0, vr: 0 });
    if (r[11]) { e.phase = r[11][0]; e.invulnT = r[11][1]; e.windMax = r[11][2]; e.slamR = r[11][3]; e.dashN = r[11][4] || 0; }
    if (fl & 64 && !e.sucked) e.sucked = { t: 0, sc: 1, spin: 0 };       // 被吸怪器吸住：旋轉縮小
    if (e.sucked) {
      e.sucked.spin += dt * 9;
      const mw = game.vac ? vacMouthWorld(false) : null;
      e.sucked.sc = mw ? clamp(Math.hypot(mw.x - e.x, mw.y - e.y) / 280, 0.12, 1) : 1;
    }
  }
  for (const [id, e] of NET.enemyMap) if (!seen.has(id)) { e.dead = true; NET.enemyMap.delete(id); }
  enemies = [...NET.enemyMap.values()];
  // 箭（直線飛行，用速度推算目前位置）
  arrows = [];
  for (const r of s0.ar) {
    if (NET.hiddenArrows.has(r[0])) continue;
    arrows.push({ nid: r[0], x: r[1] + r[3] * el, y: r[2] + r[4] * el, vx: r[3], vy: r[4], owner: r[5] ? 'player' : 'enemy', fire: !!(r[6] & 1), orb: !!(r[6] & 2), dmg: r[7], life: 1, hit: null });
  }
  // 掉落物（階段一：隊友看得到，撿取在階段二開放）
  const pseen = new Set(), nowP = netNow();
  for (const r of s0.pk) {
    const rq = NET.pickReq.get(r[0]);
    if (rq !== undefined && nowP - rq < 1.2 && r[1] !== 'goldchest' && r[1] !== 'skillchest') continue;     // 剛撿起來：等房主確認時先藏起來
    pseen.add(r[0]);
    let h = NET.pickMap.get(r[0]);
    if (!h) {
      h = { nid: r[0], kind: r[1], t: Math.random() * 3, vx: 0, vy: 0, x: r[2], y: r[3] };
      const ex = r[5];
      if (h.kind === 'food') { h.heal = ex[0]; h.name = ex[1]; }
      else if (h.kind === 'arrows') h.count = ex;
      else if (h.kind === 'weapon' || h.kind === 'bow') h.item = { uid: 0, kind: h.kind === 'weapon' ? 'weapon' : 'bow', base: ex[0], rarity: ex[1], affixes: ex[2] || [] };
      NET.pickMap.set(r[0], h);
    }
    h.x = r[2]; h.y = r[3]; h.life = r[4]; h.t += dt; h.lock = !!r[6];
    if (h.kind === 'goldchest' || h.kind === 'skillchest') h.opened = !!r[5];
  }
  for (const id of [...NET.pickMap.keys()]) if (!pseen.has(id)) NET.pickMap.delete(id);
  pickups = [...NET.pickMap.values()];
}
function netGuestTick(rdt, now) {
  if (!NET.on) {
    if (NET.connOpen) {
      NET.helloT -= rdt;
      if (NET.helloT <= 0) { NET.helloT = 1; netSend({ k: 'hi', v: NET_PROTO, vw: VW, vh: VH, vc: inv.vacuum ? 1 : 0 }); netSend({ k: 'pi', c: r3(now) }); }
    }
    if (NET.deadline && now > NET.deadline) netFail(!NET.serverOk ? NET_TEXT.server : NET.connOpen ? NET_TEXT.noReply : NET_TEXT.wifi);
    return;
  }
  NET.pingT -= rdt;
  if (NET.pingT <= 0) { NET.pingT = 1; netSend({ k: 'pi', c: r3(now) }); }
  if (now - NET.lastRecv > NET_CONFIG.lostTimeout) { netLost('和房主的連線中斷了。'); return; }
  netInterpTick(rdt);
  netGuestWorld(rdt);
  NET.stT -= rdt;
  if ((NET.stT <= 0 || NET.flush) && (NET.offsetOk || NET.lastSnapQ > 0)) { NET.stT = 1 / NET_CONFIG.guestSendHz; NET.flush = false; netGuestSend(); }
}
function netTick(rdt) {
  const now = netNow();
  const box = NET.inbox; NET.inbox = [];
  for (const m of box) {
    if (!NET.role) break;
    try { if (NET.role === 'host') netHostMsg(m); else netGuestMsg(m); } catch (err) { if (window.console) console.warn('net msg', err); }
  }
  if (NET.role === 'guest') netGuestTick(rdt, now);
  else if (NET.role === 'host') netHostTick(rdt, now);
  if (NET.on) netReviveTick(rdt);
  if (NET.uiOpen) { NET.uiT -= rdt; if (NET.uiT <= 0) { NET.uiT = 0.5; netRenderUI(); } }
}

/* ---------- 建立連線（PeerJS）---------- */
function netLoadLib(ok, fail) {
  if (window.Peer) { ok(); return; }
  const urls = NET_CONFIG.peerjsUrls.slice();
  const next = () => {
    const u = urls.shift();
    if (!u) { fail(); return; }
    const s = document.createElement('script');
    s.src = u; s.async = true;
    s.onload = () => (window.Peer ? ok() : next());
    s.onerror = () => { s.remove(); next(); };
    document.head.appendChild(s);
  };
  next();
}
function netPeerOptions() {
  const o = { debug: 0, config: { iceServers: NET_CONFIG.iceServers } };
  if (NET_CONFIG.peerServer) Object.assign(o, NET_CONFIG.peerServer);
  return o;
}
function netErrText(t) {
  if (t === 'browser-incompatible') return NET_TEXT.browser;
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed' || t === 'disconnected') return NET_TEXT.server;
  if (t === 'webrtc' || t === 'negotiation-failed') return NET_TEXT.wifi;
  return '連線失敗，請再試一次。' + (t ? `（代碼：${t}）` : '');
}
function netWire(conn) {
  conn.on('open', () => {
    if (NET.conn !== conn) return;
    NET.connOpen = true; NET.lastRecv = netNow();
    if (NET.role === 'guest') { NET.helloT = 0; NET.deadline = netNow() + NET_CONFIG.connectTimeout; }
    netRenderUI();
  });
  conn.on('data', m => {
    if (NET.conn !== conn || !m || typeof m !== 'object') return;
    NET.recv++; NET.lastRecv = netNow();
    if (m.k === 'pi' && NET.role === 'host') { netSend({ k: 'po', c: m.c, h: r3(netNow()) }); return; }
    NET.inbox.push(m);
  });
  conn.on('close', () => {
    if (NET.conn !== conn) return;
    if (NET.on) netLost(NET.role === 'host' ? '隊友斷線了，你可以繼續一個人玩。' : '和房主的連線中斷了。');
    else if (NET.role === 'guest') netFail(NET.byeWhy ? NET.status : NET_TEXT.wifi);
    else { NET.conn = null; NET.connOpen = false; netRenderUI(); }
  });
  conn.on('error', () => { if (NET.conn === conn && NET.role === 'guest' && !NET.on) netFail(NET_TEXT.wifi); });
  setTimeout(() => {
    const pc = conn.peerConnection;
    if (!pc || !pc.addEventListener) return;
    const upd = () => {
      NET.ice = pc.iceConnectionState || '';
      if (NET.ice === 'failed' && NET.conn === conn && NET.role === 'guest' && !NET.on) netFail(NET_TEXT.wifi);
    };
    pc.addEventListener('iceconnectionstatechange', upd); upd();
  }, 0);
}
function netHost() {
  if (NET.role) return;
  NET.role = 'host'; NET.deadline = netNow() + NET_CONFIG.connectTimeout;
  netStatus('正在建立房間…', '');
  netLoadLib(() => netHostTry(0), () => netFail(NET_TEXT.lib));
}
function netHostTry(n) {
  if (NET.role !== 'host') return;
  const code = String(1000 + Math.floor(Math.random() * 9000));
  let peer;
  try { peer = new window.Peer(NET_CONFIG.roomPrefix + code, netPeerOptions()); } catch (err) { netFail(NET_TEXT.browser); return; }
  NET.peer = peer; NET.code = code;
  peer.on('open', () => {
    if (NET.peer !== peer) return;
    NET.serverOk = true; NET.deadline = 0;
    if (!NET.on) netStatus('請在另一台 iPad 打開遊戲 → 暫停 → 連線 → 加入房間，輸入上面的房號。等待隊友加入中…', '');
  });
  peer.on('connection', conn => {
    if (NET.peer !== peer) return;
    if (NET.conn && NET.conn.open) {                  // 已經有隊友了
      conn.on('open', () => { try { for (let k = 0; k < 3; k++) conn.send({ k: 'bye', why: 'full' }); } catch (err) { /* 略過 */ } setTimeout(() => { try { conn.close(); } catch (err) { /* 略過 */ } }, 400); });
      return;
    }
    NET.conn = conn; NET.connOpen = false;
    netWire(conn);
  });
  peer.on('disconnected', () => {
    NET.serverOk = false;
    if (NET.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch (err) { /* 略過 */ } }
  });
  peer.on('error', err => {
    if (NET.peer !== peer) return;
    const t = err && err.type;
    if (t === 'unavailable-id' && n < 6) { try { peer.destroy(); } catch (e2) { /* 略過 */ } NET.peer = null; netHostTry(n + 1); return; }
    if (NET.on || t === 'peer-unavailable') { if (t !== 'peer-unavailable') NET.serverOk = false; return; }   // 已經連上隊友：配對伺服器斷掉沒關係
    netFail(netErrText(t));
  });
  netRenderUI();
}
function netJoin(raw) {
  if (NET.role) return;
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length !== 4) { netStatus(NET_TEXT.code, 'err'); return; }
  NET.role = 'guest'; NET.code = code; NET.deadline = 0;
  netStatus(`正在連線到房號 ${code}…`, '');
  netLoadLib(() => {
    if (NET.role !== 'guest' || NET.peer) return;
    let peer;
    try { peer = new window.Peer(netPeerOptions()); } catch (err) { netFail(NET_TEXT.browser); return; }
    NET.peer = peer; NET.deadline = netNow() + NET_CONFIG.connectTimeout;
    peer.on('open', () => {
      if (NET.peer !== peer || NET.conn) return;
      NET.serverOk = true; NET.deadline = netNow() + NET_CONFIG.connectTimeout;
      const conn = peer.connect(NET_CONFIG.roomPrefix + code, { reliable: true, serialization: 'json' });
      NET.conn = conn; netWire(conn);
    });
    peer.on('disconnected', () => { NET.serverOk = false; });
    peer.on('error', err => {
      if (NET.peer !== peer) return;
      const t = err && err.type;
      if (t === 'peer-unavailable') { if (!NET.on) netFail(NET_TEXT.noRoom(code)); return; }
      if (NET.on) { NET.serverOk = false; return; }
      netFail(netErrText(t));
    });
  }, () => netFail(NET_TEXT.lib));
  netRenderUI();
}
function netTeardown() {
  const conn = NET.conn, peer = NET.peer;
  Object.assign(NET, netFresh());
  try { if (conn) conn.close(); } catch (err) { /* 略過 */ }
  try { if (peer) peer.destroy(); } catch (err) { /* 略過 */ }
}
function netFail(text) {
  netTeardown();
  netStatus(text, 'err');
}
// 一起玩到一半斷線
function netLost(text) {
  const wasGuest = NET.role === 'guest';
  for (const e of enemies) e.frozenT = 0;
  netTeardown();
  if (!wasGuest) {
    netRescale();
    netStatus(text, 'err');
    showHint(null, text, 7);
    if (game.mode === 'play' && player.dead) endGame('lose');
    return;
  }
  // 隊友這邊：世界是房主的，房主不在了就回到標題畫面
  game.mode = 'over'; game.paused = false; game.flurry = null;
  resetInputs();
  hideAllOverlays();
  netNotice('連線中斷', text + '按下面的按鈕回到標題畫面，可以重新開始，或再加入一次房間。');
}
function netLeave() {
  if (!NET.role) return;
  if (!NET.on) { netTeardown(); netStatus(NET_TEXT.intro, ''); return; }
  const wasGuest = NET.role === 'guest';
  for (let k = 0; k < 3; k++) netSend({ k: 'bye', why: 'leave' });
  const conn = NET.conn, peer = NET.peer;
  NET.conn = null; NET.peer = null;
  setTimeout(() => { try { if (conn) conn.close(); } catch (err) { /* 略過 */ } try { if (peer) peer.destroy(); } catch (err) { /* 略過 */ } }, 300);
  for (const e of enemies) e.frozenT = 0;
  Object.assign(NET, netFresh());
  if (wasGuest) {
    game.mode = 'over'; game.paused = false;
    resetInputs(); hideAllOverlays();
    netNotice('已離開連線', '你已經離開房主的世界。按下面的按鈕回到標題畫面。');
    return;
  }
  netRescale();
  netStatus('已離開連線，現在是一個人玩。', '');
}

/* ---------- 連線畫面 ---------- */
function netStatus(text, kind) { NET.status = text; NET.statusKind = kind || ''; netRenderUI(); }
function netRenderUI() {
  const st = $('netStatus');
  if (!st) return;
  st.textContent = NET.status || NET_TEXT.intro;
  st.className = 'netstatus' + (NET.statusKind ? ' ' + NET.statusKind : '');
  $('netVer').textContent = '遊戲版本：' + NET_VERSION;
  const idle = !NET.role;
  $('netMainRow').classList.toggle('nh', !idle);
  $('netJoinRow').classList.toggle('nh', !(idle && NET.joinOpen));
  const box = $('netCodeBox');
  const showCode = NET.role === 'host' && NET.code && NET.serverOk && !NET.on;
  box.classList.toggle('nh', !showCode);
  if (showCode) box.innerHTML = `<small>房號</small>${NET.code}`;
  const lv = $('netLeaveBtn');
  lv.classList.toggle('nh', idle);
  lv.textContent = NET.on ? '離開連線' : '取消';
  $('netDiagBtn').textContent = NET.diagOpen ? '收起診斷' : '連線診斷';
  const dg = $('netDiag');
  dg.classList.toggle('nh', !NET.diagOpen);
  if (NET.diagOpen) dg.innerHTML = netDiagHtml();
}
function netDiagHtml() {
  const now = netNow();
  const role = NET.role === 'host' ? `房主（房號 ${NET.code || '—'}）` : NET.role === 'guest' ? `隊友（房號 ${NET.code || '—'}）` : '還沒有連線';
  const server = !NET.role ? '—' : NET.serverOk ? '已連上' : NET.on ? '暫時斷開（不影響已經連上的隊友）' : '連線中…';
  const mate = NET.on ? '<b class="good">已連上</b>' : NET.role === 'host' ? '等待隊友加入' : NET.role === 'guest' ? (NET.connOpen ? '已連到房主，等待回應…' : '連線中…') : '—';
  const ms = Math.round(NET.rtt);
  const msTxt = !NET.on ? '—' : ms <= 0 ? '測量中…' : `<b class="${ms < 80 ? 'good' : ms < 160 ? 'mid' : 'bad'}">${ms} 毫秒</b>（${ms < 80 ? '很好' : ms < 160 ? '普通' : '偏慢，建議兩台都靠近 Wi-Fi 基地台'}）`;
  const last = NET.on ? `${Math.max(0, now - NET.lastRecv).toFixed(1)} 秒前` : '—';
  const iceMap = { checking: '正在找路線…', connected: '已直接連上', completed: '已直接連上', disconnected: '暫時中斷', failed: '找不到路線（請確認同一個 Wi-Fi）', closed: '已關閉', new: '準備中' };
  const ice = NET.ice ? (iceMap[NET.ice] || NET.ice) : '—';
  return [
    ['身分', role], ['配對伺服器', server], ['隊友連線', mate], ['來回延遲', msTxt], ['最後收到隊友資料', last],
    ['連線路線', ice], ['畫面緩衝', NET.on ? `${Math.round(NET.interp * 1000)} 毫秒（網路慢時會自動加長）` : '—'], ['已送出／收到', NET.role ? `${NET.sent}／${NET.recv} 則` : '—'],
  ].map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');
}
function netNotice(title, text) {
  $('netNoticeTitle').textContent = title;
  $('netNoticeText').textContent = text;
  $('netNoticeScreen').classList.remove('hidden');
}
$('netBtn').addEventListener('click', () => {
  pauseScreen.classList.add('hidden');
  $('netScreen').classList.remove('hidden');
  NET.uiOpen = true; NET.uiT = 0;
  netRenderUI();
});
$('netBackBtn').addEventListener('click', () => {
  $('netScreen').classList.add('hidden');
  NET.uiOpen = false;
  if (game.mode === 'play' && game.paused) pauseScreen.classList.remove('hidden');
});
$('netHostBtn').addEventListener('click', () => netHost());
$('netJoinBtn').addEventListener('click', () => {
  NET.joinOpen = true; netRenderUI();
  try { $('netCodeInput').focus(); } catch (err) { /* 略過 */ }
});
$('netJoinGo').addEventListener('click', () => netJoin($('netCodeInput').value));
$('netCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') netJoin($('netCodeInput').value); });
$('netCodeInput').addEventListener('input', e => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); if (v !== e.target.value) e.target.value = v; });
$('netDiagBtn').addEventListener('click', () => { NET.diagOpen = !NET.diagOpen; netRenderUI(); });
$('netLeaveBtn').addEventListener('click', () => netLeave());
$('netNoticeBtn').addEventListener('click', () => { try { location.reload(); } catch (err) { /* 略過 */ } });

/* ---------- 畫隊友 ---------- */
function drawMate() {
  const m = NET.mate;
  if (!netMateIn()) return;
  if (m.x < cam.x - 120 || m.x > cam.x + VW + 120 || m.y < cam.y - 120 || m.y > cam.y + VH + 120) return;
  const sp = player, si = inv, sf = game.flurry, su = game.ult;
  player = m; inv = m.invStub; game.flurry = m.fl ? { target: null, phase: 'ready', hits: 0 } : null; heroAlt = true;
  game.ult = m.ul ? { phase: m.uc >= 0 ? 'charge' : 'travel', t: Math.max(0, m.uc) } : null;
  try { drawPlayer(); } finally { player = sp; inv = si; game.flurry = sf; game.ult = su; heroAlt = false; }
  if (m.ultHidden) return;
  // 名字與血條
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px "PingFang TC", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  const ty = m.y - 66;
  ctx.strokeText('隊友', m.x, ty); ctx.fillStyle = '#9fe0ff'; ctx.fillText('隊友', m.x, ty);
  if (!m.dead) {
    const w = 34, k = clamp(m.hp / Math.max(1, m.maxHp), 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(m.x - w / 2, ty + 9, w, 4);
    ctx.fillStyle = '#ff5f73'; ctx.fillRect(m.x - w / 2, ty + 9, w * k, 4);
  }
}
function drawGhost(p, sdir, flip) {
  const img = heroCanvas(sdir, 'idle', 0, '#cfe8ff');
  const bob = Math.sin(game.time * 3) * 3;
  ctx.save();
  ctx.globalAlpha = 0.4 + 0.1 * Math.sin(game.time * 4);
  if (img) blitHero(img, p.x, p.y - 10 + bob, flip);
  ctx.restore();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 12px "PingFang TC", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText('等待救援', p.x, p.y + 26); ctx.fillStyle = '#cfe8ff'; ctx.fillText('等待救援', p.x, p.y + 26);
  const k = p === NET.mate ? (p.rv || 0) : NET.revive;     // 救援進度圈
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(p.x, p.y - 14, 30, 0, TAU); ctx.stroke();
  if (k > 0) { ctx.strokeStyle = '#9fe0ff'; ctx.beginPath(); ctx.arc(p.x, p.y - 14, 30, -Math.PI / 2, -Math.PI / 2 + TAU * k); ctx.stroke(); }
}
function netMateMarker() {
  if (!netMateIn()) return;
  const m = NET.mate, mg = 34;
  const sx = m.x - cam.x, sy = m.y - cam.y;
  if (sx > -10 && sx < VW + 10 && sy > -10 && sy < VH + 10) return;
  const cx = VW / 2, cy = VH / 2, dx = sx - cx, dy = sy - cy;
  const k = Math.min((VW / 2 - mg - SAFE.l) / Math.abs(dx || 1e-6), (VH / 2 - mg - SAFE.t) / Math.abs(dy || 1e-6));
  const mx = cx + dx * k, my = cy + dy * k, a = Math.atan2(dy, dx);
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = m.dead ? '#cfe8ff' : '#5be37d';
  ctx.beginPath(); ctx.arc(mx, my, 13, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.moveTo(mx + Math.cos(a) * 22, my + Math.sin(a) * 22); ctx.lineTo(mx + Math.cos(a + 0.6) * 12, my + Math.sin(a + 0.6) * 12); ctx.lineTo(mx + Math.cos(a - 0.6) * 12, my + Math.sin(a - 0.6) * 12); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#10301c'; ctx.font = 'bold 12px "PingFang TC", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('友', mx, my + 1);
  ctx.globalAlpha = 1;
}
function netHud() {
  const x = VW - SAFE.r - 72, y = SAFE.t + 30;
  const ms = Math.round(NET.rtt);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px "PingFang TC", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  const t1 = ms > 0 ? `連線中 ${ms} 毫秒` : '連線中';
  ctx.strokeText(t1, x, y); ctx.fillStyle = ms <= 0 || ms < 80 ? '#5be37d' : ms < 160 ? '#ffd166' : '#ff6b5a'; ctx.fillText(t1, x, y);
  const m = NET.mate;
  const t2 = !netMateIn() ? '隊友準備中…' : m.dead ? '隊友倒下了' : `隊友 ❤ ${m.hp / 2} / ${m.maxHp / 2}`;
  ctx.strokeText(t2, x, y + 19); ctx.fillStyle = netMateIn() && m.dead ? '#cfe8ff' : '#f1ead2'; ctx.fillText(t2, x, y + 19);
}

/* =========================================================
 * 通關：打倒「深淵虛空迷境」（第 20 關）的大魔王後，播放勝利煙火秀
 *   夜空、星星、彩帶；各種煙火（牡丹、圓環、愛心、星星、柳樹、分裂）；
 *   一發煙火在空中拼出「恭喜通關」，另一發拼出亞特（連線時還有隊友）的樣子；
 *   最後是大合奏煙火，再出現通關紀錄。點畫面任何地方都可以自己放煙火。
 * ========================================================= */
const FINAL_LEVEL = 20;
function createVictory() {
  const cvs = $('victoryCanvas'), c = cvs.getContext('2d'), ui = $('victoryUI'), skipBtn = $('victorySkip');
  const fxc = document.createElement('canvas'), f = fxc.getContext('2d');
  const G = 300;                                         // 煙火粒子的重力
  const PAL = [['#ff5f73', '#ffd0d6'], ['#ffd166', '#fff3c4'], ['#7fe0ff', '#e0fbff'], ['#b48cff', '#efe6ff'],
               ['#5be37d', '#d8ffe2'], ['#ff9b3d', '#ffe2c4'], ['#ff7ad9', '#ffe0f6']];
  const GOLD = ['#ffc94f', '#fff1b0'];
  const FONT = '"PingFang TC","Noto Sans TC","Heiti TC","Microsoft JhengHei",sans-serif';
  let W = 0, H = 0, D = 1, running = false, t = 0, last = 0, raf = 0, opts = {}, uiShown = false, nextAmbient = 0;
  let rockets = [], sparks = [], forms = [], confetti = [], stars = [], timeline = [];
  const pick = a => a[(Math.random() * a.length) | 0];

  function resizeV() {
    W = VW || window.innerWidth; H = VH || window.innerHeight; D = Math.min(window.devicePixelRatio || 1, 2);
    for (const k of [cvs, fxc]) { k.width = Math.round(W * D); k.height = Math.round(H * D); }
    stars = Array.from({ length: 140 }, () => ({ x: Math.random() * W, y: Math.random() * H * 0.8, r: Math.random() * 1.4 + 0.3, p: Math.random() * TAU }));
  }
  // ---- 發射 ----
  function launch(x, ty, type, pal, extra) {
    const h = Math.max(80, H + 10 - ty);
    rockets.push(Object.assign({ x, y: H + 10, vx: rand(-15, 15), vy: -Math.sqrt(2 * 420 * h), type, pal: pal || pick(PAL), age: 0 }, extra || {}));
    Sfx.play('fwLaunch', { player: true });
  }
  function spark(x, y, vx, vy, col, o) {
    if (sparks.length > 2600) return;
    sparks.push(Object.assign({ x, y, vx, vy, col, life: rand(1.2, 2.0), max: 2, size: rand(1.6, 2.6), g: G, drag: 1.7, tw: Math.random() < 0.35, split: 0 }, o || {}));
  }
  function explode(r) {
    const S = Math.min(W, H) * 0.42, [c1, c2] = r.pal, x = r.x, y = r.y;
    switch (r.type) {
      case 'ring': {
        const n = 64, tilt = rand(0.45, 1);
        for (let i = 0; i < n; i++) { const a = i / n * TAU; spark(x, y, Math.cos(a) * S * 0.75, Math.sin(a) * S * 0.75 * tilt, i % 2 ? c1 : c2, { life: rand(1.4, 1.8) }); }
        for (let i = 0; i < 30; i++) { const a = Math.random() * TAU, s = rand(0.1, 0.35) * S; spark(x, y, Math.cos(a) * s, Math.sin(a) * s, '#ffffff', { life: 1, size: 1.5 }); }
        break;
      }
      case 'heart': {
        const n = 80;
        for (let i = 0; i < n; i++) {
          const a = i / n * TAU, hx = 16 * Math.pow(Math.sin(a), 3), hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
          spark(x, y, hx / 17 * S * 0.75, hy / 17 * S * 0.75, i % 3 ? '#ff5f73' : '#ffd0d6', { life: rand(1.6, 2.0), g: G * 0.5 });
        }
        break;
      }
      case 'star': {
        const n = 100;
        for (let i = 0; i < n; i++) {
          const k = i / n * 5, seg = Math.floor(k), fr = k - seg;
          const a1 = seg / 5 * TAU - Math.PI / 2, a2 = (seg + 0.5) / 5 * TAU - Math.PI / 2, a3 = (seg + 1) / 5 * TAU - Math.PI / 2;
          const p1 = [Math.cos(a1), Math.sin(a1)], p2 = [Math.cos(a2) * 0.42, Math.sin(a2) * 0.42], p3 = [Math.cos(a3), Math.sin(a3)];
          const q = fr < 0.5 ? [p1[0] + (p2[0] - p1[0]) * fr * 2, p1[1] + (p2[1] - p1[1]) * fr * 2] : [p2[0] + (p3[0] - p2[0]) * (fr - 0.5) * 2, p2[1] + (p3[1] - p2[1]) * (fr - 0.5) * 2];
          spark(x, y, q[0] * S * 0.8, q[1] * S * 0.8, i % 2 ? GOLD[0] : GOLD[1], { life: rand(1.6, 2.0), g: G * 0.5 });
        }
        break;
      }
      case 'willow': {                                   // 金色柳樹：慢慢垂下來
        for (let i = 0; i < 90; i++) { const a = Math.random() * TAU, s = rand(0.35, 0.8) * S; spark(x, y, Math.cos(a) * s, Math.sin(a) * s, i % 3 ? GOLD[0] : '#ff9b3d', { life: rand(2.6, 3.4), max: 3.4, drag: 2.4, g: G * 0.7, size: rand(1.4, 2.2) }); }
        break;
      }
      case 'crossette': {                                // 會再分裂一次
        for (let i = 0; i < 14; i++) { const a = i / 14 * TAU, s = S * 0.6; spark(x, y, Math.cos(a) * s, Math.sin(a) * s, c1, { life: 0.7, split: 1, size: 3 }); }
        break;
      }
      case 'form': {                                     // 拼出文字或亞特的樣子
        for (const p of r.points) {
          const a = Math.random() * TAU, s = rand(0.2, 1) * S;
          forms.push({ sx: x, sy: y, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, tx: p[0], ty: p[1], col: p[2] || pick(r.pal), age: 0, hold: r.hold, size: p[3] || 2.4 });
        }
        Sfx.play('fwBig', { player: true });
        return;
      }
      default: {                                         // 牡丹：大圓球
        const n = 110;
        for (let i = 0; i < n; i++) { const a = Math.random() * TAU, s = Math.sqrt(Math.random()) * S; spark(x, y, Math.cos(a) * s, Math.sin(a) * s, Math.random() < 0.7 ? c1 : c2); }
      }
    }
    Sfx.play('fwBoom', { player: true });
  }
  // ---- 把文字畫在小畫布上，取出點的位置 ----
  function textPoints(text, cx, cy, maxW) {
    const o = document.createElement('canvas'), ow = 1000, oh = 230;
    o.width = ow; o.height = oh;
    const x = o.getContext('2d');
    x.fillStyle = '#ffffff'; x.font = `900 180px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, ow / 2, oh / 2);
    let data;
    try { data = x.getImageData(0, 0, ow, oh).data; } catch (err) { return []; }
    const sc = Math.min(maxW / ow, 1.3), step = 7, pts = [];
    for (let yy = 0; yy < oh; yy += step) for (let xx = 0; xx < ow; xx += step) {
      if (data && data[(yy * ow + xx) * 4 + 3] > 128) pts.push([cx + (xx - ow / 2) * sc, cy + (yy - oh / 2) * sc, null, 2.6]);
    }
    return pts;
  }
  // 亞特（連線時加上戴藍帽子的隊友）的像素圖，每一格變成一個煙火粒子
  function heroPoints(cx, cy, cell, alt) {
    heroAlt = !!alt;
    const img = heroCanvas('down', 'idle', 0);
    heroAlt = false;
    if (!img) return [];
    let data;
    try { data = img.getContext('2d').getImageData(0, 0, img.width, img.height).data; } catch (err) { return []; }
    const pts = [];
    for (let py = 0; py < img.height; py++) for (let px = 0; px < img.width; px++) {
      const i = (py * img.width + px) * 4;
      if (!data || data[i + 3] < 128) continue;
      const col = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
      pts.push([cx + (px - img.width / 2) * cell, cy + (py - img.height / 2) * cell, col, cell * 0.55]);
    }
    return pts;
  }
  // ---- 節目表（秒）----
  function buildTimeline() {
    const tl = [], add = (at, fn) => tl.push({ at, fn });
    const mid = () => H * 0.42;
    add(0.35, () => Sfx.play('victory', { player: true }));
    add(0.9, () => launch(W * 0.25, H * 0.3, 'peony', PAL[0]));
    add(1.15, () => launch(W * 0.75, H * 0.28, 'peony', PAL[2]));
    add(1.6, () => launch(W * 0.5, H * 0.24, 'ring', PAL[1]));
    add(2.1, () => launch(W * 0.2, H * 0.35, 'heart'));
    add(2.3, () => launch(W * 0.82, H * 0.33, 'star'));
    add(3.0, () => launch(W * 0.5, mid(), 'form', GOLD, { points: textPoints('恭喜通關', W * 0.5, mid(), W * 0.8), hold: 3.0 }));
    add(3.6, () => launch(W * 0.12, H * 0.2, 'crossette', PAL[4]));
    add(4.2, () => launch(W * 0.88, H * 0.22, 'crossette', PAL[6]));
    add(5.0, () => launch(W * 0.15, H * 0.3, 'willow'));
    add(5.3, () => launch(W * 0.85, H * 0.3, 'willow'));
    add(6.6, () => {
      const cell = Math.max(5, Math.min(W, H) / 70);
      let pts;
      if (opts.coop) pts = heroPoints(W * 0.5 - cell * 20, mid(), cell, false).concat(heroPoints(W * 0.5 + cell * 20, mid(), cell, true));
      else pts = heroPoints(W * 0.5, mid(), cell, false);
      launch(W * 0.5, mid(), 'form', PAL[2], { points: pts, hold: 3.0 });
    });
    add(7.2, () => launch(W * 0.3, H * 0.18, 'ring', PAL[3]));
    add(7.6, () => launch(W * 0.7, H * 0.18, 'ring', PAL[5]));
    for (let k = 0; k < 16; k++) add(10.2 + k * 0.12, () => launch(rand(W * 0.08, W * 0.92), rand(H * 0.12, H * 0.42), pick(['peony', 'peony', 'ring', 'willow', 'crossette', 'heart', 'star'])));
    add(12.2, () => showUI());
    return tl.sort((a, b) => a.at - b.at);
  }
  // ---- 更新 ----
  function update(dt) {
    while (timeline.length && timeline[0].at <= t) timeline.shift().fn();
    if (uiShown && t > nextAmbient) { nextAmbient = t + rand(1.2, 2.2); launch(Math.random() < 0.5 ? rand(W * 0.06, W * 0.28) : rand(W * 0.72, W * 0.94), rand(H * 0.12, H * 0.35), pick(['peony', 'ring', 'willow', 'heart', 'star', 'crossette'])); }
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.age += dt; r.vy += 420 * dt; r.x += r.vx * dt; r.y += r.vy * dt;
      if (Math.random() < 0.9) spark(r.x + rand(-1.5, 1.5), r.y + 4, rand(-12, 12), rand(20, 60), '#ffe2b0', { life: 0.35, max: 0.35, size: 1.4, g: 40, drag: 3 });
      if (r.vy >= -30) { rockets.splice(i, 1); explode(r); }
    }
    const kept = [];
    for (const s of sparks) {
      const k = Math.exp(-s.drag * dt);
      s.vx *= k; s.vy *= k; s.vy += s.g * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      if (s.split && s.life < 0.05) {                    // 分裂成四顆
        s.split = 0;
        for (let q = 0; q < 4; q++) { const a = q / 4 * TAU + Math.random(), v = Math.min(W, H) * 0.18; spark(s.x, s.y, Math.cos(a) * v, Math.sin(a) * v, pick(PAL)[0], { life: 0.9 }); }
        Sfx.play('fwCrackle', { player: true });
      }
      if (s.life > 0) kept.push(s);
    }
    sparks = kept;
    const fk = [];
    for (const p of forms) {
      p.age += dt;
      const fly = Math.exp(-p.age * 2.2), w = clamp((p.age - 0.12) / 0.8, 0, 1), e = w * w * (3 - 2 * w);
      if (p.age < 0.95 + p.hold) {
        const fx = p.sx + p.vx * (1 - fly) / 2.2, fy = p.sy + p.vy * (1 - fly) / 2.2;
        p.x = fx + (p.tx - fx) * e; p.y = fy + (p.ty - fy) * e;
        fk.push(p);
      } else {                                           // 拼完之後散開落下
        spark(p.x, p.y, rand(-40, 40), rand(-60, 10), p.col, { life: rand(0.8, 1.6), size: p.size, g: G * 0.8 });
      }
    }
    forms = fk;
    // 彩帶
    const rate = t < 1 ? 0 : t < 8 ? 45 : 14;
    for (let n = 0; n < rate * dt * (W / 1000); n++) {
      if (confetti.length > 260) break;
      confetti.push({ x: Math.random() * W, y: -10, vx: rand(-30, 30), vy: rand(60, 130), r: Math.random() * TAU, vr: rand(-6, 6), w: rand(6, 11), h: rand(3, 6), col: pick(PAL)[Math.random() < 0.5 ? 0 : 1], ph: Math.random() * TAU });
    }
    for (let i = confetti.length - 1; i >= 0; i--) {
      const q = confetti[i];
      q.ph += dt * 3; q.x += (q.vx + Math.sin(q.ph) * 40) * dt; q.y += q.vy * dt; q.r += q.vr * dt;
      if (q.y > H + 20) confetti.splice(i, 1);
    }
  }
  // ---- 畫面 ----
  function drawHero(x, y, alt, flip, k) {
    heroAlt = !!alt;
    const img = heroCanvas('side', 'swing', 0) || heroCanvas('down', 'idle', 0);
    heroAlt = false;
    if (!img) return;
    const sc = Math.max(3, Math.min(W, H) / 150), jump = Math.abs(Math.sin(t * 3.2 + k)) * 26;
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.ellipse(x, y + 4, 15 * sc * (1 - jump / 80), 3.5 * sc, 0, 0, TAU); c.fill();
    c.translate(x, y - jump);
    if (flip) c.scale(-1, 1);
    c.imageSmoothingEnabled = false;
    c.drawImage(img, -img.width * sc / 2, -img.height * sc, img.width * sc, img.height * sc);
    c.restore();
  }
  function render() {
    // 煙火層（留一點拖尾）
    f.setTransform(D, 0, 0, D, 0, 0);
    f.globalCompositeOperation = 'destination-out';
    f.fillStyle = 'rgba(0,0,0,0.2)'; f.fillRect(0, 0, W, H);
    f.globalCompositeOperation = 'lighter';
    for (const s of sparks) {
      let a = clamp(s.life / Math.min(s.max, 1.2), 0, 1);
      if (s.tw) a *= 0.45 + 0.55 * Math.abs(Math.sin(t * 25 + s.x));
      f.globalAlpha = a; f.fillStyle = s.col;
      f.beginPath(); f.arc(s.x, s.y, s.size, 0, TAU); f.fill();
    }
    for (const p of forms) {
      f.globalAlpha = 0.65 + 0.35 * Math.abs(Math.sin(t * 9 + p.tx * 0.07));
      f.fillStyle = p.col; f.beginPath(); f.arc(p.x, p.y, p.size, 0, TAU); f.fill();
    }
    f.globalAlpha = 1;
    // 主畫面
    c.setTransform(D, 0, 0, D, 0, 0);
    const fade = clamp(t / 0.8, 0, 1);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#05061a'); g.addColorStop(0.6, '#1a0f3a'); g.addColorStop(1, '#3a1830');
    c.globalAlpha = fade; c.fillStyle = g; c.fillRect(0, 0, W, H);
    for (const s of stars) { c.globalAlpha = fade * (0.35 + 0.65 * Math.abs(Math.sin(t * 1.3 + s.p))); c.fillStyle = '#fff8e0'; c.fillRect(s.x, s.y, s.r, s.r); }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'lighter'; c.drawImage(fxc, 0, 0, W, H); c.globalCompositeOperation = 'source-over';
    // 地平線上的燼野剪影
    c.fillStyle = '#0b0714';
    c.beginPath(); c.moveTo(0, H);
    for (let x = 0; x <= W; x += 20) c.lineTo(x, H * 0.86 - Math.abs(Math.sin(x * 0.011)) * 30 - Math.abs(Math.sin(x * 0.027 + 1)) * 18);
    c.lineTo(W, H); c.closePath(); c.fill();
    // 歡呼的亞特（連線時兩個人）
    const gy = H * 0.86;
    if (opts.coop) { drawHero(W * 0.43, gy, false, false, 0); drawHero(W * 0.57, gy, true, true, 1.2); }
    else drawHero(W * 0.5, gy, false, Math.floor(t / 1.6) % 2 === 1, 0);
    // 彩帶
    for (const q of confetti) {
      c.save(); c.translate(q.x, q.y); c.rotate(q.r); c.scale(1, Math.cos(q.ph * 2));
      c.fillStyle = q.col; c.fillRect(-q.w / 2, -q.h / 2, q.w, q.h); c.restore();
    }
    // 大標題
    if (t > 0.35) {
      const k = clamp((t - 0.35) / 0.7, 0, 1), back = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);
      const sz = Math.min(W * 0.13, H * 0.17, 130);
      c.save(); c.translate(W / 2, H * 0.16); c.scale(back, back);
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `900 ${sz}px ${FONT}`;
      const tg = c.createLinearGradient(0, -sz / 2, 0, sz / 2);
      tg.addColorStop(0, '#fff6c8'); tg.addColorStop(0.5, '#ffc94f'); tg.addColorStop(1, '#ff8a3d');
      c.shadowColor = 'rgba(255,190,80,0.9)'; c.shadowBlur = 30 + 15 * Math.sin(t * 4);
      c.lineWidth = 8; c.strokeStyle = 'rgba(60,20,0,0.8)'; c.strokeText('勝利！', 0, 0);
      c.fillStyle = tg; c.fillText('勝利！', 0, 0);
      c.restore();
      const a2 = clamp((t - 1.3) / 0.8, 0, 1);
      if (a2 > 0) {
        c.globalAlpha = a2; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = `800 ${Math.max(16, Math.min(W * 0.03, 26))}px ${FONT}`; c.fillStyle = '#f1ead2';
        c.shadowColor = 'rgba(0,0,0,0.8)'; c.shadowBlur = 8;
        c.fillText(opts.coop ? '亞特和隊友一起征服了燼野之境' : '亞特征服了燼野之境', W / 2, H * 0.16 + Math.min(W * 0.13, H * 0.17, 130) * 0.7);
        c.shadowBlur = 0; c.globalAlpha = 1;
      }
    }
  }
  function loop(now) {
    if (!running) return;
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now; t += dt;
    try { update(dt); render(); } catch (err) { if (window.console) console.warn('victory', err); }
    raf = requestAnimationFrame(loop);
  }
  function fmtRun(s) { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return (h ? h + ' 小時 ' : '') + m + ' 分 ' + ss + ' 秒'; }
  function showUI() {
    if (uiShown) return;
    uiShown = true; nextAmbient = t + 1;
    const st = opts.stats || {};
    const tiles = [
      [fmtRun(st.time), '冒險時間'], [`${st.kills || 0} 隻`, opts.coop ? '擊倒怪物（兩人合計）' : '擊倒怪物'],
      [`${st.bosses || 0} 隻`, '擊敗大魔王'], [`${st.hearts || 0} 顆`, '最大生命'], [`${st.legend || 0} 件`, '傳說裝備'],
    ];
    $('victoryStats').innerHTML = tiles.map(([v, k]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
    $('victoryAgain').textContent = '再玩一次';
    ui.classList.remove('hidden');
    skipBtn.classList.add('hidden');
  }
  function onTap(x, y) {
    if (!running) return;
    if (!uiShown && t < 1) return;
    launch(x + rand(-20, 20), y, pick(['peony', 'ring', 'heart', 'star', 'willow', 'crossette']));
  }
  cvs.addEventListener('touchstart', e => { e.preventDefault(); for (const tc of e.changedTouches) onTap(tc.clientX, tc.clientY); }, { passive: false });
  cvs.addEventListener('mousedown', e => onTap(e.clientX, e.clientY));
  skipBtn.addEventListener('click', () => { if (running) { timeline = timeline.filter(x => x.at < 10.2 || x.at >= 12.2); t = Math.max(t, 10); showUI(); } });
  window.addEventListener('resize', () => { if (running) resizeV(); });
  function start(o) {
    opts = o || {};
    resizeV();
    rockets = []; sparks = []; forms = []; confetti = []; t = 0; uiShown = false;
    f.clearRect(0, 0, fxc.width, fxc.height);
    timeline = buildTimeline();
    cvs.style.display = 'block'; skipBtn.classList.remove('hidden'); ui.classList.add('hidden');
    running = true; last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    cvs.style.display = 'none'; ui.classList.add('hidden'); skipBtn.classList.add('hidden');
  }
  return { start, stop, showUI, get running() { return running; }, get t() { return t; } };
}
let victory = null;
const victoryOn = () => !!(victory && victory.running);
function playVictory() {
  game.mode = 'victory'; game.cutscene = true; game.flurry = null;
  resetInputs(); hideAllOverlays();
  Sfx.duck(true);
  let legend = 0;
  for (const raw of inv.melee) if (asItem(raw, 'weapon').rarity === 'legend') legend++;
  for (const raw of inv.bows) if (asItem(raw, 'bow').rarity === 'legend') legend++;
  const stats = { time: game.runTime || 0, kills: game.runKills || 0, bosses: game.runBosses || 0, hearts: player.maxHp / 2, legend };
  try { if (!victory) victory = createVictory(); victory.start({ coop: NET.on, stats }); }
  catch (err) { if (window.console) console.warn('勝利畫面無法播放', err); restartFromVictory(); }
}
function restartFromVictory() {
  if (victory) victory.stop();
  game.cutscene = false; game.fadeAt = 0;
  Sfx.duck(false);
  clearCheckpoint();
  newRun();
  startPlay();
}
function returnToTitleFromVictory() {
  if (victory) victory.stop();
  if (NET.role) netLeave();
  hideAllOverlays();
  $('netNoticeScreen').classList.add('hidden');
  $('newRunConfirm').classList.add('hidden');
  game.cutscene = false; game.fadeAt = 0; game.paused = false;
  Sfx.duck(false);
  resetInputs();
  newRun();
  game.mode = 'title';
  refreshContinueButton();
  startScreen.classList.remove('hidden');
  window.dispatchEvent(new Event('ater:title-intro-reset'));
}
// Safari：輕微手指移動不應使結局按鈕失效；觸控直接處理並防止重複 click。
function bindVictoryButton(id, action) {
  const button = $(id);
  let contact = null, lastTouch = -Infinity;
  const available = () => game.mode === 'victory' && !$('victoryUI').classList.contains('hidden');
  button.addEventListener('touchstart', event => {
    contact = null;
    if (!available() || event.touches.length !== 1) return;
    const t = event.changedTouches[0];
    if (t) contact = {id:t.identifier,x:t.clientX,y:t.clientY};
  }, {passive:true});
  button.addEventListener('touchcancel', () => {contact=null;}, {passive:true});
  button.addEventListener('touchend', event => {
    const start = contact; contact = null;
    if (!start || !available()) return;
    const t = Array.from(event.changedTouches).find(t => t.identifier === start.id);
    if (!t || Math.hypot(t.clientX-start.x,t.clientY-start.y)>16) return;
    const r=button.getBoundingClientRect();
    if (t.clientX<r.left || t.clientX>r.right || t.clientY<r.top || t.clientY>r.bottom) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    lastTouch=performance.now();
    Sfx.unlock(); action();
  }, {passive:false});
  button.addEventListener('click', event => {
    if (!available() || performance.now()-lastTouch<700) return;
    event.stopPropagation();
    Sfx.unlock(); action();
  });
}
bindVictoryButton('victoryAgain', () => {
  if (netGuest()) { netAct({ a: 'newrun' }); $('victoryAgain').textContent = '等待房主…'; return; }
  restartFromVictory();
});
bindVictoryButton('victoryTitle', returnToTitleFromVictory);

/* =========================================================
 * 18. 主迴圈
 *    主角永遠用真實時間；世界（敵人、箭、火、粒子）用 wdt，
 *    迅影時刻時 wdt 會變得很小 → 整個世界慢動作，只有亞特正常速度。
 * ========================================================= */
function update(rdt) {
  game.time += rdt;
  const guest = netGuest();                                // 連線的隊友：世界由房主計算
  game.runTime = (game.runTime || 0) + rdt;
  let ws = 1;
  if (game.ult) ws = NET.on ? 1 : ULT.timeScale;
  else if (game.flurry) ws = NET.on ? 1 : PC.flurryTimeScale;     // 連線時世界不變慢，只有自己畫面變色
  else if (game.slowT > 0) { game.slowT -= rdt; ws = NET.on ? 1 : 0.25; }
  const wdt = rdt * ws;
  Sfx.setSlow(ws < 1 || (NET.on && (!!game.flurry || !!game.ult)));        // 世界慢動作時，世界的聲音也變悶
  ensureChunks(player.x, player.y, GEN_RADIUS);
  if (NET.on && !guest && netMateIn()) ensureChunks(NET.mate.x, NET.mate.y, GEN_RADIUS);
  if (game.mode === 'play' && !game.ult && game.ultCD > 0) game.ultCD = Math.max(0, game.ultCD - rdt);
  if (game.mode === 'play' && !game.vac && game.vacCD > 0) game.vacCD = Math.max(0, game.vacCD - rdt);
  updateVacuum(rdt);
  updatePlayer(rdt);
  updateFlurry(rdt);
  if (guest) { netGuestArrowHits(); netGuestBossDash(); }
  else { updateEnemies(wdt); updateArrows(wdt); }
  updateSparks(wdt);
  updateFire(wdt);
  if (!guest) { updatePickups(rdt); updateSpawner(wdt); }
  else netGuestPickups();
  updateLateObjective(rdt);
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.x += q.vx * wdt; q.y += q.vy * wdt;
    const f = Math.exp(-3 * wdt); q.vx *= f; q.vy *= f;
    if (q.type === 'ember') q.vy -= 30 * wdt;
    if (q.type === 'ring') q.size += 160 * rdt;
    q.rot += q.vr * wdt; q.life -= (q.type === 'ring' || q.type === 'streak' || q.type === 'smoke' && game.ult) ? rdt : wdt;
    if (q.life <= 0) particles.splice(i, 1);
  }
  for (let i = texts.length - 1; i >= 0; i--) { const t = texts[i]; t.y -= 34 * rdt; t.life -= rdt; if (t.life <= 0) texts.splice(i, 1); }
  if (game.hints.length && game.mode === 'play') { game.hints[0].t -= rdt; if (game.hints[0].t <= 0) game.hints.shift(); }
  if (game.banner) game.banner.t -= rdt;
  if (game.bannerAt && game.time >= game.bannerAt) { game.bannerAt = 0; levelBanner(); }
  game.shake = Math.max(0, game.shake - 30 * rdt);
  game.flash = Math.max(0, game.flash - 3 * rdt);
  updateCamera(rdt);
  if (game.mode === 'ending') { game.endT -= rdt; if (game.endT <= 0) showEnd(); }
  if (game.mode === 'levelclear') { game.endT -= rdt; if (game.endT <= 0) { if (lvl.n === 1) playChapter1Ending(); else if (lvl.n >= FINAL_LEVEL) playVictory(); else showLevelScreen(); } }
}

// 開始畫面的角色預覽：原地走路
const previewCtx = (() => { try { return $('heroPreview').getContext('2d'); } catch (err) { return null; } })();
let previewKey = '';
function drawPreview() {
  if (!previewCtx || game.mode !== 'title') return;
  const ph = Math.floor(game.time * 6) % 4, key = 'w' + ph;
  if (key === previewKey) return;
  previewKey = key;
  const img = heroCanvas('down', 'walk', ph);
  previewCtx.clearRect(0, 0, 32, 36);
  if (img) previewCtx.drawImage(img, 0, 0);
}
let lastTime = performance.now();
function frame(now) {
  const rdt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  // 標題畫面與序章播放時，遊戲世界先暫停（怪物不會趁機跑到亞特身邊）
  // 連線時：暫停、背包、直向只打開選單，世界繼續（不會卡住另一個人）
  const active = (NET.on || (!game.paused && !game.portrait)) && game.mode !== 'over' && game.mode !== 'between' && game.mode !== 'title' && game.mode !== 'victory';
  if (NET.role) netTick(rdt);
  // 背景音樂：開始遊戲後就一直播放，暫停、背包、過關、結算畫面都不中斷
  if (game.fadeAt && !game.fadeDucked && game.time >= game.fadeAt) { game.fadeDucked = true; Sfx.duck(true); }   // 畫面開始變黑時，配樂一起淡出
  if (game.cutscene) Sfx.musicActive(false);        // 過場動畫有自己的配樂
  else if (game.mode !== 'title') {
    if (!active) Sfx.setSlow(false);               // 選單中不要保持慢動作的悶聲
    Sfx.musicActive(true);
    Sfx.music((lvl.n - 1) % THEMES.length, bossAlive() ? 2 : active && game.mode === 'play' && enemies.some(e => !e.dead && e.state !== 'patrol') ? 1 : 0);
  }
  if (active) { readInput(); update(rdt); }
  else game.time += rdt;
  input.attackPressed = input.dodgePressed = input.shootPressed = input.ultPressed = input.vacPressed = false;
  render();
  drawPreview();
  requestAnimationFrame(frame);
}

/* v1.0.8：單人後五關目標。 */
function lateActive() { return !NET.on && !!lvl.late; }
function lateGoal(n) {
  return ({16:'三波戰鬥，每波擊倒 8 隻敵人',17:'擊敗 3 名精英隊長，護衛不計入目標',18:'生存 60 秒，擊倒敵人可獲得補給',19:'擊敗熔岩督軍與 2 名護衛',20:'擊倒 12 隻敵人，再擊敗最終魔王'})[n] || '';
}
function lateProgress() {
  const q = lvl.late;
  switch(lvl.n) {
    case 16: return `第 ${q.wave}/3 波　擊倒 ${Math.min(8,lvl.kills-(q.wave-1)*8)}/8${q.rest > 0 ? '　準備下一波' : ''}`;
    case 17: return `精英隊長 ${q.captains}/3`;
    case 18: return `生存 ${Math.min(60,Math.floor(q.elapsed))}/60 秒`;
    case 19: return `督軍 ${q.bossDead ? '已擊敗' : '未擊敗'}　護衛 ${q.guards}/2`;
    case 20: return lvl.bossSpawned ? '擊敗最終魔王' : `擊倒 ${Math.min(12,lvl.kills)}/12　迎戰最終魔王`;
  }
}
function lateFraction() {
  const q = lvl.late;
  return lvl.n === 17 ? q.captains/3 : lvl.n === 18 ? q.elapsed/60 : lvl.n === 19 ? (q.guards + (q.bossDead?1:0))/3 : lvl.kills/lvl.target;
}
function lateEnemyKilled(e) {
  const q = lvl.late;
  if (lvl.n === 20) return false;
  if (lvl.n === 16) {
    if (lvl.kills >= 24) levelClear();
    else if (lvl.kills >= q.wave*8 && q.rest <= 0) {
      q.rest = 2;
      game.banner = {title:`第 ${q.wave} 波完成`,sub:'喘口氣，下一波即將到來',t:2};
      dropFood(player.x, player.y, false);
    }
  }
  if (lvl.n === 17 && e.lateCaptain) {
    q.captains++;
    if (q.captains >= 3) levelClear();
    else { game.banner = {title:`隊長 ${q.captains}/3`,sub:'下一名隊長即將現身',t:2}; q.rest=2; }
  }
  if (lvl.n === 18 && lvl.kills % 3 === 0) dropFood(e.x,e.y,false);
  if (lvl.n === 19 && e.lateGuard) { q.guards++; checkLateClear(); }
  return true;
}
function checkLateClear() {
  if (game.mode === 'play' && lateActive() && lvl.n === 19 && lvl.late.bossDead && lvl.late.guards >= 2) levelClear();
}
function updateLateObjective(dt) {
  if (!lateActive() || game.mode !== 'play' || game.paused || player.dead) return;
  if (lvl.n === 18) {
    const q = lvl.late;
    q.elapsed = Math.min(60,q.elapsed+dt);
    if (q.elapsed >= q.supplyAt && q.supplyAt < 60) {dropFood(player.x,player.y,false);q.supplyAt+=15;}
    if (q.elapsed >= 60) levelClear();
  }
}
function spawnLate(role, tag) {
  const off = Math.hypot(VW,VH)/2;
  if (!trySpawnEnemy(off+50,off+230,false,player,role)) return false;
  const e = enemies[enemies.length-1];
  if (tag === 'captain') {
    makeElite(e); e.lateCaptain=true;
    e.t = Object.assign({},e.t,{hp:Math.round(lvl.types[role].hp*2),name:'隊長・'+lvl.types[role].name});
    e.hp=e.t.hp;
  }
  if (tag === 'guard') { makeElite(e);e.lateGuard=true;e.t=Object.assign({},e.t,{hp:Math.round(lvl.types[role].hp*1.5),name:'督軍護衛'});e.hp=e.t.hp; }
  return true;
}
function updateLateSpawner(dt) {
  if (lvl.n === 20) {
    lvl.spawnT-=dt;
    const alive=enemies.filter(e=>!e.dead && !e.boss).length;
    if (!lvl.bossSpawned && lvl.spawnT<=0 && alive<5 && lvl.kills+alive<12) {if(spawnLate(['melee','brute','archer'][lvl.spawned%3]))lvl.spawnT=.9;}
    return;
  }
  const q=lvl.late;
  if(q.rest>0) {
    q.rest=Math.max(0,q.rest-dt);
    if(q.rest>0)return;
    if(lvl.n===16){q.wave++;game.banner={title:`第 ${q.wave}/3 波`,sub:['近戰突襲','弓手交錯','混合精兵'][q.wave-1],t:2.5};}
  }
  lvl.spawnT-=dt;
  if(lvl.spawnT>0)return;
  const alive=enemies.filter(e=>!e.dead&&!e.dying);
  if(lvl.n===16 && alive.length<5 && lvl.kills+alive.length<q.wave*8) {if(spawnLate(pickRole()))lvl.spawnT=.7;}
  if(lvl.n===17) {
    if(q.captains<3&&!alive.some(e=>e.lateCaptain)) {
      if(spawnLate(['melee','archer','brute'][q.captains],'captain')) {lvl.spawnT=.8;showHint(null,`第 ${q.captains+1} 名隊長出現！循金色箭頭尋找`,4);}
    } else if(alive.length<4) {if(spawnLate(q.captains===1?'brute':'archer'))lvl.spawnT=1.4;}
  }
  if(lvl.n===18 && alive.length<6) {if(spawnLate(['melee','archer','brute'][Math.floor(q.elapsed/20)]))lvl.spawnT=1.1;}
  if(lvl.n===19) {
    if(!lvl.bossSpawned)spawnBoss();
    if(q.guards+alive.filter(e=>e.lateGuard).length<2) {if(spawnLate(q.guards+alive.filter(e=>e.lateGuard).length===0?'brute':'archer','guard'))lvl.spawnT=.8;}
  }
}

resize();
newRun();
refreshContinueButton();
requestAnimationFrame(frame);

// 測試用掛鉤（不影響遊戲）
window.__ATER__ = {
  game, input, joy, buttons, cam, PC, lvl, WEAPONS, BOWS, bagBtn,
  get player() { return player; }, get enemies() { return enemies; }, get inv() { return inv; },
  get arrows() { return arrows; }, get pickups() { return pickups; }, get texts() { return texts; }, get chunks() { return chunks; },
  get grass() { return grass; }, aimStick, get burningCells() { return burningCells; }, get sparks() { return sparks; },
  solidsInBox: (a, b, c, d) => solidsInBox(a, b, c, d, []), makeEnemy, trySpawnEnemy,
  touch: { start: onTouchStart, move: onTouchMove, end: onTouchEnd }, Sfx, pauseGame, breakCrate, cutGrass, tryUltimate, tryVacuum, VAC, placeSkillChest, ULT, spawnBoss, startLevel, bossAlive, hazardAt, hzContains, killTargetOf, makeBossType, makeItem, itemStats, itemName, curW, curB, rollRarity, dropLoot, dropGear, openGoldChest, makeElite, trySpawnEnemy, renderBag, bagState, RARITY, BAG_MAX, fireArrow, grantBossReward, get prologue() { return prologue; }, get ch1End() { return ch1End; },
  NET, netTick, netWorldDiff, retryLevel, levelClear, damageEnemy, damagePlayer, get worldSeed() { return worldSeed; },
  addPickup, dropFood, dropArrows, collectPickup, get victory() { return victory; }, playVictory, FINAL_LEVEL,
};
})();
