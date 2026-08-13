/* 플래그 맵 제작기 — 프로토타입
   - 국가 클릭 → 국기 지정(실제 국기 / 디자인 / 이미지 / 단색)
   - 다중 선택 → 병합(하나의 나라처럼 국기 공유 + 내부 국경 제거)
   - 국기 위치/크기/회전 수동 조절, RGBA 색상, SVG·PNG 내보내기, 국가 정리
*/
'use strict';

const SVGNS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ------------------------------------------------------------------ state */
const S = {
  entities: {},        // id -> {id, name, members:[iso], flag, place, hidden}
  c2e: {},             // iso -> entityId
  sel: new Set(),      // selected entity ids
  seq: 0,
  gseq: 0,             // 그룹 id 카운터
  activeUnit: null,    // 병합 내부에서 지금 편집 중인 단위 key
  tool: 'pick',        // 'pick' = 클릭 선택, 'rect' = 직사각형 선택
  opt: {               // 색상은 #rrggbbaa (8자리 hex)
    ocean:'#dfe9f3ff', land:'#f4f4f2ff', border:'#8a8f98ff', bw:1,
    fit:false, perCountry:false, exportW:4000
  }
};
const COUNTRIES = [];        // {iso, title}
const PATHS = {};            // iso -> [<path>]
const BBOX  = {};            // iso -> {x,y,w,h}
const ORIG  = {};            // iso -> 원래 이름
let svg, defs, gPoly, gFlag, gOutline, gSelect, gHandle, gMarquee, oceanRect, baseVB;
const history = [];

/* --------------------------------------------------------------- 색상 유틸 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** '#rrggbb' + 0~1 → '#rrggbbaa' */
const joinHex = (rgb, a) =>
  rgb.slice(0, 7) + Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');
/** '#rrggbbaa' → {c:'#rrggbb', o:0~1} */
const splitHex = v => ({
  c: (v || '#000000').slice(0, 7),
  o: (v && v.length > 7) ? parseInt(v.slice(7, 9), 16) / 255 : 1
});
/** SVG 요소에 fill/stroke + -opacity 로 나눠 적용 (내보낸 SVG 호환성) */
function setPaint(el, prop, v) {
  const { c, o } = splitHex(v);
  el.setAttribute(prop, c);
  el.setAttribute(prop + '-opacity', +o.toFixed(4));
}
const paintAttr = v => { const { c, o } = splitHex(v); return `fill="${c}" fill-opacity="${+o.toFixed(4)}"`; };

/* ------------------------------------------------------------------- init */
function boot() {
  const bytes = Uint8Array.from(atob(window.MAP_SVG_B64), c => c.charCodeAt(0));
  const text = new TextDecoder('utf-8').decode(bytes);
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  svg = doc.documentElement;
  svg.removeAttribute('style');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  $('#map-wrap').appendChild(document.adoptNode(svg));

  const vb = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
  baseVB = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };

  gPoly = svg.querySelector('#polygons');

  defs = document.createElementNS(SVGNS, 'defs');
  defs.id = 'fm-defs';
  svg.insertBefore(defs, svg.firstChild);

  oceanRect = el('rect', { id:'fm-ocean', x: baseVB.x - baseVB.w, y: baseVB.y - baseVB.h,
                           width: baseVB.w * 3, height: baseVB.h * 3 });
  svg.insertBefore(oceanRect, gPoly);

  gFlag    = el('g', { id:'fm-flags',    'pointer-events':'none' });
  gOutline = el('g', { id:'fm-outlines', 'pointer-events':'none' });
  gSelect  = el('g', { id:'fm-select',   'pointer-events':'none' });
  gHandle  = el('g', { id:'fm-handle' });
  gMarquee = el('g', { id:'fm-marquee', 'pointer-events':'none' });
  svg.append(gFlag, gOutline, gSelect, gHandle, gMarquee);

  // 국가 목록 / 엔티티 초기화 (동일 id 를 가진 path 가 여러 개일 수 있음)
  gPoly.querySelectorAll('path').forEach(p => {
    const iso = p.getAttribute('id');
    if (!iso) return;
    p.removeAttribute('class');
    if (!PATHS[iso]) {
      const title = p.getAttribute('title') || iso;
      PATHS[iso] = [];
      ORIG[iso] = title;
      COUNTRIES.push({ iso, title });
      addEntity(title, [iso]);
    }
    PATHS[iso].push(p);
  });
  COUNTRIES.sort((a, b) => a.title.localeCompare(b.title));
  for (const iso in PATHS) {
    const b = PATHS[iso].reduce((acc, p) => {
      const r = p.getBBox();
      return acc ? { x:Math.min(acc.x,r.x), y:Math.min(acc.y,r.y),
                     X:Math.max(acc.X,r.x+r.width), Y:Math.max(acc.Y,r.y+r.height) }
                 : { x:r.x, y:r.y, X:r.x+r.width, Y:r.y+r.height };
    }, null);
    BBOX[iso] = { x:b.x, y:b.y, w:Math.max(b.X-b.x, 1e-3), h:Math.max(b.Y-b.y, 1e-3) };
  }

  buildFilters();
  initUI();
  setView(baseVB);
  render();
}

function el(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function addEntity(name, members) {
  const id = 'E' + (++S.seq);
  S.entities[id] = { id, name, members: [...members], flag: null, place: null, hidden: false,
                     flagMode: 'clamp', flagBg: null,
                     flagScope: 'whole', parts: {}, groups: [] };
  members.forEach(m => S.c2e[m] = id);
  return id;
}
const entOf = iso => S.entities[S.c2e[iso]];

/* ------------------------------------------------------ 인접 그래프 / 속령 */

/** 속령으로 취급하는 항목 (값 = 본국 ISO 코드).
 *  나무위키 '속령' 문서의 분류를 이 지도의 257개 폴리곤에 대조한 것으로,
 *  문서가 나눈 '통합 해외영토(본토의 일부 — GF·GP·MQ·RE·YT·BQ·SJ·HK·MO·AX)' 와
 *  '속령' 을 구분하지 않고 **모두 속령으로 함께 다룬다**.
 *  남극(AQ)만 예외 — 어느 나라의 영토도 아니므로 일반 항목으로 둔다.
 *  PS·TW·XK 는 (부분)승인 국가로 보아 포함하지 않는다. */
const TERRITORY_OF = {
  // 프랑스 — 해외 레지옹 · 해외집합체 · 특별공동체 · 해외영토(TOM)
  GF:'FR', GP:'FR', MQ:'FR', RE:'FR', YT:'FR',
  BL:'FR', MF:'FR', PF:'FR', PM:'FR', WF:'FR', NC:'FR',
  TF:'FR', GO:'FR', JU:'FR',
  // 영국 — 왕실령 · 해외영토
  IM:'GB', GG:'GB', JE:'GB',
  AI:'GB', BM:'GB', FK:'GB', GI:'GB', GS:'GB', IO:'GB', KY:'GB',
  MS:'GB', PN:'GB', SH:'GB', TC:'GB', VG:'GB',
  // 미국 — 해외영토 · 군소 제도
  AS:'US', GU:'US', MP:'US', PR:'US', VI:'US',
  'UM-DQ':'US', 'UM-FQ':'US', 'UM-HQ':'US', 'UM-JQ':'US', 'UM-MQ':'US', 'UM-WQ':'US',
  // 네덜란드 — 카리브 네덜란드 · 왕국 구성국
  BQ:'NL', AW:'NL', CW:'NL', SX:'NL',
  // 중국 — 특별행정구
  HK:'CN', MO:'CN',
  // 호주 — 외부영토
  CC:'AU', CX:'AU', HM:'AU', NF:'AU',
  // 뉴질랜드 — 속령 · 자유연합
  TK:'NZ', CK:'NZ', NU:'NZ',
  // 덴마크 · 노르웨이 · 핀란드
  GL:'DK', FO:'DK', BV:'NO', SJ:'NO', AX:'FI',
  // 주권 미확정 (유엔 비자치지역)
  EH:''
};

/** 확장 병합에서 '속령 포함'을 끄면 제외되는 항목 */
const TERRITORY = new Set(Object.keys(TERRITORY_OF));

/** 국경이 맞닿은 나라 그래프. 이 SVG 는 이웃한 나라끼리 꼭짓점 좌표가 정확히
 *  일치하므로(비이웃은 0개) 좌표 해시로 정확한 인접 관계를 얻을 수 있다.
 *  꼭짓점 1개만 닿는 경우는 국경이 아니라 점 접촉이므로 제외(2개 이상). */
let ADJ = null;
function adjacency() {
  if (ADJ) return ADJ;
  const cell = new Map();
  const re = /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g;
  for (const iso in PATHS) {
    for (const p of PATHS[iso]) {
      const d = p.getAttribute('d');
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(d))) {
        const k = m[1] + ',' + m[2];
        let s = cell.get(k);
        if (!s) cell.set(k, s = new Set());
        s.add(iso);
      }
    }
  }
  const pairs = new Map();
  for (const s of cell.values()) {
    if (s.size < 2) continue;
    const a = [...s];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const k = a[i] < a[j] ? a[i] + '|' + a[j] : a[j] + '|' + a[i];
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  ADJ = {};
  for (const [k, n] of pairs) {
    if (n < 2) continue;
    const [a, b] = k.split('|');
    (ADJ[a] || (ADJ[a] = new Set())).add(b);
    (ADJ[b] || (ADJ[b] = new Set())).add(a);
  }
  return ADJ;
}

/** 엔티티와 국경을 맞댄 다른 엔티티들 */
function neighborEntities(ent, incTerr) {
  const adj = adjacency(), out = new Set();
  ent.members.forEach(m => (adj[m] || []).forEach(n => {
    const e2 = entOf(n);
    if (!e2 || e2.id === ent.id || e2.hidden) return;
    if (!incTerr && e2.members.every(x => TERRITORY.has(x))) return;
    out.add(e2.id);
  }));
  return out;
}

/** 포함된 나라의 속령을 함께 넣는다. 속령은 본국과 국경을 맞대지 않는 경우가
 *  대부분이라(프랑스↔프랑스령 기아나) 인접 탐색으로는 닿지 않으므로 따로 붙인다.
 *  단, 붙인 속령이 다시 인접 탐색의 발판이 되지는 않는다(바다 건너 엉뚱한 확산 방지). */
function attachTerritories(all) {
  const isos = new Set([...all].flatMap(id => (S.entities[id] || { members:[] }).members));
  for (let pass = 0; pass < 3; pass++) {
    let added = false;
    for (const t in TERRITORY_OF) {
      const parent = TERRITORY_OF[t];
      if (!parent || !isos.has(parent)) continue;
      const e2 = entOf(t);
      if (!e2 || e2.hidden || all.has(e2.id)) continue;
      all.add(e2.id);
      e2.members.forEach(m => isos.add(m));
      added = true;
    }
    if (!added) break;
  }
  return all;
}

/** 선택을 depth 단계만큼 인접 방향으로 넓힌 엔티티 집합 */
function expandSelection(depth, incTerr) {
  const all = new Set(S.sel);
  let frontier = new Set(S.sel);
  for (let d = 0; d < depth; d++) {
    const next = new Set();
    frontier.forEach(id => {
      const ent = S.entities[id];
      if (ent) neighborEntities(ent, incTerr).forEach(nid => {
        if (!all.has(nid)) { all.add(nid); next.add(nid); }
      });
    });
    if (!next.size) break;
    frontier = next;
  }
  return incTerr ? attachTerritories(all) : all;
}

/* ------------------------------------------- filters (병합 외곽선 / 선택 표시) */
function buildFilters() {
  const mk = (id, radius, color) => {
    const f = el('filter', { id, 'color-interpolation-filters':'sRGB',
                             x:'-20%', y:'-20%', width:'140%', height:'140%' });
    f.appendChild(el('feMorphology', { in:'SourceAlpha', operator:'dilate', radius, result:'d' }));
    f.appendChild(el('feComposite', { in:'d', in2:'SourceAlpha', operator:'out', result:'ring' }));
    f.appendChild(el('feFlood', { 'flood-color':color, result:'c' }));
    f.appendChild(el('feComposite', { in:'c', in2:'ring', operator:'in' }));
    defs.appendChild(f);
  };
  mk('fm-f-outline', 0.1, '#8a8f98');
  mk('fm-f-select', 0.3, '#4c9aff');
}
/** 화면 1px 이 사용자 좌표계에서 몇 단위인지 (preserveAspectRatio="meet" 기준) */
function userPerPx() {
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return VB.w / 1000;
  return Math.max(VB.w / r.width, VB.h / r.height);
}
/** 확대/축소해도 외곽선 굵기가 일정하도록 feMorphology 반경을 다시 계산 */
function tuneFilters(upp = userPerPx()) {
  const o = defs.querySelector('#fm-f-outline');
  const { c, o: op } = splitHex(S.opt.border);
  o.querySelector('feMorphology').setAttribute('radius', Math.max(S.opt.bw * upp, 1e-4));
  o.querySelector('feFlood').setAttribute('flood-color', c);
  o.querySelector('feFlood').setAttribute('flood-opacity', +op.toFixed(4));
  defs.querySelector('#fm-f-select feMorphology')
      .setAttribute('radius', Math.max(2.5 * upp, 1e-4));
}

/* --------------------------------------------------------------- 국기 생성 */
const STAR = 'M0,-1 L0.2245,-0.309 L0.951,-0.309 L0.363,0.118 L0.588,0.809 L0,0.382 L-0.588,0.809 L-0.363,0.118 L-0.951,-0.309 L-0.2245,-0.309 Z';

function designSVG(d) {
  const W = 900, H = 600, n = d.colors.length;
  let body = '';
  if (d.dir === 'h') {
    d.colors.forEach((c, i) => body += `<rect x="0" y="${i*H/n}" width="${W}" height="${H/n+.5}" ${paintAttr(c)}/>`);
  } else if (d.dir === 'v') {
    d.colors.forEach((c, i) => body += `<rect x="${i*W/n}" y="0" width="${W/n+.5}" height="${H}" ${paintAttr(c)}/>`);
  } else {
    const band = 1400 / n;
    body += `<rect width="${W}" height="${H}" ${paintAttr(d.colors[0])}/>`;
    body += `<g transform="rotate(-35 450 300)">`;
    d.colors.forEach((c, i) => body += `<rect x="-400" y="${-400 + i*band}" width="1700" height="${band+.5}" ${paintAttr(c)}/>`);
    body += `</g>`;
  }
  const s = d.size, ec = paintAttr(d.ec);
  switch (d.emblem) {
    case 'circle':   body += `<circle cx="450" cy="300" r="${2.6*s}" ${ec}/>`; break;
    case 'star':     body += `<g transform="translate(450,300) scale(${2.8*s})"><path d="${STAR}" ${ec}/></g>`; break;
    case 'cross': {
      const t = 1.1 * s;
      body += `<rect x="${330-t/2}" y="0" width="${t}" height="${H}" ${ec}/>`;
      body += `<rect x="0" y="${300-t/2}" width="${W}" height="${t}" ${ec}/>`; break;
    }
    case 'canton':   body += `<rect x="0" y="0" width="${4.5*s}" height="${3*s}" ${ec}/>`; break;
    case 'triangle': body += `<polygon points="0,0 ${9*s},300 0,600" ${ec}/>`; break;
  }
  return `<svg xmlns="${SVGNS}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}</svg>`;
}
const dataURL = svgStr => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);

function flagHref(flag) {
  if (!flag) return null;
  if (flag.type === 'design') return dataURL(designSVG(flag));
  if (flag.type === 'image')  return flag.href;
  return null;                                   // solid 은 path 를 직접 칠한다
}

/* --------------------------------------------------------------- 국기 배치 */
function unionBBox(members) {
  let x=Infinity, y=Infinity, X=-Infinity, Y=-Infinity;
  members.forEach(m => {
    const b = BBOX[m]; if (!b) return;
    x = Math.min(x, b.x); y = Math.min(y, b.y);
    X = Math.max(X, b.x + b.w); Y = Math.max(Y, b.y + b.h);
  });
  return { x, y, w: Math.max(X-x, 1e-3), h: Math.max(Y-y, 1e-3) };
}
/* ------------------------------------------------- 국기 단위(unit) 모델
   병합된 국가 안에서 국기를 전체 하나 / 나라별 / 그룹별로 나눠 지정할 수 있다.
   unit = { key, name, members, raw }  ·  raw 는 편집 대상이 되는 객체
   (엔티티 자신 · ent.parts[iso] · ent.groups[n]). raw 에 없는 속성은 엔티티 값을 상속. */
function unitsOf(ent) {
  const scope = ent.flagScope || 'whole';
  if (scope === 'each')
    return ent.members.map(m => ({ key: ent.id + '#' + m, name: ORIG[m] || m,
                                   members: [m], raw: (ent.parts && ent.parts[m]) || {} }));
  if (scope === 'group') {
    const used = new Set(), us = [];
    (ent.groups || []).forEach(g => {
      const ms = g.members.filter(m => ent.members.includes(m) && !used.has(m));
      ms.forEach(m => used.add(m));
      if (ms.length) us.push({ key: ent.id + '#' + g.gid, name: g.name, members: ms, raw: g });
    });
    const rest = ent.members.filter(m => !used.has(m));
    if (rest.length) us.push({ key: ent.id + '#rest', name: '나머지', members: rest, raw: ent });
    return us;
  }
  return [{ key: ent.id, name: ent.name, members: ent.members, raw: ent }];
}
/** raw 의 미지정 속성을 엔티티 값으로 채운 실제 표시용 속성 */
function resolve(ent, raw) {
  if (raw === ent) return ent;
  return { flag: ('flag' in raw) ? raw.flag : ent.flag,
           place: raw.place || null,
           flagMode: raw.flagMode || ent.flagMode || 'clamp',
           flagBg: raw.flagBg || ent.flagBg };
}
/** 화면에 그릴 모든 단위 */
function renderUnits() {
  const out = [];
  for (const id in S.entities) {
    const ent = S.entities[id];
    if (!visible(ent)) continue;
    unitsOf(ent).forEach(u => out.push({ ...u, ent, props: resolve(ent, u.raw) }));
  }
  return out;
}
const uid = u => u.key.replace(/[^\w-]/g, '_');
let UNITS = [], ISO2UNIT = {};        // render() 에서 매번 갱신
const autoBox = u => unionBBox(u.members);
const flagBox = u => u.props.place
  ? { x:u.props.place.x, y:u.props.place.y, w:u.props.place.w, h:u.props.place.h }
  : autoBox(u);
/** 국기를 나라별로 반복할지 (수동 배치 중이면 항상 하나) */
const perCountry = u => !u.props.place && S.opt.perCountry && u.members.length > 1;

/* ------------------------------------------------------------------ render */
function render() {
  UNITS = renderUnits();
  ISO2UNIT = {};
  UNITS.forEach(u => u.members.forEach(m => ISO2UNIT[m] = u));
  paintClips();
  paintFills();
  paintFlags();
  paintOutlines();
  paintSelection();
  paintHandle();
  updatePanel();
  updateMergedList();
}

const visible = ent => ent && !ent.hidden;

function clonePaths(members, attrs) {
  const g = el('g', attrs);
  members.forEach(m => (PATHS[m] || []).forEach(p => {
    const c = p.cloneNode(false);
    c.removeAttribute('id');
    c.removeAttribute('display');
    c.setAttribute('fill', '#000');
    c.setAttribute('fill-opacity', 1);
    c.setAttribute('stroke', 'none');
    g.appendChild(c);
  }));
  return g;
}

/** 국기 이미지를 국가 모양 안쪽으로만 그리기 위한 clipPath */
function paintClips() {
  [...defs.querySelectorAll('clipPath')].forEach(c => c.remove());
  UNITS.forEach(u => {
    if (!flagHref(u.props.flag)) return;
    const cp = el('clipPath', { id:'clip_' + uid(u) });
    u.members.forEach(m => (PATHS[m] || []).forEach(p => {
      const c = p.cloneNode(false);
      c.removeAttribute('id');
      cp.appendChild(c);
    }));
    defs.appendChild(cp);
  });
}

function paintFills() {
  setPaint(oceanRect, 'fill', S.opt.ocean);
  for (const iso in PATHS) {
    const ent = entOf(iso);
    const merged = ent.members.length > 1;
    PATHS[iso].forEach(p => {
      if (ent.hidden) { p.setAttribute('display', 'none'); return; }
      p.removeAttribute('display');
      const f = (ISO2UNIT[iso] || { props:ent }).props.flag;
      setPaint(p, 'fill', f && f.type === 'solid' ? f.color : S.opt.land);
      // 병합된 나라는 내부 국경을 지우고, 바깥 테두리는 외곽선 레이어가 그린다
      if (merged) {
        p.setAttribute('stroke', 'none');
        p.removeAttribute('stroke-opacity');
      } else {
        setPaint(p, 'stroke', S.opt.border);
      }
      p.setAttribute('stroke-width', merged ? 0 : S.opt.bw);
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
    });
  }
}

const fitPA = () => S.opt.fit ? 'xMidYMid slice' : 'none';

function imageEl(href, w, h, x = 0, y = 0) {
  const img = el('image', { x, y, width:w, height:h, preserveAspectRatio: fitPA() });
  img.setAttribute('href', href);
  img.setAttributeNS(XLINK, 'xlink:href', href);
  return img;
}

/** 국기 상자가 국가를 다 덮지 못해 바깥을 채워야 하는 영역 (필요 없으면 null).
 *  회전 중심에서 국가 bbox 까지의 최대 거리를 반지름으로 하는 정사각형 →
 *  회전해도 국가를 항상 덮는다. (어차피 clipPath 로 잘리므로 넉넉해도 무방) */
function coverBox(u, b) {
  const bb = autoBox(u);
  const rot = (u.props.place && u.props.place.rot) || 0;
  if (!rot && b.x <= bb.x && b.y <= bb.y &&
      b.x + b.w >= bb.x + bb.w && b.y + b.h >= bb.y + bb.h) return null;
  const cx = b.x + b.w/2, cy = b.y + b.h/2;
  const R = 1.2 * Math.hypot(Math.max(Math.abs(bb.x - cx), Math.abs(bb.x + bb.w - cx)),
                             Math.max(Math.abs(bb.y - cy), Math.abs(bb.y + bb.h - cy)));
  return { x: cx - R, y: cy - R, w: 2*R, h: 2*R };
}

/** 가장자리 늘이기: 중앙 1 + 상하좌우 4 + 모서리 4 = 9조각.
 *  중첩 <svg> 의 viewBox 로 국기의 가장자리 한 줄만 잘라 무한히 늘인다.
 *  (내부 좌표계를 상자 크기와 같게 잡아 중앙 조각과 잘림/비율이 정확히 일치) */
function clampPieces(g, href, b, cover) {
  const EXT = Math.max(cover.w, cover.h) + Math.max(b.w, b.h);
  const eps = Math.max(Math.min(b.w, b.h) * 0.01, 1e-4);
  const piece = (px, py, pw, ph, vx, vy, vw, vh) => {
    const s = el('svg', { x:px, y:py, width:pw, height:ph,
                          viewBox:`${vx} ${vy} ${vw} ${vh}`, preserveAspectRatio:'none' });
    s.appendChild(imageEl(href, b.w, b.h));
    g.appendChild(s);
  };
  // 조각 경계의 안티에일리어싱 틈(hairline)을 없애려고 안쪽으로 ov 만큼 겹치게 그리고,
  // 겹친 부분은 항상 뒤에 그리는 조각(모서리 → 변 → 중앙 순)이 덮도록 한다.
  const ov = Math.max(b.w, b.h) * 0.02;
  const L = b.x - EXT, T = b.y - EXT, Rt = b.x + b.w - ov, Bt = b.y + b.h - ov;
  piece(L,   T,    EXT+ov, EXT+ov,  0,        0,        eps, eps);   // 좌상
  piece(Rt,  T,    EXT+ov, EXT+ov,  b.w-eps,  0,        eps, eps);   // 우상
  piece(L,   Bt,   EXT+ov, EXT+ov,  0,        b.h-eps,  eps, eps);   // 좌하
  piece(Rt,  Bt,   EXT+ov, EXT+ov,  b.w-eps,  b.h-eps,  eps, eps);   // 우하
  piece(L,   b.y,  EXT+ov, b.h,     0,        0,        eps, b.h);   // 좌
  piece(Rt,  b.y,  EXT+ov, b.h,     b.w-eps,  0,        eps, b.h);   // 우
  piece(b.x, T,    b.w,    EXT+ov,  0,        0,        b.w, eps);   // 상
  piece(b.x, Bt,   b.w,    EXT+ov,  0,        b.h-eps,  b.w, eps);   // 하
  piece(b.x, b.y,  b.w,    b.h,     0,        0,        b.w, b.h);   // 중앙
}

/** 국기 상자 + 바깥 채움(모드별)을 g 에 그린다 */
function fillFlag(g, u, href, b) {
  const cover = coverBox(u, b);
  const mode = u.props.flagMode || 'clamp';
  if (cover && mode === 'clamp') { clampPieces(g, href, b, cover); return; }
  if (cover && mode === 'tile') {                       // 패턴으로 무한 반복
    const pid = 'tile_' + uid(u);
    const pat = el('pattern', { id:pid, patternUnits:'userSpaceOnUse',
                                x:b.x, y:b.y, width:b.w, height:b.h });
    pat.appendChild(imageEl(href, b.w, b.h));
    defs.appendChild(pat);
    g.appendChild(el('rect', { x:cover.x, y:cover.y, width:cover.w, height:cover.h,
                               fill:`url(#${pid})` }));
    return;                                             // 반복 패턴이 중앙까지 포함
  }
  if (cover && mode === 'solid') {                      // 단색 + 국기 한 장
    const r = el('rect', { x:cover.x, y:cover.y, width:cover.w, height:cover.h });
    setPaint(r, 'fill', u.props.flagBg || S.opt.land);
    g.appendChild(r);
  }
  g.appendChild(imageEl(href, b.w, b.h, b.x, b.y));
}

function paintFlags() {
  gFlag.textContent = '';
  [...defs.querySelectorAll('pattern')].forEach(p => p.remove());
  UNITS.forEach(u => {
    const href = flagHref(u.props.flag);
    if (!href) return;
    const outer = el('g', { 'clip-path': `url(#clip_${uid(u)})` });
    if (perCountry(u)) {                                // 나라별 반복: 각 bbox 에 한 장씩
      u.members.forEach(m => outer.appendChild(
        imageEl(href, BBOX[m].w, BBOX[m].h, BBOX[m].x, BBOX[m].y)));
    } else {
      const b = flagBox(u), rot = (u.props.place && u.props.place.rot) || 0;
      const g = rot ? el('g', { transform:`rotate(${rot} ${b.x+b.w/2} ${b.y+b.h/2})` }) : outer;
      fillFlag(g, u, href, b);
      if (g !== outer) outer.appendChild(g);
    }
    gFlag.appendChild(outer);
  });
}

function paintOutlines() {
  gOutline.textContent = '';
  if (S.opt.bw <= 0) return;
  tuneFilters();
  for (const id in S.entities) {
    const ent = S.entities[id];
    if (!visible(ent) || ent.members.length < 2) continue;
    gOutline.appendChild(clonePaths(ent.members, { filter:'url(#fm-f-outline)' }));
  }
}

function paintSelection() {
  gSelect.textContent = '';
  S.sel.forEach(id => {
    const ent = S.entities[id];
    if (!visible(ent)) return;
    gSelect.appendChild(clonePaths(ent.members, { filter:'url(#fm-f-select)' }));
  });
}

/** 수동 배치용 드래그 사각형 (편집 중인 단위에 대해) */
function paintHandle() {
  gHandle.textContent = '';
  const u = editUnit();
  if (!u || !u.props.place || !flagHref(u.props.flag)) return;
  const b = flagBox(u), upp = userPerPx(), r = 5 * upp;
  const rot = u.props.place.rot;
  const g = el('g', rot ? { transform:`rotate(${rot} ${b.x+b.w/2} ${b.y+b.h/2})` } : {});
  const box = el('rect', { x:b.x, y:b.y, width:b.w, height:b.h, fill:'none', stroke:'#4c9aff',
                           'stroke-width':1.5, 'stroke-dasharray':'5 4',
                           'vector-effect':'non-scaling-stroke', 'pointer-events':'all' });
  box.style.cursor = 'move';
  box.dataset.grab = 'move';
  g.appendChild(box);
  [['nw',b.x,b.y], ['ne',b.x+b.w,b.y], ['sw',b.x,b.y+b.h], ['se',b.x+b.w,b.y+b.h]].forEach(([k,x,y]) => {
    const h = el('circle', { cx:x, cy:y, r, fill:'#fff', stroke:'#4c9aff',
                             'stroke-width':1.5, 'vector-effect':'non-scaling-stroke' });
    h.style.cursor = (k === 'nw' || k === 'se') ? 'nwse-resize' : 'nesw-resize';
    h.dataset.grab = k;
    g.appendChild(h);
  });
  gHandle.appendChild(g);
}

/* ------------------------------------------------------- 편집 대상(단위) */
/** 지금 편집 중인 단위 (표시용 속성 포함). 범위가 '전체'면 엔티티 자체. */
function editUnit() {
  const ent = soloSelection();
  if (!ent) return null;
  const us = unitsOf(ent);
  const u = (ent.flagScope || 'whole') === 'whole'
    ? us[0]
    : us.find(x => x.key === S.activeUnit);
  return u ? { ...u, ent, props: resolve(ent, u.raw) } : null;
}
/** 편집 대상의 mutable 객체. 나라별 모드에서는 parts 항목을 이때 만든다. */
function editRaw() {
  const ent = soloSelection();
  if (!ent) return null;
  const scope = ent.flagScope || 'whole';
  if (scope === 'whole') return ent;
  const u = unitsOf(ent).find(x => x.key === S.activeUnit);
  if (!u || u.raw === ent) return u ? ent : null;      // '나머지' 는 엔티티 자체
  if (scope === 'each') {
    const iso = u.members[0];
    ent.parts = ent.parts || {};
    return (ent.parts[iso] = ent.parts[iso] || u.raw);
  }
  return u.raw;                                        // 그룹 객체
}
/** 위치 조절이 가능한 국기인가 (단색·국기 없음은 불가) */
const placeable = u => !!(u && flagHref(u.props.flag));

/* ------------------------------------------------------- 직사각형 선택 도구 */
const rectOf = m => ({ x1:Math.min(m.x0, m.x1), y1:Math.min(m.y0, m.y1),
                       x2:Math.max(m.x0, m.x1), y2:Math.max(m.y0, m.y1) });

function paintMarquee(m) {
  gMarquee.textContent = '';
  if (!m) return;
  const r = rectOf(m);
  gMarquee.appendChild(el('rect', {
    x:r.x1, y:r.y1, width:r.x2-r.x1, height:r.y2-r.y1,
    fill:'#4c9aff', 'fill-opacity':0.15, stroke:'#4c9aff', 'stroke-width':1.5,
    'stroke-dasharray':'5 4', 'vector-effect':'non-scaling-stroke'
  }));
}

/** 사각형에 국토가 실제로 걸치는 엔티티들. bbox 로 후보를 거른 뒤
 *  겹치는 영역만 격자로 찍어 isPointInFill 로 확인한다 (bbox 만 쓰면
 *  해외 영토 때문에 bbox 가 큰 나라가 과선택된다). */
function entitiesInRect(r) {
  const out = new Set();
  const pt = svg.createSVGPoint();
  for (const iso in PATHS) {
    const ent = entOf(iso);
    if (!visible(ent) || out.has(ent.id)) continue;
    const b = BBOX[iso];
    if (b.x > r.x2 || b.x + b.w < r.x1 || b.y > r.y2 || b.y + b.h < r.y1) continue;
    if (b.x >= r.x1 && b.y >= r.y1 && b.x + b.w <= r.x2 && b.y + b.h <= r.y2) {
      out.add(ent.id); continue;                       // bbox 가 통째로 들어옴
    }
    const x1 = Math.max(b.x, r.x1), y1 = Math.max(b.y, r.y1);
    const x2 = Math.min(b.x + b.w, r.x2), y2 = Math.min(b.y + b.h, r.y2);
    const N = 12;
    let found = false;
    for (let i = 0; i <= N && !found; i++) {
      for (let j = 0; j <= N && !found; j++) {
        pt.x = x1 + (x2 - x1) * i / N;
        pt.y = y1 + (y2 - y1) * j / N;
        found = PATHS[iso].some(p => p.isPointInFill(pt));
      }
    }
    if (found) out.add(ent.id);
  }
  return out;
}

function setTool(t) {
  S.tool = t;
  $$('#tool-ctl button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  svg.classList.toggle('rect-tool', t === 'rect');
  $('#hint').textContent = t === 'rect'
    ? '드래그: 범위 선택 · Ctrl/Shift+드래그: 추가 선택 · Alt(또는 휠 클릭)+드래그: 이동 · 휠: 확대'
    : '클릭: 선택 · Ctrl/Shift+클릭: 다중 선택 · 드래그: 이동 · 휠: 확대';
}

function soloSelection() {
  if (S.sel.size !== 1) return null;
  const ent = S.entities[[...S.sel][0]];
  return visible(ent) ? ent : null;
}

/* ------------------------------------------------------------- pan & zoom */
let VB = { x:0, y:0, w:0, h:0 };
function setView(v) {
  VB = { ...v };
  svg.setAttribute('viewBox', `${VB.x} ${VB.y} ${VB.w} ${VB.h}`);
  tuneFilters();
  if (gHandle && gHandle.children.length) paintHandle();   // 손잡이 크기 유지
}
function zoomAt(cx, cy, k) {
  const nw = Math.min(baseVB.w * 4, Math.max(baseVB.w / 400, VB.w * k));
  const s = nw / VB.w;
  setView({ x: cx - (cx - VB.x) * s, y: cy - (cy - VB.y) * s, w: nw, h: VB.h * s });
}
function toUser(evt) {
  const r = svg.getBoundingClientRect();
  const sc = Math.max(VB.w / r.width, VB.h / r.height);           // preserveAspectRatio=meet
  return { x: VB.x + VB.w/2 + (evt.clientX - r.left - r.width/2) * sc,
           y: VB.y + VB.h/2 + (evt.clientY - r.top - r.height/2) * sc };
}
function fitTo(box, pad = 1.8) {
  const w = Math.max(box.w * pad, baseVB.w / 60);
  const h = Math.max(box.h * pad, baseVB.h / 60);
  const k = Math.max(w / baseVB.w, h / baseVB.h);
  setView({ w: baseVB.w * k, h: baseVB.h * k,
            x: box.x + box.w/2 - baseVB.w*k/2, y: box.y + box.h/2 - baseVB.h*k/2 });
}
/** 점을 (cx,cy) 기준으로 -deg 회전 */
function unrotate(p, cx, cy, deg) {
  if (!deg) return p;
  const a = -deg * Math.PI / 180, dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx*Math.cos(a) - dy*Math.sin(a), y: cy + dx*Math.sin(a) + dy*Math.cos(a) };
}

/* ------------------------------------------------------------ interaction */
function initUI() {
  /* --- 지도: 이동 / 확대 / 선택 / 국기 배치 드래그 --- */
  let drag = null, moved = false, hit = null, grab = null, marq = null;
  const pathAt = e => (e.target.closest && e.target.closest('#polygons path')) || null;

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault();         // 휠 클릭 자동스크롤 방지
    const p = toUser(e);
    const g = e.button === 0 && e.target.dataset && e.target.dataset.grab;
    // 직사각형 도구여도 Alt / 휠 클릭이면 이동
    const panning = S.tool === 'pick' || e.button === 1 || e.altKey;
    if (g) {                                        // 국기 배치 손잡이
      const raw = editRaw();
      grab = { mode:g, raw, start:p, box:{ ...raw.place } };
      snapshot();
    } else {
      // 포인터 캡처를 걸면 pointerup 의 target 이 svg 로 바뀌므로 여기서 대상을 기억해 둔다
      hit = pathAt(e);
      if (panning) drag = { ...p, sx:e.clientX, sy:e.clientY };
      else marq = { x0:p.x, y0:p.y, x1:p.x, y1:p.y, sx:e.clientX, sy:e.clientY,
                    add: e.ctrlKey || e.shiftKey };
    }
    moved = false;
    svg.setPointerCapture(e.pointerId);
    if (drag) svg.classList.add('panning');
  });

  svg.addEventListener('pointermove', e => {
    if (grab) {
      const p = toUser(e), b = grab.box, pl = grab.raw.place;
      const cx = b.x + b.w/2, cy = b.y + b.h/2;
      if (grab.mode === 'move') {
        pl.x = b.x + (p.x - grab.start.x);
        pl.y = b.y + (p.y - grab.start.y);
      } else {
        const q = unrotate(p, cx, cy, pl.rot);
        const min = 0.5;
        const west = grab.mode.includes('w'), north = grab.mode.includes('n');
        const ax = west ? b.x + b.w : b.x;          // 끌지 않는 반대쪽 모서리(고정점)
        const ay = north ? b.y + b.h : b.y;
        let w = Math.max(min, west ? ax - q.x : q.x - ax);
        let h = Math.max(min, north ? ay - q.y : q.y - ay);
        if (e.shiftKey || e.ctrlKey) {              // 비율 유지
          const k = Math.max(w / b.w, h / b.h);
          w = Math.max(min, b.w * k);
          h = Math.max(min, b.h * k);
        }
        pl.w = w; pl.h = h;
        pl.x = west ? ax - w : ax;
        pl.y = north ? ay - h : ay;
      }
      paintFlags(); paintHandle(); syncPlaceInputs();
      return;
    }
    if (marq) {
      if (Math.abs(e.clientX-marq.sx) + Math.abs(e.clientY-marq.sy) > 4) moved = true;
      const p = toUser(e);
      marq.x1 = p.x; marq.y1 = p.y;
      hideTip();
      if (moved) paintMarquee(marq);
      return;
    }
    if (!drag) {
      const t = pathAt(e);
      if (t) showTip(e, t); else hideTip();
      return;
    }
    if (Math.abs(e.clientX-drag.sx) + Math.abs(e.clientY-drag.sy) > 4) moved = true;
    if (!moved) return;
    hideTip();
    const p = toUser(e);
    setView({ ...VB, x: VB.x + (drag.x - p.x), y: VB.y + (drag.y - p.y) });
  });

  svg.addEventListener('pointerup', e => {
    svg.classList.remove('panning');
    if (grab) { grab = null; drag = null; marq = null; hit = null; return; }
    const wasDrag = moved, t = hit, m = marq;
    drag = null; moved = false; hit = null; marq = null;
    if (m) {                                        // 직사각형 선택 완료
      paintMarquee(null);
      if (wasDrag) {
        const ids = entitiesInRect(rectOf(m));
        if (!m.add) S.sel.clear();
        ids.forEach(id => S.sel.add(id));
        render();
        return;
      }
      // 거의 움직이지 않았으면 일반 클릭 선택으로 처리
    }
    if (wasDrag) return;
    if (!t) { if (!e.ctrlKey && !e.shiftKey) { S.sel.clear(); render(); } return; }
    const iso = t.getAttribute('id'), eid = S.c2e[iso];
    const solo = soloSelection();
    // 병합 내부를 나라별/그룹별로 편집 중이면, 클릭한 나라를 편집 대상으로 삼는다
    if (solo && solo.id === eid && (solo.flagScope || 'whole') !== 'whole' && !e.ctrlKey && !e.shiftKey) {
      const u = unitsOf(solo).find(x => x.members.includes(iso));
      if (u) { S.activeUnit = u.key; render(); return; }
    }
    if (e.ctrlKey || e.shiftKey) S.sel.has(eid) ? S.sel.delete(eid) : S.sel.add(eid);
    else { S.sel.clear(); S.sel.add(eid); }
    render();
  });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const p = toUser(e);
    zoomAt(p.x, p.y, e.deltaY > 0 ? 1.18 : 1/1.18);
  }, { passive:false });

  $('#tool-ctl').onclick = e => {
    const b = e.target.closest('button');
    if (b) setTool(b.dataset.tool);
  };
  setTool('pick');

  $('#zoom-ctl').onclick = e => {
    const z = e.target.dataset.zoom;
    if (z === 'in')  zoomAt(VB.x+VB.w/2, VB.y+VB.h/2, 1/1.5);
    if (z === 'out') zoomAt(VB.x+VB.w/2, VB.y+VB.h/2, 1.5);
    if (z === 'reset') setView(baseVB);
  };

  /* --- 병합 --- */
  $('#btn-merge').onclick = mergeSelected;
  $('#btn-unmerge').onclick = unmergeSelected;
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea')) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'm') { e.preventDefault(); e.shiftKey ? unmergeSelected() : mergeSelected(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Escape') { S.sel.clear(); render(); }
    if (!e.ctrlKey && !e.altKey) {
      if (e.key === 'v' || e.key === 'V') setTool('pick');
      if (e.key === 'r' || e.key === 'R') setTool('rect');
    }
  });

  /* --- 인접 확장 병합 --- */
  $('#ex-depth').oninput = e => { $('#ex-depth-o').value = e.target.value; updateExpandPane(); };
  $('#ex-terr').onchange = updateExpandPane;
  const expand = () => expandSelection(+$('#ex-depth').value, $('#ex-terr').checked);
  $('#btn-expand-sel').onclick = () => {
    if (!S.sel.size) return;
    const all = expand();
    S.sel = new Set(all);
    render();
  };
  $('#btn-expand-merge').onclick = () => {
    if (!S.sel.size) return;
    const all = expand();
    if (all.size < 2) { alert('맞닿은 나라가 없습니다.'); return; }
    S.sel = new Set(all);
    mergeSelected();
  };

  /* --- 병합 내부 국기 범위 / 그룹 --- */
  $('#scope-tabs').onclick = e => {
    const t = e.target.closest('.tab'); if (!t) return;
    const ent = soloSelection(); if (!ent) return;
    snapshot();
    ent.flagScope = t.dataset.scope;
    ent.parts = ent.parts || {};
    ent.groups = ent.groups || [];
    S.activeUnit = null;
    render();
  };
  $('#btn-new-group').onclick = () => {
    const ent = soloSelection(); if (!ent) return;
    const picked = $$('#group-picker span.on').map(s => s.textContent);
    if (!picked.length) { alert('그룹으로 묶을 나라를 먼저 고르세요.'); return; }
    snapshot();
    ent.groups = ent.groups || [];
    ent.groups.forEach(g => g.members = g.members.filter(m => !picked.includes(m)));
    ent.groups = ent.groups.filter(g => g.members.length);
    const gid = 'G' + (++S.gseq);
    ent.groups.push({ gid, name: `그룹 ${ent.groups.length + 1}`, members: picked });
    S.activeUnit = ent.id + '#' + gid;
    render();
  };
  $('#btn-del-group').onclick = () => {
    const ent = soloSelection(); if (!ent) return;
    const u = unitsOf(ent).find(x => x.key === S.activeUnit);
    if (!u || u.raw === ent) return;
    snapshot();
    ent.groups = ent.groups.filter(g => g !== u.raw);
    S.activeUnit = null;
    render();
  };

  /* --- 이름 --- */
  $('#entity-name').oninput = e => {
    const ent = soloSelection(); if (!ent) return;
    ent.name = e.target.value;
    updateMergedList();
  };

  /* --- 탭 --- */
  $('#flag-tabs').onclick = e => {
    const t = e.target.closest('.tab'); if (!t) return;
    $$('#flag-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
  };

  /* --- 실제 국기 --- */
  const sel = $('#preset-country');
  COUNTRIES.forEach(c => {
    const o = document.createElement('option');
    o.value = c.iso; o.textContent = `${c.title} (${c.iso})`;
    sel.appendChild(o);
  });
  $('#btn-own-flag').onclick = () => applyRealFlags(null);
  $('#btn-apply-preset').onclick = () => applyRealFlags(sel.value);

  /* --- 디자인 --- */
  const D = () => ({
    type:'design', dir:$('#d-dir').value,
    colors: $$('#d-colors .swatch').map(s => joinHex(s.querySelector('input[type=color]').value,
                                                     +s.querySelector('.alpha').value / 100)),
    emblem:$('#d-emblem').value,
    ec: joinHex($('#d-ec').value, +$('#d-ec-a').value / 100),
    size:+$('#d-emblem-size').value
  });
  const PALETTE = ['#c0392b','#ffffff','#1f5fa9','#f1c40f','#2e8b57'];
  function buildSwatches() {
    const n = +$('#d-count').value, box = $('#d-colors');
    const old = $$('#d-colors .swatch').map(s => [s.querySelector('input[type=color]').value,
                                                  s.querySelector('.alpha').value]);
    box.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const w = document.createElement('div');
      w.className = 'swatch';
      w.innerHTML = `<input type="color" value="${old[i] ? old[i][0] : PALETTE[i % PALETTE.length]}">` +
                    `<input type="range" class="alpha" min="0" max="100" value="${old[i] ? old[i][1] : 100}">`;
      w.oninput = previewDesign;
      box.appendChild(w);
    }
    previewDesign();
  }
  function previewDesign() { $('#d-preview').innerHTML = designSVG(D()); }
  $('#d-count').oninput = e => { $('#d-count-o').value = e.target.value; buildSwatches(); };
  ['#d-dir','#d-emblem','#d-ec','#d-ec-a','#d-emblem-size'].forEach(s => $(s).oninput = previewDesign);
  buildSwatches();
  $('#btn-apply-design').onclick = () => applyFlag(() => D());

  /* --- 업로드 --- */
  let uploaded = null;
  $('#file-flag').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      uploaded = r.result;
      $('#u-preview').innerHTML = `<img src="${uploaded}" alt="">`;
      $('#btn-apply-upload').disabled = false;
    };
    r.readAsDataURL(f);
  };
  $('#btn-apply-upload').onclick = () => uploaded && applyFlag(() => ({ type:'image', href:uploaded }));

  /* --- 단색 / 제거 --- */
  $('#btn-apply-solid').onclick = () => applyFlag(() => ({
    type:'solid', color: joinHex($('#solid-color').value, +$('#solid-color-a').value / 100)
  }));
  $('#btn-clear-flag').onclick = () => applyFlag(() => null);

  /* --- 국기 배치 --- */
  $('#place-tabs').onclick = e => {
    const t = e.target.closest('.tab'); if (!t) return;
    const u = editUnit();
    if (!u) { alert('국가를 하나만 선택하고, 국기 대상을 고르세요.'); return; }
    if (!placeable(u)) { alert('이미지·디자인 국기에서만 위치를 조절할 수 있습니다.'); return; }
    snapshot();
    const raw = editRaw();
    if (t.dataset.place === 'manual') raw.place = { ...flagBox(u), rot: (raw.place && raw.place.rot) || 0 };
    else raw.place = null;
    render();
  };
  const plInput = () => {
    const raw = editRaw(); if (!raw || !raw.place) return;
    raw.place.x = +$('#pl-x').value; raw.place.y = +$('#pl-y').value;
    raw.place.w = Math.max(0.1, +$('#pl-w').value); raw.place.h = Math.max(0.1, +$('#pl-h').value);
    raw.place.rot = +$('#pl-rot').value;
    $('#pl-rot-o').value = raw.place.rot + '°';
    render();
  };
  ['#pl-x','#pl-y','#pl-w','#pl-h','#pl-rot'].forEach(s => $(s).oninput = plInput);
  $('#fmode').onchange = e => {
    const raw = editRaw(); if (!raw) return;
    snapshot();
    raw.flagMode = e.target.value;
    if (raw.flagMode === 'solid' && !raw.flagBg) raw.flagBg = S.opt.land;
    render();
  };
  $('#fbg').oninput = $('#fbg-a').oninput = () => {
    const raw = editRaw(); if (!raw) return;
    raw.flagBg = joinHex($('#fbg').value, +$('#fbg-a').value / 100);
    render();
  };
  $('#btn-place-reset').onclick = () => {
    const u = editUnit(), raw = editRaw();
    if (!u || !raw || !raw.place) return;
    snapshot();
    raw.place = { ...autoBox(u), rot: 0 };
    render();
  };

  /* --- 지도 설정 --- */
  const bindColor = (id, key) => {
    const c = $('#' + id), a = $('#' + id + '-a');
    const cur = splitHex(S.opt[key]);
    c.value = cur.c; a.value = Math.round(cur.o * 100);
    c.oninput = a.oninput = () => {
      S.opt[key] = joinHex(c.value, +a.value / 100);
      $('#stage').style.backgroundColor = S.opt.ocean;
      render();
    };
  };
  bindColor('opt-ocean', 'ocean');
  bindColor('opt-land', 'land');
  bindColor('opt-border', 'border');
  const opt = (sel2, key, fn) => $(sel2).oninput = e => { S.opt[key] = fn(e.target); render(); };
  opt('#opt-bw','bw', t => +t.value);
  opt('#opt-fit','fit', t => t.checked);
  opt('#opt-per-country','perCountry', t => t.checked);
  $('#opt-exw').oninput = e => S.opt.exportW = clamp(+e.target.value || 4000, 100, 20000);

  /* --- 정리 --- */
  $('#btn-keep').onclick = keepEdited;
  $('#btn-hide-sel').onclick = hideSelected;
  $('#btn-restore').onclick = () => {
    snapshot();
    Object.values(S.entities).forEach(e => e.hidden = false);
    render();
  };
  $('#btn-fit-visible').onclick = () => {
    const vis = Object.values(S.entities).filter(visible).flatMap(e => e.members);
    if (vis.length) fitTo(unionBBox(vis), 1.1);
  };

  /* --- 검색 --- */
  const box = $('#search-results');
  $('#search').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    box.innerHTML = '';
    if (!q) { box.style.display = 'none'; return; }
    COUNTRIES.filter(c => c.title.toLowerCase().includes(q) || c.iso.toLowerCase() === q)
      .slice(0, 40).forEach(c => {
        const d = document.createElement('div');
        d.innerHTML = `${c.title} <small>${c.iso}</small>`;
        d.onclick = () => {
          const ent = entOf(c.iso);
          ent.hidden = false;
          S.sel.clear(); S.sel.add(ent.id);
          fitTo(unionBBox(ent.members));
          box.style.display = 'none'; $('#search').value = ''; render();
        };
        box.appendChild(d);
      });
    box.style.display = box.children.length ? 'block' : 'none';
  };
  $('#search').onblur = () => setTimeout(() => box.style.display = 'none', 180);

  /* --- 저장 / 불러오기 / 내보내기 --- */
  $('#btn-save').onclick = saveJSON;
  $('#btn-load').onclick = () => $('#file-load').click();
  $('#file-load').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { loadJSON(r.result); e.target.value = ''; };
    r.readAsText(f);
  };
  $('#btn-png').onclick = exportPNG;
  $('#btn-svg').onclick = exportSVG;

  $('#stage').style.backgroundColor = S.opt.ocean;
}

function showTip(e, path) {
  const ent = entOf(path.getAttribute('id'));
  const t = $('#tooltip');
  const own = path.getAttribute('title') || '';
  t.textContent = ent.members.length > 1 ? `${ent.name} — ${own}` : ent.name;
  t.style.display = 'block';
  const r = $('#stage').getBoundingClientRect();
  t.style.left = (e.clientX - r.left + 14) + 'px';
  t.style.top  = (e.clientY - r.top  + 14) + 'px';
}
const hideTip = () => $('#tooltip').style.display = 'none';

/* ------------------------------------------------------ 병합 / 편집 / 정리 */
function snapshot() {
  history.push(JSON.stringify({ entities:S.entities, c2e:S.c2e, seq:S.seq, gseq:S.gseq }));
  if (history.length > 40) history.shift();
}
function undo() {
  const h = history.pop(); if (!h) return;
  const d = JSON.parse(h);
  S.entities = d.entities; S.c2e = d.c2e; S.seq = d.seq; S.gseq = d.gseq || S.gseq;
  S.sel.clear(); S.activeUnit = null; render();
}

function mergeSelected() {
  if (S.sel.size < 2) { alert('두 개 이상 선택하세요. (Ctrl+클릭으로 다중 선택)'); return; }
  snapshot();
  const ids = [...S.sel];
  const base = S.entities[ids[0]];
  ids.slice(1).forEach(id => {
    base.members.push(...S.entities[id].members);
    if (!base.flag && S.entities[id].flag) base.flag = S.entities[id].flag;
    delete S.entities[id];
  });
  base.members.forEach(m => S.c2e[m] = base.id);
  base.place = null;                                   // 영역이 바뀌었으므로 자동 배치로
  S.sel.clear(); S.sel.add(base.id);
  render();
}

function unmergeSelected() {
  const ids = [...S.sel].filter(id => S.entities[id] && S.entities[id].members.length > 1);
  if (!ids.length) return;
  snapshot();
  S.sel.clear();
  ids.forEach(id => {
    const ent = S.entities[id];
    delete S.entities[id];
    ent.members.forEach(m => {
      const nid = addEntity(ORIG[m] || m, [m]);
      S.entities[nid].hidden = ent.hidden;
      S.sel.add(nid);
    });
  });
  render();
}

function applyFlag(make) {
  if (!S.sel.size) { alert('먼저 나라를 선택하세요.'); return; }
  const ent = soloSelection();
  if (ent && (ent.flagScope || 'whole') !== 'whole') {   // 병합 내부의 일부에만 적용
    const raw = editRaw();
    if (!raw) { alert('국기를 지정할 대상(나라 또는 그룹)을 먼저 고르세요.'); return; }
    snapshot();
    raw.flag = make(ent);
    render();
    return;
  }
  snapshot();
  S.sel.forEach(id => S.entities[id].flag = make(S.entities[id]));
  render();
}

/** 사용자가 손댄 국가인가 */
function isEdited(ent) {
  if (ent.flag || ent.place || ent.members.length > 1) return true;
  if ((ent.flagScope || 'whole') !== 'whole') return true;
  return ent.name !== (ORIG[ent.members[0]] || ent.members[0]);
}
function keepEdited() {
  const keep = new Set(S.sel);
  Object.values(S.entities).forEach(e => { if (isEdited(e)) keep.add(e.id); });
  if (!keep.size) { alert('남길 국가가 없습니다. 먼저 국가를 선택하거나 편집하세요.'); return; }
  snapshot();
  Object.values(S.entities).forEach(e => e.hidden = !keep.has(e.id));
  render();
}
function hideSelected() {
  if (!S.sel.size) return;
  snapshot();
  S.sel.forEach(id => S.entities[id].hidden = true);
  S.sel.clear();
  render();
}

async function applyRealFlags(fixedIso) {
  if (!S.sel.size) { alert('먼저 나라를 선택하세요.'); return; }
  const solo = soloSelection();
  const sub = solo && (solo.flagScope || 'whole') !== 'whole' ? editRaw() : null;
  if (solo && (solo.flagScope || 'whole') !== 'whole' && !sub) {
    alert('국기를 지정할 대상(나라 또는 그룹)을 먼저 고르세요.'); return;
  }
  snapshot();
  const btns = [$('#btn-own-flag'), $('#btn-apply-preset')];
  btns.forEach(b => b.disabled = true);
  try {
    if (sub) {                                    // 병합 내부의 일부 대상에만
      const u = editUnit();
      const iso = (fixedIso || u.members[0]).split('-')[0].toLowerCase();
      const href = await fetchFlag(iso);
      if (href) sub.flag = { type:'image', href };
    } else for (const id of [...S.sel]) {
      const ent = S.entities[id];
      const iso = (fixedIso || ent.members[0]).split('-')[0].toLowerCase();
      const href = await fetchFlag(iso);
      if (href) ent.flag = { type:'image', href };
    }
  } finally {
    btns.forEach(b => b.disabled = false);
  }
  render();
}

const flagCache = {};
async function fetchFlag(iso) {
  if (flagCache[iso]) return flagCache[iso];
  const url = `https://flagcdn.com/w640/${iso}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    const d = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    flagCache[iso] = d;
    return d;
  } catch (err) {
    alert(`'${iso.toUpperCase()}' 국기를 불러오지 못했습니다.\n(인터넷 연결 또는 해당 코드의 국기 없음)`);
    return null;
  }
}

/* ------------------------------------------------------------------ 패널 UI */
function updatePanel() {
  const ids = [...S.sel];
  const nameInput = $('#entity-name');
  $('#sel-count').textContent = ids.length ? `${ids.length}개 선택` : '';
  const mem = $('#sel-members');
  mem.innerHTML = '';
  if (!ids.length) {
    $('#sel-title').textContent = '선택 없음';
    nameInput.value = ''; nameInput.disabled = true;
  } else if (ids.length === 1) {
    const ent = S.entities[ids[0]];
    $('#sel-title').textContent = ent.name;
    nameInput.value = ent.name; nameInput.disabled = false;
    ent.members.forEach(m => {
      const s = document.createElement('span');
      s.textContent = m; s.title = ORIG[m] || m;
      mem.appendChild(s);
    });
  } else {
    $('#sel-title').textContent = `${ids.length}개 국가 선택됨`;
    nameInput.value = ''; nameInput.disabled = true;
    ids.forEach(id => {
      const s = document.createElement('span');
      s.textContent = S.entities[id].name;
      mem.appendChild(s);
    });
  }
  $('#btn-merge').disabled = ids.length < 2;
  $('#btn-unmerge').disabled = !ids.some(id => S.entities[id] && S.entities[id].members.length > 1);
  $('#hidden-count').textContent = Object.values(S.entities).filter(e => e.hidden).length;
  updateExpandPane();
  updateScopePane();
  syncPlaceInputs();
}

function syncPlaceInputs() {
  const u = editUnit();
  const ent = u && u.ent;
  const ok = placeable(u);
  const manual = ok && !!u.props.place;
  $$('#place-tabs .tab').forEach(t => {
    t.classList.toggle('active', (t.dataset.place === 'manual') === manual);
    t.disabled = !ok;
  });
  $('#place-fields').hidden = !manual;
  $('#mode-fields').hidden = !ok;
  if (ok) {
    const mode = u.props.flagMode || 'clamp';
    $('#fmode').value = mode;
    $('#fbg-row').hidden = mode !== 'solid';
    const bg = splitHex(u.props.flagBg || S.opt.land);
    $('#fbg').value = bg.c;
    $('#fbg-a').value = Math.round(bg.o * 100);
  }
  const solo = soloSelection();
  const hint = $('#place-hint');
  hint.textContent = !solo ? '국가를 하나만 선택하면 배치를 조절할 수 있습니다.'
                   : !u    ? '위에서 국기를 지정할 대상(나라 또는 그룹)을 고르세요.'
                   : !ok   ? '이미지·디자인 국기에서만 위치를 조절할 수 있습니다. (단색 제외)'
                   : '자동: 국가 영역에 맞춰 국기를 채웁니다.';
  hint.hidden = manual;
  if (!manual) return;
  const p = u.props.place;
  $('#pl-x').value = +p.x.toFixed(1); $('#pl-y').value = +p.y.toFixed(1);
  $('#pl-w').value = +p.w.toFixed(1); $('#pl-h').value = +p.h.toFixed(1);
  $('#pl-rot').value = p.rot || 0;
  $('#pl-rot-o').value = (p.rot || 0) + '°';
}

/** 인접 확장 병합 패널 */
function updateExpandPane() {
  const pane = $('#pane-expand');
  pane.hidden = !S.sel.size;
  if (pane.hidden) return;
  const depth = +$('#ex-depth').value, terr = $('#ex-terr').checked;
  const after = expandSelection(depth, terr);
  const cnt = ids => [...ids].reduce((n, id) => n + (S.entities[id] ? S.entities[id].members.length : 0), 0);
  $('#ex-preview').textContent =
    `현재 ${cnt(S.sel)}개국 → ${depth}단계 확장 시 ${cnt(after)}개국 (${after.size}개 덩어리)`;
}

/** 병합 내부 국기 범위 패널 (전체 / 나라별 / 그룹별) */
function updateScopePane() {
  const ent = soloSelection();
  const pane = $('#pane-scope');
  // 다른 국가를 선택하면 편집 대상은 자동 해제
  if (S.activeUnit && (!ent || !S.activeUnit.startsWith(ent.id + '#'))) S.activeUnit = null;
  pane.hidden = !ent || ent.members.length < 2;
  const hint = $('#flag-target-hint');
  if (pane.hidden) { hint.hidden = true; return; }

  const scope = ent.flagScope || 'whole';
  $$('#scope-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.scope === scope));

  const list = $('#unit-list');
  list.innerHTML = '';
  const units = unitsOf(ent);
  if (scope === 'whole') {
    list.hidden = true;
    hint.hidden = true;
  } else {
    list.hidden = false;
    // 유효하지 않은 대상은 해제
    if (S.activeUnit && !units.some(u => u.key === S.activeUnit)) S.activeUnit = null;
    units.forEach(u => {
      const props = resolve(ent, u.raw);
      const d = document.createElement('div');
      d.className = 'merged-item' + (u.key === S.activeUnit ? ' act' : '');
      const sw = document.createElement('div');
      sw.className = 'sw';
      if (props.flag && props.flag.type === 'solid') {
        const { c, o } = splitHex(props.flag.color);
        sw.style.background = c; sw.style.opacity = o;
      } else {
        const h = flagHref(props.flag);
        if (h) sw.innerHTML = `<img src="${h}" alt="">`;
      }
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = u.name + (('flag' in u.raw) || u.raw === ent ? '' : ' (상속)');
      const ct = document.createElement('div');
      ct.className = 'ct'; ct.textContent = u.members.length;
      d.append(sw, nm, ct);
      d.onclick = () => { S.activeUnit = u.key; render(); };
      list.appendChild(d);
    });
    const cur = units.find(u => u.key === S.activeUnit);
    hint.hidden = false;
    hint.textContent = cur ? `적용 대상: ${cur.name} (${cur.members.length}개국)`
                           : '적용 대상을 위에서 고르세요.';
  }

  const gt = $('#group-tools');
  gt.hidden = scope !== 'group';
  if (scope === 'group') {
    const picker = $('#group-picker');
    picker.innerHTML = '';
    const inGroup = new Set();
    (ent.groups || []).forEach(g => g.members.forEach(m => inGroup.add(m)));
    ent.members.forEach(m => {
      const s = document.createElement('span');
      s.textContent = m;
      s.title = ORIG[m] || m;
      if (inGroup.has(m)) s.classList.add('grouped');
      s.onclick = () => { s.classList.toggle('on'); };
      picker.appendChild(s);
    });
    const cur = units.find(u => u.key === S.activeUnit);
    $('#btn-del-group').disabled = !cur || cur.raw === ent;
  }
}

function updateMergedList() {
  const list = $('#merged-list');
  list.innerHTML = '';
  const merged = Object.values(S.entities).filter(e => e.members.length > 1);
  $('#merged-count').textContent = merged.length;
  if (!merged.length) { list.innerHTML = '<div class="empty">병합된 국가가 없습니다.</div>'; return; }
  merged.forEach(ent => {
    const d = document.createElement('div');
    d.className = 'merged-item' + (S.sel.has(ent.id) ? ' on' : '') + (ent.hidden ? ' off' : '');
    const sw = document.createElement('div');
    sw.className = 'sw';
    if (ent.flag && ent.flag.type === 'solid') {
      const { c, o } = splitHex(ent.flag.color);
      sw.style.background = c; sw.style.opacity = o;
    } else {
      const h = flagHref(ent.flag);
      if (h) sw.innerHTML = `<img src="${h}" alt="">`;
    }
    const nm = document.createElement('div');
    nm.className = 'nm'; nm.textContent = ent.name;
    const ct = document.createElement('div');
    ct.className = 'ct'; ct.textContent = ent.members.length;
    d.append(sw, nm, ct);
    d.onclick = e => {
      if (!e.ctrlKey && !e.shiftKey) S.sel.clear();
      S.sel.add(ent.id);
      if (!ent.hidden) fitTo(unionBBox(ent.members));
      render();
    };
    list.appendChild(d);
  });
}

/* ------------------------------------------------------------ 저장 / 내보내기 */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function saveJSON() {
  const data = { v:3, entities:S.entities, c2e:S.c2e, seq:S.seq, gseq:S.gseq, opt:S.opt };
  download(new Blob([JSON.stringify(data)], { type:'application/json' }), 'flagmap.json');
}
function loadJSON(text) {
  try {
    const d = JSON.parse(text);
    S.entities = d.entities; S.c2e = d.c2e; S.seq = d.seq;
    Object.values(S.entities).forEach(e => {
      e.place = e.place || null;
      e.hidden = !!e.hidden;
      e.flagMode = e.flagMode || 'clamp';
      e.flagBg = e.flagBg || null;
      e.flagScope = e.flagScope || 'whole';
      e.parts = e.parts || {};
      e.groups = e.groups || [];
    });
    S.gseq = d.gseq || 0;
    S.activeUnit = null;
    Object.assign(S.opt, d.opt || {});
    ['ocean','land','border'].forEach(k => {
      const { c, o } = splitHex(S.opt[k]);
      $('#opt-' + k).value = c; $('#opt-' + k + '-a').value = Math.round(o * 100);
    });
    $('#opt-bw').value = S.opt.bw;
    $('#opt-fit').checked = S.opt.fit; $('#opt-per-country').checked = S.opt.perCountry;
    $('#opt-exw').value = S.opt.exportW;
    $('#stage').style.backgroundColor = S.opt.ocean;
    S.sel.clear(); render();
  } catch (err) { alert('불러오기 실패: ' + err.message); }
}

/** 내보내기용 SVG 사본 (선택 표시·손잡이 제거, 숨긴 국가 삭제, 전체 지도 범위) */
function buildExportSVG(pxWidth) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', SVGNS);
  clone.setAttribute('xmlns:xlink', XLINK);
  clone.setAttribute('viewBox', `${baseVB.x} ${baseVB.y} ${baseVB.w} ${baseVB.h}`);
  clone.querySelector('#fm-select').remove();
  clone.querySelector('#fm-handle').remove();
  clone.querySelector('#fm-marquee').remove();
  clone.querySelectorAll('#polygons path[display="none"]').forEach(p => p.remove());
  // 출력 해상도에 맞춰 병합 외곽선 굵기 재계산 (화면 배율과 다르므로)
  clone.querySelector('#fm-f-outline feMorphology')
       .setAttribute('radius', Math.max(S.opt.bw * baseVB.w / pxWidth, 1e-4));
  return clone;
}
const serialize = node => new XMLSerializer().serializeToString(node);

function exportSVG() {
  const W = Math.round(baseVB.w), H = Math.round(baseVB.h);
  const clone = buildExportSVG(W);
  clone.setAttribute('width', W);
  clone.setAttribute('height', H);
  download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + serialize(clone)],
                    { type:'image/svg+xml;charset=utf-8' }), 'flagmap.svg');
}

function exportPNG() {
  const W = clamp(Math.round(S.opt.exportW) || 4000, 100, 20000);
  const H = Math.round(W * baseVB.h / baseVB.w);
  const clone = buildExportSVG(W);
  clone.setAttribute('width', W);
  clone.setAttribute('height', H);
  const url = URL.createObjectURL(new Blob([serialize(clone)], { type:'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    cv.getContext('2d').drawImage(img, 0, 0, W, H);
    cv.toBlob(b => { if (b) download(b, `flagmap-${W}x${H}.png`); else alert('PNG 변환에 실패했습니다.'); });
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { alert('PNG 내보내기에 실패했습니다.'); URL.revokeObjectURL(url); };
  img.src = url;
}

boot();
