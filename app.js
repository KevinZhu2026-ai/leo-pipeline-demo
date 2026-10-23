// 卫星轨道展示系统 —— 自研展示层（three.js MIT + satellite.js MIT）
// 数据：Celestrak/KeepTrack 编目快照，NASA Blue Marble 贴图（公有领域）
import * as THREE from './libs/three.module.min.js';

const SAT = window.satellite;
const R_EARTH = 6378.137;
const MU = 398600.4418;
const D2R = Math.PI / 180;

// ---------- 全局状态 ----------
const S = {
  objs: [],            // {norad,name,con,cls,type,tle1,tle2,epoch,inc,raan,ecc,argp,M0,n,visible,satrec}
  visibleCount: 0,
  simOffset: 0,        // 相对 baseTime 的秒数
  baseTime: Date.now(),
  rate: 10,
  playing: true,
  selected: null,
  follow: false,
  track: false,
  showOrbit: true,
  station: null,
  filters: new Map(),  // con -> bool
  typeFilter: [true, true, true, true],  // payload/rocket/debris/unknown
  soloCon: null,       // 当前单独显示的星座（null = 全部）
  rowEls: new Map(),   // 分组名 -> DOM
  expanded: new Set(), // 展开的父分组
  customSite: null,
};

const PALETTE = {
  'Starlink': '#37c2ff', 'OneWeb': '#7ee787', '千帆（Qianfan）': '#ffd166',
  '卫星互联网技术试验（中国星网）': '#ff8f6b', 'Kuiper': '#c792ea', 'Iridium': '#9aa7b8',
  'GPS': '#63b3ff', 'Galileo': '#8bd6c6', 'BeiDou': '#ff9ecd', 'GLONASS': '#b0bec5',
  'Globalstar': '#d4c685',
  '遥感系列（Yaogan）': '#f2b8a0', '吉林一号（Jilin-1）': '#c3a6ff', '天目（Tianmu）': '#8fd3ff',
  '高分（Gaofen）': '#a8e6a3', '实践（Shijian）': '#ffcf6b', '天绘（Tianhui）': '#7fd8c8',
  'CENTISPACE 系列': '#e0a3d8', '风云（Fengyun）': '#9fb8ff', '海洋（Haiyang）': '#6fd0e0',
  '中星（ChinaSat）': '#ffa8b8', '亚太卫星（Apstar）': '#d0b48f', '珠海一号': '#b6e07a',
  '其他': '#6f7d8c',
};

// 中文别名 → 分组（供搜索使用）
const CON_ALIAS = {
  '千帆': '千帆（Qianfan）', '垣信': '千帆（Qianfan）', '中国星网': '卫星互联网技术试验（中国星网）',
  '国网': '卫星互联网技术试验（中国星网）', '卫星互联网': '卫星互联网技术试验（中国星网）', '星网': '卫星互联网技术试验（中国星网）',
  '北斗': 'BeiDou', '遥感': '遥感系列（Yaogan）', '吉林': '吉林一号（Jilin-1）', '长光': '吉林一号（Jilin-1）',
  '天目': '天目（Tianmu）', '高分': '高分（Gaofen）', '实践': '实践（Shijian）', '天绘': '天绘（Tianhui）',
  '风云': '风云（Fengyun）', '海洋': '海洋（Haiyang）', '中星': '中星（ChinaSat）', '亚太': '亚太卫星（Apstar）',
  '珠海': '珠海一号', '星链': 'Starlink', '一网': 'OneWeb', '铱星': 'Iridium', '伽利略': 'Galileo',
};

// ---------- 场景 ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 10, 3e6);
let camDist = 5.0 * R_EARTH;
let camYaw = 1.2, camPitch = 0.35, camTarget = new THREE.Vector3(0, 0, 0);

// 地球
const earthGeo = new THREE.SphereGeometry(R_EARTH, 96, 64);
const earthMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
earthMat.emissive = new THREE.Color(0x0c1a28);
earthMat.emissiveIntensity = 1.0;
const earth = new THREE.Mesh(earthGeo, earthMat);
scene.add(earth);
new THREE.TextureLoader().load('./assets/earth.jpg',
  (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    earthMat.map = t; earthMat.needsUpdate = true;
    console.log('earth texture ready', t.image.width + 'x' + t.image.height);
  },
  undefined,
  () => { earthMat.color.set(0x123a5c); console.warn('earth texture failed'); });

// 大气光晕
const glow = new THREE.Mesh(
  new THREE.SphereGeometry(R_EARTH * 1.02, 64, 48),
  new THREE.MeshBasicMaterial({ color: 0x2a6fa8, transparent: true, opacity: 0.12, side: THREE.BackSide })
);
scene.add(glow);

// 星空
(function stars() {
  const N = 4000, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 1.2e6;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = r * s * Math.cos(th); pos[i * 3 + 1] = r * u; pos[i * 3 + 2] = r * s * Math.sin(th);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb4cc, size: 900, sizeAttenuation: true })));
})();

// 太阳光
const sunLight = new THREE.DirectionalLight(0xffffff, 2.1);
scene.add(sunLight);
scene.add(new THREE.AmbientLight(0x2b3a4d, 0.9));

// ---------- 卫星点云 ----------
const MAXP = 40000;
const satGeo = new THREE.BufferGeometry();
const satPos = new Float32Array(MAXP * 3);
const satCol = new Float32Array(MAXP * 3);
satGeo.setAttribute('position', new THREE.BufferAttribute(satPos, 3));
satGeo.setAttribute('color', new THREE.BufferAttribute(satCol, 3));
const satPoints = new THREE.Points(satGeo, new THREE.PointsMaterial({
  size: 2.4, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95
}));
scene.add(satPoints);

// 选中卫星示意模型（自建几何，不依赖第三方资源）
const satModel = new THREE.Group();
(function buildSat() {
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 0.7, 1.4),
    new THREE.MeshLambertMaterial({ color: 0xcfd8e3, emissive: 0x0a1220 }));
  const panelMat = new THREE.MeshLambertMaterial({ color: 0x1b4f8f, emissive: 0x06121f });
  const p1 = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.04, 0.9), panelMat);
  const p2 = p1.clone();
  p1.position.x = -1.9; p2.position.x = 1.9;
  satModel.add(body, p1, p2);
  satModel.visible = false;
  scene.add(satModel);
})();

// 选中卫星标记 + 轨道线
const marker = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 0.012, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffd166 }));
marker.visible = false; scene.add(marker);
const orbitLine = new THREE.Line(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x63e6ff, transparent: true, opacity: 0.85 }));
scene.add(orbitLine);

// 地面站与覆盖圈
const siteMark = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 0.008, 10, 8),
  new THREE.MeshBasicMaterial({ color: 0x35c68a }));
siteMark.visible = false; scene.add(siteMark);
const coverLine = new THREE.Line(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x35c68a, transparent: true, opacity: 0.7 }));
coverLine.visible = false; scene.add(coverLine);

// ---------- 单星覆盖范围（footprint） ----------
const COV = { on: false, minEl: 10, radiusKm: 0, ring: null, cone: null, note: '', mode: 'single', groupMesh: null, groupCount: 0 };

(function initCover() {
  const ringGeo = new THREE.BufferGeometry();
  COV.ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({
    color: 0xd8f6ff, transparent: true, opacity: 1.0, depthWrite: false,
  }));
  COV.ring.visible = false; COV.ring.frustumCulled = false;
  scene.add(COV.ring);

  const coneGeo = new THREE.BufferGeometry();
  COV.cone = new THREE.LineSegments(coneGeo, new THREE.LineBasicMaterial({
    color: 0x9fe8ff, transparent: true, opacity: 0.5,
  }));
  COV.cone.visible = false; COV.cone.frustumCulled = false;
  scene.add(COV.cone);

  COV.cap = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: 0x6fdcff, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
    depthWrite: false,
  }));
  COV.cap.visible = false; COV.cap.frustumCulled = false;
  scene.add(COV.cap);

  COV.dot = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 0.004, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xeaf9ff }));
  COV.dot.visible = false;
  scene.add(COV.dot);
})();

// 由高度与最小仰角求地心角：psi = acos(R/(R+h)·cosε) − ε
function footprintAngle(hKm, elDeg) {
  const eps = elDeg * D2R;
  const r = R_EARTH + hKm;
  const v = R_EARTH / r * Math.cos(eps);
  if (v >= 1) return 0;
  return Math.max(0, Math.acos(v) - eps);
}

// 以星下点为中心、角半径 psi 画圈 + 卫星到圈边的连线
function updateCoverage(tMs) {
  const o = S.selected;
  if (!COV.on || !o) { COV.ring.visible = false; COV.cone.visible = false; COV.cap.visible = false; COV.dot.visible = false; return; }
  const p = exactPos(o, tMs);
  if (!p) { COV.ring.visible = false; COV.cone.visible = false; COV.cap.visible = false; COV.dot.visible = false; return; }
  const r = Math.hypot(p[0], p[1], p[2]);
  const h = r - R_EARTH;
  const psi = footprintAngle(h, COV.minEl);
  COV.radiusKm = R_EARTH * psi;

  // 星下点单位向量
  const ux = p[0] / r, uy = p[1] / r, uz = p[2] / r;
  // 构造与 u 垂直的两个基向量
  let ax = 0, ay = 0, az = 1;
  if (Math.abs(uz) > 0.9) { ax = 1; az = 0; }
  let e1 = [ay * uz - az * uy, az * ux - ax * uz, ax * uy - ay * ux];
  const n1 = Math.hypot(...e1); e1 = e1.map((v) => v / n1);
  const e2 = [uy * e1[2] - uz * e1[1], uz * e1[0] - ux * e1[2], ux * e1[1] - uy * e1[0]];

  const N = 128;
  const ring = new Float32Array(N * 3);
  const cone = new Float32Array(16 * 2 * 3);
  const cosP = Math.cos(psi), sinP = Math.sin(psi);
  const surf = R_EARTH * 1.001;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * 2 * Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    const dx = ux * cosP + (e1[0] * c + e2[0] * s) * sinP;
    const dy = uy * cosP + (e1[1] * c + e2[1] * s) * sinP;
    const dz = uz * cosP + (e1[2] * c + e2[2] * s) * sinP;
    ring[i * 3] = dx * surf; ring[i * 3 + 1] = dy * surf; ring[i * 3 + 2] = dz * surf;
    if (i < 16) {
      cone[i * 6] = p[0]; cone[i * 6 + 1] = p[1]; cone[i * 6 + 2] = p[2];
      cone[i * 6 + 3] = ring[i * 3]; cone[i * 6 + 4] = ring[i * 3 + 1]; cone[i * 6 + 5] = ring[i * 3 + 2];
    }
  }
  COV.ring.geometry.dispose();
  COV.ring.geometry = new THREE.BufferGeometry();
  COV.ring.geometry.setAttribute('position', new THREE.BufferAttribute(ring, 3));
  COV.ring.visible = true;
  COV.cone.geometry.dispose();
  COV.cone.geometry = new THREE.BufferGeometry();
  COV.cone.geometry.setAttribute('position', new THREE.BufferAttribute(cone, 3));
  COV.cone.visible = true;

  // 半球冠填充：以星下点为中心、圈上各点为边
  const capPos = new Float32Array(N * 9);
  const c0x = ux * surf, c0y = uy * surf, c0z = uz * surf;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    capPos[i * 9] = c0x; capPos[i * 9 + 1] = c0y; capPos[i * 9 + 2] = c0z;
    capPos[i * 9 + 3] = ring[i * 3]; capPos[i * 9 + 4] = ring[i * 3 + 1]; capPos[i * 9 + 5] = ring[i * 3 + 2];
    capPos[i * 9 + 6] = ring[j * 3]; capPos[i * 9 + 7] = ring[j * 3 + 1]; capPos[i * 9 + 8] = ring[j * 3 + 2];
  }
  COV.cap.geometry.dispose();
  COV.cap.geometry = new THREE.BufferGeometry();
  COV.cap.geometry.setAttribute('position', new THREE.BufferAttribute(capPos, 3));
  COV.cap.visible = true;
  COV.dot.position.set(c0x, c0y, c0z);
  COV.dot.scale.setScalar(Math.max(1, camDist / (R_EARTH * 0.9)));
  COV.dot.visible = true;

  const el = document.getElementById('coverInfo');
  if (el) {
    el.textContent = `半径 ${COV.radiusKm.toFixed(0)} km · 高度 ${h.toFixed(0)} km · 仰角门限 ${COV.minEl}°`
      + (COV.note ? ` · ${COV.note}` : '');
  }
}

// 整星座覆盖：把所有目标卫星的覆盖冠合并到一个 geometry（低透明度叠加成覆盖带）
const GROUP_CAP_MAX = 500;
const groupMat = new THREE.MeshBasicMaterial({
  color: 0x3fb6ff, transparent: true, opacity: 0.10, side: THREE.DoubleSide,
  depthWrite: false, blending: THREE.AdditiveBlending,
});
const groupLineMat = new THREE.LineBasicMaterial({
  color: 0x9fe8ff, transparent: true, opacity: 0.28, depthWrite: false,
});

function clearCoverageVisuals() {
  COV.on = false;
  COV.ring.visible = false; COV.cone.visible = false; COV.cap.visible = false;
  if (COV.dot) COV.dot.visible = false;
  if (COV.groupMesh) { scene.remove(COV.groupMesh); COV.groupMesh.geometry.dispose(); COV.groupMesh = null; }
  if (COV.groupLines) { scene.remove(COV.groupLines); COV.groupLines.geometry.dispose(); COV.groupLines = null; }
  COV.note = '';
  const btn = document.getElementById('cover');
  if (btn) btn.classList.remove('on');
  const info = document.getElementById('coverInfo');
  if (info) info.textContent = '';
}

function coverTargets() {
  const grp = S.soloCon && !S.soloCon.startsWith('Starlink|') ? S.soloCon
    : (S.soloCon || (S.selected ? S.selected.con : null));
  if (!grp) return { grp: null, list: [] };
  let list = S.objs.filter((o) => o.visible && (o.con === grp || o.key === grp));
  if (!list.length) return { grp, list: [] };
  return { grp, list };
}

function updateGroupCoverage(tMs) {
  if (COV.groupMesh) {
    scene.remove(COV.groupMesh);
    if (COV.groupMesh.material === groupMat) { /* keep shared material */ }
    COV.groupMesh.geometry.dispose();
    COV.groupMesh = null;
  }
  if (COV.groupLines) { scene.remove(COV.groupLines); COV.groupLines.geometry.dispose(); COV.groupLines = null; }
  const { grp, list } = coverTargets();
  const info = document.getElementById('coverInfo');
  if (!grp || !list.length) {
    COV.groupCount = 0;
    if (info) info.textContent = '星座模式：请先在左栏选一个星座分组（点击分组名）';
    return;
  }
  const step = Math.max(1, Math.ceil(list.length / GROUP_CAP_MAX));
  const use = step === 1 ? list : list.filter((_, i) => i % step === 0);
  const N = 96;                       // 每条覆盖圈 96 段，边缘更顺
  const pos = new Float32Array(use.length * N * 9);
  const lpos = new Float32Array(use.length * N * 6);   // 轮廓线段
  const surf = R_EARTH * 1.002;
  let k = 0, lk = 0, rSum = 0;
  for (const o of use) {
    const p = fastPos(o, tMs);
    const r = Math.hypot(p[0], p[1], p[2]);
    const psi = footprintAngle(r - R_EARTH, COV.minEl);
    rSum += R_EARTH * psi;
    const ux = p[0] / r, uy = p[1] / r, uz = p[2] / r;
    let ax = 0, ay = 0, az = 1;
    if (Math.abs(uz) > 0.9) { ax = 1; az = 0; }
    let e1 = [ay * uz - az * uy, az * ux - ax * uz, ax * uy - ay * ux];
    const n1 = Math.hypot(...e1) || 1; e1 = e1.map((v) => v / n1);
    const e2 = [uy * e1[2] - uz * e1[1], uz * e1[0] - ux * e1[2], ux * e1[1] - uy * e1[0]];
    const cosP = Math.cos(psi), sinP = Math.sin(psi);
    const cx = ux * surf, cy2 = uy * surf, cz = uz * surf;
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * 2 * Math.PI;
      const c = Math.cos(th), s2 = Math.sin(th);
      const dx = ux * cosP + (e1[0] * c + e2[0] * s2) * sinP;
      const dy = uy * cosP + (e1[1] * c + e2[1] * s2) * sinP;
      const dz = uz * cosP + (e1[2] * c + e2[2] * s2) * sinP;
      const qx = dx * surf, qy = dy * surf, qz = dz * surf;
      if (i > 0) {
        pos[k++] = cx; pos[k++] = cy2; pos[k++] = cz;
        pos[k++] = px; pos[k++] = py; pos[k++] = pz;
        pos[k++] = qx; pos[k++] = qy; pos[k++] = qz;
        lpos[lk++] = px; lpos[lk++] = py; lpos[lk++] = pz;
        lpos[lk++] = qx; lpos[lk++] = qy; lpos[lk++] = qz;
      }
      px = qx; py = qy; pz = qz;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k), 3));
  COV.groupMesh = new THREE.Mesh(geo, groupMat);
  COV.groupMesh.frustumCulled = false;
  scene.add(COV.groupMesh);

  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.BufferAttribute(lpos.subarray(0, lk), 3));
  COV.groupLines = new THREE.LineSegments(lgeo, groupLineMat);
  COV.groupLines.frustumCulled = false;
  scene.add(COV.groupLines);
  COV.groupCount = use.length;
  if (info) {
    info.textContent = `${grp} · ${use.length.toLocaleString()} 颗覆盖${step > 1 ? `（抽样 1/${step}）` : ''}`
      + ` · 平均半径 ${(rSum / use.length).toFixed(0)} km · 仰角 ${COV.minEl}°`;
  }
}

// ---------- L2 接触图（链路） ----------
const MAXSEG = 6000;
function makeLines(color, opacity) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(MAXSEG * 6);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setDrawRange(0, 0);
  const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const o = new THREE.LineSegments(g, m);
  o.visible = false; o.frustumCulled = false;
  scene.add(o);
  return { geo: g, pos, obj: o };
}
const linkGround = makeLines(0x35c68a, 0.75);
const linkIsl = makeLines(0x4fb6ff, 0.45);

const LK = { on: false, ground: true, isl: true, maxKm: 2000, seg: 0, stat: {} };

function siteArr() {
  const st = S.station;
  if (!st) return null;
  const lo = st.lon * D2R, la = st.lat * D2R;
  return [R_EARTH * Math.cos(la) * Math.cos(lo), R_EARTH * Math.sin(la), -R_EARTH * Math.cos(la) * Math.sin(lo)];
}

// 用场景坐标直接算仰角（同一个地固坐标系）
function elevFromScene(px, py, pz, site) {
  const dx = px - site[0], dy = py - site[1], dz = pz - site[2];
  const d = Math.hypot(dx, dy, dz);
  if (d < 1) return -90;
  const upx = site[0] / R_EARTH, upy = site[1] / R_EARTH, upz = site[2] / R_EARTH;
  return Math.asin((dx * upx + dy * upy + dz * upz) / d) / D2R;
}

function updateLinks() {
  if (!LK.on) { linkGround.obj.visible = false; linkIsl.obj.visible = false; return; }
  let n = 0, ni = 0;
  const gPos = linkGround.pos, iPos = linkIsl.pos;
  const site = siteArr();
  let gCount = 0, gDist = 0;

  // 地面站 ↔ 可见卫星
  if (LK.ground && site) {
    const cand = [];
    for (let i = 0; i < S.objs.length; i++) {
      if (!S.objs[i].visible) continue;
      if (S.objs[i].cls !== 0 && S.objs[i].cls !== 1) continue;   // LEO + MEO（排除 GEO/HEO）
      const px = satPos[i * 3], py = satPos[i * 3 + 1], pz = satPos[i * 3 + 2];
      if (py < -1e5) continue;
      const el = elevFromScene(px, py, pz, site);
      if (el < 10) continue;
      const d = Math.hypot(px - site[0], py - site[1], pz - site[2]);
      cand.push([d, px, py, pz]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [d, px, py, pz] of cand.slice(0, 300)) {
      if (n >= MAXSEG) break;
      gPos[n * 6] = site[0]; gPos[n * 6 + 1] = site[1]; gPos[n * 6 + 2] = site[2];
      gPos[n * 6 + 3] = px; gPos[n * 6 + 4] = py; gPos[n * 6 + 5] = pz;
      n++; gCount++; gDist += d;
    }
  }

  // 星间链路：同星座近邻（网格加速）
  let iCount = 0, iDist = 0;
  if (LK.isl) {
    const pool = [];
    for (let i = 0; i < S.objs.length && pool.length < 900; i++) {
      const o = S.objs[i];
      if (!o.visible || o.cls !== 0 || o.type !== 0) continue;
      if (i % 11 !== 0) continue;                     // 抽样，控制规模
      const px = satPos[i * 3], py = satPos[i * 3 + 1], pz = satPos[i * 3 + 2];
      if (py < -1e5) continue;
      pool.push([px, py, pz, o.con]);
    }
    const cell = LK.maxKm;
    const grid = new Map();
    for (let k = 0; k < pool.length; k++) {
      const [x, y, z] = pool[k];
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(k);
    }
    const linked = new Set();
    for (let k = 0; k < pool.length && n < MAXSEG; k++) {
      const [x, y, z, con] = pool[k];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let cnt = 0;
      for (let dx = -1; dx <= 1 && cnt < 3; dx++)
        for (let dy = -1; dy <= 1 && cnt < 3; dy++)
          for (let dz = -1; dz <= 1 && cnt < 3; dz++) {
            const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!arr) continue;
            for (const j of arr) {
              if (j === k || cnt >= 3) continue;
              const [x2, y2, z2, con2] = pool[j];
              if (con2 !== con) continue;
              const key = k < j ? k + '-' + j : j + '-' + k;
              if (linked.has(key)) continue;
              const d = Math.hypot(x2 - x, y2 - y, z2 - z);
              if (d > LK.maxKm || d < 1) continue;
              linked.add(key);
              if (ni >= MAXSEG) break;
              iPos[ni * 6] = x; iPos[ni * 6 + 1] = y; iPos[ni * 6 + 2] = z;
              iPos[ni * 6 + 3] = x2; iPos[ni * 6 + 4] = y2; iPos[ni * 6 + 5] = z2;
              ni++; iCount++; iDist += d; cnt++;
            }
          }
    }
  }

  LK.seg = n + ni;
  linkGround.geo.attributes.position.needsUpdate = true;
  linkGround.geo.setDrawRange(0, n * 2);
  linkGround.obj.visible = n > 0;
  linkIsl.geo.attributes.position.needsUpdate = true;
  linkIsl.geo.setDrawRange(0, ni * 2);
  linkIsl.obj.visible = ni > 0;

  const avgG = gCount ? gDist / gCount : 0, avgI = iCount ? iDist / iCount : 0;
  LK.stat = { gCount, iCount, avgG, avgI };
  const el = document.getElementById('lkStat');
  if (el) {
    el.innerHTML = site
      ? (gCount === 0
        ? `当前无可见 LEO/MEO 卫星（10° 仰角门限）<br>`
        : `地面→LEO/MEO 链路 <b>${gCount}</b> 条 · 均距 ${avgG.toFixed(0)} km<br>`) + 
        `星间链路 <b>${iCount}</b> 条 · 均距 ${avgI.toFixed(0)} km<br>
         单向时延 ≈ ${(avgI / 299792.458 * 1000).toFixed(1)} ms（星间均值）`
      : `未选择地面站（仅星间）<br>星间链路 <b>${iCount}</b> 条 · 均距 ${avgI.toFixed(0)} km<br>
         单向时延 ≈ ${(avgI / 299792.458 * 1000).toFixed(1)} ms`;
  }
}

// ---------- 星座轨迹（全对象） ----------
const TRK = { on: false, lines: null, pts: 72, limit: 12000, t0: 0 };
const trkMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.035, vertexColors: true, depthWrite: false });

function scheduleTracks() {
  if (!TRK.on) return;
  TRK.pending = true;          // 由主循环消费，避免定时器在高负载下被拖死
}

function clearTracks() {
  if (TRK.lines) {
    scene.remove(TRK.lines);
    TRK.lines.geometry.dispose();
    TRK.lines = null;
  }
}

function buildTracks(tMs) {
  clearTracks();
  if (!TRK.on || !S.objs.length) return;
  const sel = S.objs.filter((o) => o.visible);
  const step = Math.max(1, Math.ceil(sel.length / TRK.limit));
  const list = step === 1 ? sel : sel.filter((_, i) => i % step === 0);
  const N = TRK.pts, segPer = N - 1;
  const verts = list.length * segPer * 2;
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const c = new THREE.Color();
  let k = 0;
  for (const o of list) {
    const periodMs = (1440 / o.n) * 60000;
    c.set(PALETTE[o.con] || PALETTE['其他']);
    let prev = fastPos(o, tMs);
    for (let i = 1; i < N; i++) {
      const cur = fastPos(o, tMs + (i / segPer) * periodMs);
      pos[k * 6] = prev[0]; pos[k * 6 + 1] = prev[1]; pos[k * 6 + 2] = prev[2];
      pos[k * 6 + 3] = cur[0]; pos[k * 6 + 4] = cur[1]; pos[k * 6 + 5] = cur[2];
      col[k * 6] = c.r; col[k * 6 + 1] = c.g; col[k * 6 + 2] = c.b;
      col[k * 6 + 3] = c.r; col[k * 6 + 4] = c.g; col[k * 6 + 5] = c.b;
      k++; prev = cur;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k * 6), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, k * 6), 3));
  // 轨迹条数越少越亮：单星座孤立显示时看得清，全编目时又不糊住地球
  trkMat.opacity = Math.min(0.55, Math.max(0.04, 0.55 * Math.pow(400 / Math.max(1, list.length), 0.6)));
  TRK.lines = new THREE.LineSegments(geo, trkMat);
  TRK.lines.frustumCulled = false;
  scene.add(TRK.lines);
  TRK.t0 = tMs;
  const badge = document.getElementById('trkInfo');
  if (badge) badge.textContent = `${list.length.toLocaleString()} 条轨迹${step > 1 ? `（抽样 1/${step}）` : ''}`;
}


// ---------- 星座资料（公开资料整理，非逐星实测） ----------
const GROUP_INFO = {
  '卫星互联网技术试验（中国星网）': {
    title: '中国星网 GW 星座',
    lines: [
      '运营方：中国卫星网络集团有限公司（2021 成立）',
      '规划：12 992 颗 —— GW-A59 6 080 颗（<500 km）+ GW-A2 6 912 颗（约 1 145 km），倾角 30°–85°',
      'ITU 频轨：2020-09 申报，代号 GW-A59 / GW-1 / GW-2 / GW-S',
      '进度：2024-12 首次组网发射；2026-09 累计约 204–213 颗；2029 年底约 1 300 颗；2035 年建成',
      '验证：2026-10 首次跨南北极视频通话，时延 <1 s，上下行约 30 Mbps',
    ],
    note: '本页在轨数为本地编目（2026-03 快照，试验星命名 HULIANWANG JISHU SHIYAN）；资料据公开报道（中国航天科技集团、央视/腾讯新闻，2026-10）',
  },
  '千帆（Qianfan）': {
    title: '千帆星座（G60 / 上海垣信）',
    lines: [
      '运营方：上海垣信卫星科技有限公司（故也简称「垣信」，搜索「垣信」即命中本组）',
      '规划：约 1.5 万颗，分三期部署，主用 Ku / Q / V 频段',
      '进度：2024-08 首批组网；截至 2026-09-16 累计发射 256 颗（9/15 朱雀二号改遥七 10 颗、9/16 引力一号遥三海上发射 8 颗）；2026 年底目标 324 颗',
      'ITU：公开空间网络库无 QIANFAN / G60 / YUANXIN 申报记录',
    ],
    note: '本地编目仅 108 个 QIANFAN 对象（2026-03 快照），远少于公开累计发射数；缺口来自 CelesTrak 大组刷新受限，待限流解除后重跑 refresh_catalog.py',
  },
  'Starlink': {
    title: 'Starlink（SpaceX）',
    lines: [
      '运营方：SpaceX',
      '规模：已部署上万颗，多壳层（约 340–580 km），含 43°/53°/70°/97° 等倾角批次',
      'ITU：公开空间网络库未收录其申报记录',
    ],
    note: '壳层划分见左侧 Starlink ▸ 展开项（按高度 20 km × 倾角 1°）',
  },
  'BeiDou': {
    title: '北斗（BeiDou）',
    lines: ['运营方：中国卫星导航系统管理办公室', '构型：GEO + IGSO + MEO 混合星座', 'ITU 申报名：BEIDOU / 早期 COMPASS'],
    note: '本页在轨数为本地编目快照',
  },
};

function updateGroupInfo(key) {
  const box = document.getElementById('groupInfo');
  if (!box) return;
  const k = key || S.soloCon;
  const info = k && GROUP_INFO[k];
  if (!info) { box.classList.remove('show'); box.innerHTML = ''; return; }
  const n = S.objs.filter((o) => o.con === k).length;
  box.innerHTML = `<div class="gi-t">${info.title}</div>`
    + info.lines.map((l) => `<div>· ${l}</div>`).join('')
    + `<div style="margin-top:4px;color:#8be0ff">本地在轨：${n.toLocaleString()} 个对象</div>`
    + `<div class="gi-s">${info.note}</div>`;
  box.classList.add('show');
}

// ---------- 数学 ----------
const GMST = (date) => SAT.gstime(date);

function tleElements(tle1, tle2) {
  const yy = +tle1.substr(18, 2), doy = +tle1.substr(20, 12);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const epoch = Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
  return {
    epoch,
    inc: +tle2.substr(8, 8),
    raan: +tle2.substr(17, 8),
    ecc: +('0.' + tle2.substr(26, 7).trim()),
    argp: +tle2.substr(34, 8),
    M0: +tle2.substr(43, 8),
    n: +tle2.substr(52, 11),
  };
}

// 近似递推：开普勒二体（快，用于点云）
function fastPos(o, tMs) {
  const nrad = o.n * 2 * Math.PI / 86400;
  const a = Math.cbrt(MU / (nrad * nrad));
  const M = (o.M0 * D2R + nrad * ((tMs - o.epoch) / 1000)) % (2 * Math.PI);
  let E = M;
  for (let i = 0; i < 3; i++) E = E - (E - o.ecc * Math.sin(E) - M) / (1 - o.ecc * Math.cos(E));
  const xv = a * (Math.cos(E) - o.ecc), yv = a * Math.sqrt(1 - o.ecc * o.ecc) * Math.sin(E);
  const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
  const w = o.argp * D2R, i = o.inc * D2R, O = o.raan * D2R;
  const cv = Math.cos(v + w), sv = Math.sin(v + w);
  const x = r * (Math.cos(O) * cv - Math.sin(O) * sv * Math.cos(i));
  const y = r * (Math.sin(O) * cv + Math.cos(O) * sv * Math.cos(i));
  const z = r * (sv * Math.sin(i));
  const g = GMST(new Date(tMs));
  const cg = Math.cos(g), sg = Math.sin(g);
  const xe = x * cg + y * sg, ye = -x * sg + y * cg;   // ECI → ECEF
  return [xe, z, -ye];                                  // ECEF → three (y 轴向上)
}

// 精确递推（satellite.js SGP4），返回 three 坐标
function exactPos(o, tMs) {
  if (!o.satrec) o.satrec = SAT.twoline2satrec(o.tle1, o.tle2);
  const d = new Date(tMs);
  const pv = SAT.propagate(o.satrec, d);
  if (!pv || !pv.position) return null;
  const g = GMST(d), cg = Math.cos(g), sg = Math.sin(g);
  const { x, y, z } = pv.position;
  const xe = x * cg + y * sg, ye = -x * sg + y * cg;
  return [xe, z, -ye];
}

function geodetic(o, tMs) {
  const p = exactPos(o, tMs);
  if (!p) return null;
  const x = p[0], y = p[2], z = -p[1];   // 回到 ECEF
  const lon = Math.atan2(y, x) / D2R, lat = Math.atan2(z, Math.hypot(x, y)) / D2R;
  return { lon, lat, alt: Math.hypot(x, y, z) - R_EARTH };
}

function siteVec(lonDeg, latDeg, radius) {
  const lo = lonDeg * D2R, la = latDeg * D2R;
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(radius);
}

// ---------- 加载数据 ----------
async function loadCatalog() {
  const res = await fetch('./data/catalog.json.gz');
  const buf = new Uint8Array(await res.arrayBuffer());
  const bar = document.getElementById('pbar');
  bar.style.width = '45%';
  const text = await new Response(
    new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).text();
  bar.style.width = '75%';
  const rows = JSON.parse(text);
  const counts = new Map();
  for (const r of rows) {
    const [norad, name, con, cls, typ, tle1, tle2] = r;
    const el = tleElements(tle1, tle2);
    const o = { norad, name, con: con || '其他', cls, type: typ, tle1, tle2, ...el, visible: true, satrec: null };
    const key = o.con;
    counts.set(key, (counts.get(key) || 0) + 1);
    S.objs.push(o);
  }
  bar.style.width = '100%';
  // 颜色
  const c = new THREE.Color();
  S.objs.forEach((o, i) => {
    c.set(PALETTE[o.con] || PALETTE['其他']);
    satCol[i * 3] = c.r; satCol[i * 3 + 1] = c.g; satCol[i * 3 + 2] = c.b;
    S.filters.set(o.con, true);
  });
  // Starlink 按「高度 20km 桶 × 倾角 1°」拆子壳层；少于 30 颗的并入"其他壳层"
  const SH_MIN = 30;
  const altOf = (o) => {
    const nrad = (o.n || 0) * 2 * Math.PI / 86400;
    if (!nrad) return 0;
    return Math.cbrt(MU / (nrad * nrad)) - R_EARTH;
  };
  const slBucket = (o) => {
    return `${Math.round(altOf(o) / 20) * 20} km / ${Math.round(o.inc || 0)}°`;
  };
  const slCount = new Map();
  for (const o of S.objs) if (o.con === 'Starlink') {
    const k = slBucket(o);
    slCount.set(k, (slCount.get(k) || 0) + 1);
  }
  const slShells = [...slCount.entries()].filter(([, n]) => n >= SH_MIN)
    .sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const shellSet = new Set(slShells);
  S.shells = slShells;
  for (const o of S.objs) {
    if (o.con === 'Starlink') {
      const b = slBucket(o);
      o.sub = shellSet.has(b) ? b : '其他壳层';
      o.key = 'Starlink|' + o.sub;
    } else {
      o.key = o.con;
    }
  }
  satGeo.attributes.color.needsUpdate = true;
  satGeo.setDrawRange(0, S.objs.length);
  buildConstellationList(counts);
  buildTypeChips();
  // 用中位纪元代表"主体编目"的时效；最大值可能是个别刚刷新的分组
  const eps = S.objs.map(o => o.epoch).sort((a, b) => a - b);
  const med = eps[Math.floor(eps.length / 2)] || Date.now();
  const newest = eps[eps.length - 1] || Date.now();
  const d = new Date(med);
  const age = Math.round((Date.now() - med) / 86400000);
  const partial = (newest - med) > 7 * 86400000;
  document.getElementById('catdate').textContent =
    `编目 ${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` +
    ` · ${age} 天前${partial ? '（部分分组已刷新）' : ''}`;
  document.getElementById('loading').style.display = 'none';
}

// ---------- 星座列表 ----------
function buildConstellationList(counts) {
  const box = document.getElementById('cons');
  const order = ['Starlink', 'OneWeb', '千帆（Qianfan）', '卫星互联网技术试验（中国星网）', 'Kuiper',
    'Iridium', 'Globalstar', 'GPS', 'Galileo', 'BeiDou', 'GLONASS',
    '遥感系列（Yaogan）', '吉林一号（Jilin-1）', '高分（Gaofen）', '天目（Tianmu）', '实践（Shijian）',
    '天绘（Tianhui）', '风云（Fengyun）', '海洋（Haiyang）', 'CENTISPACE 系列', '中星（ChinaSat）',
    '亚太卫星（Apstar）', '珠海一号', '其他'];
  const list = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || counts.get(b) - counts.get(a);
  });
  const payCount = new Map(), debrisCount = new Map();
  for (const o of S.objs) {
    const c = o.key || o.con;
    if (o.type === 2 || o.type === 1) debrisCount.set(c, (debrisCount.get(c) || 0) + 1);
    else payCount.set(c, (payCount.get(c) || 0) + 1);
  }
  box.innerHTML = '';
  S.rowEls = new Map();
  S.filters = new Map();

  const addRow = (key, label, n, pay, deb, indent, kids) => {
    const el = document.createElement('div');
    el.className = 'row' + (indent ? ' sub' : '');
    el.title = deb ? `载荷 ${pay} · 碎片/箭体 ${deb} · 合计 ${n}` : `合计 ${n}`;
    const caret = kids ? `<span class="caret">${S.expanded.has(key) ? '▾' : '▸'}</span>` : '';
    el.innerHTML = `${caret}<span class="dot" style="background:${PALETTE[key.split('|')[0]] || PALETTE['其他']}"></span>
      <span class="nm">${label}</span><span class="ct">${pay.toLocaleString()}${deb ? '*' : ''}</span>`;
    el.onclick = (ev) => {
      if (ev.target.classList.contains('caret')) {
        ev.stopPropagation();
        if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
        buildConstellationList(counts);
        return;
      }
      onGroupClick(key, ev);
    };
    S.rowEls.set(key, el);
    S.filters.set(key, true);
    box.appendChild(el);
  };

  const conPay = new Map(), conDeb = new Map();
  for (const o of S.objs) {
    if (o.type === 2 || o.type === 1) conDeb.set(o.con, (conDeb.get(o.con) || 0) + 1);
    else conPay.set(o.con, (conPay.get(o.con) || 0) + 1);
  }
  for (const k of list) {
    const n = counts.get(k);
    if (n < 3) continue;
    const pay = conPay.get(k) || 0, deb = conDeb.get(k) || 0;
    const isSL = k === 'Starlink' && S.shells;
    const kids = [];
    if (isSL) {
      for (const sub of S.shells.concat(['其他壳层'])) {
        const key = 'Starlink|' + sub;
        const rows = S.objs.filter((o) => o.key === key);
        if (!rows.length) continue;
        const sp = rows.filter((o) => o.type !== 1 && o.type !== 2).length;
        kids.push([key, sub, rows.length, sp, rows.length - sp]);
        S.filters.set(key, true);          // 折叠时也要有状态
      }
    }
    addRow(k, k, n, pay, deb, false, kids.length);
    if (isSL && S.expanded.has(k)) {
      for (const [key, sub, sn, sp, sd] of kids) addRow(key, sub, sn, sp, sd, true);
    }
  }
  syncConRows();
}

function onGroupClick(key, ev) {
  const multi = ev.metaKey || ev.ctrlKey || ev.shiftKey;
  if (multi) {
    S.soloCon = null;
    S.filters.set(key, !S.filters.get(key));
  } else if (S.soloCon === key) {
    S.soloCon = null;
    for (const k of S.filters.keys()) S.filters.set(k, true);
  } else {
    S.soloCon = key;
    for (const k of S.filters.keys()) S.filters.set(k, false);
    if (key === 'Starlink') {
      S.filters.set('Starlink', true);
      for (const k of S.filters.keys()) if (k.startsWith('Starlink|')) S.filters.set(k, true);
    } else if (key.startsWith('Starlink|')) {
      S.filters.set('Starlink', true);
      S.filters.set(key, true);
    } else {
      S.filters.set(key, true);
    }
  }
  syncConRows();
  scheduleTracks();
  updateGroupInfo(S.soloCon);
  if (COV.on && COV.mode === 'group') updateGroupCoverage(simTime());
}

// 把过滤状态同步到左侧行样式，并标注"单独显示"
function syncConRows() {
  const slOn = [...S.filters.entries()].some(([k, v]) => k.startsWith('Starlink|') && v !== false);
  for (const [k, el] of S.rowEls) {
    let on = S.filters.get(k) !== false;
    if (k === 'Starlink') on = slOn;
    el.classList.toggle('off', !on);
    el.classList.toggle('solo', S.soloCon === k);
  }
}

// ---------- 对象类型过滤 ----------
const TYPE_NAMES = ['载荷', '火箭体', '碎片', '未知'];
const TYPE_COLORS = ['#7ac6ff', '#c8b27a', '#9aa7b8', '#5d6874'];
function buildTypeChips() {
  const box = document.getElementById('types');
  const counts = [0, 0, 0, 0];
  S.objs.forEach(o => counts[o.type >= 0 && o.type <= 3 ? o.type : 3]++);
  box.innerHTML = '';
  TYPE_NAMES.forEach((nm, i) => {
    const el = document.createElement('div');
    el.className = 'tchip';
    el.innerHTML = `<span class="dot" style="width:7px;height:7px;border-radius:50%;background:${TYPE_COLORS[i]}"></span>${nm} ${counts[i].toLocaleString()}`;
    el.onclick = () => {
      S.typeFilter[i] = !S.typeFilter[i];
      el.classList.toggle('off', !S.typeFilter[i]);
      scheduleTracks();
    };
    box.appendChild(el);
  });
}

// ---------- 搜索 ----------
const qEl = document.getElementById('q'), resEl = document.getElementById('results');
qEl.addEventListener('input', () => {
  const q = qEl.value.trim().toUpperCase();
  resEl.innerHTML = '';
  if (!q) return;
  let hit = 0;
  const alias = Object.keys(CON_ALIAS).find((k) => k.includes(qEl.value.trim()));
  const aliasGroup = alias ? CON_ALIAS[alias] : null;
  let total = 0;
  for (const o of S.objs) {
    const m = o.name.toUpperCase().includes(q) || String(o.norad) === q || (aliasGroup && o.con === aliasGroup);
    if (!m) continue;
    total++;
    if (hit >= 60) continue;
    const d = document.createElement('div');
    d.className = 'r';
    d.innerHTML = `${o.name}<div class="sub">${o.norad} · ${o.con}</div>`;
    d.onclick = () => select(o);
    resEl.appendChild(d);
    hit++;
  }
  if (!hit) { resEl.innerHTML = '<div class="r" style="color:#66707d">无匹配</div>'; return; }
  if (total > hit) {
    const tip = document.createElement('div');
    tip.className = 'r';
    tip.style.color = '#66707d';
    tip.textContent = `命中 ${total.toLocaleString()} 条，仅显示前 ${hit} 条`;
    resEl.appendChild(tip);
  }
});

// ---------- 选中 ----------
function select(o) {
  S.selected = o;
  COV.note = '';
  const p = exactPos(o, simTime());
  if (p) { marker.position.set(p[0], p[1], p[2]); marker.visible = true; }
  document.getElementById('right').classList.add('show');
  document.getElementById('oName').textContent = o.name || '—';
  document.getElementById('oId').textContent = `NORAD ${o.norad} · ${o.con}`;
  updateInfo();
  updateOrbitLine();
  if (COV.on) updateCoverage(simTime());
  updatePasses();
  updateGroupInfo(S.soloCon || o.con);
}

function updateInfo() {
  const o = S.selected; if (!o) return;
  const t = simTime();
  const p = exactPos(o, t);
  const alt = p ? Math.hypot(p[0], p[1], p[2]) - R_EARTH : 0;
  const gd = geodetic(o, t) || { lon: 0, lat: 0 };
  const ageDays = ((Date.now() - o.epoch) / 86400000).toFixed(0);
  const rows = [
    ['轨道类型', ['LEO', 'MEO', 'GEO', 'HEO', '—'][o.cls] ?? '—'],
    ['高度', `${alt.toFixed(0)} km`],
    ['倾角', `${o.inc.toFixed(2)}°`],
    ['周期', `${(1440 / o.n).toFixed(1)} min`],
    ['偏心率', o.ecc.toFixed(5)],
    ['星下点', `${gd.lat.toFixed(2)}°, ${gd.lon.toFixed(2)}°`],
    ['TLE 年龄', `${ageDays} 天`],
  ];
  document.getElementById('oKv').innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('');
}

// ---------- 轨道线 ----------
function updateOrbitLine() {
  const o = S.selected;
  if (!o || !S.showOrbit || COV.on) { orbitLine.visible = false; return; }
  const t0 = simTime();
  const stepMs = (1440 / o.n) * 60000 / 160;
  const pts = [];
  for (let i = 0; i <= 160; i++) {
    const p = exactPos(o, t0 + i * stepMs);
    if (!p) continue;
    pts.push(new THREE.Vector3(p[0], p[1], p[2]));
  }
  orbitLine.geometry.dispose();
  orbitLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  orbitLine.visible = true;
}

// ---------- 地面站 ----------
const SITES = [
  ['北京', 116.4, 39.9], ['上海', 121.5, 31.2], ['西安', 108.9, 34.3],
  ['三亚', 109.5, 18.3], ['乌鲁木齐', 87.6, 43.8], ['拉萨', 91.1, 29.7],
  ['漠河', 122.5, 52.9], ['南沙', 114.2, 10.4],
];
const stEl = document.getElementById('station');
stEl.innerHTML = '<option value="">（未选择地面站）</option>' +
  SITES.map((s, i) => `<option value="${i}">${s[0]} ${s[1]}°E ${s[2]}°N</option>`).join('') +
  '<option value="custom">自定义经纬度…</option>';
stEl.onchange = () => {
  const cs = document.getElementById('customSite');
  if (stEl.value === 'custom') {
    cs.classList.add('show');
    applyCustomSite();
    return;
  }
  cs.classList.remove('show');
  if (stEl.value === '') { S.station = null; siteMark.visible = false; coverLine.visible = false; updatePasses(); return; }
  const s = SITES[+stEl.value];
  S.station = { name: s[0], lon: s[1], lat: s[2] };
  siteMark.position.copy(siteVec(s[1], s[2], R_EARTH * 1.001));
  siteMark.visible = true;
  drawCoverage();
  updatePasses();
};

function drawCoverage() {
  const s = S.station; if (!s) return;
  const el = 10 * D2R;
  const h = 550;                                     // 典型 LEO 高度
  const psi = Math.acos(R_EARTH / (R_EARTH + h) * Math.cos(el)) - el;
  const pts = [];
  const la0 = s.lat * D2R, lo0 = s.lon * D2R;
  for (let i = 0; i <= 180; i++) {
    const b = i / 180 * 2 * Math.PI;
    const la = Math.asin(Math.sin(la0) * Math.cos(psi) + Math.cos(la0) * Math.sin(psi) * Math.cos(b));
    const lo = lo0 + Math.atan2(Math.sin(b) * Math.sin(psi) * Math.cos(la0), Math.cos(psi) - Math.sin(la0) * Math.sin(la));
    const v = siteVec(lo / D2R, la / D2R, R_EARTH * 1.002);
    pts.push(v);
  }
  coverLine.geometry.dispose();
  coverLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  coverLine.visible = true;
}

function applyCustomSite() {
  const lon = parseFloat(document.getElementById('csLon').value);
  const lat = parseFloat(document.getElementById('csLat').value);
  if (!isFinite(lon) || !isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  S.station = { name: `自定义 ${lon.toFixed(1)}°E ${lat.toFixed(1)}°N`, lon, lat };
  siteMark.position.copy(siteVec(lon, lat, R_EARTH * 1.001));
  siteMark.visible = true;
  drawCoverage();
  updatePasses();
}
['csLon', 'csLat'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', applyCustomSite);
});

// ---------- 过境 ----------
function elevation(o, s, tMs) {
  const g = SAT.gstime(new Date(tMs));
  const gd = SAT.eciToGeodetic(SAT.propagate(o.satrec || (o.satrec = SAT.twoline2satrec(o.tle1, o.tle2)), new Date(tMs)).position, g);
  const la = gd.latitude, lo = gd.longitude, r = R_EARTH + gd.height;
  const rx = r * Math.cos(la) * Math.cos(lo), ry = r * Math.cos(la) * Math.sin(lo), rz = r * Math.sin(la);
  const sx = R_EARTH * Math.cos(s.lat * D2R) * Math.cos(s.lon * D2R);
  const sy = R_EARTH * Math.cos(s.lat * D2R) * Math.sin(s.lon * D2R);
  const sz = R_EARTH * Math.sin(s.lat * D2R);
  const dx = rx - sx, dy = ry - sy, dz = rz - sz;
  const up = (dx * Math.cos(s.lat * D2R) * Math.cos(s.lon * D2R) +
              dy * Math.cos(s.lat * D2R) * Math.sin(s.lon * D2R) + dz * Math.sin(s.lat * D2R));
  return Math.asin(up / Math.hypot(dx, dy, dz)) / D2R;
}

function updatePasses() {
  const box = document.getElementById('passes');
  const o = S.selected, s = S.station;
  if (!o || !s) { box.innerHTML = '<div style="color:#66707d">选中卫星并选择地面站</div>'; return; }
  box.innerHTML = '<div style="color:#66707d">计算中…</div>';
  setTimeout(() => {
    const t0 = Date.now(), step = 30000, span = 24 * 3600e3;
    const out = [];
    let inPass = false, start = 0, maxEl = 0, maxT = 0;
    for (let t = t0; t <= t0 + span; t += step) {
      const e = elevation(o, s, t);
      if (e >= 10 && !inPass) { inPass = true; start = t; maxEl = e; maxT = t; }
      else if (e >= 10 && inPass) { if (e > maxEl) { maxEl = e; maxT = t; } }
      else if (e < 10 && inPass) { inPass = false; out.push([start, maxT, t, maxEl]); }
      if (out.length >= 8) break;
    }
    if (inPass) out.push([start, maxT, t0 + span, maxEl]);
    box.innerHTML = out.length ? out.map(([a, m, b, mx]) => {
      const f = (x) => new Date(x).toLocaleTimeString('zh-CN', { hour12: false });
      return `<div><span>${f(a)} → ${f(b)}</span><span>最高 ${mx.toFixed(0)}°</span></div>`;
    }).join('') : '<div style="color:#66707d">24 小时内无 ≥10° 过境</div>';
  }, 20);
}

// ---------- 时间 ----------
const sliderEl = document.getElementById('tslider');
function simTime() { return S.baseTime + S.simOffset * 1000; }
function fmt(t) {
  return new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
document.getElementById('play').onclick = (e) => {
  S.playing = !S.playing;
  e.target.textContent = S.playing ? '暂停' : '继续';
};
document.getElementById('rate').onchange = (e) => { S.rate = +e.target.value; };
sliderEl.oninput = (e) => { S.simOffset = +e.target.value; };
document.getElementById('now').onclick = () => {
  S.baseTime = Date.now(); S.simOffset = 0; sliderEl.value = 0;
};
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement.id !== 'q') {
    e.preventDefault(); document.getElementById('play').click();
  }
});

// ---------- 相机交互（鼠标 / 触摸 / 键盘） ----------
let camDistTarget = camDist;
let dragging = false, dragButton = 0, dragMoved = 0;
let lastX = 0, lastY = 0;
const pointers = new Map();      // 多点触控
let pinchStart = 0, pinchDist0 = 0;

function pickAt(clientX, clientY, tol = 14) {
  if (!S.objs.length) return null;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  let best = null, bestD = tol;
  const v = new THREE.Vector3();
  const t = simTime();
  for (const o of S.objs) {
    if (!o.visible) continue;
    const p = fastPos(o, t);
    v.set(p[0], p[1], p[2]).project(camera);
    if (v.z > 1) continue;
    const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
    const d = Math.hypot(sx - mx, sy - my);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

canvas.style.cursor = 'grab';
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = camDistTarget;
    pinchDist0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    dragging = false;
    return;
  }
  dragging = true; dragButton = e.button; dragMoved = 0;
  lastX = e.clientX; lastY = e.clientY;
  canvas.style.cursor = e.button === 2 ? 'ns-resize' : 'grabbing';
});

addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    camDistTarget = clampDist(pinchStart * (pinchDist0 / d));
    return;
  }
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);

  if (dragButton === 2) {
    // 右键拖动 = 缩放
    camDistTarget = clampDist(camDistTarget * Math.exp(dy * 0.006));
    return;
  }
  camYaw -= dx * 0.005;
  camPitch = Math.max(-1.45, Math.min(1.45, camPitch + dy * 0.005));
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!dragging) return;
  dragging = false;
  canvas.style.cursor = 'grab';
  // 位移小于阈值视为点击
  if (dragMoved < 6 && dragButton === 0) {
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) select(hit);
  }
}
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);

function clampDist(d) {
  return Math.max(R_EARTH * 0.12, Math.min(R_EARTH * 30, d));
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // 触控板双指滑动 deltaY 很小，鼠标滚轮步长大；统一用指数缩放
  const k = e.deltaMode === 1 ? 0.05 : 0.0015;
  camDistTarget = clampDist(camDistTarget * Math.exp(e.deltaY * k));
}, { passive: false });

// 双击：命中卫星则选中并跟随，命中空白则回到全球视角
canvas.addEventListener('dblclick', (e) => {
  const hit = pickAt(e.clientX, e.clientY);
  if (hit) {
    select(hit);
    S.follow = true;
    document.getElementById('follow').classList.add('on');
    camDistTarget = clampDist(R_EARTH * 0.6);
  } else {
    camDistTarget = clampDist(R_EARTH * 5);
  }
});

// 键盘：方向键旋转、+/- 缩放
addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
  const step = 0.08;
  if (e.key === 'ArrowLeft') camYaw += step;
  else if (e.key === 'ArrowRight') camYaw -= step;
  else if (e.key === 'ArrowUp') camPitch = Math.min(1.45, camPitch + step);
  else if (e.key === 'ArrowDown') camPitch = Math.max(-1.45, camPitch - step);
  else if (e.key === '+' || e.key === '=') camDistTarget = clampDist(camDistTarget * 0.85);
  else if (e.key === '-' || e.key === '_') camDistTarget = clampDist(camDistTarget * 1.18);
  else return;
  e.preventDefault();
});

document.getElementById('follow').onclick = (e) => {
  S.follow = !S.follow; e.target.classList.toggle('on', S.follow);
};
document.getElementById('track').onclick = (e) => {
  S.track = !S.track; e.target.classList.toggle('on', S.track);
  if (S.track) { camDist = R_EARTH * 0.05; camDistTarget = camDist; }
};
document.getElementById('orbit').onclick = (e) => {
  S.showOrbit = !S.showOrbit; e.target.classList.toggle('on', S.showOrbit);
  updateOrbitLine();
};
// 默认开启两个
document.getElementById('follow').classList.add('on'); S.follow = true;
document.getElementById('orbit').classList.add('on');

// 操作指南
function showGuide(show) {
  document.getElementById('guide').classList.toggle('show', show);
  if (show) localStorage.setItem('guideSeen', '1');
}
document.getElementById('guideBtn').onclick = () => showGuide(true);
document.getElementById('guideClose').onclick = () => showGuide(false);
document.getElementById('guide').onclick = (e) => {
  if (e.target.id === 'guide') showGuide(false);
};
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') showGuide(false);
});

// 关于弹窗
document.getElementById('about').onclick = () => document.getElementById('modal').classList.add('show');
document.getElementById('closeAbout').onclick = () => document.getElementById('modal').classList.remove('show');
document.getElementById('modal').onclick = (e) => {
  if (e.target.id === 'modal') e.target.classList.remove('show');
};
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('modal').classList.remove('show');
  if (e.key === 'r' && document.activeElement.tagName !== 'INPUT') {
    camDist = 5.0 * R_EARTH; camDistTarget = camDist; camPitch = 0.35; S.follow = false; S.track = false;
    document.getElementById('follow').classList.remove('on');
    document.getElementById('track').classList.remove('on');
  }
});

document.getElementById('trkAll').onchange = (e) => {
  TRK.on = e.target.checked;
  if (TRK.on) {
    clearCoverageVisuals();          // 与覆盖范围互斥（含星座模式的合并网格）
    buildTracks(simTime());
  } else clearTracks();
};

document.getElementById('cover').onclick = (e) => {
  COV.on = !COV.on;
  e.target.classList.toggle('on', COV.on);
  if (COV.on) {
    // 与轨迹互斥
    TRK.on = false;
    document.getElementById('trkAll').checked = false;
    clearTracks();
    document.getElementById('trkInfo').textContent = '';
    orbitLine.visible = false;
    if (COV.mode === 'group') {
      // 星座模式要看整个半球：太近就退到 3R（单星模式才拉近）
      if (camDist < R_EARTH * 2.6) { camDist = R_EARTH * 3; camDistTarget = camDist; }
      updateGroupCoverage(simTime());
      return;
    }
    if (camDist > R_EARTH * 3) { camDist = R_EARTH * 2.2; camDistTarget = camDist; }   // 拉近到能看清覆盖圈
    if (!S.selected) {
      // 没选中就自动挑一颗有代表性的在役卫星：优先星链 LEO 载荷 → 任意 LEO 载荷 → 任意可见
      const isLEO = (o) => o.cls === 0 && o.type === 0;
      const cand = S.objs.find((o) => o.visible && o.con === 'Starlink' && isLEO(o))
        || S.objs.find((o) => o.visible && isLEO(o))
        || S.objs.find((o) => o.visible);
      if (cand) {
        select(cand);
        S._coverAuto = true;
      }
    }
    if (S.selected) {
      S.follow = true;
      updateCoverage(simTime());
      if (S._coverAuto) {
        COV.note = `已自动选中 ${S.selected.name}`;
        S._coverAuto = false;
        setTimeout(() => { COV.note = ''; }, 8000);
      }
    } else {
      document.getElementById('coverInfo').textContent = '当前没有可见卫星，先调整左侧筛选或搜索一颗';
    }
  } else {
    clearCoverageVisuals();
    if (S.selected && S.showOrbit) updateOrbitLine();
  }
};

document.getElementById('coverScope').onchange = (e) => {
  COV.mode = e.target.value;
  if (!COV.on) return;
  if (COV.mode === 'group') {
    // 切到星座模式：清掉单星图形
    COV.ring.visible = false; COV.cone.visible = false; COV.cap.visible = false; COV.dot.visible = false;
    if (camDist < R_EARTH * 2.6) { camDist = R_EARTH * 3; camDistTarget = camDist; }
    updateGroupCoverage(simTime());
  } else {
    if (COV.groupMesh) { scene.remove(COV.groupMesh); COV.groupMesh.geometry.dispose(); COV.groupMesh = null; }
    if (COV.groupLines) { scene.remove(COV.groupLines); COV.groupLines.geometry.dispose(); COV.groupLines = null; }
    if (!S.selected) {
      const cand = S.objs.find((o) => o.visible && o.con === 'Starlink' && o.cls === 0 && o.type === 0)
        || S.objs.find((o) => o.visible && o.cls === 0 && o.type === 0) || S.objs.find((o) => o.visible);
      if (cand) select(cand);
    }
    updateCoverage(simTime());
  }
};

document.getElementById('minEl').onchange = (e) => {
  COV.minEl = +e.target.value;
  if (!COV.on) return;
  if (COV.mode === 'group') updateGroupCoverage(simTime()); else updateCoverage(simTime());
};

// ---------- 链路面板 ----------
document.getElementById('linkBtn').onclick = (e) => {
  LK.on = !LK.on;
  document.getElementById('linkPanel').classList.toggle('show', LK.on);
  e.target.classList.toggle('on', LK.on);
  if (LK.on) updateLinks(); else { linkGround.obj.visible = false; linkIsl.obj.visible = false; }
};
document.getElementById('linkClose').onclick = () => {
  LK.on = false;
  document.getElementById('linkPanel').classList.remove('show');
  document.getElementById('linkBtn').classList.remove('on');
  linkGround.obj.visible = false; linkIsl.obj.visible = false;
};
document.getElementById('lkGround').onchange = (e) => { LK.ground = e.target.checked; updateLinks(); };
document.getElementById('lkIsl').onchange = (e) => { LK.isl = e.target.checked; updateLinks(); };
document.getElementById('lkMax').onchange = (e) => {
  LK.maxKm = Math.max(200, Math.min(8000, +e.target.value || 2000));
  e.target.value = LK.maxKm; updateLinks();
};

// ---------- ITU 申报抽屉 ----------
const ITU = { rows: null, loaded: false, loading: false, q: '', adm: '' };
const ITU_MATCH = {
  'Starlink': ['STARLINK'], 'OneWeb': ['ONEWEB'], 'Kuiper': ['KUIPER'],
  '千帆（Qianfan）': ['QIANFAN'], '卫星互联网技术试验（中国星网）': ['GW', 'HULIANWANG'],
  'Iridium': ['IRIDIUM'], 'Globalstar': ['GLOBALSTAR'], 'GPS': ['NAVSTAR', 'GPS '],
  'Galileo': ['GSAT', 'GALILEO'], 'BeiDou': ['BEIDOU', 'COMPASS'], 'GLONASS': ['GLONASS'],
};

async function loadItu() {
  if (ITU.loaded || ITU.loading) return;
  ITU.loading = true;
  document.getElementById('ituCards').innerHTML = '<div class="id-card"><div class="k">状态</div><div class="v" style="font-size:13px">加载中…</div></div>';
  const res = await fetch('./data/itu.json.gz');
  const buf = new Uint8Array(await res.arrayBuffer());
  const txt = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  ITU.rows = JSON.parse(txt);
  ITU.loaded = ITU.loading = false;
  renderItuStats();
  renderItuList();
}

function renderItuStats() {
  const R = ITU.rows || [];
  const admCount = new Map();
  let geo = 0, ymin = 9999, ymax = 0;
  for (const r of R) {
    admCount.set(r[0], (admCount.get(r[0]) || 0) + 1);
    if (r[5] === 1) geo++;
    const y = r[3] && r[3].slice(-4);
    if (y && +y > 1900) { ymin = Math.min(ymin, +y); ymax = Math.max(ymax, +y); }
  }
  const cards = [
    ['申报记录', R.length.toLocaleString()],
    ['主管机构', admCount.size],
    ['GEO / NGSO', `${geo.toLocaleString()} / ${(R.length - geo).toLocaleString()}`],
    ['年份跨度', `${ymin}–${ymax}`],
  ];
  document.getElementById('ituCards').innerHTML = cards
    .map(([k, v]) => `<div class="id-card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const top = [...admCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = top[0] ? top[0][1] : 1;
  document.getElementById('ituBars').innerHTML = top.map(([k, v]) =>
    `<div><span>${k}</span><span class="bar2" style="width:${v / max * 100}%"></span><span style="text-align:right;color:#8695a8">${v.toLocaleString()}</span></div>`).join('');

  // 名称匹配（严格前缀，不做臆测映射）
  const boxes = [];
  for (const [con, keys] of Object.entries(ITU_MATCH)) {
    let n = 0;
    for (const r of R) {
      const nm = (r[2] || '').toUpperCase();
      if (keys.some((k) => nm.startsWith(k))) n++;
    }
    boxes.push([con, n]);
  }
  document.getElementById('ituMatch').innerHTML = boxes
    .map(([c, n]) => `<div><span>${c}</span><span style="color:${n ? '#35c68a' : '#6f7d8c'}">${n ? n + ' 条' : '无记录'}</span></div>`).join('');
}

function renderItuList() {
  const R = ITU.rows || [];
  const q = ITU.q.trim().toUpperCase();
  const box = document.getElementById('ituList');
  if (!q) { box.innerHTML = '<div style="color:#66707d;display:block;padding:6px 0">输入关键字检索（如 GW、ONEWEB、CHN）</div>'; return; }
  const out = [];
  for (const r of R) {
    if (out.length >= 120) break;
    if ((r[2] || '').toUpperCase().includes(q) || (r[0] || '').toUpperCase().includes(q) || (r[1] || '').toUpperCase().includes(q)) {
      out.push(r);
    }
  }
  box.innerHTML = out.length ? out.map((r) =>
    `<div><span>${r[0]}</span><span class="n" title="${r[2]}">${r[2] || '—'}</span><span style="color:#8695a8">${r[3] || '—'}</span><span style="color:#8695a8">${r[5] ? 'GEO' : 'NGSO'}</span></div>`).join('')
    : '<div style="color:#66707d;display:block;padding:6px 0">无匹配</div>';
}

document.getElementById('ituBtn').onclick = () => {
  document.getElementById('ituDrawer').classList.add('show');
  loadItu();
};
document.getElementById('ituClose').onclick = () => document.getElementById('ituDrawer').classList.remove('show');
document.getElementById('ituQ').oninput = (e) => { ITU.q = e.target.value; renderItuList(); };

// ---------- 主循环 ----------
let last = performance.now(), acc = 0, frames = 0, fps = 0;
function tick(now) {
  const dt = (now - last) / 1000; last = now;
  if (S.playing) {
    S.simOffset += dt * S.rate;
    S.simOffset = Math.max(-86400, Math.min(86400, S.simOffset));
    sliderEl.value = S.simOffset;
  }
  const tMs = simTime();

  // 更新点云（限 20 Hz，降低 CPU 占用）
  let n = S.visibleCount;
  const needUpdate = !S._lastPos || (now - S._lastPos) > 50 || Math.abs(S.rate) > 100;
  if (needUpdate) {
  S._lastPos = now;
  n = 0;
  for (let i = 0; i < S.objs.length; i++) {
    const o = S.objs[i];
    o.visible = S.filters.get(o.con) !== false
      && (o.con === 'Starlink' ? S.filters.get(o.key) !== false : true)
      && S.typeFilter[o.type >= 0 && o.type <= 3 ? o.type : 3];
    if (!o.visible) { satPos[i * 3] = 0; satPos[i * 3 + 1] = -2e6; satPos[i * 3 + 2] = 0; continue; }
    const p = fastPos(o, tMs);
    satPos[i * 3] = p[0]; satPos[i * 3 + 1] = p[1]; satPos[i * 3 + 2] = p[2];
    n++;
  }
  S.visibleCount = n;
  satGeo.attributes.position.needsUpdate = true;
  }

  // 选中目标
  if (S.selected) {
    const p = exactPos(S.selected, tMs);
    if (p) {
      marker.position.set(p[0], p[1], p[2]);
      marker.visible = camDist > R_EARTH * 0.35;
      const ms = Math.max(camDist * 0.004, 4);
      marker.scale.setScalar(ms / (R_EARTH * 0.012));
      satModel.position.set(p[0], p[1], p[2]);
      satModel.visible = camDist < R_EARTH * 0.6;
      const s2 = Math.max(camDist * 0.025, 6);
      satModel.scale.setScalar(s2);
      satModel.lookAt(camera.position);
      if (S.follow || S.track) camTarget.set(p[0], p[1], p[2]);
    }
    updateInfo();
    if (S.showOrbit && Math.floor(tMs / 2000) !== Math.floor((tMs - dt * 1000 * S.rate) / 2000)) updateOrbitLine();
  } else {
    camTarget.lerp(new THREE.Vector3(0, 0, 0), 0.08);
  }

  // 相机（距离平滑插值，避免滚轮跳跃）
  camDist += (camDistTarget - camDist) * 0.18;
  const cy = Math.cos(camPitch), sy2 = Math.sin(camPitch);
  camera.position.set(
    camTarget.x + camDist * cy * Math.cos(camYaw),
    camTarget.y + camDist * sy2,
    camTarget.z + camDist * cy * Math.sin(camYaw)
  );
  camera.lookAt(camTarget);
  earth.position.set(0, 0, 0);

  // 太阳方向（低精度解析式）：ECI → ECEF → 场景
  const jd = tMs / 86400000 + 2440587.5;
  const nS = jd - 2451545.0;
  const L = ((280.460 + 0.9856474 * nS) % 360) * D2R;
  const gS = ((357.528 + 0.9856003 * nS) % 360) * D2R;
  const lam = L + (1.915 * Math.sin(gS) + 0.020 * Math.sin(2 * gS)) * D2R;
  const eps = 23.439 * D2R;
  const ex = Math.cos(lam), ey = Math.cos(eps) * Math.sin(lam), ez = Math.sin(eps) * Math.sin(lam);
  const gm = GMST(new Date(tMs)), cg = Math.cos(gm), sg = Math.sin(gm);
  const sunEcef = [ex * cg + ey * sg, -ex * sg + ey * cg, ez];
  sunLight.position.set(sunEcef[0], sunEcef[2], -sunEcef[1]).normalize().multiplyScalar(1e6);
  if (!S.camInit) {
    S.camInit = true;
    camYaw = Math.atan2(-sunEcef[1], sunEcef[0]);
    camPitch = 0.35;
  }

  // 轨迹：过滤变化（pending）或时间跳变 > 10 分钟时重建
  if (TRK.on && (TRK.pending || Math.abs(tMs - TRK.t0) > 600000)) {
    TRK.pending = false;
    buildTracks(tMs);
  }

  // 覆盖范围（1 Hz，跟随星下点移动）
  if (COV.on && (!S._lastCov || now - S._lastCov > 1000)) {
    S._lastCov = now;
    if (COV.mode === 'group') updateGroupCoverage(tMs);
    else if (S.selected) updateCoverage(tMs);
  }

  // 链路（1 Hz）
  if (LK.on && (!S._lastLink || now - S._lastLink > 1000)) {
    S._lastLink = now;
    updateLinks();
  }

  // 统计
  acc += dt; frames++;
  if (acc > 0.5) { fps = Math.round(frames / acc); acc = 0; frames = 0; }
  document.getElementById('stat').textContent =
    `${S.objs.length.toLocaleString()} 个对象 · 显示 ${n.toLocaleString()} · ${fps} fps`;
  document.getElementById('time').textContent = fmt(tMs);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------- 启动 ----------
window.__dbg = { earth, earthMat, sunLight, scene, camera, S, THREE, TRK, buildTracks, scheduleTracks, LK, linkGround, linkIsl, COV, updateGroupInfo, simTime };
resize();
loadCatalog().then(() => {
  requestAnimationFrame(tick);
  if (!localStorage.getItem('guideSeen')) setTimeout(() => showGuide(true), 900);
});
