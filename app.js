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
const COV = { on: false, minEl: 10, radiusKm: 0, ring: null, cone: null, note: '', mode: 'single', groupMesh: null, groupCount: 0, groupSig: null, groupDirty: false, groupT0: 0 };

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
// 上限 3 000：每颗 64 段，3 000 颗 = 1.7 M 顶点（约 7 MB），一次构建几十毫秒。
// 早期为 500 / 96 段且每 1 Hz 重建，导致 Starlink 全量只有 5% 的卫星有覆盖圈。
const GROUP_CAP_MAX = 3000;
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
  COV.groupSig = null; COV.groupDirty = false; COV.groupT0 = 0;
  const btn = document.getElementById('cover');
  if (btn) btn.classList.remove('on');
  const info = document.getElementById('coverInfo');
  if (info) info.textContent = '';
}

function coverTargets() {
  const grp = S.soloCon && !S.soloCon.startsWith('Starlink|') ? S.soloCon
    : (S.soloCon || (S.selected ? S.selected.con : null));
  if (!grp) return { grp: null, list: [] };
  // 只对载荷画覆盖：碎片/箭体没有业务覆盖意义，混进来会让计数虚高（Iridium 234 → 107）
  let list = S.objs.filter((o) => o.visible && o.type === 0 && (o.con === grp || o.key === grp));
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
  const N = 64;                       // 每条覆盖圈 64 段；组模式是叠加成带，不需要单星模式那么细
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
    info.textContent = `${grp} · 可见 ${list.length.toLocaleString()} 颗，绘制 ${use.length.toLocaleString()} 颗`
      + (step > 1 ? `（上限 ${GROUP_CAP_MAX}，抽样 1/${step}）` : '')
      + ` · 平均半径 ${(rSum / use.length).toFixed(0)} km · 仰角 ${COV.minEl}°`;
  }
}

// ---------- L2 接触图（链路） ----------
const MAXSEG = 12000;
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
// 用户链路（选中站点） / 馈电链路（全星座馈电站） / 星间三类 / 太阳规避
const linkGround   = makeLines(0x3ddc97, 0.85);
const linkFeeder   = makeLines(0xffb454, 0.50);
const linkIslSame  = makeLines(0x4fb6ff, 0.38);
const linkIslCross = makeLines(0x7dd3fc, 0.20);
const linkIslSeam  = makeLines(0xff9ecd, 0.70);
const linkIslSun   = makeLines(0x8b98a6, 0.28);
const LINK_OBJS = [linkGround, linkFeeder, linkIslSame, linkIslCross, linkIslSeam, linkIslSun];

// 各系统星间终端配置（来源见《星间链路调研》§6）：每星同时维持的链路条数上限
const ISL_CFG = {
  'Iridium': 4, 'Starlink': 4, 'Kuiper': 4, 'Telesat': 4,
  '千帆（Qianfan）': 4, '卫星互联网技术试验（中国星网）': 4,
  'OneWeb': 0, 'Globalstar': 0,
};

const LK = {
  on: false, ground: true, feeder: true, isl: true,
  maxKm: 5000, deg: 4, minEl: 10, sunAvoid: false,
  seg: 0, stat: {},
};

// 站点 → 场景坐标（与卫星点云同一地固系）
function siteXYZ(st) {
  const lo = st.lon * D2R, la = st.lat * D2R;
  return [R_EARTH * Math.cos(la) * Math.cos(lo), R_EARTH * Math.sin(la), -R_EARTH * Math.cos(la) * Math.sin(lo)];
}
function siteArr() { return S.station ? siteXYZ(S.station) : null; }

// 场景坐标下的仰角（站点地心方向即"天顶"，|site| = R_EARTH）
function elevAt(sx, sy, sz, px, py, pz) {
  const dx = px - sx, dy = py - sy, dz = pz - sz;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1) return -90;
  return Math.asin((dx * sx + dy * sy + dz * sz) / (d * R_EARTH)) / D2R;
}

// ---------- 星间链路：接触图（同轨 / 异轨 / 缝合线） ----------
// 物理约定见《低轨星座管道化展示仿真_星间链路调研》§3–§6：
//   同轨（intra-plane）：面内沿迹前后邻居，距离恒定，运行期不断链
//   异轨（inter-plane）：相邻轨道面同 u 槽位最近邻，距离随纬度伸缩
//   缝合线（seam）：RAAN 环上最大间隙两侧的面，相对运动反向，链路周期性中断
// 轨道面聚类：先按「倾角 + 高度壳」分组（不同壳层的 RAAN 集合互不相干），
// 再按 RAAN 间隔断簇。不用固定度数的 RAAN 网格——真实星座的 RAAN 有 TLE 拟合噪声，
// 且备份星/漂移星散落各处，硬分桶会把一个物理面切成多块，异轨配对就会连到"假的相邻面"。
function groupPlanes(list) {
  const byShell = new Map();
  for (const nd of list) {
    if (!byShell.has(nd.shell)) byShell.set(nd.shell, []);
    byShell.get(nd.shell).push(nd);
  }
  const planes = [];
  for (const g of byShell.values()) {
    if (!g.length) continue;
    g.sort((a, b) => a.raan - b.raan);
    const m = g.length;
    const gaps = g.map((n, i) => {
      let d = g[(i + 1) % m].raan - n.raan;
      if (i === m - 1) d += 360;
      return d;
    });
    const sg = gaps.slice().sort((a, b) => a - b);
    const med = sg[sg.length >> 1] || 0;
    // 阈值随面间距自适应：面内噪声远小于面间距，同时给 8° 上限避免把密集星座的邻面并进来
    const thr = Math.max(0.4, Math.min(med * 0.5, 8));
    let start = 0, maxG = -1;
    gaps.forEach((d, i) => { if (d > maxG) { maxG = d; start = i; } });
    let cur = [];
    const flush = () => { if (cur.length) { planes.push(cur); cur = []; } };
    for (let k = 0; k < m; k++) {
      const nd = g[(start + 1 + k) % m];
      if (cur.length) {
        let d = nd.raan - cur[cur.length - 1].raan;
        if (d < 0) d += 360;
        if (d > thr) flush();
      }
      cur.push(nd);
    }
    flush();
  }
  planes.sort((a, b) => a[0].raan - b[0].raan);
  return planes;
}

function islContacts(tMs) {
  const nodes = [];
  const byCon = new Map();
  for (let i = 0; i < S.objs.length; i++) {
    const o = S.objs[i];
    if (!o.visible || o.cls !== 0 || o.type !== 0) continue;
    if ((ISL_CFG[o.con] || 0) === 0) continue;
    const x = satPos[i * 3], y = satPos[i * 3 + 1], z = satPos[i * 3 + 2];
    if (y < -1e5) continue;
    const nrad = o.n * 2 * Math.PI / 86400;
    const M = o.M0 * D2R + nrad * ((tMs - o.epoch) / 1000);
    let u = (o.argp * D2R + M) % (2 * Math.PI);
    if (u < 0) u += 2 * Math.PI;
    const alt = Math.cbrt(MU / (nrad * nrad)) - R_EARTH;
    const nd = {
      idx: nodes.length, con: o.con, inc: o.inc || 0,
      shell: `${Math.round(o.inc || 0)}|${Math.round(alt / 20)}`,
      raan: ((o.raan % 360) + 360) % 360,
      x, y, z, u, deg: 0,
    };
    nodes.push(nd);
    if (!byCon.has(o.con)) byCon.set(o.con, []);
    byCon.get(o.con).push(nd);
  }

  const same = [], cross = [], seam = [];
  const planeInfo = new Map();
  const seen = new Set();
  const MAXEDGE = 16000;
  let edges = 0;

  for (const [con, arr] of byCon) {
    const cap = Math.min(ISL_CFG[con] || 4, LK.deg);
    if (cap < 1) continue;
    // 分面：倾角分桶 + RAAN 间隔聚类；面内按纬度幅角排序成环
    const all = groupPlanes(arr);
    for (const pl of all) pl.sort((a, b) => a.u - b.u);
    // 只有 ≥2 颗的簇才当作轨道面参与异轨配对（单星碎片不占邻面位置）
    const planes = all.filter((p) => p.length >= 2);
    const frags = all.length - planes.length;

    // 同轨优先建链：面内 u 排序成环，前后各一条（距离恒定，运行期不断链）
    for (const pl of all) {
      const m = pl.length;
      if (m < 2) continue;
      for (let k = 0; k < m && edges < MAXEDGE; k++) {
        const a = pl[k], b = pl[(k + 1) % m];
        if (a === b || a.deg >= cap || b.deg >= cap) continue;
        const key = a.idx < b.idx ? a.idx * 65536 + b.idx : b.idx * 65536 + a.idx;
        if (seen.has(key)) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        if (d > LK.maxKm || d < 1) continue;
        seen.add(key);
        same.push([a, b, d]); a.deg++; b.deg++; edges++;
      }
    }

    // 按壳层再分组：异轨链路只在同一壳层内配对（不同高度的面之间不建 ISL）
    const byShell = new Map();
    for (const pl of planes) {
      const sh = pl[0].shell;
      if (!byShell.has(sh)) byShell.set(sh, []);
      byShell.get(sh).push(pl);
    }

    let gapMax = -1, nPlane = 0, nSeamPairs = 0;
    for (const [sh, pls] of byShell) {
      pls.sort((a, b) => a[0].raan - b[0].raan);
      nPlane += pls.length;
      // 缝合线 = 该壳层 RAAN 环上最大间隙的两侧（相对运动反向，链路会周期性中断）
      let seamA = null, seamB = null, gMax = -1;
      if (pls.length > 2) {
        for (let j = 0; j < pls.length; j++) {
          const a = pls[j], b = pls[(j + 1) % pls.length];
          let g = b[0].raan - a[0].raan;
          if (j === pls.length - 1) g += 360;
          if (g > gMax) { gMax = g; seamA = a; seamB = b; }
        }
        if (gMax > 0) { nSeamPairs++; if (gMax > gapMax) gapMax = gMax; }
      }
      const pairUp = (A, B, isSeam) => {
        for (const a of A) {
          if (a.deg >= cap || edges >= MAXEDGE) continue;
          let lo = 0, hi = B.length - 1, pos = 0;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (B[mid].u < a.u) { lo = mid + 1; pos = lo; } else hi = mid - 1;
          }
          let best = null, bestD = Infinity;
          for (let w = -3; w <= 3; w++) {
            const b = B[((pos + w) % B.length + B.length) % B.length];
            if (b === a || b.deg >= cap) continue;
            const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            if (d < bestD) { bestD = d; best = b; }
          }
          if (!best || bestD > LK.maxKm || bestD < 1) continue;
          const key = a.idx < best.idx ? a.idx * 65536 + best.idx : best.idx * 65536 + a.idx;
          if (seen.has(key)) continue;
          seen.add(key);
          (isSeam ? seam : cross).push([a, best, bestD]);
          a.deg++; best.deg++; edges++;
        }
      };
      // 异轨：每个面与其 RAAN 相邻面互连（两方向各取 u 最近邻）
      for (let j = 0; j < pls.length && edges < MAXEDGE; j++) {
        const A = pls[j], B = pls[(j + 1) % pls.length];
        if (A === B) continue;
        const isSeam = pls.length > 2 &&
          ((A === seamA && B === seamB) || (A === seamB && B === seamA));
        pairUp(A, B, isSeam);
        if (pls.length > 2) pairUp(B, A, isSeam);
      }
    }

    planeInfo.set(con, {
      planes: nPlane, fragments: frags, shells: byShell.size,
      sats: planes.reduce((s, p) => s + p.length, 0),
      seamGap: gapMax > 0 ? +gapMax.toFixed(1) : 0,
    });
    void nSeamPairs;
  }
  return { nodes, same, cross, seam, planeInfo };
}

function updateLinks() {
  if (!LK.on) { for (const L of LINK_OBJS) L.obj.visible = false; return; }
  const tMs = simTime();
  const t0 = performance.now();
  const st = LK.stat = {
    gCnt: 0, gDist: 0, fCnt: 0, fDist: 0, stationsSeen: 0, feedTotal: FEED.list.length,
    same: 0, cross: 0, seam: 0, sunBlocked: 0, nodes: 0, islDist: 0, degAvg: 0,
    offCon: [], planeInfo: null, ms: 0,
  };

  // ---- 1. 选中站点 ↔ 可见卫星（用户链路） ----
  const site = siteArr();
  let gN = 0;
  if (LK.ground && site) {
    const cand = [];
    for (let i = 0; i < S.objs.length; i++) {
      const o = S.objs[i];
      if (!o.visible) continue;
      if (o.cls !== 0 && o.cls !== 1) continue;          // LEO + MEO
      const px = satPos[i * 3], py = satPos[i * 3 + 1], pz = satPos[i * 3 + 2];
      if (py < -1e5) continue;
      if (elevAt(site[0], site[1], site[2], px, py, pz) < LK.minEl) continue;
      cand.push([Math.hypot(px - site[0], py - site[1], pz - site[2]), px, py, pz]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const P = linkGround.pos;
    for (const [d, px, py, pz] of cand.slice(0, 240)) {
      if (gN >= MAXSEG) break;
      const o = gN * 6;
      P[o] = site[0]; P[o + 1] = site[1]; P[o + 2] = site[2];
      P[o + 3] = px; P[o + 4] = py; P[o + 5] = pz;
      gN++; st.gDist += d;
    }
    st.gCnt = gN;
  }

  // ---- 2. 全星座馈电站（馈电链路）：每站接最近的 2 颗本星座可见卫星 ----
  let fN = 0;
  if (LK.feeder && FEED.list.length) {
    const byCon = new Map();
    for (let i = 0; i < S.objs.length; i++) {
      const o = S.objs[i];
      if (!o.visible || o.cls !== 0) continue;
      if (!FEED.byCon.has(o.con)) continue;
      const px = satPos[i * 3], py = satPos[i * 3 + 1], pz = satPos[i * 3 + 2];
      if (py < -1e5) continue;
      if (!byCon.has(o.con)) byCon.set(o.con, []);
      byCon.get(o.con).push(px, py, pz);
    }
    const P = linkFeeder.pos;
    for (const s2 of FEED.list) {
      const arr = byCon.get(s2.con);
      if (!arr) continue;
      const [sx, sy, sz] = siteXYZ(s2);
      const cand = [];
      for (let k = 0; k < arr.length; k += 3) {
        const px = arr[k], py = arr[k + 1], pz = arr[k + 2];
        if (elevAt(sx, sy, sz, px, py, pz) < LK.minEl) continue;
        cand.push([Math.hypot(px - sx, py - sy, pz - sz), px, py, pz]);
      }
      if (!cand.length) continue;
      cand.sort((a, b) => a[0] - b[0]);
      st.stationsSeen++;
      for (const [d, px, py, pz] of cand.slice(0, 2)) {
        if (fN >= MAXSEG) break;
        const o = fN * 6;
        P[o] = sx; P[o + 1] = sy; P[o + 2] = sz;
        P[o + 3] = px; P[o + 4] = py; P[o + 5] = pz;
        fN++; st.fDist += d;
      }
    }
    st.fCnt = fN;
  }

  // ---- 3. 星间链路 ----
  let sameN = 0, crossN = 0, seamN = 0, sunN = 0;
  const sunB = linkIslSun.pos;
  // 画多少条：链路总量可达上万条，全画会糊成毛球，按配额等间隔抽样（统计口径仍用真实总数）
  const drawIsl = (L, list, quota) => {
    const P = L.pos;
    const stride = Math.max(1, Math.ceil(list.length / quota));
    let k = 0;
    for (let i = 0; i < list.length; i += stride) {
      const [a, b] = list[i];
      if (k >= MAXSEG) break;
      const o = k * 6;
      P[o] = a.x; P[o + 1] = a.y; P[o + 2] = a.z;
      P[o + 3] = b.x; P[o + 4] = b.y; P[o + 5] = b.z;
      k++;
    }
    L.n = k;
    L.stride = stride;
    return k;
  };
  // 太阳规避：光学终端 3° 禁区把链路整条剔除，单列一色以便观察"日落断链"
  const splitSun = (list, L, quota) => {
    const keep = [], block = [];
    const cos3 = Math.cos(3 * D2R);
    for (const e of list) {
      const [a, b] = e;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const dd = Math.hypot(dx, dy, dz) || 1;
      const s = S.sunDir || [0, 0, 0];
      const c1 = (dx * s[0] + dy * s[1] + dz * s[2]) / dd;
      const c2 = -c1;
      (c1 > cos3 || c2 > cos3 ? block : keep).push(e);
    }
    const P = sunB;
    const stride = Math.max(1, Math.ceil(block.length / 400));
    let m = 0;
    for (let i = 0; i < block.length; i += stride) {
      if (m >= MAXSEG) break;
      const [a, b] = block[i];
      const o = m * 6;
      P[o] = a.x; P[o + 1] = a.y; P[o + 2] = a.z;
      P[o + 3] = b.x; P[o + 4] = b.y; P[o + 5] = b.z;
      m++;
    }
    linkIslSun.n = m;
    sunN = m;
    return drawIsl(L, keep, quota);
  };

  if (LK.isl) {
    const g = islContacts(tMs);
    st.nodes = g.nodes.length;
    st.planeInfo = g.planeInfo;
    st.same = g.same.length; st.cross = g.cross.length; st.seam = g.seam.length;
    let sumD = 0;
    for (const L2 of [g.same, g.cross, g.seam]) for (const e of L2) sumD += e[2];
    st.islDist = sumD;
    // 绘制配额随规模收缩：万颗级星座若全画会糊成一片，看不出拓扑
    const q = g.nodes.length > 3000 ? { s: 1200, c: 800, m: 500 }
      : g.nodes.length > 800 ? { s: 2000, c: 1400, m: 700 }
        : { s: 2600, c: 2200, m: 800 };

    if (LK.sunAvoid) {
      sameN = splitSun(g.same, linkIslSame, q.s);
      crossN = splitSun(g.cross, linkIslCross, q.c);
      seamN = splitSun(g.seam, linkIslSeam, q.m);
    } else {
      sameN = drawIsl(linkIslSame, g.same, q.s);
      crossN = drawIsl(linkIslCross, g.cross, q.c);
      seamN = drawIsl(linkIslSeam, g.seam, q.m);
      linkIslSun.n = 0;
    }
    st.sunBlocked = sunN;
    const degSum = g.nodes.reduce((s, n) => s + n.deg, 0);
    st.degAvg = g.nodes.length ? degSum / g.nodes.length : 0;
    const seenCon = new Set();
    for (let i = 0; i < S.objs.length; i++) {
      const o = S.objs[i];
      if (!o.visible || o.cls !== 0 || o.type !== 0) continue;
      // 只报"显式配置为 0 条"的通信星座；遥感/导航等未配置分组不参与星间链路是默认行为，不该刷屏
      if (Object.prototype.hasOwnProperty.call(ISL_CFG, o.con) && ISL_CFG[o.con] === 0) seenCon.add(o.con);
    }
    st.offCon = [...seenCon];
    st.drawn = sameN + crossN + seamN;
  } else {
    for (const L of [linkIslSame, linkIslCross, linkIslSeam, linkIslSun]) L.n = 0;
  }

  // ---- 写缓冲 ----
  const flush = (L, n) => {
    L.geo.attributes.position.needsUpdate = true;
    L.geo.setDrawRange(0, n * 2);
    L.obj.visible = n > 0;
  };
  flush(linkGround, gN);
  flush(linkFeeder, fN);
  flush(linkIslSame, LK.isl ? linkIslSame.n || 0 : 0);
  flush(linkIslCross, LK.isl ? linkIslCross.n || 0 : 0);
  flush(linkIslSeam, LK.isl ? linkIslSeam.n || 0 : 0);
  flush(linkIslSun, sunN);
  LK.seg = gN + fN + sameN + crossN + seamN;

  st.ms = Math.round(performance.now() - t0);

  // ---- 面板 ----
  const el = document.getElementById('lkStat');
  if (!el) return;
  const out = [];
  if (site != null) {
    const stName = S.station ? S.station.name : '站点';
    const kind = S.station && S.station.kind === 'feeder' ? '馈电（选中站）' : '用户链路（选中站）';
    out.push(st.gCnt
      ? `${kind} · <b>${stName}</b> → 卫星 <b>${st.gCnt}${st.gCnt >= 240 ? '+' : ''}</b> 条`
        + ` · 均距 ${(st.gDist / st.gCnt).toFixed(0)} km${st.gCnt >= 240 ? '（已达显示上限）' : ''}`
      : `${kind} · <b>${stName}</b> 当前无 ${LK.minEl}° 以上可见卫星`);
  } else out.push('未选择地面站');
  if (LK.feeder && st.feedTotal) {
    out.push(`馈电链路 <b>${st.fCnt}</b> 条 · 可见馈电站 ${st.stationsSeen}/${st.feedTotal}`);
  }
  if (LK.isl) {
    const tot = st.same + st.cross + st.seam;
    const avgI = tot ? st.islDist / tot : 0;
    out.push(`同轨 <b>${st.same}</b> · 异轨 <b>${st.cross}</b> · 缝合 <b>${st.seam}</b>`);
    out.push(`节点 ${st.nodes} · 平均度 ${st.degAvg.toFixed(2)} · 均距 ${avgI.toFixed(0)} km`);
    if (tot) out.push(`星间单向时延 ≈ ${(avgI / 299792.458 * 1000).toFixed(1)} ms（真空光速）`);
    if (st.drawn < tot) out.push(`<span style="color:#4d5a68">画面抽样绘制 ${st.drawn} / ${tot} 条</span>`);
    if (st.sunBlocked) out.push(`<span style="color:#8b98a6">太阳规避剔除 ${st.sunBlocked} 条（抽样）</span>`);
    if (st.offCon.length) out.push(`<span style="color:#66707d">无星间链路设计：${st.offCon.join('、')}</span>`);
  }
  out.push(`<span style="color:#4d5a68;font-size:10.5px">${st.ms} ms 刷新</span>`);
  el.innerHTML = out.join('<br>');
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
// 加载失败要说得清：本页必须经 http 服务打开整个 _build/site 目录，
// 只拷走 index.html（或某些预览器漏掉 data/）会导致编目 404，页面会一直转圈。
function showLoadFail(detail) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.innerHTML =
    '<div style="color:#ffb454;font-weight:600;font-size:14px">编目数据加载失败</div>' +
    '<div style="color:#8695a8;font-size:12px">' + detail + '</div>' +
    '<div style="max-width:480px;line-height:1.8;color:#9fb0c2;font-size:12px;text-align:center">'
    + '本页用 ES 模块 + fetch 读取 <code>data/catalog.json.gz</code>（1.9 MB）与 <code>libs/</code>、<code>assets/</code>，'
    + '<b>必须</b>通过 http 服务打开<b>整个</b> <code>_build/site/</code> 目录。<br>'
    + '方式一：双击 <code>start.command</code><br>'
    + '方式二：<code>cd _build/site &amp;&amp; python3 -m http.server 8100</code>，再打开 http://127.0.0.1:8100/'
    + '</div>';
  el.style.gap = '10px';
}

async function loadCatalog() {
  const bar = document.getElementById('pbar');
  let res;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    res = await fetch('./data/catalog.json.gz', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} —— 取不到 ./data/catalog.json.gz`);
  } catch (e) {
    showLoadFail(String(e && e.message ? e.message : e));
    throw e;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
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
  if (COV.on && COV.mode === 'group') COV.groupDirty = true;   // 由主循环统一重建，避免重复构建
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

// ---------- 地面站 / 馈电站 ----------
// 演示点位（中国境内，用于"用户链路"演示）
const SITES = [
  ['北京', 116.4, 39.9], ['上海', 121.5, 31.2], ['西安', 108.9, 34.3],
  ['三亚', 109.5, 18.3], ['乌鲁木齐', 87.6, 43.8], ['拉萨', 91.1, 29.7],
  ['漠河', 122.5, 52.9], ['南沙', 114.2, 10.4],
];

// ITU 已申报馈电站（_build/data/feeder_stations.json → site/data/feeder.json.gz）
const FEED = { list: [], byCon: new Map(), stat: {}, loaded: false, marker: null, halo: null };
const CON_ALT = new Map();          // 星座中位高度，用于站点覆盖圈几何

function altOfObj(o) {
  const nrad = (o.n || 0) * 2 * Math.PI / 86400;
  if (!nrad) return 0;
  return Math.cbrt(MU / (nrad * nrad)) - R_EARTH;
}

function computeConAlts() {
  const acc = new Map();
  for (const o of S.objs) {
    if (o.cls !== 0 || o.type !== 0) continue;
    if (!acc.has(o.con)) acc.set(o.con, []);
    acc.get(o.con).push(altOfObj(o));
  }
  for (const [con, arr] of acc) {
    arr.sort((a, b) => a - b);
    CON_ALT.set(con, arr[Math.floor(arr.length / 2)]);
  }
}

async function loadFeeder() {
  try {
    const res = await fetch('./data/feeder.json.gz');
    const buf = new Uint8Array(await res.arrayBuffer());
    const txt = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const j = JSON.parse(txt);
    FEED.list = j.stations.map(([con, name, lon, lat, band, date, kind, adm]) =>
      ({ con, name, lon, lat, band, date, kind, adm }));
    FEED.stat = j.stat || {};
    for (const s of FEED.list) {
      if (!FEED.byCon.has(s.con)) FEED.byCon.set(s.con, []);
      FEED.byCon.get(s.con).push(s);
    }
    buildFeederMarkers();
    buildStationOptions();
    FEED.loaded = true;
  } catch (e) {
    console.warn('馈电站数据加载失败', e);
    const el = document.getElementById('stInfo');
    if (el) el.innerHTML = '· <span style="color:#ffb454">馈电站数据未加载</span>';
  }
}

// 圆形柔光点纹理：PointsMaterial 不贴图时默认画方块，站点标记会像噪点
let _dotTex = null;
function dotTexture() {
  if (_dotTex) return _dotTex;
  const S2 = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S2;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S2 / 2, S2 / 2, 0, S2 / 2, S2 / 2, S2 / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.30, 'rgba(255,255,255,0.98)');
  grd.addColorStop(0.52, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S2, S2);
  _dotTex = new THREE.CanvasTexture(cv);
  _dotTex.colorSpace = THREE.SRGBColorSpace;
  return _dotTex;
}

// 空心环纹理：站点与卫星点云同为小点，仅靠颜色分不开（Iridium 卫星与它的站同色），
// 所以地面站一律画成"环"，形状上与天上的实心点区分开。
let _ringTex = null;
function ringTexture() {
  if (_ringTex) return _ringTex;
  const S2 = 96, c2 = S2 / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S2;
  const g = cv.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 9;
  g.beginPath(); g.arc(c2, c2, c2 - 12, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.lineWidth = 4;
  g.beginPath(); g.arc(c2, c2, c2 - 4, 0, Math.PI * 2); g.stroke();
  _ringTex = new THREE.CanvasTexture(cv);
  _ringTex.colorSpace = THREE.SRGBColorSpace;
  return _ringTex;
}

function buildFeederMarkers() {
  const n = FEED.list.length;
  if (!n) return;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const c = new THREE.Color();
  FEED.list.forEach((s, i) => {
    const v = siteVec(s.lon, s.lat, R_EARTH * 1.004);
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    c.set(PALETTE[s.con] || '#ffb454');
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // 底衬柔光：让环在亮地表（沙漠/冰盖）上也能看清
  FEED.halo = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 20, map: dotTexture(), vertexColors: true, sizeAttenuation: false, transparent: true,
    opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  FEED.halo.frustumCulled = false;
  scene.add(FEED.halo);
  FEED.marker = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 13, map: ringTexture(), vertexColors: true, sizeAttenuation: false, transparent: true,
    opacity: 1.0, depthWrite: false,
  }));
  FEED.marker.frustumCulled = false;
  scene.add(FEED.marker);
}

const stEl = document.getElementById('station');
function fmtLL(lon, lat) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildStationOptions() {
  const keep = stEl.value;
  let html = '<option value="">（未选择地面站）</option>';
  if (FEED.list.length) {
    html += '<optgroup label="ITU 已申报馈电站（有坐标）">';
    FEED.list.forEach((s, i) => {
      html += `<option value="f${i}">${esc(s.name)} · ${esc(s.con)} · ${fmtLL(s.lon, s.lat)}</option>`;
    });
    html += '</optgroup>';
  }
  html += '<optgroup label="演示点位（中国境内）">';
  SITES.forEach((s, i) => {
    html += `<option value="d${i}">${s[0]} ${s[1]}°E ${s[2]}°N</option>`;
  });
  html += '</optgroup><option value="custom">自定义经纬度…</option>';
  stEl.innerHTML = html;
  if (keep) stEl.value = keep;
}

stEl.onchange = () => {
  const cs = document.getElementById('customSite');
  const v = stEl.value;
  if (v === 'custom') { cs.classList.add('show'); applyCustomSite(); return; }
  cs.classList.remove('show');
  if (!v) {
    S.station = null; siteMark.visible = false; coverLine.visible = false;
    updateStInfo(); updatePasses(); if (LK.on) updateLinks();
    return;
  }
  if (v[0] === 'f') {
    const s = FEED.list[+v.slice(1)];
    S.station = { name: s.name, lon: s.lon, lat: s.lat, con: s.con, kind: 'feeder', band: s.band, date: s.date };
  } else {
    const s = SITES[+v.slice(1)];
    S.station = { name: s[0], lon: s[1], lat: s[2], kind: 'demo' };
  }
  placeStation();
};

function placeStation() {
  const st = S.station;
  if (!st) return;
  siteMark.material.color.set(st.kind === 'feeder' ? 0xffb454 : 0x35c68a);
  siteMark.position.copy(siteVec(st.lon, st.lat, R_EARTH * 1.006));
  siteMark.visible = true;
  drawCoverage();
  updateStInfo();
  updatePasses();
  if (LK.on) updateLinks();
}

function updateStInfo() {
  const el = document.getElementById('stInfo');
  if (!el) return;
  const st = S.station;
  if (!st) { el.textContent = `（共 ${FEED.list.length} 座 ITU 馈电站可选）`; return; }
  if (st.kind === 'feeder') {
    el.innerHTML = `· <span style="color:#ffb454">ITU 馈电</span> ${esc(st.con)} · ${esc(st.band || '频段未列')}`;
  } else if (st.kind === 'demo') {
    el.innerHTML = `· <span style="color:#35c68a">演示点位</span>`;
  } else {
    el.innerHTML = `· <span style="color:#35c68a">自定义</span>`;
  }
}

buildStationOptions();
updateStInfo();

// 顶栏显示 app.js 的实际修改时间：排查"看到的还是旧版本"时，一眼可确认
fetch('./app.js', { method: 'HEAD' }).then((r) => {
  const lm = r.headers.get('Last-Modified');
  const el = document.getElementById('buildtag');
  if (!el) return;
  if (!lm) { el.textContent = '构建 —'; return; }
  const d = new Date(lm);
  el.textContent = `构建 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}).catch(() => { });

function drawCoverage() {
  const s = S.station; if (!s) return;
  const el = 10 * D2R;
  // 高度取该星座中位轨道高度；无归属星座（演示/自定义点位）时按 LEO 典型 550 km
  const h = (s.con && CON_ALT.get(s.con)) || 550;
  const psi = Math.acos(R_EARTH / (R_EARTH + h) * Math.cos(el)) - el;
  coverLine.material.color.set(s.kind === 'feeder' ? 0xffb454 : 0x35c68a);
  if (!(psi > 0)) { coverLine.visible = false; return; }
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
  const km = R_EARTH * psi;
  S.coverKm = km;
  S.coverH = h;
}

function applyCustomSite() {
  const lon = parseFloat(document.getElementById('csLon').value);
  const lat = parseFloat(document.getElementById('csLat').value);
  if (!isFinite(lon) || !isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  S.station = { name: `自定义 ${lon.toFixed(1)}°E ${lat.toFixed(1)}°N`, lon, lat, kind: 'custom' };
  placeStation();
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

// ---------- 过顶预测（多站 / 多星） ----------
const PASS = { open: false, mode: 'satAll', spanH: 24, minEl: 10, running: false };

function autoPickSat() {
  if (S.selected) return S.selected;
  // 优先取当前单独显示的星座（其次任意可见 LEO 载荷），并顺手选中它，避免用户空跑一次
  const solo = S.soloCon;
  const cand = S.objs.find((o) => o.visible && o.cls === 0 && o.type === 0 && (!solo || o.con === solo))
    || S.objs.find((o) => o.visible && o.cls === 0 && o.type === 0);
  if (cand) select(cand);
  return cand;
}

function passJob() {
  const mode = PASS.mode;
  if (mode === 'satAll') {
    const o = autoPickSat();
    if (!o) return { err: '先选中一颗卫星' };
    const own = FEED.list.filter((s) => s.con === o.con);
    const sts = own.length ? own : FEED.list;
    return {
      sats: [o], stations: sts, exact: true,
      label: `${o.name} × ${sts.length} 座${own.length ? '本星座' : '全部'}馈电站`,
    };
  }
  if (mode === 'siteCon') {
    const st = S.station;
    if (!st) return { err: '先选择一个站点（链路面板或此处）' };
    const what = document.getElementById('passWhat').value;
    const pool = S.objs.filter((o) => o.visible && o.cls === 0 && o.type === 0 && (!what || o.con === what));
    const sats = pool.slice(0, 200);
    return {
      sats, stations: [st], exact: false,
      label: `${st.name} × ${what || '可见 LEO'}（${sats.length} 颗${pool.length > 200 ? '，已截断' : ''}）`,
      truncated: pool.length > 200,
    };
  }
  const o = autoPickSat(), st = S.station;
  if (!o || !st) return { err: '先选中一颗卫星并选择一个站点' };
  return { sats: [o], stations: [st], exact: true, label: `${o.name} × ${st.name}` };
}

// 分片计算，避免长时间阻塞主线程；返回 [a, tMax, b, maxEl] 与 (星,站) 索引
function predictPasses(job, onDone) {
  const stepS = job.exact ? 30 : 60;
  const spanS = PASS.spanH * 3600;
  const steps = Math.max(1, Math.floor(spanS / stepS));
  const t0 = simTime(), minEl = PASS.minEl;
  const nS = job.stations.length, nSat = job.sats.length;
  const gap = stepS * 1000;
  const sxyz = job.stations.map(siteXYZ);
  const stt = new Array(nSat * nS);
  for (let i = 0; i < stt.length; i++) stt[i] = { in: false, a: 0, m: 0, mx: -90 };
  const out = [];
  const conc = new Int16Array(steps + 1);       // 每个时间片同时可见卫星数（仅单站模式有意义）
  let k = 0;

  function chunk() {
    const tStart = performance.now();
    while (k <= steps) {
      const t = t0 + k * stepS * 1000;
      for (let si = 0; si < nSat; si++) {
        const o = job.sats[si];
        const p = job.exact ? exactPos(o, t) : fastPos(o, t);
        if (!p) continue;
        for (let ti = 0; ti < nS; ti++) {
          const q = stt[si * nS + ti];
          const e = elevAt(sxyz[ti][0], sxyz[ti][1], sxyz[ti][2], p[0], p[1], p[2]);
          if (e >= minEl) {
            if (!q.in) { q.in = true; q.a = t; q.m = t; q.mx = e; if (nS === 1) conc[k]++; }
            else if (e > q.mx) { q.mx = e; q.m = t; }
          } else if (q.in) {
            q.in = false;
            out.push({ si, ti, a: q.a, m: q.m, b: t, mx: q.mx });
          }
        }
      }
      k++;
      if (performance.now() - tStart > 22) { setTimeout(chunk, 0); return; }
    }
    const tEnd = t0 + spanS * 1000;
    for (let i = 0; i < stt.length; i++) {
      const q = stt[i];
      if (q.in) out.push({ si: Math.floor(i / nS), ti: i % nS, a: q.a, m: q.m, b: tEnd, mx: q.mx });
    }
    onDone(out, { t0, tEnd, spanS, stepS, conc, nSat, nS });
  }
  chunk();
}

function unionOf(list) {
  const iv = list.map((p) => [p.a, p.b]).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of iv) {
    const last = merged[merged.length - 1];
    if (!last || a > last[1]) merged.push([a, b]);
    else if (b > last[1]) last[1] = b;
  }
  return merged;
}

function renderPasses(passes, meta, job) {
  const fT = (x) => new Date(x).toLocaleString('zh-CN',
    { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fS = (x) => new Date(x).toLocaleTimeString('zh-CN', { hour12: false });
  const merged = unionOf(passes);
  const covMs = merged.reduce((s, [a, b]) => s + (b - a), 0);
  let maxGap = 0, gapAt = 0;
  for (let i = 1; i < merged.length; i++) {
    const g = merged[i][0] - merged[i - 1][1];
    if (g > maxGap) { maxGap = g; gapAt = merged[i - 1][1]; }
  }
  const spanMs = meta.spanS * 1000;
  const covPct = covMs / spanMs * 100;
  const maxConc = meta.conc && meta.nS === 1 ? Math.max(0, ...meta.conc) : 0;

  const cards = [
    ['过境窗口', passes.length.toLocaleString(), '次'],
    ['时间覆盖率', covPct.toFixed(1), '%'],
    ['最长断链', (maxGap / 60000).toFixed(0), 'min'],
    meta.nS === 1 ? ['峰值同时可见', maxConc, '颗'] : ['合并可见', (covMs / 60000).toFixed(0), 'min'],
  ];
  document.getElementById('passCards').innerHTML = cards.map(([k, v, u]) =>
    `<div class="pd-card"><div class="k">${k}</div><div class="v">${v}<span class="u">${u}</span></div></div>`).join('');

  // 明细表
  const maxDur = Math.max(1, ...passes.map((p) => p.b - p.a));
  const nameOf = (p) => meta.nS === 1
    ? (job.sats[p.si].name || job.sats[p.si].norad)
    : job.stations[p.ti].name;
  const head = meta.nS === 1
    ? '<tr><th>卫星</th><th>起始</th><th>结束</th><th>时长</th><th>最高仰角</th><th>窗口</th></tr>'
    : '<tr><th>站点</th><th>起始</th><th>结束</th><th>时长</th><th>最高仰角</th><th>窗口</th></tr>';
  const rows = passes.slice().sort((x, y) => x.a - y.a || x.mx - y.mx).slice(0, 400).map((p) => {
    const dur = (p.b - p.a) / 60000;
    const w = Math.max(3, Math.round((p.b - p.a) / maxDur * 60));
    return `<tr><td>${esc(nameOf(p))}</td><td>${fT(p.a)}</td><td>${fS(p.b)}</td>
      <td>${dur.toFixed(0)} min</td><td class="h">${p.mx.toFixed(0)}°</td>
      <td><span class="bar" style="display:inline-block;width:${w}px"></span></td></tr>`;
  }).join('');
  document.getElementById('passTable').innerHTML = passes.length
    ? `<table class="pd-tbl">${head}${rows}</table>`
    : `<div style="color:#66707d;padding:14px 0">该时间窗内没有任何 ≥${PASS.minEl}° 的过境</div>`;

  // 结论
  const notes = [];
  notes.push(`<b>${esc(job.label)}</b> · 起始 ${fT(meta.t0)} · 步长 ${meta.stepS}s · 仰角门限 ${PASS.minEl}°`);
  if (meta.nS === 1) {
    notes.push(`该站 ${PASS.spanH}h 内共 <b>${passes.length}</b> 次过境，平均间隔约 ${(PASS.spanH * 60 / Math.max(1, passes.length)).toFixed(0)} min，`
      + `累计可见 ${(covMs / 60000).toFixed(0)} min（覆盖率 ${covPct.toFixed(1)}%），最长连续不可见 ${(maxGap / 60000).toFixed(0)} min，峰值同时可见 ${maxConc} 颗。`);
    if (covPct >= 99.5) {
      notes.push(`该站对本星座<b>长时间连续可管</b>（覆盖率 ≈100%），瓶颈因此不在可见性，而在<b>星上资源与波束调度</b>。`);
    } else {
      notes.push(`覆盖率不足 100%，说明该站单独无法维持连续管道，需靠<b>多站组网</b>或星间链路回传补盲。`);
    }
  } else {
    notes.push(`该星在 ${meta.nS} 座馈电站中，合并可见时长 ${(covMs / 60000).toFixed(0)} min，`
      + `任一站可见的时间占比 ${covPct.toFixed(1)}%。`);
    if (covPct < 60) notes.push(`覆盖率偏低通常源于<b>ITU 申报的站址稀疏</b>（申报只登记关口站/典型站，不含商用网关全量），并非系统能力上限。`);
  }
  if (job.truncated) notes.push(`卫星数已截断到 200 颗以控制计算量；缩小星座范围可得到完整结果。`);
  notes.push(`<span style="color:#5f6f80">方法：${job.exact ? 'SGP4 精确递推' : '二体近似递推'}，步长 ${meta.stepS}s，`
    + `窗口 = 仰角 ≥ 门限的连续区间，起止精度约 ±${meta.stepS}s。这是<b>几何可见性</b>预测，`
    + `不含链路预算、雨衰、波束调度与星上资源约束。</span>`);
  document.getElementById('passNote').innerHTML = notes.map((n) => `<div>${n}</div>`).join('');
  void gapAt;
}

function runPass() {
  if (PASS.running) return;
  const job = passJob();
  if (job.err) {
    document.getElementById('passCards').innerHTML = '';
    document.getElementById('passTable').innerHTML = `<div style="color:#ffb454;padding:12px 0">${job.err}</div>`;
    document.getElementById('passNote').innerHTML = '';
    return;
  }
  PASS.running = true;
  document.getElementById('passRun').textContent = '计算中…';
  document.getElementById('passCards').innerHTML = '';
  document.getElementById('passTable').innerHTML = '<div style="color:#66707d;padding:14px 0">递推中…</div>';
  setTimeout(() => {
    predictPasses(job, (passes, meta) => {
      PASS.running = false;
      document.getElementById('passRun').textContent = '计算';
      renderPasses(passes, meta, job);
    });
  }, 30);
}

function refreshPassWhat() {
  const sel = document.getElementById('passWhat');
  const mode = PASS.mode;
  if (mode !== 'siteCon') { sel.style.display = 'none'; return; }
  sel.style.display = '';
  const set = [];
  for (const o of S.objs) if (o.visible && o.cls === 0 && o.type === 0 && !set.includes(o.con)) set.push(o.con);
  set.sort((a, b) => a.localeCompare(b, 'zh'));
  const keep = sel.value;
  sel.innerHTML = '<option value="">全部可见 LEO 星座</option>' +
    set.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (keep && set.includes(keep)) sel.value = keep;
}

document.getElementById('passBtn').onclick = (e) => {
  PASS.open = !PASS.open;
  document.getElementById('passDrawer').classList.toggle('show', PASS.open);
  e.target.classList.toggle('on', PASS.open);
  if (PASS.open) { refreshPassWhat(); runPass(); }
};
document.getElementById('passClose').onclick = () => {
  PASS.open = false;
  document.getElementById('passDrawer').classList.remove('show');
  document.getElementById('passBtn').classList.remove('on');
};
document.getElementById('passMode').onchange = (e) => { PASS.mode = e.target.value; refreshPassWhat(); runPass(); };
document.getElementById('passSpan').onchange = (e) => { PASS.spanH = +e.target.value; runPass(); };
document.getElementById('passEl').onchange = (e) => { PASS.minEl = +e.target.value; runPass(); };
document.getElementById('passWhat').onchange = () => runPass();
document.getElementById('passRun').onclick = () => runPass();

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

// 馈电站拾取：只认朝向相机那一半（地表点被地球挡住时不响应）
function pickStationAt(clientX, clientY, tol = 11) {
  if (!FEED.list.length) return -1;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  const camN = camera.position.clone().normalize();
  const v = new THREE.Vector3();
  let best = -1, bestD = tol;
  FEED.list.forEach((s, i) => {
    v.copy(siteVec(s.lon, s.lat, R_EARTH)).normalize();
    if (v.dot(camN) <= 0) return;                       // 背面
    v.multiplyScalar(R_EARTH * 1.004).project(camera);
    if (v.z > 1) return;
    const sx = (v.x * 0.5 + 0.5) * rect.width;
    const sy = (-v.y * 0.5 + 0.5) * rect.height;
    const d = Math.hypot(sx - mx, sy - my);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

const tipEl = document.getElementById('tip');
function showStationTip(i, x, y) {
  if (!tipEl) return;
  const s = FEED.list[i];
  const kind = /Specific/i.test(s.kind || '') ? '特定地球站' : '典型地球站';
  tipEl.innerHTML = `<div class="t1">${esc(s.name)}</div>`
    + `<div class="t2">${esc(s.con)} · ${fmtLL(s.lon, s.lat)}</div>`
    + `<div class="t3">${esc(s.band || '频段未列')}</div>`
    + `<div class="t2">${kind} · 收妥 ${esc(s.date || '—')} · ${esc(s.adm || '')}</div>`
    + `<div class="t2" style="margin-top:2px;color:#5f6f80">点击选中该站</div>`;
  tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = Math.min(x + 14, innerWidth - w - 8) + 'px';
  tipEl.style.top = Math.min(y + 14, innerHeight - h - 8) + 'px';
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

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
  if (!dragging) {
    // 未拖动时做站点悬停提示（39 座，逐帧投影开销可忽略）
    const si = pickStationAt(e.clientX, e.clientY);
    if (si >= 0) {
      showStationTip(si, e.clientX, e.clientY);
      canvas.style.cursor = 'pointer';
    } else {
      hideTip();
      if (canvas.style.cursor === 'pointer') canvas.style.cursor = 'grab';
    }
    return;
  }
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);

  if (dragButton === 2) {
    // 右键拖动 = 缩放
    camDistTarget = clampDist(camDistTarget * Math.exp(dy * 0.006));
    return;
  }
  camYaw -= dx * 0.005;
  camPitch = clampPitch(camPitch + dy * 0.005);
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!dragging) return;
  dragging = false;
  canvas.style.cursor = 'grab';
  // 位移小于阈值视为点击：先判站点（小目标），再判卫星
  if (dragMoved < 6 && dragButton === 0) {
    const si = pickStationAt(e.clientX, e.clientY);
    if (si >= 0) { selectFeederStation(si); return; }
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) select(hit);
  }
}

function selectFeederStation(i) {
  const sel = document.getElementById('station');
  sel.value = 'f' + i;
  sel.dispatchEvent(new Event('change'));
  if (!LK.on) document.getElementById('linkBtn').click();
}
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);

function clampDist(d) {
  // 下限 > 1R：绝不允许相机进入地球内部（曾经的 0.12R 会让视图只剩一小块内壁）
  return Math.max(CAM_MIN, Math.min(R_EARTH * 30, d));
}

// 跟随状态提示：相机跟着卫星走时地球会离开画面中心，这个状态必须显眼，
// 否则用户只会觉得"视角莫名其妙跑了"
function syncFollowTag() {
  const el = document.getElementById('followTag');
  if (!el) return;
  const on = !!(S.follow || S.track);
  el.classList.toggle('show', on);
  el.textContent = S.track ? '定轨跟踪中 · 点此退出' : '跟随视角中 · 点此退出';
}
document.getElementById('followTag').onclick = () => {
  S.follow = false; S.track = false;
  document.getElementById('follow').classList.remove('on');
  document.getElementById('track').classList.remove('on');
  syncFollowTag();          // camTarget 会在 tick 里平滑回地心，地球随之回中
};

// ---------- 视图诊断 ----------
// 「地球不在画面中心」这类问题，凭描述很难定位：可能是相机目标、画布尺寸、DPR、
// 也可能 canvas 这个元素本身就不在窗口中心（例如内嵌预览面板停靠在右下角）。
// 把所有坐标数据摆出来，一眼可判。
function renderDiag() {
  const box = document.getElementById('diagBody');
  if (!box) return;
  const c = document.getElementById('c');
  const r = c.getBoundingClientRect();
  const v = new THREE.Vector3(0, 0, 0).project(camera);
  const ex = (v.x * 0.5 + 0.5) * r.width, ey = (-v.y * 0.5 + 0.5) * r.height;
  const off = [Math.round(ex - r.width / 2), Math.round(ey - r.height / 2)];
  const rows = [
    ['窗口视口 innerWidth × innerHeight', `${innerWidth} × ${innerHeight}`],
    ['devicePixelRatio', String(devicePixelRatio)],
    ['canvas 位置 left / top', `${Math.round(r.left)} / ${Math.round(r.top)}`],
    ['canvas 尺寸 宽 × 高', `${Math.round(r.width)} × ${Math.round(r.height)}`],
    ['canvas 中心（窗口坐标）', `${Math.round(r.left + r.width / 2)}, ${Math.round(r.top + r.height / 2)}`],
    ['绘制缓冲 buffer', `${c.width} × ${c.height}`],
    ['camera.aspect', camera.aspect.toFixed(4)],
    ['相机距地心', `${Math.round(Math.hypot(camera.position.x, camera.position.y, camera.position.z))} km`
      + `（${(Math.hypot(camera.position.x, camera.position.y, camera.position.z) / R_EARTH).toFixed(2)}R）`],
    ['相机目标 camTarget', `${Math.round(camTarget.x)}, ${Math.round(camTarget.y)}, ${Math.round(camTarget.z)}`],
    ['地球投影（canvas 坐标）', `${Math.round(ex)}, ${Math.round(ey)}`],
    ['<b>地球相对画布中心偏移</b>', `<b class="${Math.abs(off[0]) > 2 || Math.abs(off[1]) > 2 ? 'warn' : ''}">${off[0]}, ${off[1]}</b>`],
    ['地球锁定 / 跟随 / 定轨', `${LOCK.on} / ${S.follow} / ${S.track}`],
    ['已选中', S.selected ? S.selected.name : '无'],
  ];
  box.innerHTML = rows.map(([k, val]) => `<div class="dl"><span>${k}</span><span>${val}</span></div>`).join('');
  window.__diagText = rows.map(([k, val]) => `${k.replace(/<[^>]+>/g, '')}: ${val.replace(/<[^>]+>/g, '')}`).join('\n');
}
document.getElementById('diagBtn').onclick = (e) => {
  const p = document.getElementById('diagPanel');
  p.classList.toggle('show');
  e.target.classList.toggle('on', p.classList.contains('show'));
  if (p.classList.contains('show')) renderDiag();
};
document.getElementById('diagClose').onclick = () => {
  document.getElementById('diagPanel').classList.remove('show');
  document.getElementById('diagBtn').classList.remove('on');
};
document.getElementById('diagRefresh').onclick = renderDiag;
document.getElementById('diagCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(window.__diagText || ''); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = window.__diagText || '';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  document.getElementById('diagCopy').textContent = '已复制';
  setTimeout(() => { document.getElementById('diagCopy').textContent = '复制'; }, 1200);
};

// ---------- 视角：复位 / 锁定地轴（极地俯视） ----------
// 相机距离语义（全部以地球半径为单位）。下限必须 > 1R：一旦相机进入地球内部，
// 只能看到内壁一小块，而拖动只改朝向不改距离，用户会觉得"视角卡死改不回来"。
const CAM_MIN     = R_EARTH * 1.06;    // 贴地表外 6%，兼顾看清覆盖圈与避免与地面 z-fighting
const CAM_FOLLOW  = R_EARTH * 1.45;    // 跟随/定轨：卫星与地表同框
const CAM_GLOBAL  = R_EARTH * 5;       // 复位视角
const CAM_AXIS    = R_EARTH * 3.2;     // 极地俯视
// 地球是否强制居中。开启时相机目标永远钉在地心：点云很密，"双击空白"极易误命中卫星，
// 一旦进入跟随，地球就被甩到画面一角且用户不易发现原因。默认开启，需要跟随时再取消。
const LOCK = { on: true };
const lockEl = document.getElementById('lockEarth');

function setLock(on) {
  LOCK.on = on;
  if (lockEl) lockEl.checked = on;
  if (on) {
    // 上锁即退出跟随，camTarget 会在 tick 里平滑回地心
    S.follow = false; S.track = false;
    document.getElementById('follow').classList.remove('on');
    document.getElementById('track').classList.remove('on');
    syncFollowTag();
  }
}
if (lockEl) lockEl.onchange = (e) => setLock(e.target.checked);

// 跟随/定轨按钮：用户明确要跟随时，自动解除地球锁定（否则按钮会像"点了没反应"）
function wantFollow(which) {
  const btn = document.getElementById(which);
  const turningOn = which === 'follow' ? !S.follow : !S.track;
  if (turningOn && LOCK.on) setLock(false);
  if (which === 'follow') { S.follow = !S.follow; btn.classList.toggle('on', S.follow); }
  else { S.track = !S.track; btn.classList.toggle('on', S.track); if (S.track) { camDist = camDistTarget = CAM_FOLLOW; } }
  syncFollowTag();
}
// 俯仰上限留 1° 余量：pitch = ±π/2 时相机与 lookAt 目标同轴，up 向量退化会画面翻转
const AXIS_PITCH = Math.PI / 2 - 0.0175;
const clampPitch = (p) => Math.max(-AXIS_PITCH, Math.min(AXIS_PITCH, p));

function resetView() {
  camYaw = 1.2; camPitch = 0.35;
  camDist = camDistTarget = CAM_GLOBAL;
  camTarget.set(0, 0, 0);
  S.follow = false; S.track = false;
  document.getElementById('follow').classList.remove('on');
  document.getElementById('track').classList.remove('on');
  document.getElementById('viewAxis').value = '';
  syncFollowTag();
}
document.getElementById('viewReset').onclick = resetView;

// 锁定地轴：相机沿自转轴俯视，极轨星座与极区覆盖在这个视角下是同心圆，最直观
function setAxisView(pole) {
  if (!pole) { resetView(); return; }
  camYaw = 0;                       // 正上方时 yaw 不影响相机位置，固定以保持画面朝向稳定
  camPitch = pole === 'n' ? AXIS_PITCH : -AXIS_PITCH;
  camDist = camDistTarget = CAM_AXIS;
  camTarget.set(0, 0, 0);           // 必须回到地心，否则会绕某颗卫星转
  S.follow = false; S.track = false;
  document.getElementById('follow').classList.remove('on');
  document.getElementById('track').classList.remove('on');
  syncFollowTag();
}
document.getElementById('viewAxis').onchange = (e) => setAxisView(e.target.value);

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
    // 地球锁定居中时，双击只选中、不跟随——否则点云密集处"想双击空白"也会误命中卫星
    if (!LOCK.on) {
      S.follow = true;
      document.getElementById('follow').classList.add('on');
      camDistTarget = CAM_FOLLOW;   // 必须是地外距离：曾经的 0.6R 会把相机放进地球内部
    }
    syncFollowTag();
  } else {
    resetView();
  }
});

// 键盘：方向键旋转、+/- 缩放
addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
  const step = 0.08;
  if (e.key === 'ArrowLeft') camYaw += step;
  else if (e.key === 'ArrowRight') camYaw -= step;
  else if (e.key === 'ArrowUp') camPitch = clampPitch(camPitch + step);
  else if (e.key === 'ArrowDown') camPitch = clampPitch(camPitch - step);
  else if (e.key === '+' || e.key === '=') camDistTarget = clampDist(camDistTarget * 0.85);
  else if (e.key === '-' || e.key === '_') camDistTarget = clampDist(camDistTarget * 1.18);
  else return;
  e.preventDefault();
});

document.getElementById('follow').onclick = () => wantFollow('follow');
document.getElementById('track').onclick = () => wantFollow('track');
document.getElementById('orbit').onclick = (e) => {
  S.showOrbit = !S.showOrbit; e.target.classList.toggle('on', S.showOrbit);
  updateOrbitLine();
};
// 默认只开轨道线。「跟随视角」必须默认关闭：否则用户随手点一颗卫星看参数，
// camTarget 就跳到那颗星上，地球被甩到画面一角，且不主动关掉就回不来。
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
  if (e.key === 'r' && document.activeElement.tagName !== 'INPUT') resetView();
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
      COV.groupDirty = true;                   // 主循环下一帧统一重建
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
    COV.groupDirty = true;                     // 主循环下一帧统一重建
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
  if (COV.mode === 'group') COV.groupDirty = true; else updateCoverage(simTime());
};

// ---------- 链路面板 ----------
const hideLinks = () => { for (const L of LINK_OBJS) L.obj.visible = false; };
document.getElementById('linkBtn').onclick = (e) => {
  LK.on = !LK.on;
  document.getElementById('linkPanel').classList.toggle('show', LK.on);
  e.target.classList.toggle('on', LK.on);
  if (LK.on) { updateStInfo(); updateLinks(); } else hideLinks();
};
document.getElementById('linkClose').onclick = () => {
  LK.on = false;
  document.getElementById('linkPanel').classList.remove('show');
  document.getElementById('linkBtn').classList.remove('on');
  hideLinks();
};
document.getElementById('lkGround').onchange = (e) => { LK.ground = e.target.checked; updateLinks(); };
document.getElementById('lkFeeder').onchange = (e) => { LK.feeder = e.target.checked; updateLinks(); };
document.getElementById('lkIsl').onchange = (e) => { LK.isl = e.target.checked; updateLinks(); };
document.getElementById('lkSun').onchange = (e) => { LK.sunAvoid = e.target.checked; updateLinks(); };
document.getElementById('lkMax').onchange = (e) => {
  LK.maxKm = Math.max(200, Math.min(12000, +e.target.value || 5000));
  e.target.value = LK.maxKm; updateLinks();
};
document.getElementById('lkDeg').onchange = (e) => {
  LK.deg = Math.max(0, Math.min(8, +e.target.value || 4));
  e.target.value = LK.deg; updateLinks();
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
      marker.visible = camDist > R_EARTH * 1.02;      // 相机已不可能进地表，这里只做兜底
      const ms = Math.max(camDist * 0.004, 4);
      marker.scale.setScalar(ms / (R_EARTH * 0.012));
      satModel.position.set(p[0], p[1], p[2]);
      satModel.visible = camDist < R_EARTH * 1.8;     // 近距离才渲染实体模型，远处用 marker
      const s2 = Math.max(camDist * 0.025, 6);
      satModel.scale.setScalar(s2);
      satModel.lookAt(camera.position);
      // 地球锁定居中时，相机目标钉死在地心：任何路径都不能把地球甩出画面中心
      if (LOCK.on) camTarget.set(0, 0, 0);
      else if (S.follow || S.track) camTarget.set(p[0], p[1], p[2]);
    }
    updateInfo();
    if (S.showOrbit && Math.floor(tMs / 2000) !== Math.floor((tMs - dt * 1000 * S.rate) / 2000)) updateOrbitLine();
  } else if (LOCK.on) {
    camTarget.set(0, 0, 0);
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
  S.sunDir = [sunEcef[0], sunEcef[2], -sunEcef[1]];   // 场景系单位向量（星间太阳规避用）
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

  // 覆盖范围：单星 1 Hz 跟随；星座模式是叠加覆盖带，改为事件驱动重建
  // （过滤/仰角/分组变化，或仿真时间跳变超过 10 分钟），不再每秒重建上千个三角形
  if (COV.on) {
    if (COV.mode === 'group') {
      const sig = `${S.soloCon}|${S.visibleCount}|${COV.minEl}`;
      if (COV.groupDirty || sig !== COV.groupSig || Math.abs(tMs - (COV.groupT0 || 0)) > 600000) {
        COV.groupSig = sig; COV.groupDirty = false; COV.groupT0 = tMs;
        updateGroupCoverage(tMs);
      }
    } else if (S.selected && (!S._lastCov || now - S._lastCov > 1000)) {
      S._lastCov = now;
      updateCoverage(tMs);
    }
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
  // 双保险：canvas 是 replaced element，CSS 的 width:auto 会取固有宽度（= buffer 宽）。
  // dpr=2 时 buffer 是视口的 2 倍，元素会被布局成 2 倍大、只有左上 1/4 可见，
  // 其中心正好落在视口右下角——表现为"地球被锁在了右下角"。这里显式钉死 CSS 尺寸。
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------- 启动 ----------
window.__dbg = {
  earth, earthMat, sunLight, scene, camera, S, THREE, TRK, buildTracks, scheduleTracks,
  LK, COV, FEED, PASS, LINK_OBJS, islContacts, predictPasses, updateLinks, updateGroupInfo, simTime,
  // 调试用：yaw 为经度取负、pitch 为纬度（弧度），dist 单位 km
  setView: (yaw, pitch, dist) => {
    camYaw = yaw; camPitch = clampPitch(pitch);
    camDist = camDistTarget = clampDist(dist);
    camTarget.set(0, 0, 0);
  },
  pickStationAt,
  // 回归测试用：用页面自身的 fastPos 算某对象的屏幕坐标（外部复现递推会有偏差，点不中）
  screenOf: (o) => {
    const p = fastPos(o, simTime());
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: Math.round((v.x * 0.5 + 0.5) * r.width), y: Math.round((-v.y * 0.5 + 0.5) * r.height) };
  },
};
resize();
loadCatalog().then(() => {
  computeConAlts();
  loadFeeder().then(() => { updateStInfo(); if (LK.on) updateLinks(); });
  requestAnimationFrame(tick);
  if (!localStorage.getItem('guideSeen')) setTimeout(() => showGuide(true), 900);
}).catch((e) => {
  console.error('编目加载失败', e);            // showLoadFail 已在页面里给出可操作提示
});
