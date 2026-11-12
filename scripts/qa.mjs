#!/usr/bin/env node
/**
 * bb-video-qa — 补齐引擎 --check 的盲区。
 *
 * 引擎的 --check 管：元素出画面、元素互相重叠、停留太短、屏幕文字 vs brief.md。
 * 它**不管**：文字相对「自己那个框」是否居中、是否压住框线、
 *            文字锚点是否落在正确的口播句上（顺序错位）。
 * 这些恰恰是最容易复发、且 0 error 也会翻车的问题。
 *
 * 做法：不靠正则猜坐标 —— 用 vm 真实执行 index.html 的 build()，
 * 配一个假画板把每个 text / rect 的真实数值记下来，再做几何与语义检查。
 * 因此无论项目里 helper 叫什么名字、用不用 forEach，都能覆盖。
 *
 *   node qa.mjs <project> [--aspect 9:16|16:9] [--json] [--no-brief]
 *   退出码：0 = 无 ERROR；1 = 有 ERROR；2 = 无法解析项目
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const proj = argv.find((a) => !a.startsWith('--'));
const asJson = argv.includes('--json');
const noBrief = argv.includes('--no-brief');
const aspIdx = argv.indexOf('--aspect');
const aspect = aspIdx >= 0 ? (argv[aspIdx + 1] || '9:16') : '9:16';
const [W, H] = aspect === '16:9' ? [1920, 1080] : [1080, 1920];

if (!proj) {
  console.error('用法: node qa.mjs <project目录> [--aspect 9:16|16:9] [--json] [--no-brief]');
  process.exit(2);
}
const root = path.resolve(proj);
const htmlPath = path.join(root, 'index.html');
const tlPath = path.join(root, 'timeline.js');
const briefPath = path.join(root, 'brief.md');
for (const p of [htmlPath, tlPath]) {
  if (!fs.existsSync(p)) { console.error(`缺少文件: ${p}`); process.exit(2); }
}

// ---------- 读源码 ----------
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const code = scripts[scripts.length - 1];
if (!code || !/EV\.composition/.test(code)) {
  console.error('index.html 里找不到 EV.composition({...}) 的内联脚本');
  process.exit(2);
}

const tlSrc = fs.readFileSync(tlPath, 'utf8');
const tlMatch = tlSrc.match(/window\.TIMELINE\s*=\s*(\{[\s\S]*\})\s*;/);
let TIMELINE = { lines: [] };
try { TIMELINE = JSON.parse(tlMatch ? tlMatch[1] : tlSrc); } catch (e) {
  console.error('无法解析 timeline.js 的 window.TIMELINE: ' + e.message);
  process.exit(2);
}
const lineText = {};
const lineStart = {};
const lineEnd = {};
const lineWords = {};
for (const l of (TIMELINE.lines || [])) {
  lineText[l.id] = (l.words || []).map((w) => w.text).join('');
  lineStart[l.id] = Number(l.start ?? 0);
  lineEnd[l.id] = Number(l.end ?? (l.start ?? 0));
  lineWords[l.id] = l.words || [];
}

// ---------- 假画板：真实执行 build()，收集元素 ----------
const items = [];
const wordCalls = [];
const erases = [];   // 每幕开头的 erase('all', t) 时间点 = 分幕边界
let spec = null;

const mkEl = (o) => ({ ...o, node: { remove() {} }, pulse() { return this; } });
const latexW = (latex, size) => {
  const sq = (String(latex).match(/\\sqrt|\\le|\\quad/g) || []).length;
  const rest = String(latex).replace(/\\[a-zA-Z]+|[{}\\\s$]/g, '');
  return rest.length * size * 0.55 + sq * size * 0.8;
};
const cameras = [];  // 白板是无限画布 + 镜头移动：E1 按「绘制那一刻的镜头画面」查越界
const resolveAt = (o) => {
  const a = o && o.at;
  if (a && typeof a === 'object') return +(a.end ?? a.at) || 0;  // at 可以传另一个元素 = 它画完的时间
  return +a || 0;
};
const cjkWidth0 = (s, size) => [...String(s)].reduce((w, ch) => {
  if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) return w + size;
  if (/[a-zA-Z0-9]/.test(ch)) return w + size * 0.58;
  return w + size * 0.45;
}, 0);
const board = {
  W, H,
  items,   // 暴露元素数组，支持 build() 里的探针式 el.node.remove() + b.items.pop()
  text(str, o = {}) {
    const size = +o.size || 32;
    let w = cjkWidth0(String(str).replace(/\{[a-z]+:/g, '').replace(/\}/g, ''), size);
    let h = size * 1.5;
    if (o.maxWidth && w > o.maxWidth) { const lines = Math.ceil(w / o.maxWidth); h = lines * size * 1.5; w = Math.min(w, o.maxWidth); }
    const e = mkEl({ kind: 'text', str: String(str), x: +o.x || 0, y: +o.y || 0, size, align: o.align || 'left', valign: o.valign || 'middle', at: resolveAt(o), hud: !!o.hud });
    e.w = w; e.h = h;
    e.box = { x: e.align === 'center' ? e.x - w / 2 : e.align === 'right' ? e.x - w : e.x, y: e.valign === 'middle' ? e.y - h / 2 : e.y, w, h };
    items.push(e); return e;
  },
  rect(x, y, w, h, o = {}) { const e = mkEl({ kind: 'rect', x: +x, y: +y, w: +w, h: +h, at: resolveAt(o) }); items.push(e); return e; },
  circle(x, y, r, o = {}) { const e = mkEl({ kind: 'circle', x: +x, y: +y, r: +r, at: resolveAt(o) }); items.push(e); return e; },
  arrow(x1, y1, x2, y2, o = {}) { const e = mkEl({ kind: 'arrow', x1: +x1, y1: +y1, x2: +x2, y2: +y2, at: resolveAt(o) }); items.push(e); return e; },
  note(str, o = {}) {
    const w = +o.w || 460, size = +o.size || 44;
    const lines = Math.max(1, Math.ceil(cjkWidth0(str, size) / Math.max(w - 48, 1)));
    const h = size * 1.4 * lines + 48;
    const left = (o.anchor === 'center') ? +o.x - w / 2 : (o.anchor === 'right') ? +o.x - w : +o.x;
    const e = mkEl({ kind: 'note', str: String(str), x: left, y: +o.y || 0, w, h, at: resolveAt(o) });
    e.box = { x: left, y: +o.y || 0, w, h };
    items.push(e); return e;
  },
  math(latex, o = {}) {
    const e = mkEl({ kind: 'math', str: String(latex), x: +o.x || 0, y: +o.y || 0, size: +o.size || 56, align: o.align || 'left', at: resolveAt(o), hud: !!o.hud });
    e.w = latexW(latex, e.size); e.h = e.size * 1.7;
    e.box = { x: e.align === 'center' ? e.x - e.w / 2 : e.align === 'right' ? e.x - e.w : e.x, y: e.y, w: e.w, h: e.h };
    e.part = (name) => ({ x: e.box.x + e.w * 0.3, y: e.box.y, w: e.w * 0.4, h: e.h, __part: name });
    items.push(e); return e;
  },
  cover(opts = {}) {
    // 模拟引擎 cover() 的元素生成顺序：[panel, 边框rect, 标题, 副标题, tag便签]，cov.items 供 build() 索引
    const covItems = [];
    const PT = H > W;
    const plain = (s) => String(s || '').replace(/\{[a-z]+:([^}]*)\}/g, '$1');
    covItems.push(mkEl({ kind: 'panel', at: 0 }));
    covItems.push(board.rect(64, 64, W - 128, H - 128, { at: 0 }));
    const tw = W - 200;
    let title = null;
    for (const s of [150, 136, 124, 112, 100, 88]) {
      title = board.text(plain(opts.title), { hud: true, x: W / 2, y: opts.titleY ?? (PT ? H * 0.28 : opts.tag ? 310 : 250), size: s, align: 'center', valign: 'middle', at: 0, dur: 0, ...(PT ? { maxWidth: tw } : {}) });
      if (title.box.h <= s * 2.6 || s === 88) break;
      items.pop();
    }
    covItems.push(title);
    let bottom = title.box.y + title.box.h;
    if (opts.subtitle) {
      const sub = board.text(opts.subtitle, { hud: true, x: W / 2, y: bottom + 24, size: PT ? 48 : 56, align: 'center', at: 0, dur: 0, ...(PT ? { maxWidth: tw } : {}) });
      bottom = sub.box.y + sub.box.h;
      covItems.push(sub);
    }
    if (opts.tag) covItems.push(board.note(opts.tag, { hud: true, x: 104, y: 96, w: Math.min(420, 60 + opts.tag.length * 40), size: 36, color: 'yellow', rotate: -3, at: 0, dur: 0 }));
    const area = { x: W * 0.055, y: Math.max(bottom + 40, H * 0.33), w: W * 0.89, h: H * 0.33 };
    const cov = { area, end: 1.9, items: covItems, add(el) { (el.items || [el]).forEach((x) => items.push(x)); } };
    return cov;
  },
  erase(kind, t) { if (String(kind) === 'all') erases.push(+t || 0); },
  at() {}, line() {}, image() {}, character() {},
  camera(at, target, dur) { cameras.push({ at: +at || 0, x: +target.x, y: +target.y, zoom: +target.zoom || 1, dur: +dur || 0 }); },
  focus(at, target) { cameras.push({ at: +(at && at.at) || 0, x: +target.x, y: +target.y, zoom: +target.zoom || 1, dur: 1 }); },
  overview() {},
  highlight(el, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o) }); items.push(e); return e; },
  circleAround(el, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o) }); items.push(e); return e; },
  boxAround(el, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o) }); items.push(e); return e; },
  underline(el, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o), end: (resolveAt(o)) + 0.4 }); items.push(e); return e; },
  strike(el, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o) }); items.push(e); return e; },
  check(x, y, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o) }); items.push(e); return e; },
  cross(x, y, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o) }); items.push(e); return e; },
  dot(x, y, o = {}) { const e = mkEl({ kind: 'mark', at: resolveAt(o) }); items.push(e); return e; },
};
const frameAt = (t) => {
  let f = { x: W / 2, y: H / 2, zoom: 1 };
  for (const c of cameras) if (c.at <= t + 1e-6) f = c;
  return f;
};

const T = {
  start: (id) => lineStart[id] ?? 0,
  end: (id) => lineEnd[id] ?? ((lineStart[id] ?? 0) + 3),
  word: (id, phrase, nth) => {
    wordCalls.push({ id, phrase: String(phrase) });
    const text = (TIMELINE.lines || []).find((l) => l.id === id)?.text || lineText[id] || '';
    const words = lineWords[id] || [];
    const idx = nth ? -1 : text.indexOf(String(phrase));
    if (idx >= 0) {
      // 走一遍 words，找到覆盖该字符位置的词，取它的真实开始时间
      let acc = 0;
      for (const w of words) {
        if (acc + String(w.text).length > idx) return Number(w.start);
        acc += String(w.text).length;
      }
      return lineEnd[id] ?? 0;
    }
    return (lineStart[id] ?? 0) + 0.3;
  },
  wordEnd: (id, phrase) => T.word(id, phrase) + 0.3,
  at: (id, s) => (lineStart[id] ?? 0) + (+s || 0),
};
const sandbox = {
  EV: { composition: (s) => { spec = s; } },
  WB: { board: () => board },
  T, window: {}, document: {}, console,
  Math, JSON, Array, Object, String, Number, Boolean, Set, Map, Promise, RegExp,
  setTimeout, clearTimeout,
};
try {
  vm.createContext(sandbox);
  new vm.Script(code, { filename: htmlPath }).runInContext(sandbox);
  if (!spec || typeof spec.build !== 'function') throw new Error('composition 没有 build()');
  await spec.build({ T });
} catch (e) {
  console.error('执行 index.html 的 build() 失败: ' + e.message);
  console.error('（若你的项目用了本工具未 mock 的 API，请把报错贴出来补进 sandbox）');
  process.exit(2);
}

// ---------- 分幕 ----------
// 白板每幕 erase('all') 会清屏；不同幕的框和字共用一套坐标，绝不能互相配对。
const sceneOf = (at) => { let s = -1; for (let i = 0; i < erases.length; i++) if (at >= erases[i] - 1e-6) s = i; return s; };
for (const e of items) e.scene = sceneOf(e.at);
const scenes = new Set(items.map((e) => e.scene));

// ---------- 工具 ----------
const PAD = 6;          // 文字与框线之间至少留的像素
const TOL = 4;          // 水平居中容差
const MARGIN = 20;      // 元素与画面边缘的安全距离
const norm = (s) => String(s).replace(/[\s.,:;!?·「」『』""''（）()【】\[\]/、，。：；！？✓✗①-⑩>=<→·\-—_]/g, '').toLowerCase();
const cjkWidth = (s, size) => [...String(s)].reduce((w, ch) => {
  if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) return w + size;
  if (/[a-zA-Z0-9]/.test(ch)) return w + size * 0.58;
  return w + size * 0.45;
}, 0);
const lineNoOf = (needle) => {
  const i = html.indexOf(needle);
  return i < 0 ? '?' : html.slice(0, i).split('\n').length;
};
const ERR = [], WARN = [];
const err = (code, msg, line) => ERR.push({ code, msg, line });
const warn = (code, msg, line) => WARN.push({ code, msg, line });

// 候选「所属框」：排除封面大框 / 背景框（面积 > 画面 70%）
const boxes = items.filter((e) => e.kind === 'rect' && e.w * e.h < W * H * 0.7);
const texts = items.filter((e) => e.kind === 'text');
const ownerOf = (t) => {
  const hits = boxes.filter((b) => b.scene === t.scene
    && t.x >= b.x - 2 && t.x <= b.x + b.w + 2 && t.y >= b.y - 2 && t.y <= b.y + b.h + 2);
  hits.sort((a, b) => a.w * a.h - b.w * b.h);
  return hits[0] || null;
};

// ---------- E1 画面越界（所有元素）----------
for (const e of items) {
  let x1, y1, x2, y2, label;
  if (e.kind === 'text') {
    const hw = cjkWidth(e.str, e.size) / 2, hh = e.size / 2;
    x1 = e.x - (e.align === 'center' ? hw : 0); y1 = e.y - hh;
    x2 = e.x + (e.align === 'center' ? hw : cjkWidth(e.str, e.size)); y2 = e.y + hh;
    label = `文字「${e.str}」`;
  } else if (e.kind === 'rect') {
    x1 = e.x; y1 = e.y; x2 = e.x + e.w; y2 = e.y + e.h; label = `框 (${e.x},${e.y},${e.w}×${e.h})`;
  } else if (e.kind === 'math') {
    const b = e.box;
    x1 = b.x; y1 = b.y; x2 = b.x + b.w; y2 = b.y + b.h; label = `公式「${e.str}」`;
  } else if (e.kind === 'note') {
    x1 = e.x; y1 = e.y; x2 = e.x + e.w; y2 = e.y + e.h; label = `便签「${e.str}」`;
  } else continue;
  const f = e.hud ? frameAt(0) : frameAt(e.at);
  const fx1 = f.x - W / (2 * f.zoom), fy1 = f.y - H / (2 * f.zoom);
  const fx2 = f.x + W / (2 * f.zoom), fy2 = f.y + H / (2 * f.zoom);
  if (x1 < fx1 + MARGIN || y1 < fy1 + MARGIN || x2 > fx2 - MARGIN || y2 > fy2 - MARGIN) {
    err('E1', `${label} 出画面（镜头中心 ${Math.round(f.x)},${Math.round(f.y)}）：包围盒 (${Math.round(x1)},${Math.round(y1)})–(${Math.round(x2)},${Math.round(y2)})，画面 (${Math.round(fx1)},${Math.round(fy1)})–(${Math.round(fx2)},${Math.round(fy2)}) 需留 ${MARGIN}px`, lineNoOf(e.str || String(e.x)));
  }
}

// ---------- E2/E3/E4 文字相对所属框 ----------
const byOwner = new Map();
const orphan = [];
for (const t of texts) {
  const b = ownerOf(t);
  if (!b) { orphan.push(t); continue; }
  if (!byOwner.has(b)) byOwner.set(b, []);
  byOwner.get(b).push(t);
}
if (orphan.length) {
  const sample = orphan.slice(0, 3).map((t) => `「${t.str}」`).join('、');
  warn('W1', `${orphan.length} 处文字无所属框，通常是整屏标题/说明/封面（设计意图）：${sample}${orphan.length > 3 ? ' …' : ''}`, '?');
}
for (const [b, ts] of byOwner) {
  const cx = b.x + b.w / 2;
  // 横排标签：同一大框里 ≥3 个文字且几乎同一行（如「✗ 代写作业 / ✗ 考试作弊 …」），
  // 它们本就各自占位，不该要求每个都居中于大框中心。
  // 按「同一行」判定，而不是把整个框的所有文字混在一起：
  // 与 t 同行（|Δy|<40）的同伴 ≥3 个，说明它是横排并列标签，豁免居中要求。
  const rowPeers = (t) => ts.filter((o) => Math.abs(o.y - t.y) < 40).length;

  for (const t of ts) {
    const hw = cjkWidth(t.str, t.size) / 2, hh = t.size / 2;
    const top = t.y - hh, bottom = t.y + hh;
    const left = t.x - hw, right = t.x + hw;
    if (top < b.y + PAD || bottom > b.y + b.h - PAD) {
      err('E2', `文字「${t.str}」压框线：字占 y ${Math.round(top)}–${Math.round(bottom)}，框 y ${b.y}–${b.y + b.h}（需留 ${PAD}px）`, lineNoOf(t.str));
    }
    if (left < b.x + PAD || right > b.x + b.w - PAD) {
      err('E2', `文字「${t.str}」横向溢出框：字占 x ${Math.round(left)}–${Math.round(right)}，框 x ${b.x}–${b.x + b.w}`, lineNoOf(t.str));
    }
    if (rowPeers(t) < 3 && Math.abs(t.x - cx) > TOL) {
      err('E3', `文字「${t.str}」未在框内居中：字中心 x=${t.x}，框中心 x=${cx}（差 ${Math.round(t.x - cx)}px）`, lineNoOf(t.str));
    }
  }
  // 同框「同一列」文字上下压叠（跨列的横排标签不比较）
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    const a = ts[i], c = ts[j];
    if (Math.abs(a.x - c.x) > 20) continue;
    const overlap = Math.min(a.y + a.size / 2, c.y + c.size / 2) - Math.max(a.y - a.size / 2, c.y - c.size / 2);
    if (overlap > 2) err('E4', `同框同列文字压叠：「${a.str}」与「${c.str}」纵向重叠 ${Math.round(overlap)}px`, lineNoOf(c.str));
  }
}

// ---------- E5 锚点必须命中对应句口播（文字/动画顺序一致性）----------
for (const c of wordCalls) {
  const spoken = norm(lineText[c.id] || '');
  if (!spoken) { err('E5', `锚点 '${c.phrase}' 引用了不存在的句 ${c.id}`, lineNoOf(c.phrase)); continue; }
  if (!spoken.includes(norm(c.phrase))) {
    err('E5', `锚点 '${c.phrase}' 不在 ${c.id} 的口播里 → 会回退到句首，文字比旁白早/晚出现（顺序错位）。该句口播: ${(lineText[c.id] || '').slice(0, 46)}…`, lineNoOf(c.phrase));
  }
}

// ---------- W2 锚点节奏：一幕里过半主视觉挤在句尾 = 前大半段只有标题 ----------
// 引擎只查「画完到擦除」的时长，查不出「整幕前 2/3 只有标题」。
// 单个句尾锚点是正常的（结论本就最后说）；成堆出现才是问题。
const ratioOf = (c) => {
  const words = lineWords[c.id] || [];
  if (!words.length) return null;
  const pos = norm(words.map((w) => w.text).join('')).indexOf(norm(c.phrase));
  if (pos < 0) return null;
  let cum = 0, at = null;
  for (const w of words) {
    const n = norm(w.text).length;
    if (cum + n > pos) { at = Number(w.start ?? lineStart[c.id]); break; }
    cum += n;
  }
  if (at == null) at = lineEnd[c.id];
  const span = lineEnd[c.id] - lineStart[c.id];
  return span > 0 ? (at - lineStart[c.id]) / span : 1;
};
const byLine = {};
for (const c of wordCalls) {
  const r = ratioOf(c);
  if (r == null) continue;
  (byLine[c.id] ||= []).push({ phrase: c.phrase, ratio: r, late: r > 0.65 });
}
const dense = [];
for (const [id, arr] of Object.entries(byLine)) {
  const uniq = [...new Map(arr.map((x) => [x.phrase, x])).values()];
  const lates = uniq.filter((x) => x.late);
  if (lates.length >= 2 && lates.length / uniq.length > 0.5) dense.push({ id, lates, total: uniq.length });
}
if (dense.length) {
  const desc = dense.slice(0, 3).map((d) => `${d.id} 中 ${d.lates.length}/${d.total} 个（${d.lates.slice(0, 3).map((x) => `'${x.phrase}'`).join('、')}）`).join('；');
  warn('W2', `${dense.length} 幕的锚点成堆落在句尾 65% 之后：${desc}${dense.length > 3 ? ' …' : ''}。该幕前大半段会只有标题、内容刚画完就切幕 —— 把主视觉锚点换成句子前半段出现的对应词，再抽帧确认`, '?');
}

// ---------- E6 屏幕文案必须登记进 brief.md（画面文字一致性）----------
if (!noBrief && fs.existsSync(briefPath)) {
  const brief = fs.readFileSync(briefPath, 'utf8');
  const m = brief.match(/##\s*On-screen text[^\n]*\n([\s\S]*?)(?=\n##|\n#\s|$)/i);
  const registered = norm(m ? m[1] : brief);
  const skip = /^[\d\s.,:·✓✗①-⑩>→\-—/]+$/.test.bind(null);
  for (const t of texts) {
    const s = String(t.str).trim();
    if (!s || /^[\d\s.,:·✓✗①-⑩>→\-—/]+$/.test(s)) continue;
    const n = norm(s);
    if (n.length < 2) continue;
    if (!registered.includes(n)) {
      err('E6', `屏幕文案「${s}」未登记在 brief.md 的 On-screen text 清单里（改了字没同步事实表 → 画面文字不一致）`, lineNoOf(s));
    }
  }
}

// ---------- 输出 ----------
const groups = [
  ['E1', '画面越界'], ['E2', '文字压框线 / 溢出框'], ['E3', '文字未在框内居中'],
  ['E4', '同框文字重叠'], ['E5', '锚点与口播顺序错位'], ['E6', '屏幕文案未登记事实表'],
  ['W1', '无所属框的文字'], ['W2', '锚点节奏偏句尾'],
];
const result = { project: root, aspect, canvas: [W, H], elements: items.length, texts: texts.length, boxes: boxes.length, anchors: wordCalls.length, errors: ERR, warnings: WARN, pass: ERR.length === 0 };
if (asJson) { console.log(JSON.stringify(result, null, 2)); }
else {
  console.log(`\n项目: ${root}`);
  console.log(`画布: ${W}×${H} | ${scenes.size} 幕 | 元素 ${items.length}（文字 ${texts.length} / 框 ${boxes.length}）| 锚点 ${wordCalls.length}`);
  console.log('─'.repeat(72));
  if (!ERR.length && !WARN.length) console.log('✓ 全部通过：居中 / 不压框线 / 不越界 / 锚点顺序 / 文案登记 均无问题');
  for (const [code, title] of groups) {
    const list = (code.startsWith('E') ? ERR : WARN).filter((x) => x.code === code);
    if (!list.length) continue;
    console.log(`\n${code.startsWith('E') ? '✗ ERROR' : '! WARN '} ${title} — ${list.length} 处`);
    for (const x of list) console.log(`   index.html:${x.line}  ${x.msg}`);
  }
  console.log('\n' + '─'.repeat(72));
  console.log(`结果: ${ERR.length} 个错误, ${WARN.length} 个提醒 → ${ERR.length ? '禁止渲染，先修' : '可以渲染'}`);
  if (WARN.length) console.log('提醒请逐条看一眼，确认是有意为之再忽略。');
}
process.exitCode = ERR.length ? 1 : 0;
