#!/usr/bin/env node
// paltex.mjs — palette-first pixel-art texture tool made for LLMs (Quake 1 / Doom 2 / Chasm era look).
// Zero dependencies, single file, Node >= 16.   Usage: node paltex.mjs help
// Everything is an 8-bit INDEXED canvas: no operation can ever create a color outside the palette.
import fs from 'node:fs';
import zlib from 'node:zlib';

// ─────────────────────────────────────────────────────────────── state & helpers
const DEFAULT_BRUSH = () => ({
  shape: 'circle', sprite: null, spriteAlpha: false, size: 3, spriteSize: 0, angle: 0, aspect: 100,
  spacing: 1, spacingPct: 0, taper: [100, 100], jitter: 0, scatter: 0, density: 50,
  dither: 'bayer4', rot: 'fixed', seed: 0, n: 5, skip: 20, shade: [0, 0],
  flow: 100, opacity: 100, blend: 'auto', texScale: 8,
  sizeJitter: 0, angleJitter: 0, shadeJitter: 0, flowJitter: 0,
});
const S = {
  w: 0, h: 0, px: new Uint8Array(0), hmap: new Float32Array(0), pal: [], ramps: new Map(), rampOf: [],
  fullbright: new Uint8Array(256), keys: new Map(), keyOf: new Map(), sprites: new Map(), wrap: true,
  changed: 0, hchanged: 0, cmdSeq: 0, anchors: new Map(), shapes: new Map(), activeShape: null,
  brush: DEFAULT_BRUSH(), brushOn: false, brushStack: [],
  sym: { mode: 'off', ax: null, ay: null, jitter: 0, seed: 0 },
  layers: [], activeLayer: -1, belowPx: null,
  albedo: null, lightAccum: null, lastLights: [],
  undoStack: [], undoBytes: 0, checkpoints: new Map(), lastDiff: null,
  trace: { active: false, dir: null, scale: 4, pad: 4, all: false, step: 0 },
};
const out = (s = '') => process.stdout.write(s + '\n');
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; }); // "| head" must not kill the script (it may still have to save)
const fail = (m) => { throw new Error(m); };
const mod = (a, n) => ((a % n) + n) % n;
const fmod = (a, n) => { const r = ((a % n) + n) % n; return r >= n ? 0 : r; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const unhex = (s) => {
  let h = s.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(2); // paint.net AARRGGBB
  if (!/^[0-9a-f]{6}$/i.test(h)) fail(`bad hex color "${s}"`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const int = (t, what) => {
  if (t === undefined || !/^[-+]?\d+$/.test(String(t))) fail(`expected integer for <${what}>, got "${t ?? 'nothing'}"`);
  return parseInt(t, 10);
};
function evalAnchorExpr(t, axis = 'x', allowFloat = false) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.([xywh]))?(?:([+-](?:\d+\.?\d*|\.\d+)))?$/.exec(String(t));
  if (!m) return null;
  const [, nm, prop, off] = m;
  let base = null;
  if (S.anchors.has(nm)) base = S.anchors.get(nm);
  else if (S.w > 0 && (nm === 'cx' || nm === 'cy')) base = [Math.floor(S.w / 2), Math.floor(S.h / 2), null, null];
  else if (S.w > 0 && (nm === 'w' || nm === 'h')) base = [S.w, S.h, S.w, S.h];
  if (!base) return null;
  if ((prop === 'w' || prop === 'h') && base[prop === 'w' ? 2 : 3] == null) return null;
  const v = prop === 'x' ? base[0] : prop === 'y' ? base[1] : prop === 'w' ? base[2] : prop === 'h' ? base[3]
    : (nm === 'cy' || nm === 'h') ? base[1] : (nm === 'cx' || nm === 'w') ? base[0]
    : (axis === 'y' ? base[1] : base[0]);
  const d = off ? (allowFloat ? parseFloat(off) : (/^[+-]\d+$/.test(off) ? parseInt(off, 10) : NaN)) : 0;
  return Number.isNaN(d) ? null : v + d;
}
function coord(t, what, axis = 'x') {
  if (t === undefined) fail(`expected coordinate for <${what}>, got "nothing"`);
  if (/^[-+]?\d+$/.test(String(t))) return parseInt(t, 10);
  const v = evalAnchorExpr(t, axis, false);
  if (v !== null) return v;
  fail(`expected integer or anchor for <${what}>, got "${t}"`);
}
function coordf(t, what, axis = 'x') {
  if (t === undefined) fail(`expected number or anchor for <${what}>, got "nothing"`);
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(String(t))) return parseFloat(t);
  const v = evalAnchorExpr(t, axis, true);
  if (v !== null) return v;
  fail(`expected number or anchor for <${what}>, got "${t}"`);
}
const float = (t, what) => {
  if (t === undefined || !/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(String(t))) fail(`expected number for <${what}>, got "${t ?? 'nothing'}"`);
  return parseFloat(t);
};
const num = (v, dflt, what = 'option') => (v === undefined ? dflt : int(v, what));
const fnum = (v, dflt, what = 'option') => (v === undefined ? dflt : float(v, what));
const pair = (v, dflt, what = 'option') => {
  if (v === undefined) return dflt;
  const p = String(v).split(',');
  if (p.length !== 2) fail(`${what} must be "a,b", got "${v}"`);
  return [int(p[0], what), int(p[1], what)];
};

// ─────────────────────────────────────────────────────────────── palette & ramps
// Built-in palette "grime": 16 hue-shifted ramps x 16 shades (dark -> light), index = ramp*16 + step.
// Cool/deep shadows -> earthy midtones -> warm/desaturated highlights. NOT a copy of any game palette.
function sampleAnchors(anchors, count) {
  const pts = anchors.map(unhex), n = pts.length - 1, outCols = [];
  for (let i = 0; i < count; i++) {
    const pos = (i / Math.max(1, count - 1)) * n, k = Math.min(n - 1, Math.floor(pos)), u = pos - k;
    outCols.push(pts[k].map((v, c) => Math.round(v + (pts[k + 1][c] - v) * u)));
  }
  return outCols;
}
const BUILTIN = {
  grey: ['#040508', '#2a2c34', '#69686b', '#abaaa2', '#ebe7db'],
  dirt: ['#0f0a09', '#312319', '#5e492d', '#90744d', '#bfa77a'],
  stone: ['#090b12', '#262b38', '#4f5460', '#81878e', '#b7b9b5'],
  moss: ['#080e08', '#1e2b15', '#3e4d23', '#697a3a', '#9ea963'],
  rust: ['#140706', '#3d190a', '#703716', '#a8672e', '#d69c5c'],
  brick: ['#160709', '#421818', '#733128', '#a65745', '#cf896f'],
  flesh: ['#1a0b0d', '#4f2822', '#8c5844', '#c58c6f', '#f0c0a5'],
  blood: ['#120103', '#3d0407', '#740c0a', '#b32419', '#e65038'],
  slime: ['#030d05', '#0e3310', '#236119', '#4f9c28', '#8cd94c'],
  water: ['#030712', '#0d1d3b', '#1b3e68', '#3c6f9c', '#74aedb'],
  steel: ['#06080e', '#1a232e', '#3c4d5b', '#6c8290', '#a6bbc7'],
  brass: ['#120c02', '#3b2b0a', '#6f5814', '#ac8d2d', '#e5cc66'],
  bone: ['#161210', '#443b30', '#7e715b', '#b9aa8c', '#f0e4ca'],
  lava: ['#240502', '#6e1603', '#c74b07', '#f29b22', '#fff188'],
  purple: ['#0b0712', '#261538', '#4a295d', '#7b4e8d', '#b183c7'],
  teal: ['#030d10', '#0c2e30', '#185955', '#358c82', '#69c4b3'],
};
const nearCache = new Map(), autoRamps = new Set(), aliasRamps = new Set();
function setPalette(cols) {
  if (!cols.length || cols.length > 256) fail(`palette must have 1..256 colors, got ${cols.length}`);
  S.pal = cols; S.ramps.clear(); S.rampOf = []; S.fullbright.fill(0); nearCache.clear(); autoRamps.clear(); aliasRamps.clear();
}
function setFullbright(indices) {
  nearCache.clear();
  for (const i of indices) if (i >= 0 && i < S.pal.length) S.fullbright[i] = 1;
}
function parseIndexSpec(toks) {
  const idx = [];
  for (const t of toks) {
    const m = /^(\d+)\.\.(\d+)$/.exec(t);
    if (m) { const p = +m[1], q = +m[2], s = p <= q ? 1 : -1; for (let i = p; i !== q + s; i += s) idx.push(i); }
    else idx.push(col(t, false));
  }
  return idx;
}
// Original Quake-layout hue-shifted palette (14 16-color material ramps + 31 fullbrights 224..254 + index 255).
// Not a binary copy of id Software's palette.lmp; for the real one run `palette quake <path/to/palette.lmp>`.
const QUAKE_LAYOUT = [
  ['grey', ['#050609', '#2b2c32', '#636368', '#a8a69e', '#eae6dc']],
  ['brown', ['#120b09', '#36251c', '#69492e', '#9f754e', '#cfa87c']],
  ['slate', ['#080b14', '#1f2b3d', '#41546b', '#70889e', '#a7becb']],
  ['moss', ['#080d07', '#202e16', '#3e5225', '#687f3d', '#9eb368']],
  ['blood', ['#140204', '#420708', '#7d120c', '#b82917', '#e85838']],
  ['rust', ['#140806', '#3d1c0c', '#734018', '#a86c2e', '#d69d56']],
  ['gold', ['#170e03', '#4b310a', '#8a6416', '#c89d2d', '#f2dc74']],
  ['flesh', ['#1c0b0d', '#522923', '#8f5642', '#c68a6d', '#f2c2a3']],
  ['purple', ['#0f0816', '#301c42', '#5c376a', '#8d5c94', '#be92be']],
  ['rose', ['#180811', '#471d32', '#7b3e57', '#ad667c', '#dca0af']],
  ['teal', ['#050f12', '#143336', '#295d5c', '#4d918b', '#89c8be']],
  ['mud', ['#100d09', '#2e261b', '#53462d', '#7e6d48', '#ab9669']],
  ['bile', ['#0e1404', '#323c0c', '#62701c', '#97a532', '#cbd563']],
  ['cobalt', ['#050818', '#111e4d', '#254086', '#466cbe', '#7ea7f0']],
];
const QUAKE_FULLBRIGHT = [
  ['fb_lava', ['#5b0700', '#e75700', '#fff797'], 8],
  ['fb_fire', ['#7f1300', '#ff6f07', '#ffffcf'], 8],
  ['fb_plasma', ['#00377f', '#1797ef', '#b7f7ff'], 8],
  ['fb_runic', ['#2f0047', '#af27df', '#ff9fff'], 7],
];
function applyQuakeRamps() {
  if (S.pal.length < 256) fail('quake ramps require a 256-color palette');
  S.ramps.clear(); autoRamps.clear(); aliasRamps.clear(); S.fullbright.fill(0);
  QUAKE_LAYOUT.forEach(([name], row) => {
    const base = row * 16;
    const idx = Array.from({ length: 16 }, (_, j) => base + j).sort((p, q) => lum(S.pal[p]) - lum(S.pal[q]));
    setRamp(name, idx);
  });
  let fbPos = 224;
  for (const [name, , count] of QUAKE_FULLBRIGHT) {
    const block = Array.from({ length: count }, (_, j) => fbPos + j).sort((p, q) => lum(S.pal[p]) - lum(S.pal[q]));
    setRamp(name, block);
    fbPos += count;
  }
  const g = S.ramps.get('grey'), br = S.ramps.get('brown'), md = S.ramps.get('mud');
  const boneIdx = [...new Set([g[0], br[1], md[2], md[4], md[5], md[7], md[8], md[10], md[11], br[11], md[13], md[14], md[15], g[12], g[13], g[15]])]
    .sort((p, q) => lum(S.pal[p]) - lum(S.pal[q]));
  setRamp('bone', boneIdx, { alias: true });
  setRamp('fb_warm', Array.from({ length: 16 }, (_, j) => 224 + j).sort((p, q) => lum(S.pal[p]) - lum(S.pal[q])), { alias: true });
  setRamp('fb_cool', Array.from({ length: 15 }, (_, j) => 240 + j).sort((p, q) => lum(S.pal[p]) - lum(S.pal[q])), { alias: true });
  setFullbright(Array.from({ length: 31 }, (_, j) => 224 + j));
  S.fullbright[255] = 1;
}
function quakePalette(file) {
  if (file) { setPalette(loadPaletteFile(file)); applyQuakeRamps(); return; }
  const cols = [];
  for (const [, anchors] of QUAKE_LAYOUT) cols.push(...sampleAnchors(anchors, 16));
  for (const [, anchors, count] of QUAKE_FULLBRIGHT) cols.push(...sampleAnchors(anchors, count));
  cols.push([159, 91, 83]); // index 255
  setPalette(cols);
  applyQuakeRamps();
}
function setRamp(name, idx, opts = {}) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) fail(`bad ramp name "${name}" (letters, digits, _)`);
  if (!idx.length) fail(`ramp ${name}: needs at least one palette index`);
  for (const i of idx) if (!(i >= 0 && i < S.pal.length)) fail(`ramp ${name}: index ${i} not in palette (0..${S.pal.length - 1})`);
  if (opts.auto) autoRamps.add(name); else autoRamps.delete(name);
  if (opts.alias) aliasRamps.add(name); else aliasRamps.delete(name);
  if (opts.primary) {
    const prev = [...S.ramps.entries()].filter(([k]) => k !== name);
    S.ramps.clear();
    S.ramps.set(name, idx);
    for (const [k, v] of prev) S.ramps.set(k, v);
  } else {
    S.ramps.set(name, idx);
  }
  S.rampOf = [];
  for (const passAuto of [false, true]) {
    for (const [n, r] of S.ramps) {
      if (aliasRamps.has(n) || autoRamps.has(n) !== passAuto) continue;
      r.forEach((c, i) => { if (!S.rampOf[c]) S.rampOf[c] = { name: n, i }; });
    }
  }
}
function builtinPalette() {
  const cols = [], ramps = [];
  for (const [name, anchors] of Object.entries(BUILTIN)) {
    const base = cols.length;
    cols.push(...sampleAnchors(anchors, 16));
    ramps.push([name, Array.from({ length: 16 }, (_, i) => base + i)]);
  }
  setPalette(cols);
  for (const [n, idx] of ramps) setRamp(n, idx);
}
const needPal = () => { if (!S.pal.length) builtinPalette(); };
const needCanvas = () => { if (!S.w) fail('no canvas yet — run: new <w> <h> [color]'); };
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const brightnessOf = (c) => {
  const rm = S.rampOf[c];
  if (rm) return rm.i / Math.max(1, S.ramps.get(rm.name).length - 1);
  return lum(S.pal[c]) / 255;
};
function dist(a, b) { // "redmean" perceptual-ish RGB distance (squared)
  const rm = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}
function nearest(rgb, cand) { // nearest palette index (optionally restricted to candidate indices; skips fullbright unless explicit cand)
  const k = cand ? null : (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  if (k !== null && nearCache.has(k)) return nearCache.get(k);
  let best = 0, bd = Infinity, fbBest = 0, fbBd = Infinity;
  const n = cand ? cand.length : S.pal.length;
  for (let j = 0; j < n; j++) {
    const i = cand ? cand[j] : j, d = dist(rgb, S.pal[i]);
    if (!cand && S.fullbright[i]) { if (d < fbBd) { fbBd = d; fbBest = i; } continue; }
    if (d < bd) { bd = d; best = i; }
  }
  if (bd === Infinity) best = fbBest;
  if (k !== null) nearCache.set(k, best);
  return best;
}
// Move a palette index n steps along its ramp (+ lighter, - darker), clamped at the ramp ends.
// Colors that belong to no ramp fall back to the nearest PALETTE color of the scaled RGB.
function shadeIdx(c, n) {
  if (!n) return c;
  const r = S.rampOf[c];
  if (r) { const a = S.ramps.get(r.name); return a[clamp(r.i + n, 0, a.length - 1)]; }
  const f = Math.pow(1.18, n);
  return nearest(S.pal[c].map((v) => clamp(Math.round(v * f), 0, 255)));
}
// Color token -> palette index, or {d:n} for relative "+n/-n" (shade what is already there).
function col(t, allowRel = true) {
  if (t === undefined) fail('missing <color>');
  needPal();
  if (/^[+-]\d+$/.test(t)) { if (!allowRel) fail(`relative color "${t}" not allowed here`); return { d: parseInt(t, 10) }; }
  if (/^\d+$/.test(t)) { const i = +t; if (i >= S.pal.length) fail(`color index ${i} out of palette (0..${S.pal.length - 1})`); return i; }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return nearest(unhex(t));
  if (t[0] === '@' && [...t].length === 2) { const ch = [...t][1]; if (!S.keys.has(ch)) fail(`no key "${ch}" defined (define: key ${ch} <color>)`); return S.keys.get(ch); }
  const [name, st] = t.split(':'), r = S.ramps.get(name);
  if (!r) fail(`unknown color "${t}" — use index, #hex (snaps to nearest), ramp:step, @key or +n/-n. ramps: ${[...S.ramps.keys()].join(' ') || '(none)'}`);
  if (st === undefined) return r[r.length >> 1];
  const i = int(st, 'ramp step'), j = i < 0 ? r.length + i : i;
  if (j < 0 || j >= r.length) fail(`ramp ${name} has steps 0..${r.length - 1} (or -1 = lightest), got ${st}`);
  return r[j];
}
function maskSet(t) { // "stone,12,rust:3,@a" (ramp name = every shade of it); leading ! inverts
  needPal();
  const inv = t[0] === '!', m = new Uint8Array(256);
  for (const p of (inv ? t.slice(1) : t).split(',')) { const r = S.ramps.get(p); if (r) r.forEach((c) => (m[c] = 1)); else m[col(p, false)] = 1; }
  if (inv) for (let i = 0; i < 256; i++) m[i] ^= 1;
  return m;
}
const descr = (c) => `${String(c).padStart(3)} ${hex(S.pal[c])} ${S.rampOf[c] ? S.rampOf[c].name + ':' + S.rampOf[c].i : '-'}${S.fullbright[c] ? ' [FB]' : ''}`;

// ─────────────────────────────────────────────────────────────── PNG codec (indexed out; 8-bit any type in)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
function encodePNG(w, h, px, pal) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = px[y * w + x];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(pal.flat())), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) fail('not a PNG file');
  let p = 8, w = 0, h = 0, depth = 8, ct = 0, plte = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; if (d[12]) fail('interlaced PNG not supported'); }
    else if (type === 'PLTE') { plte = []; for (let i = 0; i + 2 < len; i += 3) plte.push([d[i], d[i + 1], d[i + 2]]); }
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!ch || (depth !== 8 && !(ct === 3 && depth < 8))) fail(`unsupported PNG (color type ${ct}, bit depth ${depth}) — convert to 8-bit`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil((w * ch * depth) / 8);
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride), rgba = new Uint8Array(w * h * 4), idx = ct === 3 ? new Uint8Array(w * h) : null;
  for (let y = 0, q = 0; y < h; y++) {
    const f = raw[q++];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = raw[q++];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, bl, al = 255;
      if (ct === 3) {
        const i = depth === 8 ? cur[x] : (cur[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
        idx[y * w + x] = i; [r, g, bl] = (plte && plte[i]) || [0, 0, 0];
        if (trns && i < trns.length) al = trns[i];
      } else if (ct === 0) r = g = bl = cur[x];
      else if (ct === 4) { r = g = bl = cur[x * 2]; al = cur[x * 2 + 1]; }
      else { r = cur[x * ch]; g = cur[x * ch + 1]; bl = cur[x * ch + 2]; if (ch === 4) al = cur[x * ch + 3]; }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = al;
    }
    cur.copy(prev);
  }
  return { w, h, rgba, idx, plte };
}
function loadPaletteFile(file) { // PNG (PLTE or unique colors), GIMP .gpl, JASC .pal, hex list, or raw RGB triples (Quake palette.lmp, Doom PLAYPAL)
  const buf = fs.readFileSync(file), txt = buf.toString('latin1');
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const im = decodePNG(buf);
    if (im.plte) return im.plte;
    const seen = new Map();
    for (let i = 0; i < im.rgba.length; i += 4) {
      const k = (im.rgba[i] << 16) | (im.rgba[i + 1] << 8) | im.rgba[i + 2];
      if (!seen.has(k)) { seen.set(k, [im.rgba[i], im.rgba[i + 1], im.rgba[i + 2]]); if (seen.size > 256) fail('PNG has more than 256 distinct colors'); }
    }
    return [...seen.values()];
  }
  if (/^(GIMP Palette|JASC-PAL)/.test(txt)) return txt.split(/\r?\n/).map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)(\s|$)/.exec(l)).filter(Boolean).map((m) => [+m[1], +m[2], +m[3]]);
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== ';');
  if (lines.length && lines.every((l) => /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.test(l))) return lines.map(unhex);
  if (buf.length >= 768) return Array.from({ length: 256 }, (_, i) => [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]]);
  if (buf.length % 3 === 0 && buf.length) return Array.from({ length: buf.length / 3 }, (_, i) => [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]]);
  fail(`cannot read a palette from ${file} (supported: .png .gpl .pal(JASC) hex list, raw RGB bytes)`);
}

// ─────────────────────────────────────────────────────────────── canvas, layers, undo & symmetry
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]], N8 = [...N4, [1, 1], [-1, 1], [1, -1], [-1, -1]];
function sminH(a, b, k) {
  if (!(k > 0)) return Math.max(a, b);
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return a + (b - a) * h + k * h * (1 - h);
}
function blendHeightBuf(dst, src, pxMask, hmode, smoothR) {
  for (let i = 0; i < dst.length; i++) {
    const v = src[i], hasPx = pxMask ? pxMask[i] >= 0 : false;
    if (hmode === 'add') { if (v !== 0) dst[i] += v; }
    else if (hmode === 'max') { if (v !== 0 || hasPx) dst[i] = Math.max(dst[i], v); }
    else if (hmode === 'over') { if (v !== 0 || hasPx) dst[i] = v; }
    else if (hmode === 'smin') { if (v !== 0) dst[i] = sminH(dst[i], v, smoothR || 2.5); }
  }
}
const activeHMap = () => (S.layers.length ? S.layers[S.activeLayer].hmap : S.hmap);
const markHChanged = () => { S.hchanged++; if (S.layers.length) S.layers[S.activeLayer].hused = true; };
function initCanvas(w, h, fillIdx = 0) {
  S.w = w; S.h = h; S.px = new Uint8Array(w * h).fill(fillIdx); S.hmap = new Float32Array(w * h);
  S.layers = []; S.activeLayer = -1; S.belowPx = null; S.anchors.clear(); S.shapes.clear(); S.activeShape = null;
  S.albedo = null; S.lightAccum = null; S.lastLights = [];
  S.undoStack = []; S.undoBytes = 0; S.checkpoints.clear(); S.lastDiff = null;
}
function compositeLayers(upto = S.layers.length - 1, outArr = new Uint8Array(S.w * S.h)) {
  if (!S.layers.length) { outArr.set(S.px); return outArr; }
  outArr.set(S.layers[0].px);
  for (let li = 1; li <= upto; li++) {
    const L = S.layers[li];
    if (!L.visible) continue;
    if (L.kind === 'paint') {
      for (let i = 0; i < outArr.length; i++) if (L.px[i] >= 0) outArr[i] = L.px[i];
    } else if (L.kind === 'shade') {
      for (let i = 0; i < outArr.length; i++) if (L.px[i] !== 0 && !S.fullbright[outArr[i]]) outArr[i] = shadeIdx(outArr[i], L.px[i]);
    } else {
      outArr.set(L.px);
    }
  }
  return outArr;
}
function compositeHeight() {
  if (!S.layers.length) return;
  S.hmap.set(S.layers[0].hmap);
  for (let li = 1; li < S.layers.length; li++) {
    const L = S.layers[li];
    if (!L.visible || !L.hused) continue;
    blendHeightBuf(S.hmap, L.hmap, L.kind === 'paint' ? L.px : null, L.hmode || 'add', L.smoothR || 2.5);
  }
}
function syncLayers() {
  if (!S.layers.length) { S.belowPx = null; return; }
  S.belowPx = S.activeLayer > 0 ? compositeLayers(S.activeLayer - 1) : null;
  compositeLayers(S.layers.length - 1, S.px);
  compositeHeight();
}
function snapState(label = '') {
  return {
    label, w: S.w, h: S.h, px: S.px.slice(), hmap: S.hmap.slice(),
    albedo: S.albedo ? S.albedo.slice() : null,
    activeLayer: S.activeLayer, layers: S.layers.map((l) => ({ ...l, px: l.px.slice(), hmap: l.hmap ? l.hmap.slice() : new Float32Array(S.w * S.h) })),
    activeShape: S.activeShape, shapes: [...S.shapes].map(([k, v]) => [k, v.slice()]),
  };
}
function restoreState(st) {
  S.w = st.w; S.h = st.h; S.px = st.px.slice(); S.hmap = st.hmap.slice();
  S.albedo = st.albedo ? st.albedo.slice() : null;
  S.activeLayer = st.activeLayer; S.layers = st.layers.map((l) => ({ ...l, px: l.px.slice(), hmap: l.hmap ? l.hmap.slice() : new Float32Array(S.w * S.h) }));
  S.shapes = new Map((st.shapes || []).map(([k, v]) => [k, v.slice()])); S.activeShape = st.activeShape ?? null;
  syncLayers(); S.changed++;
}
function pushUndo(label) {
  if (!S.w) return;
  const st = snapState(label);
  const bytes = st.px.byteLength + st.hmap.byteLength + st.layers.reduce((a, l) => a + l.px.byteLength, 0);
  S.undoStack.push({ st, bytes }); S.undoBytes += bytes;
  while (S.undoStack.length > 50 || (S.undoStack.length > 1 && S.undoBytes > 64 * 1024 * 1024)) {
    S.undoBytes -= S.undoStack.shift().bytes;
  }
}
const get = (x, y, src = S.px) => {
  if (S.wrap) return src[mod(y, S.h) * S.w + mod(x, S.w)];
  return x < 0 || y < 0 || x >= S.w || y >= S.h ? -1 : src[y * S.w + x];
};
function put(x, y, c) {
  if (S.wrap) { x = mod(x, S.w); y = mod(y, S.h); } else if (x < 0 || y < 0 || x >= S.w || y >= S.h) return;
  const i = y * S.w + x;
  if (!S.layers.length) {
    if (S.px[i] !== c) { S.px[i] = c; S.changed++; }
    return;
  }
  const L = S.layers[S.activeLayer];
  if (L.kind === 'base') {
    if (L.px[i] !== c) { L.px[i] = c; S.changed++; }
    if (S.activeLayer === S.layers.length - 1 && L.visible) S.px[i] = c;
  } else if (L.kind === 'paint') {
    if (L.px[i] !== c) { L.px[i] = c; S.changed++; }
    if (S.activeLayer === S.layers.length - 1 && L.visible) S.px[i] = c >= 0 ? c : S.belowPx[i];
  } else {
    const rm = S.rampOf[c], d = rm ? rm.i - (S.ramps.get(rm.name).length >> 1) : 0;
    if (L.px[i] !== d) { L.px[i] = d; S.changed++; }
    if (S.activeLayer === S.layers.length - 1 && L.visible) {
      const bc = S.belowPx[i]; S.px[i] = d && !S.fullbright[bc] ? shadeIdx(bc, d) : bc;
    }
  }
}
function parseRampMix(spec, mixOpt, dfltPct = 50) {
  if (spec === undefined) return null;
  const [name, pctStr] = String(spec).split(':');
  const r = S.ramps.get(name) || fail(`unknown ramp "${name}" (ramps: ${[...S.ramps.keys()].join(' ')})`);
  let pct = dfltPct;
  if (pctStr !== undefined) pct = parseFloat(pctStr);
  else if (mixOpt !== undefined) pct = fnum(mixOpt, dfltPct, 'mix');
  if (Number.isNaN(pct)) fail(`bad mix percentage "${spec}"`);
  return { name, ramp: r, mix: clamp(pct, 0, 100) / 100 };
}
function mixColorTowardRamp(cBase, shiftedCol, targetRampInfo, alpha) {
  if (!targetRampInfo || alpha <= 0.01) return shiftedCol;
  const b = brightnessOf(shiftedCol), tr = targetRampInfo.ramp;
  const tgtCol = tr[clamp(Math.round(b * (tr.length - 1)), 0, tr.length - 1)];
  if (alpha >= 0.99) return tgtCol;
  const rgb = [0, 1, 2].map((k) => Math.round((1 - alpha) * S.pal[shiftedCol][k] + alpha * S.pal[tgtCol][k]));
  const rm = S.rampOf[cBase];
  const cand = rm ? [...new Set([...S.ramps.get(rm.name), ...tr])] : null;
  return nearest(rgb, cand);
}
function putShaded(x, y, srcColor, d, o) {
  const shSpec = o?.shadow_ramp !== undefined ? parseRampMix(o.shadow_ramp, o.shadow_mix, 45) : null;
  const hiKey = o?.hi_ramp ?? o?.light_ramp;
  const hiSpec = hiKey !== undefined ? parseRampMix(hiKey, o.hi_mix ?? o.light_mix, 40) : null;
  if (!shSpec && !hiSpec) { if (d !== 0) putRel(x, y, srcColor, d); return; }
  const shifted = shadeIdx(srcColor, d);
  let outCol = shifted;
  if (d < 0 && shSpec) outCol = mixColorTowardRamp(srcColor, shifted, shSpec, shSpec.mix * clamp(Math.abs(d) / 4, 0.35, 1));
  else if (d > 0 && hiSpec) outCol = mixColorTowardRamp(srcColor, shifted, hiSpec, hiSpec.mix * clamp(d / 4, 0.35, 1));
  put(x, y, outCol);
}
function putRel(x, y, srcColor, d) {
  if (S.wrap) { x = mod(x, S.w); y = mod(y, S.h); } else if (x < 0 || y < 0 || x >= S.w || y >= S.h) return;
  const i = y * S.w + x;
  if (S.layers.length && S.layers[S.activeLayer].kind === 'shade') {
    const L = S.layers[S.activeLayer], bc = S.belowPx[i];
    if (S.fullbright[bc]) return;
    const nd = clamp(L.px[i] + d, -32, 32);
    if (L.px[i] !== nd) { L.px[i] = nd; S.changed++; }
    if (S.activeLayer === S.layers.length - 1 && L.visible) S.px[i] = nd ? shadeIdx(bc, nd) : bc;
    return;
  }
  put(x, y, shadeIdx(srcColor, d));
}
function symPoints(x, y, jx = 0, jy = 0) {
  if (S.sym.mode === 'off') return [[x, y]];
  const ax = S.sym.ax ?? (S.w - 1) / 2, ay = S.sym.ay ?? (S.h - 1) / 2;
  const doX = S.sym.mode === 'x' || S.sym.mode === 'xy', doY = S.sym.mode === 'y' || S.sym.mode === 'xy';
  const mx = Math.round(2 * ax - x) + jx, my = Math.round(2 * ay - y) + jy;
  const pts = [[x, y]];
  if (doX) pts.push([mx, y]);
  if (doY) pts.push([x, my]);
  if (doX && doY) pts.push([mx, my]);
  return pts;
}
function symJitter(salt = 0) {
  if (!S.sym.jitter || S.sym.mode === 'off') return [0, 0];
  const j = S.sym.jitter;
  return [
    Math.round((hash(S.cmdSeq, salt, S.sym.seed, 91) * 2 - 1) * j),
    Math.round((hash(S.cmdSeq, salt, S.sym.seed, 92) * 2 - 1) * j),
  ];
}
const regionOf = (o) => { const R = o.region || [0, 0, S.w, S.h]; return S.wrap ? [R[0], R[1], Math.min(R[2], S.w), Math.min(R[3], S.h)] : R; };
function evalShapeExpr(expr) {
  const raw = String(expr).trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return S.shapes.get(raw) || fail(`unknown shape "${raw}" (use "shape new ${raw}" first)`);
  const toks = raw.match(/[A-Za-z_][A-Za-z0-9_]*|[!&|()]/g);
  if (!toks || toks.join('') !== raw.replace(/\s+/g, '')) fail(`bad shape expression "${expr}"`);
  let p = 0;
  const n = S.w * S.h;
  const parseOr = () => {
    let v = parseAnd();
    while (toks[p] === '|') { p++; const r = parseAnd(); for (let i = 0; i < n; i++) v[i] = v[i] || r[i] ? 1 : 0; }
    return v;
  };
  const parseAnd = () => {
    let v = parseUnary();
    while (toks[p] === '&') { p++; const r = parseUnary(); for (let i = 0; i < n; i++) v[i] = v[i] && r[i] ? 1 : 0; }
    return v;
  };
  const parseUnary = () => {
    if (toks[p] === '!') { p++; const r = parseUnary(); for (let i = 0; i < n; i++) r[i] ^= 1; return r; }
    if (toks[p] === '(') {
      p++;
      const r = parseOr();
      if (toks[p] !== ')') fail(`unclosed "(" in shape expression "${expr}"`);
      p++;
      return r;
    }
    const nm = toks[p++];
    if (!nm || /^[!&|()]$/.test(nm)) fail(`unexpected token "${nm ?? 'end'}" in shape expression "${expr}"`);
    const buf = S.shapes.get(nm) || fail(`unknown shape "${nm}" (use "shape new ${nm}" first)`);
    return buf.slice();
  };
  const res = parseOr();
  if (p < toks.length) fail(`unexpected token "${toks[p]}" in shape expression "${expr}"`);
  return res;
}
// scope = region=x,y,w,h AND mask=colors AND shape=expr, tested against a snapshot taken before the command runs.
function scope(o, srcOverride = null) {
  const src = srcOverride || S.px.slice(), R = o.region, M = o.mask;
  const SB = o.shape && o.shape !== 'radial' && o.shape !== 'linear' ? evalShapeExpr(o.shape) : null;
  const inS = (x, y) => !SB || (S.wrap ? SB[mod(y, S.h) * S.w + mod(x, S.w)] === 1 : x >= 0 && y >= 0 && x < S.w && y < S.h && SB[y * S.w + x] === 1);
  const inR = (x, y) => !R || (S.wrap ? mod(x - R[0], S.w) < R[2] && mod(y - R[1], S.h) < R[3] : x >= R[0] && y >= R[1] && x < R[0] + R[2] && y < R[1] + R[3]);
  const has = (x, y) => { const c = get(x, y, src); return c >= 0 && inR(x, y) && inS(x, y) && (!M || M[c] === 1); };
  const each = (fn) => {
    const [x0, y0, w, h] = regionOf(o);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const x = x0 + i, y = y0 + j, c = get(x, y, src);
      if (c >= 0 && inS(x, y) && (!M || M[c] === 1)) fn(x, y, c, i, j);
    }
  };
  return { src, inR, has, each };
}
// plotter: every vector primitive draws through this. Absolute color = set; relative {d:n} = shade once per pixel.
function plotter(o, c) {
  const sc = scope(o), rel = typeof c === 'object', seen = new Set(), [jx, jy] = symJitter(1);
  return (x, y) => {
    x = Math.round(x); y = Math.round(y);
    for (const [px, py] of o._nosym ? [[x, y]] : symPoints(x, y, jx, jy)) {
      if (!sc.has(px, py)) continue;
      if (!rel) { put(px, py, c); continue; }
      const k = S.wrap ? mod(py, S.h) * S.w + mod(px, S.w) : py * S.w + px;
      if (seen.has(k)) continue;
      seen.add(k); putRel(px, py, get(px, py, sc.src), c.d);
    }
  };
}

// ─────────────────────────────────────────────────────────────── primitives
function line(P, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  for (let e = dx + dy; ;) {
    P(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
function rect(P, x, y, w, h, fill) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (fill || !j || !i || j === h - 1 || i === w - 1) P(x + i, y + j);
}
function poly(P, pts, fill) {
  if (fill) {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if (ay <= y !== by <= y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) P(x, y);
    }
  }
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; line(P, p[0], p[1], q[0], q[1]); });
}
function ellipse(P, cx, cy, rx, ry, fill) {
  const hw = (dy) => (Math.abs(dy) > ry ? -1 : ry === 0 ? rx : Math.round(rx * Math.sqrt(1 - (dy * dy) / (ry * ry))));
  for (let dy = -ry; dy <= ry; dy++) {
    const w = hw(dy), a = hw(dy - 1), b = hw(dy + 1);
    for (let dx = -w; dx <= w; dx++) if (fill || Math.abs(dx) === w || Math.abs(dx) > a || Math.abs(dx) > b) P(cx + dx, cy + dy);
  }
}
function flood(x, y, c, o) {
  const sc = scope(o), rel = typeof c === 'object', [jx, jy] = symJitter(2), seen = new Set();
  for (const [sx, sy] of symPoints(x, y, jx, jy)) {
    if (!sc.inR(sx, sy)) continue;
    const t = get(sx, sy, sc.src);
    if (t < 0) { if (sx === x && sy === y) fail(`flood: start ${x},${y} is outside the canvas (wrap is off)`); continue; }
    const nb = o.diag ? N8 : N4, st = [[sx, sy]];
    while (st.length) {
      let [px, py] = st.pop();
      if (S.wrap) { px = mod(px, S.w); py = mod(py, S.h); } else if (px < 0 || py < 0 || px >= S.w || py >= S.h) continue;
      const k = py * S.w + px;
      if (seen.has(k) || sc.src[k] !== t || !sc.inR(px, py) || (o.mask && o.mask[t] !== 1)) continue;
      seen.add(k);
      if (rel) putRel(px, py, t, c.d); else put(px, py, c);
      for (const [dx, dy] of nb) st.push([px + dx, py + dy]);
    }
  }
}

// ─────────────────────────────────────────────────────────────── sprites (text grids, key or ramp-step mode)
function resolveSpriteChar(ch, y, x, meta) {
  if (ch === '.' || ch === ' ') return { c: -1, step: -1 };
  if (meta && meta.overrides && meta.overrides.has(ch)) {
    const c = meta.overrides.get(ch);
    return { c, step: S.rampOf[c] ? S.rampOf[c].i : -1 };
  }
  if (ch === '#' && meta && meta.outline !== undefined) return { c: meta.outline, step: -1 };
  if (meta && (meta.ramp || meta.shade) && /^[0-9a-z]$/i.test(ch)) {
    const step = parseInt(ch.toLowerCase(), 36);
    if (meta.ramp) {
      const r = S.ramps.get(meta.ramp) || fail(`sprite: unknown ramp "${meta.ramp}"`);
      return { c: r[clamp(step, 0, r.length - 1)], step };
    }
    const r = S.ramps.get('grey') || [...S.ramps.values()][0];
    const c = r ? r[clamp(step, 0, r.length - 1)] : clamp(step, 0, S.pal.length - 1);
    return { c, step };
  }
  if (!S.keys.has(ch)) fail(`grid row ${y + 1} col ${x + 1}: char "${ch}" has no key (define it first: key ${ch} <color>)`);
  const c = S.keys.get(ch);
  return { c, step: S.rampOf[c] ? S.rampOf[c].i : -1 };
}
function parseSprite(rows, meta = null) {
  if (!rows.length) fail('empty sprite grid');
  const g = rows.map((r) => [...r]), w = Math.max(...g.map((r) => r.length));
  const d = new Int16Array(w * g.length).fill(-1), steps = new Int16Array(w * g.length).fill(-1);
  g.forEach((r, y) => r.forEach((ch, x) => {
    const res = resolveSpriteChar(ch, y, x, meta);
    d[y * w + x] = res.c; steps[y * w + x] = res.step;
  }));
  return { w, h: g.length, d, steps, rows: rows.slice(), meta };
}
function grabSprite(name, x, y, w, h, o) {
  if (w < 1 || h < 1 || w > 512 || h > 512) fail('grab: width/height must be 1..512');
  const sc = scope(o), d = new Int16Array(w * h).fill(-1), steps = new Int16Array(w * h).fill(-1);
  let count = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!sc.has(x + i, y + j)) continue;
    const c = get(x + i, y + j, sc.src);
    if (c >= 0) { d[j * w + i] = c; steps[j * w + i] = S.rampOf[c] ? S.rampOf[c].i : -1; count++; }
  }
  S.sprites.set(name, { w, h, d, steps, rows: null, meta: null });
  out(`sprite "${name}": grabbed ${w}x${h} (${count} opaque px)`);
}
function editSpriteRow(name, rowIdx, rowStr) {
  const sp = S.sprites.get(name) || fail(`no sprite "${name}"`);
  if (rowIdx < 0 || rowIdx >= sp.h) fail(`sprite "${name}" has rows 0..${sp.h - 1}, got ${rowIdx}`);
  const chars = [...rowStr], nw = Math.max(sp.w, chars.length);
  if (nw !== sp.w) {
    const nd = new Int16Array(nw * sp.h).fill(-1), ns = new Int16Array(nw * sp.h).fill(-1);
    for (let y = 0; y < sp.h; y++) for (let x = 0; x < sp.w; x++) { nd[y * nw + x] = sp.d[y * sp.w + x]; ns[y * nw + x] = sp.steps[y * sp.w + x]; }
    sp.d = nd; sp.steps = ns; sp.w = nw;
  }
  for (let x = 0; x < sp.w; x++) {
    const ch = x < chars.length ? chars[x] : '.';
    const res = resolveSpriteChar(ch, rowIdx, x, sp.meta);
    sp.d[rowIdx * sp.w + x] = res.c; sp.steps[rowIdx * sp.w + x] = res.step;
  }
  if (sp.rows) sp.rows[rowIdx] = rowStr;
}
function showSprite(name, view = 'char') {
  const sp = S.sprites.get(name) || fail(`no sprite "${name}"`);
  if (!['char', 'idx', 'step'].includes(view)) fail('view must be char | idx | step');
  const used = new Map();
  for (const c of sp.d) if (c >= 0) used.set(c, (used.get(c) || 0) + 1);
  autoKeys([...used.keys()]);
  const cw = view === 'idx' ? 4 : 1, pad = String(Math.max(0, sp.h - 1)).length;
  const xs = Array.from({ length: sp.w }, (_, i) => i);
  out(`sprite "${name}" ${sp.w}x${sp.h}${sp.meta?.ramp ? ` (ramp=${sp.meta.ramp})` : sp.meta?.shade ? ' (shade)' : ''}`);
  if (cw === 1) for (let d = String(Math.max(0, sp.w - 1)).length - 1; d >= 0; d--) out(' '.repeat(pad + 1) + xs.map((x, i) => (d === 0 || x % 10 === 0 || i === 0 ? Math.floor(x / 10 ** d) % 10 : ' ')).join(''));
  else out(' '.repeat(pad + 1) + xs.map((x) => String(x).padStart(cw)).join(''));
  for (let j = 0; j < sp.h; j++) {
    const line = [];
    for (let i = 0; i < sp.w; i++) {
      const c = sp.d[j * sp.w + i], st = sp.steps ? sp.steps[j * sp.w + i] : -1;
      if (c < 0) line.push('.'.padStart(cw));
      else if (view === 'idx') line.push(String(c).padStart(cw));
      else if (view === 'step') line.push((st >= 0 ? st.toString(36) : S.rampOf[c] ? S.rampOf[c].i.toString(36) : '?').padStart(cw));
      else line.push((S.keyOf.get(c) ?? '?').padStart(cw));
    }
    out(String(j).padStart(pad) + ' ' + line.join(''));
  }
  legend(used);
}
const sprAt = (sp, rot, fx, fy, i, j) => { // pixel (i,j) of the rotated/flipped sprite as drawn on the canvas; -1 = transparent
  const { w, h, d } = sp;
  let [u, v] = rot === 0 ? [i, j] : rot === 1 ? [j, h - 1 - i] : rot === 2 ? [w - 1 - i, h - 1 - j] : [w - 1 - j, i];
  if (fx) u = w - 1 - u;
  if (fy) v = h - 1 - v;
  return { c: d[v * w + u], step: sp.steps ? sp.steps[v * w + u] : -1 };
};
function stampSize(W, H, o) {
  let ow = W, oh = H;
  if (o.scale !== undefined) {
    const s = String(o.scale);
    if (s.includes(',')) { [ow, oh] = pair(s, [W, H], 'scale'); }
    else {
      const f = s.endsWith('%') ? parseFloat(s) / 100 : s.endsWith('x') ? parseFloat(s) : float(s, 'scale');
      if (!(f > 0)) fail('stamp scale must be > 0');
      ow = Math.max(1, Math.round(W * f)); oh = Math.max(1, Math.round(H * f));
    }
  }
  if (o.w !== undefined) ow = Math.max(1, coord(o.w, 'w', 'x'));
  if (o.h !== undefined) oh = Math.max(1, coord(o.h, 'h', 'y'));
  return [clamp(ow, 1, 4096), clamp(oh, 1, 4096)];
}
function stamp(sp, x, y, o) {
  const { w, h } = sp, rot = mod(Math.round(num(o.rot, 0, 'rot') / 90), 4), [W, H] = rot & 1 ? [h, w] : [w, h];
  const [outW, outH] = stampSize(W, H, o);
  const ox = o._center ? x - Math.floor(outW / 2) : x, oy = o._center ? y - Math.floor(outH / 2) : y;
  const [nx, ny] = pair(o.repeat, [1, 1], 'repeat'), [sx, sy] = pair(o.step, [outW, outH], 'step'), sc = o._sc || scope(o);
  const relMode = !!o._relShade, sh = o._shade || 0, seen = relMode ? new Set() : null;
  const rLen = sp.meta?.ramp && S.ramps.get(sp.meta.ramp) ? S.ramps.get(sp.meta.ramp).length : 16;
  const mid = num(o.mid, sp.meta?.mid ?? (rLen >> 1), 'mid');
  const [jx, jy] = o._nosym ? [0, 0] : symJitter(3);
  for (let ry = 0; ry < ny; ry++) for (let rx = 0; rx < nx; rx++) for (let j = 0; j < outH; j++) for (let i = 0; i < outW; i++) {
    const si = outW === W ? i : Math.min(W - 1, Math.floor(((i + 0.5) * W) / outW));
    const sj = outH === H ? j : Math.min(H - 1, Math.floor(((j + 0.5) * H) / outH));
    const { c, step } = sprAt(sp, rot, o.flipx, o.flipy, si, sj);
    if (c < 0) continue;
    const X = ox + rx * sx + i, Y = oy + ry * sy + j;
    for (const [px, py] of o._nosym ? [[X, Y]] : symPoints(X, Y, jx, jy)) {
      if (!sc.has(px, py)) continue;
      if (relMode) {
        const k = S.wrap ? mod(py, S.h) * S.w + mod(px, S.w) : py * S.w + px;
        if (seen.has(k)) continue;
        seen.add(k);
        const cur = get(px, py, sc.src);
        if (S.fullbright[cur]) continue;
        const baseStep = step >= 0 ? step : S.rampOf[c] ? S.rampOf[c].i : Math.round(brightnessOf(c) * (rLen - 1));
        const delta = baseStep - mid + sh;
        if (delta !== 0) putRel(px, py, cur, delta);
      } else {
        put(px, py, sh ? shadeIdx(c, sh) : c);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────── brushes, strokes & curves
const BRUSH_SHAPES = new Set(['circle', 'square', 'chisel', 'diamond', 'soft', 'spray', 'sprite', 'bristle', 'chalk', 'mottle']);
const BRUSH_BLENDS = new Set(['auto', 'mix', 'replace', 'tint', 'rgb']);
const BRUSH_OPTS = [
  'brush', 'size', 'angle', 'aspect', 'spacing', 'taper', 'jitter', 'scatter', 'density', 'rot',
  'n', 'bristles', 'skip', 'shade', 'flow', 'opacity', 'blend', 'ramps', 'tex_scale', 'alpha', 'tint',
  'size_jitter', 'angle_jitter', 'shade_jitter', 'flow_jitter',
];
const hasBrushOpt = (o) => BRUSH_OPTS.some((k) => o[k] !== undefined);
function parseTaper(v, dflt) {
  if (v === undefined) return dflt;
  const p = String(v).split(',').map((t) => clamp(int(t, 'taper'), 0, 200));
  if (p.length === 1) return [100, p[0]];
  if (p.length === 2 || p.length === 3) return p;
  fail(`taper must be end | start,end | start,mid,end, got "${v}"`);
}
function parseShadeRange(v) {
  if (v === undefined) return [0, 0];
  if (String(v).includes(',')) {
    let [lo, hi] = pair(v, [0, 0], 'shade');
    if (lo > hi) [lo, hi] = [hi, lo];
    return [clamp(lo, -16, 16), clamp(hi, -16, 16)];
  }
  const n = Math.abs(int(v, 'shade'));
  return [-clamp(n, 0, 16), clamp(n, 0, 16)];
}
function evalTaper(tp, t) {
  if (tp.length === 2) return (tp[0] + (tp[1] - tp[0]) * t) / 100;
  return t <= 0.5 ? (tp[0] + (tp[1] - tp[0]) * (t * 2)) / 100 : (tp[1] + (tp[2] - tp[1]) * ((t - 0.5) * 2)) / 100;
}
function smooth1D(pos, seed, salt) {
  const i0 = Math.floor(pos), f = pos - i0, u = f * f * (3 - 2 * f);
  const h0 = hash(i0, seed, salt), h1 = hash(i0 + 1, seed, salt);
  return h0 + (h1 - h0) * u;
}
function applyBrushOpts(dst, shapeArg, sprArg, o) {
  if (shapeArg) {
    if (shapeArg.startsWith('sprite:')) {
      const nm = shapeArg.slice(7);
      if (!S.sprites.has(nm)) fail(`no sprite "${nm}"`);
      dst.shape = 'sprite'; dst.sprite = nm;
      if (o.size === undefined) dst.spriteSize = 0;
    } else if (!BRUSH_SHAPES.has(shapeArg) && S.sprites.has(shapeArg)) {
      dst.shape = 'sprite'; dst.sprite = shapeArg;
      if (o.size === undefined) dst.spriteSize = 0;
    } else {
      if (!BRUSH_SHAPES.has(shapeArg)) fail(`unknown brush shape "${shapeArg}" (use: ${[...BRUSH_SHAPES].join(' ')})`);
      if (shapeArg === 'sprite') {
        const nm = need(sprArg, 'sprite name');
        if (!S.sprites.has(nm)) fail(`no sprite "${nm}"`);
        dst.shape = 'sprite'; dst.sprite = nm;
        if (o.size === undefined) dst.spriteSize = 0;
      } else {
        const prev = dst.shape;
        dst.shape = shapeArg;
        if (shapeArg === 'chisel' && prev !== 'chisel') {
          if (o.aspect === undefined) dst.aspect = 35;
          if (o.angle === undefined) dst.angle = 45;
        } else if (shapeArg !== 'chisel' && prev === 'chisel') {
          if (o.aspect === undefined) dst.aspect = 100;
          if (o.angle === undefined) dst.angle = 0;
        }
        if (shapeArg === 'bristle' && o.size === undefined && dst.size < 5) dst.size = 5;
        if ((shapeArg === 'chalk' || shapeArg === 'mottle') && o.size === undefined && dst.size < 6) dst.size = 6;
        dst.spriteAlpha = false;
      }
    }
  }
  if (o.alpha !== undefined) dst.spriteAlpha = !!o.alpha;
  if (o.size !== undefined) {
    const sz = clamp(int(o.size, 'size'), 1, 128);
    if (dst.shape === 'sprite') dst.spriteSize = sz; else dst.size = sz;
  }
  if (o.angle !== undefined) dst.angle = int(o.angle, 'angle');
  if (o.aspect !== undefined) dst.aspect = clamp(int(o.aspect, 'aspect'), 10, 400);
  if (o.spacing !== undefined) {
    const sm = /^(\d+)%$/.exec(String(o.spacing));
    if (sm) { dst.spacingPct = clamp(parseInt(sm[1], 10), 1, 500); dst.spacing = 0; }
    else { dst.spacing = clamp(int(o.spacing, 'spacing'), 1, 128); dst.spacingPct = 0; }
  }
  if (o.taper !== undefined) dst.taper = parseTaper(o.taper, dst.taper);
  if (o.jitter !== undefined) dst.jitter = clamp(int(o.jitter, 'jitter'), 0, 64);
  if (o.scatter !== undefined) dst.scatter = clamp(int(o.scatter, 'scatter'), 0, 64);
  if (o.density !== undefined) dst.density = clamp(int(o.density, 'density'), 1, 100);
  if (o.dither !== undefined) { ditherOpt(o.dither); dst.dither = o.dither; }
  if (o.rot !== undefined) {
    if (!['fixed', 'follow', 'random'].includes(o.rot)) fail('brush rot must be fixed | follow | random');
    dst.rot = o.rot;
  }
  if (o.seed !== undefined) dst.seed = int(o.seed, 'seed');
  if (o.n !== undefined || o.bristles !== undefined) dst.n = clamp(int(o.n ?? o.bristles, 'n'), 1, 32);
  if (o.skip !== undefined) dst.skip = clamp(int(o.skip, 'skip'), 0, 95);
  if (o.shade !== undefined) dst.shade = parseShadeRange(o.shade);
  if (o.flow !== undefined) dst.flow = clamp(int(o.flow, 'flow'), 1, 100);
  if (o.opacity !== undefined) dst.opacity = clamp(int(o.opacity, 'opacity'), 1, 100);
  if (o.blend !== undefined) {
    if (!BRUSH_BLENDS.has(o.blend)) fail(`blend must be ${[...BRUSH_BLENDS].join(' | ')}`);
    dst.blend = o.blend;
  }
  if (o.tint) dst.blend = 'tint';
  if (o.tex_scale !== undefined) dst.texScale = clamp(int(o.tex_scale, 'tex_scale'), 1, 64);
  if (o.size_jitter !== undefined) dst.sizeJitter = clamp(int(o.size_jitter, 'size_jitter'), 0, 100);
  if (o.angle_jitter !== undefined) dst.angleJitter = clamp(int(o.angle_jitter, 'angle_jitter'), 0, 180);
  if (o.shade_jitter !== undefined) dst.shadeJitter = clamp(int(o.shade_jitter, 'shade_jitter'), 0, 16);
  if (o.flow_jitter !== undefined) dst.flowJitter = clamp(int(o.flow_jitter, 'flow_jitter'), 0, 100);
  return dst;
}
function showBrush() {
  const b = S.brush, sz = b.shape === 'sprite' ? (b.spriteSize || 'native') : b.size;
  const spStr = b.spacingPct > 0 ? `${b.spacingPct}%` : `${b.spacing}`;
  const extra = [
    b.shape === 'bristle' ? `n=${b.n} skip=${b.skip} shade=${b.shade.join(',')}` : '',
    b.shape === 'sprite' && b.spriteAlpha ? 'alpha' : '',
    b.flow < 100 ? `flow=${b.flow}` : '',
    b.opacity < 100 ? `opacity=${b.opacity}` : '',
    b.blend !== 'auto' ? `blend=${b.blend}` : '',
    (b.shape === 'chalk' || b.shape === 'mottle') ? `tex_scale=${b.texScale}` : '',
    b.sizeJitter ? `size_jitter=${b.sizeJitter}` : '',
    b.angleJitter ? `angle_jitter=${b.angleJitter}` : '',
    b.shadeJitter ? `shade_jitter=${b.shadeJitter}` : '',
    b.flowJitter ? `flow_jitter=${b.flowJitter}` : '',
  ].filter(Boolean).join(' ');
  out(`brush ${b.shape}${b.shape === 'sprite' ? ' ' + b.sprite : ''} size=${sz} angle=${b.angle} aspect=${b.aspect} spacing=${spStr} taper=${b.taper.join(',')} jitter=${b.jitter} scatter=${b.scatter} density=${b.density} dither=${b.dither} rot=${b.rot} seed=${b.seed}${extra ? ' ' + extra : ''}${S.brushOn ? ' [active]' : ' [default]'}`);
}
function evalCurve(pts, closed, forceSpline) {
  const outPts = [];
  if (closed || forceSpline || pts.length >= 5) {
    const n = pts.length;
    const getP = (i) => {
      if (closed) return pts[mod(i, n)];
      if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
      if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
      return pts[i];
    };
    const segCount = closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = getP(i - 1), p1 = getP(i), p2 = getP(i + 1), p3 = getP(i + 2);
      const steps = Math.max(8, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * 2));
      for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
        const t = k / steps, t2 = t * t, t3 = t2 * t;
        outPts.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
  } else if (pts.length === 3) {
    const [p0, p1, p2] = pts, len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(12, Math.ceil(len * 2));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      outPts.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
    }
  } else {
    const [p0, p1, p2, p3] = pts, len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const steps = Math.max(16, Math.ceil(len * 2));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      outPts.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  }
  return outPts;
}
function warnOversizeBrush(B, sc, o) {
  if (!o._warn || B.shape === 'sprite') return;
  const effSize = B.shape === 'bristle' ? Math.max(B.n, B.size) : B.size;
  if (effSize < 4) return;
  if (o.region) {
    const [, , rw, rh] = regionOf(o);
    if (effSize > Math.min(rw, rh)) o._warn(`brush size=${effSize} exceeds region ${rw}x${rh}`);
  } else if (o.mask) {
    let minX = S.w, maxX = -1, minY = S.h, maxY = -1, cnt = 0;
    sc.each((x, y) => { cnt++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; });
    if (cnt > 0 && effSize > Math.min(maxX - minX + 1, maxY - minY + 1)) o._warn(`brush size=${effSize} is larger than masked feature (${maxX - minX + 1}x${maxY - minY + 1})`);
  }
}
function paintPath(rawPts, colTok, o, alreadyClosed = false) {
  // Explicit inline brush=<shape> starts from clean defaults so stale state doesn't leak.
  const baseBrush = o.brush ? DEFAULT_BRUSH() : { ...S.brush, taper: [...S.brush.taper], shade: [...S.brush.shade] };
  const B = applyBrushOpts(baseBrush, o.brush || null, null, o);
  const keep = colTok === 'keep';
  if (keep && B.shape !== 'sprite') fail('color "keep" only works with a sprite brush');
  const c = keep ? null : col(colTok);
  const sp = B.shape === 'sprite' ? (S.sprites.get(B.sprite) || fail(`no sprite "${B.sprite}"`)) : null;
  const closed = !!o.closed;
  const pts = closed && !alreadyClosed && rawPts.length >= 2 ? [...rawPts, rawPts[0]] : rawPts;
  const segs = [];
  let L = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], len = Math.hypot(x1 - x0, y1 - y0);
    if (len > 1e-6) { segs.push({ x0, y0, x1, y1, len, s0: L, tx: (x1 - x0) / len, ty: (y1 - y0) / len }); L += len; }
  }
  const baseRad = (B.angle * Math.PI) / 180, dabs = [];
  const baseSize = B.shape === 'sprite' ? (B.spriteSize || sp.w) : B.size;
  const step = B.spacingPct > 0
    ? Math.max(0.5, (baseSize * B.spacingPct) / 100)
    : (B.shape === 'bristle' ? 0.75 : (B.spacing <= 1 ? 0.5 : B.spacing));
  if (L === 0) {
    dabs.push({ x: pts[0][0], y: pts[0][1], s: 0, t: 0.5, nx: 0, ny: 1, theta: B.rot === 'random' ? hash(0, 0, B.seed, 58) * Math.PI * 2 : baseRad });
  } else {
    const nSteps = Math.max(1, Math.ceil(L / step)), jNodes = Math.max(2, Math.ceil(L / 4));
    const jVal = (sn) => {
      const pos = sn * (closed ? jNodes : jNodes - 1), i0 = Math.floor(pos), f = pos - i0, u = f * f * (3 - 2 * f);
      const n0 = closed ? i0 % jNodes : Math.min(i0, jNodes - 1), n1 = closed ? (i0 + 1) % jNodes : Math.min(i0 + 1, jNodes - 1);
      const h0 = hash(n0, B.seed, 55) * 2 - 1, h1 = hash(n1, B.seed, 55) * 2 - 1;
      return h0 + (h1 - h0) * u;
    };
    let si = 0;
    for (let k = 0; k <= nSteps; k++) {
      if (closed && step > 1 && k === nSteps) break;
      const s = k === nSteps ? L : Math.min(L, k * step);
      while (si + 1 < segs.length && s > segs[si].s0 + segs[si].len) si++;
      const seg = segs[si], u = clamp((s - seg.s0) / seg.len, 0, 1), sn = s / L;
      let x = seg.x0 + (seg.x1 - seg.x0) * u, y = seg.y0 + (seg.y1 - seg.y0) * u;
      if (B.jitter > 0) { const jn = jVal(sn) * B.jitter; x += -seg.ty * jn; y += seg.tx * jn; }
      if (B.scatter > 0) { const ang = hash(k, B.seed, 56) * Math.PI * 2, rad = hash(k, B.seed, 57) * B.scatter; x += Math.cos(ang) * rad; y += Math.sin(ang) * rad; }
      const theta = B.rot === 'follow' ? baseRad + Math.atan2(seg.ty, seg.tx) : B.rot === 'random' ? hash(k, B.seed, 58) * Math.PI * 2 : baseRad;
      dabs.push({ x, y, s, t: sn, nx: -seg.ty, ny: seg.tx, theta });
    }
  }
  const sc = scope(o), D = ditherOpt(B.dither), rel = !keep && typeof c === 'object', seen = new Set();
  warnOversizeBrush(B, sc, o);
  const maxOp = B.opacity / 100, baseFlow = B.flow / 100;
  const isTexturedTip = B.shape === 'soft' || B.shape === 'chalk' || B.shape === 'mottle' || (B.shape === 'sprite' && B.spriteAlpha);
  const buildupMode = B.flow < 100 || B.opacity < 100 || B.flowJitter > 0 || B.blend !== 'auto' || B.shape === 'chalk' || B.shape === 'mottle' || (B.shape === 'sprite' && B.spriteAlpha);
  const useAccum = isTexturedTip || buildupMode;
  const accum = useAccum ? new Map() : null;
  const rgbCand = B.blend === 'rgb' && o.ramps ? [...new Set(String(o.ramps).split(',').flatMap((nm) => S.ramps.get(nm) || fail(`unknown ramp "${nm}"`)))] : null;
  const [sjx, sjy] = symJitter(4);
  const dabDynamics = (k, baseTheta) => {
    const sizeMul = B.sizeJitter > 0 ? Math.max(0.25, 1 + (hash(k, B.seed, 61) * 2 - 1) * (B.sizeJitter / 100)) : 1;
    const angOff = B.angleJitter > 0 ? (hash(k, B.seed, 62) * 2 - 1) * ((B.angleJitter * Math.PI) / 180) : 0;
    const flowMul = B.flowJitter > 0 ? clamp(1 + (hash(k, B.seed, 63) * 2 - 1) * (B.flowJitter / 100), 0.05, 1.5) : 1;
    const shOff = B.shadeJitter > 0 ? Math.round((hash(k, B.seed, 64) * 2 - 1) * B.shadeJitter) : 0;
    return { sizeMul, theta: baseTheta + angOff, dabFlow: clamp(baseFlow * flowMul, 0.01, 1), shOff };
  };
  const deposit = (px, py, w, outCol, dabFlow, shOff = 0) => {
    px = Math.round(px); py = Math.round(py);
    for (const [sx, sy] of symPoints(px, py, sjx, sjy)) {
      if (!sc.has(sx, sy)) continue;
      const k = S.wrap ? mod(sy, S.h) * S.w + mod(sx, S.w) : sy * S.w + sx;
      if (useAccum) {
        let e = accum.get(k);
        if (!e) { e = { a: 0, shSum: 0, wSum: 0, col: outCol }; accum.set(k, e); }
        const a = clamp(w * dabFlow, 0, 1);
        if (a <= 0) continue;
        // Preserve original soft max(w) falloff when neither flow nor opacity buildup is requested.
        e.a = buildupMode ? Math.min(maxOp, 1 - (1 - e.a) * (1 - a)) : Math.max(e.a, a);
        e.shSum += shOff * a; e.wSum += a; e.col = outCol;
        continue;
      }
      const effCol = typeof outCol === 'object' ? { d: outCol.d + shOff } : (shOff ? shadeIdx(outCol, shOff) : outCol);
      if (typeof effCol !== 'object') { put(sx, sy, effCol); continue; }
      if (effCol.d === 0 || seen.has(k)) continue;
      seen.add(k);
      putRel(sx, sy, get(sx, sy, sc.src), effCol.d);
    }
  };
  if (B.shape === 'bristle') {
    const nb = B.n, [shLo, shHi] = B.shade, skipF = B.skip / 100, widthBase = Math.max(nb, B.size);
    const bShade = Array.from({ length: nb }, (_, b) => (shLo === shHi ? shLo : shLo + Math.floor(hash(b, B.seed, 71) * (shHi - shLo + 1))));
    dabs.forEach(({ x, y, s, t, nx, ny }, k) => {
      const { sizeMul, dabFlow, shOff } = dabDynamics(k, 0);
      const tp = evalTaper(B.taper, t), w = Math.max(1, widthBase * tp * sizeMul);
      if (tp <= 0.05) return;
      for (let b = 0; b < nb; b++) {
        if (skipF > 0 && smooth1D(s / 5 + b * 17.3, B.seed, 170 + b) < skipF) continue;
        const baseLat = nb === 1 ? 0 : ((b / (nb - 1)) - 0.5) * (w - 1);
        const wander = (smooth1D(s / 9 + b * 7.1, B.seed, 70 + b) - 0.5) * 1.4;
        const px = x + nx * (baseLat + wander), py = y + ny * (baseLat + wander);
        deposit(px, py, 1, c, dabFlow, bShade[b] + shOff);
      }
    });
  } else if (B.shape === 'sprite') {
    const scaleS = B.spriteSize ? B.spriteSize / sp.w : 1;
    const rLen = sp.meta?.ramp && S.ramps.get(sp.meta.ramp) ? S.ramps.get(sp.meta.ramp).length : 16;
    const sprCov = (sv, st) => (B.spriteAlpha ? (st >= 0 ? clamp((st + 1) / rLen, 0.05, 1) : clamp(brightnessOf(sv), 0.05, 1)) : 1);
    dabs.forEach(({ x, y, t, theta: bTheta }, k) => {
      const { sizeMul, theta, dabFlow, shOff } = dabDynamics(k, bTheta);
      const ts = evalTaper(B.taper, t) * scaleS * sizeMul;
      if (ts <= 0.05) return;
      const W = sp.w, H = sp.h, ix = Math.round(x), iy = Math.round(y);
      if (Math.abs(theta) < 1e-6 && Math.abs(ts - 1) < 1e-6) {
        const ox = Math.floor(W / 2), oy = Math.floor(H / 2);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const sv = sp.d[j * W + i], st = sp.steps ? sp.steps[j * W + i] : -1;
          if (sv >= 0) deposit(ix + i - ox, iy + j - oy, sprCov(sv, st), keep ? sv : c, dabFlow, shOff);
        }
      } else {
        const R = Math.ceil(Math.hypot(W * ts, H * ts) / 2) + 1, cs = Math.cos(theta), sn = Math.sin(theta);
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const u = Math.floor((dx * cs + dy * sn) / ts + W / 2), v = Math.floor((-dx * sn + dy * cs) / ts + H / 2);
          if (u >= 0 && u < W && v >= 0 && v < H) {
            const sv = sp.d[v * W + u], st = sp.steps ? sp.steps[v * W + u] : -1;
            if (sv >= 0) deposit(ix + dx, iy + dy, sprCov(sv, st), keep ? sv : c, dabFlow, shOff);
          }
        }
      }
    });
  } else {
    const texCx = Math.max(2, Math.round(S.w / B.texScale)), texCy = Math.max(2, Math.round(S.h / B.texScale));
    const worldTex = (wx, wy, mode) => {
      const u = (mod(wx, S.w) * texCx) / S.w, v = (mod(wy, S.h) * texCy) / S.h;
      const base = sampleValue(u, v, texCx, texCy, B.seed, 66);
      if (mode === 'chalk') return 0.65 * base + 0.35 * wnoise(wx, wy, B.seed, 67);
      return 0.7 * base + 0.3 * sampleValue(u * 2, v * 2, texCx * 2, texCy * 2, B.seed, 68);
    };
    dabs.forEach(({ x, y, t, theta: bTheta }, k) => {
      const { sizeMul, theta, dabFlow, shOff } = dabDynamics(k, bTheta);
      const d = B.size * evalTaper(B.taper, t) * sizeMul;
      if (d < 0.5) return;
      if (d <= 1.2 && B.shape !== 'spray' && !isTexturedTip) { deposit(Math.round(x), Math.round(y), 1, c, dabFlow, shOff); return; }
      const rd = Math.max(1, Math.round(d)), even = rd % 2 === 0 ? 0.5 : 0;
      const rx = d / 2, ry = Math.max(0.55, rx * (B.aspect / 100)), reach = Math.ceil(Math.hypot(rx, ry)) + 1;
      const ix = Math.round(x), iy = Math.round(y), cs = Math.cos(theta), sn = Math.sin(theta), cThresh = rx * rx - 0.35;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const px = ix + dx, py = iy + dy, ox = dx - even, oy = dy - even, u = ox * cs + oy * sn, v = -ox * sn + oy * cs;
        let w = 0;
        if (B.shape === 'circle') w = B.aspect === 100 && rd >= 3 ? (ox * ox + oy * oy <= cThresh ? 1 : 0) : ((u / rx) ** 2 + (v / ry) ** 2 <= 1 ? 1 : 0);
        else if (B.shape === 'square' || B.shape === 'chisel') w = Math.abs(u) <= rx && Math.abs(v) <= ry ? 1 : 0;
        else if (B.shape === 'diamond') w = Math.abs(u) / rx + Math.abs(v) / ry <= 1.05 ? 1 : 0;
        else if (B.shape === 'soft' || B.shape === 'spray' || B.shape === 'chalk' || B.shape === 'mottle') {
          const nr = Math.hypot(u / rx, v / ry);
          if (nr < 1) {
            if (B.shape === 'chalk') w = clamp((1 - nr * 0.85) * (0.45 + 0.9 * worldTex(px, py, 'chalk')) - 0.15, 0, 1);
            else if (B.shape === 'mottle') w = clamp((1 - nr * 0.75) * (0.25 + 1.1 * worldTex(px, py, 'mottle')) - 0.1, 0, 1);
            else w = 1 - nr;
          }
        }
        if (w <= 0) continue;
        if (B.shape === 'spray') {
          const wx = S.wrap ? mod(px, S.w) : px, wy = S.wrap ? mod(py, S.h) : py;
          if (hash(wx, wy, B.seed, 41) < (0.35 + 0.65 * w) * (B.density / 100)) deposit(px, py, 1, c, dabFlow, shOff);
        } else {
          deposit(px, py, w, c, dabFlow, shOff);
        }
      }
    });
  }
  if (accum) {
    for (const [k, e] of accum) {
      const px = k % S.w, py = (k / S.w) | 0, alpha = clamp(e.a, 0, 1);
      if (alpha <= 0) continue;
      const tVal = thr(D, px, py), cur = get(px, py, sc.src), shMean = e.wSum > 0 ? Math.round(e.shSum / e.wSum) : 0;
      if (typeof e.col === 'object') {
        if (S.fullbright[cur]) continue;
        const amt = (e.col.d + shMean) * alpha;
        const st = (amt >= 0 ? 1 : -1) * (D.kind === 'none' ? Math.round(Math.abs(amt)) : Math.floor(Math.abs(amt) + tVal));
        if (st !== 0) putRel(px, py, cur, st);
        continue;
      }
      const targetCol = shMean ? shadeIdx(e.col, shMean) : e.col;
      const effBlend = B.blend === 'auto' ? (alpha < 0.999 ? 'mix' : 'replace') : B.blend;
      if (effBlend !== 'replace' && S.fullbright[cur] && !S.fullbright[targetCol]) continue;
      if (effBlend === 'replace') {
        if (D.kind === 'none' ? alpha >= 0.5 : alpha > tVal) put(px, py, targetCol);
      } else if (effBlend === 'tint') {
        if (D.kind === 'none' ? alpha >= 0.5 : alpha > tVal) {
          const rmN = S.rampOf[targetCol];
          if (rmN) {
            const arr = S.ramps.get(rmN.name);
            put(px, py, arr[clamp(Math.round(brightnessOf(cur) * (arr.length - 1)), 0, arr.length - 1)]);
          } else put(px, py, targetCol);
        }
      } else if (effBlend === 'rgb') {
        const rgb = [0, 1, 2].map((ch) => Math.round((1 - alpha) * S.pal[cur][ch] + alpha * S.pal[targetCol][ch]));
        put(px, py, nearest(rgb, rgbCand));
      } else { // 'mix': ramp-step interpolation when same ramp, dithered coverage across different ramps
        const rmO = S.rampOf[cur], rmN = S.rampOf[targetCol];
        if (rmO && rmN && rmO.name === rmN.name) {
          const arr = S.ramps.get(rmO.name);
          const fStep = rmO.i + (rmN.i - rmO.i) * alpha;
          const q = D.kind === 'none' ? Math.round(fStep) : Math.floor(fStep + tVal);
          put(px, py, arr[clamp(q, 0, arr.length - 1)]);
        } else if (D.kind === 'none' ? alpha >= 0.5 : alpha > tVal) {
          put(px, py, targetCol);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────── pixel-art operations (all in palette / ramp steps)
function bayer(n, x, y) { // ordered-dither threshold in (0,1), n = 2, 4 or 8
  let v = 0;
  for (let b = 1; b < n; b <<= 1) v = (v << 2) | (((x ^ y) & b ? 2 : 0) | (y & b ? 1 : 0));
  return (v + 0.5) / (n * n);
}
// ── seeded noise: pure functions of (x, y, seed). Nothing is "random" between runs, and coordinates are folded with
//    mod(W,H) before hashing, so every noise-based pattern tiles by construction.
const mix32 = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16; return h >>> 0; };
function hash(x, y, seed = 0, salt = 0) { // uniform in [0,1)
  let h = mix32(((seed | 0) + 0x6d2b79f5) ^ Math.imul(salt | 0, 0x9e3779b9));
  h = mix32(h ^ Math.imul(x | 0, 0x85ebca6b));
  return mix32(h ^ Math.imul(y | 0, 0xc2b2ae35)) / 4294967296;
}
const wnoise = (x, y, seed, salt = 1) => hash(mod(x, S.w), mod(y, S.h), seed, salt);
function rng(seed) { // mulberry32 stream for commands that draw a sequence (scatter)
  let a = mix32(seed | 0);
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function ditherOpt(t) {
  const m = /^bayer([248])$/.exec(t), z = /^noise(?::([-+]?\d+))?$/.exec(t);
  if (m) return { kind: 'bayer', n: +m[1] };
  if (z) return { kind: 'noise', seed: +(z[1] || 0) };
  if (t === 'fs' || t === 'none') return { kind: t, n: 4 };
  fail(`dither must be bayer2 | bayer4 | bayer8 | noise[:seed] | fs | none, got "${t}"`);
}
const thr = (D, x, y) => (D.kind === 'noise' ? wnoise(x, y, D.seed) : bayer(D.n, mod(x, S.w), mod(y, S.h))); // threshold in (0,1)
function quantizer(D, W) { // float ramp-step -> integer step, dithered. fs keeps its error rows between calls (scan order)
  let err = new Float32Array(W + 2), nxt = new Float32Array(W + 2), row = -1;
  return (v, x, y, i, j) => {
    if (D.kind === 'fs') {
      if (j !== row) { if (j !== row + 1) nxt.fill(0); [err, nxt] = [nxt, err]; nxt.fill(0); row = j; }
      v += err[i + 1];
      const q = Math.round(v), e = v - q;
      err[i + 2] += (e * 7) / 16; nxt[i] += (e * 3) / 16; nxt[i + 1] += (e * 5) / 16; nxt[i + 2] += e / 16;
      return q;
    }
    return D.kind === 'none' ? Math.round(v) : Math.floor(v + thr(D, x, y));
  };
}
const tintCoverage = (v, prob) => {
  if (prob >= 100) return 1;
  if (prob <= 0) return 0;
  const t = prob / 100, cutoff = 1 - t, half = Math.min(0.25, t, 1 - t);
  return clamp((v - cutoff) / (2 * half) + 0.5, 0, 1);
};
// Gradient measured in RAMP STEPS and dithered between neighbouring steps.
// target = ramp name (paint that ramp) or "shade" (shift whatever is there by from..to steps).
function grad(target, x0, y0, x1, y1, o) {
  const rel = target === 'shade', r = rel ? null : S.ramps.get(target);
  if (!rel && !r) fail(`grad: "${target}" is not a ramp (or "shade"). ramps: ${[...S.ramps.keys()].join(' ')}`);
  if (o.tint && rel) fail('grad: tint requires a target ramp, not "shade"');
  const a = num(o.from, rel ? -2 : 0, 'from'), b = num(o.to, rel ? 2 : r.length - 1, 'to');
  const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy || 1, D = ditherOpt(o.dither || 'bayer4'), sc = scope(o), Q = quantizer(D, regionOf(o)[2]);
  const isRadial = !!o.radial || o.mode === 'radial' || o.shape === 'radial';
  const hasProb = o.prob !== undefined, prob = num(o.prob, 50, 'prob');
  if (prob < 0 || prob > 100) fail('prob must be 0..100');
  sc.each((x, y, c, i, j) => {
    if ((rel || o.tint) && S.fullbright[c]) return;
    const u = clamp(isRadial ? Math.sqrt(((x - x0) ** 2 + (y - y0) ** 2) / L) : ((x - x0) * dx + (y - y0) * dy) / L, 0, 1);
    if (o.tint) {
      if (Q(hasProb ? tintCoverage(u, prob) : u, x, y, i, j) >= 1) {
        put(x, y, r[clamp(Math.round(a + (b - a) * brightnessOf(c)), 0, r.length - 1)]);
      }
      return;
    }
    const q = Q(a + (b - a) * u, x, y, i, j);
    if (rel) putShaded(x, y, c, q, o); else put(x, y, r[clamp(q, 0, r.length - 1)]);
  });
}
function dfill(c, pct, o) { // pattern fill: paints <pct>% of the scoped pixels. bayer=N: ordered grid. noise=SEED: seeded grain
  const n = num(o.bayer, 4, 'bayer'), seeded = o.noise !== undefined, seed = num(o.noise, 0, 'noise');
  if (![2, 4, 8].includes(n)) fail('bayer must be 2, 4 or 8');
  if (seeded && o.bayer !== undefined) fail('dfill: use bayer=N or noise=SEED, not both');
  const P = plotter(o, c);
  let total = 0;
  scope(o).each((x, y) => { total++; if ((seeded ? wnoise(x, y, seed) : bayer(n, mod(x, S.w), mod(y, S.h))) < pct / 100) P(x, y); });
  if (!seeded && n === 2 && total >= 256 && o._warn) o._warn(`dfill bayer=2 over ${total}px can create visible checkerboard tiling (consider bayer=4 or noise=)`);
}
function sampleValue(u, v, cx, cy, seed, salt) {
  const iu = Math.floor(u), iv = Math.floor(v), fx = u - iu, fy = v - iv, ix = iu % cx, iy = iv % cy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), jx = (ix + 1) % cx, jy = (iy + 1) % cy;
  return hash(ix, iy, seed, salt) * (1 - sx) * (1 - sy) + hash(jx, iy, seed, salt) * sx * (1 - sy)
       + hash(ix, jy, seed, salt) * (1 - sx) * sy + hash(jx, jy, seed, salt) * sx * sy;
}
function sampleVoronoi(u, v, cx, cy, seed, salt) {
  const iu = Math.floor(u), iv = Math.floor(v);
  let d1 = Infinity, d2 = Infinity, bx = 0, by = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = mod(iu + dx, cx), ny = mod(iv + dy, cy);
    const px = iu + dx + 0.1 + 0.8 * hash(nx, ny, seed, salt), py = iv + dy + 0.1 + 0.8 * hash(nx, ny, seed, salt + 50);
    const d = Math.hypot(px - u, py - v);
    if (d < d1) { d2 = d1; d1 = d; bx = nx; by = ny; }
    else if (d < d2) d2 = d;
  }
  return { d1, d2, cell: hash(bx, by, seed, salt + 99) };
}
// Tileable fractal noise field over the whole canvas, normalised to 0..1 (so from/to are always reached).
// Supports value, turbulence, ridged, voronoi, cracks, cells, optional domain warp, and anisotropic cx0 x cy0.
function buildNoiseField(type, seed, cx0, cy0, oct, warp) {
  const W = S.w, H = S.h, f = new Float32Array(W * H);
  let wx = null, wy = null;
  if (warp > 0) {
    wx = buildNoiseField('value', seed + 101, cx0, cy0, Math.min(2, oct), 0);
    wy = buildNoiseField('value', seed + 202, cx0, cy0, Math.min(2, oct), 0);
  }
  for (let o = 0, amp = 1; o < oct; o++, amp /= 2) {
    const cx = cx0 << o, cy = cy0 << o, k = 100 + o, vk = 300 + o * 120;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const px = warp > 0 ? fmod(x + (wx[idx] - 0.5) * warp, W) : x;
      const py = warp > 0 ? fmod(y + (wy[idx] - 0.5) * warp, H) : y;
      const u = (px * cx) / W, v = (py * cy) / H;
      let val = 0;
      if (type === 'value') val = sampleValue(u, v, cx, cy, seed, k);
      else if (type === 'turbulence') val = Math.abs(2 * sampleValue(u, v, cx, cy, seed, k) - 1);
      else if (type === 'ridged') { const r = 1 - Math.abs(2 * sampleValue(u, v, cx, cy, seed, k) - 1); val = r * r; }
      else {
        const vr = sampleVoronoi(u, v, cx, cy, seed, vk);
        val = type === 'voronoi' ? vr.d1 : type === 'cracks' ? vr.d2 - vr.d1 : vr.cell;
      }
      f[idx] += amp * val;
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of f) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / (hi - lo || 1);
  return f;
}
const valueNoise = (seed, cx0, cy0, oct) => buildNoiseField('value', seed, cx0, cy0, oct, 0);
// Uniform-in-[0,1) decision field that is spatially CLUMPED (runs of ~clump px) instead of white noise: smooth value noise
// plus a little jitter, rank-transformed so that "u < prob" selects exactly prob of the pixels. clump=1 = plain white noise.
function clumpField(seed, clump) {
  const W = S.w, H = S.h, n = W * H, f = new Float32Array(n);
  if (clump <= 1) { for (let k = 0; k < n; k++) f[k] = hash(k % W, (k / W) | 0, seed, 6); return f; }
  const vn = valueNoise(seed, Math.max(1, Math.round(W / clump)), Math.max(1, Math.round(H / clump)), 1);
  for (let k = 0; k < n; k++) f[k] = vn[k] + 0.25 * hash(k % W, (k / W) | 0, seed, 6);
  const u = new Float32Array(n), idx = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => f[a] - f[b]);
  for (let r = 0; r < n; r++) u[idx[r]] = (r + 0.5) / n;
  return u;
}
const NOISE_TYPES = new Set(['value', 'turbulence', 'ridged', 'voronoi', 'cracks', 'cells']);
function noiseField(target, o) { // like grad, but the step offset comes from a smooth/cellular noise field
  const rel = target === 'shade', r = rel ? null : S.ramps.get(target);
  if (!rel && !r) fail(`noise: "${target}" is not a ramp (or "shade"). ramps: ${[...S.ramps.keys()].join(' ')}`);
  if (o.tint && rel) fail('noise: tint requires a target ramp, not "shade"');
  const seed = num(o.seed, 0, 'seed'), oct = num(o.octaves, 1, 'octaves');
  const baseSz = num(o.scale, 16, 'scale'), sx = num(o.scalex, baseSz, 'scalex'), sy = num(o.scaley, baseSz, 'scaley');
  const type = o.type || 'value', warp = num(o.warp, 0, 'warp');
  const contrast = num(o.contrast, 100, 'contrast'), bias = num(o.bias, 50, 'bias'), prob = num(o.prob, 50, 'prob');
  if (sx < 1 || sy < 1) fail('scale/scalex/scaley must be >= 1 (pixels per noise cell)');
  if (oct < 1 || oct > 6) fail('octaves must be 1..6');
  if (!NOISE_TYPES.has(type)) fail(`noise type must be ${[...NOISE_TYPES].join(' | ')}, got "${type}"`);
  if (warp < 0 || warp > 256) fail('warp must be 0..256');
  if (contrast < 1 || contrast > 500) fail('contrast must be 1..500');
  if (bias < 1 || bias > 99) fail('bias must be 1..99');
  if (prob < 0 || prob > 100) fail('prob must be 0..100');
  const a = num(o.from, rel ? -2 : 0, 'from'), b = num(o.to, rel ? 2 : r.length - 1, 'to'), D = ditherOpt(o.dither || `noise:${seed}`);
  const cx = Math.max(1, Math.round(S.w / sx)), cy = Math.max(1, Math.round(S.h / sy));
  if ((o.scale !== undefined || o.scalex !== undefined || o.scaley !== undefined) && (S.w / cx !== sx || S.h / cy !== sy)) {
    out(`note: scale adjusted so the tile closes: noise cells are ${+(S.w / cx).toFixed(1)}x${+(S.h / cy).toFixed(1)} px`);
  }
  const F = buildNoiseField(type, seed, cx, cy, oct, warp), sc = scope(o), Q = quantizer(D, regionOf(o)[2]);
  const gamma = bias === 50 ? 1 : Math.log(bias / 100) / Math.log(0.5);
  sc.each((x, y, c, i, j) => {
    if ((rel || o.tint) && S.fullbright[c]) return;
    let v = F[mod(y, S.h) * S.w + mod(x, S.w)];
    if (contrast !== 100) v = clamp((v - 0.5) * (contrast / 100) + 0.5, 0, 1);
    if (gamma !== 1) v = Math.pow(v, gamma);
    if (o.tint) {
      if (Q(tintCoverage(v, prob), x, y, i, j) >= 1) {
        put(x, y, r[clamp(Math.round(a + (b - a) * brightnessOf(c)), 0, r.length - 1)]);
      }
      return;
    }
    const q = Q(a + (b - a) * v, x, y, i, j);
    if (rel) putRel(x, y, c, q); else put(x, y, r[clamp(q, 0, r.length - 1)]);
  });
}
// Scatter n copies of one or more sprites at seeded positions. The sprite's centre must land on a scoped pixel;
// "inside" demands every opaque pixel does. min = minimum centre distance (wrap-aware).
function scatter(sps, n, o) {
  if (n < 1 || n > 5000) fail('scatter: n must be 1..5000');
  const seed = num(o.seed, 0, 'seed'), gap = num(o.min, 0, 'min'), R = rng(seed), sc = scope(o), [x0, y0, w, h] = regionOf(o), pts = [];
  const fixed = o.rot === 'any' ? null : num(o.rot, 0, 'rot');
  let shLo = 0, shHi = 0;
  if (o.shade !== undefined) {
    if (String(o.shade).includes(',')) [shLo, shHi] = pair(o.shade, [0, 0], 'shade');
    else { const v = Math.abs(int(o.shade, 'shade')); shLo = -v; shHi = v; }
    if (shLo > shHi) [shLo, shHi] = [shHi, shLo];
  }
  const far = (cx, cy) => pts.every(([px, py]) => {
    let dx = Math.abs(cx - px), dy = Math.abs(cy - py);
    if (S.wrap) { dx = mod(dx, S.w); dy = mod(dy, S.h); dx = Math.min(dx, S.w - dx); dy = Math.min(dy, S.h - dy); }
    return Math.hypot(dx, dy) >= gap;
  });
  for (let t = 0; pts.length < n && t < n * 100; t++) {
    const sp = sps.length === 1 ? sps[0] : sps[Math.floor(R() * sps.length)];
    const x = x0 + Math.floor(R() * w), y = y0 + Math.floor(R() * h);
    const rot = fixed === null ? 90 * Math.floor(R() * 4) : fixed, fx = !!o.flip && R() < 0.5, fy = !!o.flip && R() < 0.5;
    const sh = shLo === shHi ? shLo : shLo + Math.floor(R() * (shHi - shLo + 1));
    const q = mod(Math.round(rot / 90), 4), [W, H] = q & 1 ? [sp.h, sp.w] : [sp.w, sp.h], cx = x + (W >> 1), cy = y + (H >> 1);
    if (!sc.has(cx, cy) || !far(cx, cy)) continue;
    if (o.inside) { let ok = true; for (let j = 0; j < H && ok; j++) for (let i = 0; i < W && ok; i++) if (sprAt(sp, q, fx, fy, i, j).c >= 0 && !sc.has(x + i, y + j)) ok = false; if (!ok) continue; }
    pts.push([cx, cy]);
    stamp(sp, x, y, { flipx: fx, flipy: fy, rot: String(rot), _sc: sc, _shade: sh, _nosym: true });
  }
  if (pts.length < n) out(`scatter: placed ${pts.length} of ${n} — no room left; lower min=, widen mask=/region=, or drop inside`);
}
// rough: the shape (mask ∧ region) gets an irregular edge. Layer d = d pixels from the border; a seeded noise test
// decides who flips, and a pixel in layer d>1 only flips if a neighbour in layer d-1 did (no floating islands).
// Erosion copies the colour of the nearest outside pixel, growth the nearest inside colour: palette-safe.
function roughMask(ins, outs, A, P, clump, seed, mode, onFlip) {
  const W = S.w, H = S.h, n = W * H;
  const at = (k, dx, dy) => { let x = (k % W) + dx, y = ((k / W) | 0) + dy; if (S.wrap) { x = mod(x, W); y = mod(y, H); } else if (x < 0 || y < 0 || x >= W || y >= H) return -1; return y * W + x; };
  const bite = (T, Opp, U, isGrow) => {
    const layer = new Uint8Array(n), ref = new Int32Array(n).fill(-1), lists = [null, []];
    for (let k = 0; k < n; k++) if (T[k]) for (const [dx, dy] of N4) { const j = at(k, dx, dy); if (j >= 0 && Opp[j]) { layer[k] = 1; ref[k] = j; lists[1].push(k); break; } }
    for (let d = 2; d <= A; d++) { lists[d] = []; for (const k of lists[d - 1]) for (const [dx, dy] of N4) { const j = at(k, dx, dy); if (j >= 0 && T[j] && !layer[j]) { layer[j] = d; ref[j] = ref[k]; lists[d].push(j); } } }
    const take = new Uint8Array(n);
    for (let d = 1; d <= A; d++) for (const k of lists[d]) {
      if (d > 1 && !N4.some(([dx, dy]) => { const j = at(k, dx, dy); return j >= 0 && layer[j] === d - 1 && take[j]; })) continue;
      if (U[k] < (P * (A + 1 - d)) / A) { take[k] = 1; onFlip(k, ref[k], isGrow); }
    }
    return take;
  };
  const eroded = mode[0] ? bite(ins, ins.map((v) => v ^ 1), clumpField(seed * 2, clump), false) : new Uint8Array(n);
  // growth may only start from inside pixels that survived the erosion, otherwise it leaves loose pixels floating in the gap
  if (mode[1]) bite(outs, ins.map((v, k) => v & (eroded[k] ^ 1)), clumpField(seed * 2 + 1, clump), true);
}
function rough(o) {
  if (!o.mask && !o.region && !o.shape) fail('rough needs mask=<colors>, shape=<name>, and/or region=');
  const A = num(o.amount, 1, 'amount'), P = num(o.prob, 50, 'prob') / 100, seed = num(o.seed, 0, 'seed'), clump = num(o.clump, 3, 'clump');
  if (A < 1 || A > 8) fail('amount must be 1..8');
  if (clump < 1 || clump > 32) fail('clump must be 1..32 (pixels per bump; 1 = white noise)');
  const mode = { both: [1, 1], in: [1, 0], inner: [1, 0], out: [0, 1], outer: [0, 1] }[o.side || 'both'];
  if (!mode) fail('side must be both | in | out');
  const sc = scope(o), W = S.w, n = W * S.h, ins = new Uint8Array(n), outs = new Uint8Array(n);
  for (let k = 0; k < n; k++) { const x = k % W, y = (k / W) | 0; ins[k] = sc.has(x, y) ? 1 : 0; outs[k] = !ins[k] && sc.inR(x, y) ? 1 : 0; }
  roughMask(ins, outs, A, P, clump, seed, mode, (k, j) => put(k % W, (k / W) | 0, sc.src[j]));
}
// chip: convex corners (an L of two orthogonal outside neighbours) lose 1..size pixels with probability prob.
// face=n (optional) shades the newly exposed pixels of the cut n ramp steps (+ lit, - dark).
function chip(o) {
  if (!o.mask && !o.region && !o.shape) fail('chip needs mask=<colors>, shape=<name>, and/or region=');
  const P = num(o.prob, 40, 'prob') / 100, size = clamp(num(o.size, 2, 'size'), 1, 3), seed = num(o.seed, 0, 'seed'), face = num(o.face, 0, 'face'), sc = scope(o);
  const outside = (x, y) => get(x, y, sc.src) >= 0 && !sc.has(x, y), key = (x, y) => mod(y, S.h) * S.w + mod(x, S.w), used = new Set(), cut = [];
  sc.each((x, y) => {
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (!outside(x + dx, y) || !outside(x, y + dy) || used.has(key(x, y))) continue;
      if (hash(x, y, seed, 2) >= P) return;
      const nbs = [[x - dx, y], [x, y - dy]].filter(([u, v]) => sc.has(u, v) && !used.has(key(u, v)));
      const want = 1 + Math.floor(hash(x, y, seed, 3) * size), cells = [[x, y]];
      if (want === 2 && nbs.length) cells.push(nbs[hash(x, y, seed, 4) < 0.5 ? 0 : nbs.length - 1]);
      if (want === 3) cells.push(...nbs);
      for (const [u, v] of cells) {
        const nb = N4.map(([ex, ey]) => [u + ex, v + ey]).find(([p, q]) => outside(p, q));
        used.add(key(u, v)); cut.push([u, v, get(...(nb || [x + dx, y]), sc.src)]);
      }
      return;
    }
  });
  for (const [u, v, c] of cut) put(u, v, c);
  if (face) {
    const done = new Set();
    for (const [u, v] of cut) for (const [ex, ey] of N4) {
      const p = u + ex, q = v + ey, k = key(p, q);
      if (sc.has(p, q) && !used.has(k) && !done.has(k)) { done.add(k); put(p, q, shadeIdx(get(p, q, sc.src), face)); }
    }
  }
}
// smudge: blur INSIDE the palette. Default: mean of the ramp STEPS of same-ramp neighbours (other ramps are ignored,
// so stone never bleeds into moss), rounded with seeded noise (floor(mean + u)) so a checkerboard melts into
// mottling instead of flipping. blend=nearest ramps=a,b: RGB mean snapped to the nearest colour of those ramps.
function smudge(o) {
  const R = num(o.radius, 1, 'radius'), str = num(o.strength, 100, 'strength') / 100, seed = num(o.seed, 0, 'seed'), len = num(o.len, 3, 'len'), passes = num(o.passes, 1, 'passes');
  if (R < 1 || R > 8 || len < 1 || len > 32 || passes < 1 || passes > 8 || str < 0 || str > 1) fail('smudge: radius 1..8, len 1..32, passes 1..8, strength 0..100');
  const blend = o.blend || 'ramp', rnd = o.round || 'noise', prot = o.protect;
  if (blend !== 'ramp' && blend !== 'nearest') fail('blend must be ramp | nearest');
  if (rnd !== 'noise' && rnd !== 'nearest') fail('round must be noise | nearest');
  let cand = null;
  if (blend === 'nearest') {
    if (!o.ramps) fail('blend=nearest needs ramps=a,b (the only ramps the result may snap to)');
    cand = [...new Set(String(o.ramps).split(',').flatMap((nm) => S.ramps.get(nm) || fail(`unknown ramp "${nm}"`)))];
  }
  const inCand = new Uint8Array(256), offs = [];
  if (cand) cand.forEach((c) => (inCand[c] = 1));
  if (o.dir) { // axis (x y d1 d2): symmetric reach ±len.  compass (n s e w ..): colour flows TOWARD that direction, reach len upstream
    const AX = { x: [1, 0], y: [0, 1], d1: [1, 1], d2: [1, -1] }, d = o.dir;
    if (AX[d]) for (let k = -len; k <= len; k++) offs.push([AX[d][0] * k, AX[d][1] * k]);
    else if (DIRS[d]) for (let k = 0; k <= len; k++) offs.push([-DIRS[d][0] * k, -DIRS[d][1] * k]);
    else fail(`dir must be x | y | d1 | d2 or a compass direction (${Object.keys(DIRS).join(' ')})`);
  } else for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) offs.push([i, j]);
  for (let p = 0; p < passes; p++) {
    const sc = scope(o), sd = seed + p * 7919;
    sc.each((x, y, c) => {
      if (prot && prot[c]) return;
      if (str < 1 && hash(x, y, sd, 4) >= str) return;
      let sum = 0, cnt = 0;
      if (cand) {
        if (!inCand[c]) return;
        const rgb = [0, 0, 0];
        for (const [dx, dy] of offs) { const nc = get(x + dx, y + dy, sc.src); if (nc >= 0 && inCand[nc] && !(prot && prot[nc])) { cnt++; for (let k = 0; k < 3; k++) rgb[k] += S.pal[nc][k]; } }
        if (cnt) put(x, y, nearest(rgb.map((v) => Math.round(v / cnt)), cand));
      } else {
        const rm = S.rampOf[c];
        if (!rm) return;
        for (const [dx, dy] of offs) { const nc = get(x + dx, y + dy, sc.src), rn = nc >= 0 ? S.rampOf[nc] : null; if (rn && rn.name === rm.name && !(prot && prot[nc])) { sum += rn.i; cnt++; } }
        const m = sum / cnt, arr = S.ramps.get(rm.name), q = rnd === 'noise' ? Math.floor(m + hash(x, y, sd, 5)) : Math.round(m);
        put(x, y, arr[clamp(q, 0, arr.length - 1)]);
      }
    });
  }
}
// cavity: 2D ambient occlusion / contact shadow & crevice deepening.
function cavity(o) {
  const R = num(o.radius, 2, 'radius');
  if (R < 1 || R > 6) fail('cavity: radius must be 1..6');
  const lo = num(o.lo, 2, 'lo'), minPct = num(o.min, o.against ? 15 : 25, 'min');
  if (lo < 1 || lo > 16) fail('cavity: lo must be 1..16');
  if (minPct < 0 || minPct > 100) fail('cavity: min must be 0..100');
  const seed = num(o.seed, 0, 'seed'), D = ditherOpt(o.dither || `noise:${seed}`), sc = scope(o), ag = o.against || null, offs = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    if (!dx && !dy) continue;
    const d = Math.hypot(dx, dy);
    if (d <= R + 0.25) offs.push([dx, dy, 1 / d]);
  }
  const wSum = offs.reduce((s, a) => s + a[2], 0) || 1, Q = quantizer(D, regionOf(o)[2]), minF = minPct / 100;
  sc.each((x, y, c, i, j) => {
    if (S.fullbright[c]) return;
    if (!o.mask && ag && ag[c]) return;
    let occ = 0;
    if (ag) {
      for (const [dx, dy, w] of offs) { const nc = get(x + dx, y + dy, sc.src); if (nc >= 0 && ag[nc]) occ += w; }
      occ /= wSum;
    } else if (o.mask) {
      for (const [dx, dy, w] of offs) { const nc = get(x + dx, y + dy, sc.src); if (nc >= 0 && !o.mask[nc]) occ += w; }
      occ /= wSum;
    } else {
      const myL = lum(S.pal[c]);
      let avgL = 0, ws = 0;
      for (const [dx, dy, w] of offs) { const nc = get(x + dx, y + dy, sc.src); if (nc >= 0) { avgL += lum(S.pal[nc]) * w; ws += w; } }
      occ = ws ? clamp((avgL / ws - myL) / 64, 0, 1) : 0;
    }
    if (occ <= minF) return;
    const t = clamp((occ - minF) / Math.max(0.05, 1 - minF), 0, 1);
    const q = Q(t * lo, x, y, i, j);
    if (q > 0) putShaded(x, y, c, -q, o);
  });
}
function pixelate(n, o) { // each n×n block becomes its most frequent palette index
  if (n < 2) fail('pixelate: block size must be >= 2');
  const sc = scope(o), [x0, y0, w, h] = regionOf(o);
  for (let by = 0; by < h; by += n) for (let bx = 0; bx < w; bx += n) {
    const cnt = new Map();
    let best = -1, bc = 0;
    for (let j = 0; j < n && by + j < h; j++) for (let i = 0; i < n && bx + i < w; i++) {
      const c = get(x0 + bx + i, y0 + by + j, sc.src);
      if (c < 0) continue;
      const k = (cnt.get(c) || 0) + 1;
      cnt.set(c, k);
      if (k > bc) { bc = k; best = c; }
    }
    if (best < 0) continue;
    for (let j = 0; j < n && by + j < h; j++) for (let i = 0; i < n && bx + i < w; i++) if (sc.has(x0 + bx + i, y0 + by + j)) put(x0 + bx + i, y0 + by + j, best);
  }
}
function resize(w, h) { // nearest-neighbour (syncs px, hmap, and layers)
  if (w < 1 || h < 1 || w > 4096 || h > 4096) fail('resize: size must be 1..4096');
  const mapBuf = (src, Ctor) => {
    const dst = new Ctor(w * h);
    for (let y = 0; y < h; y++) {
      const sy = Math.floor(((y + 0.5) * S.h) / h);
      for (let x = 0; x < w; x++) dst[y * w + x] = src[sy * S.w + Math.floor(((x + 0.5) * S.w) / w)];
    }
    return dst;
  };
  S.px = mapBuf(S.px, Uint8Array);
  S.hmap = mapBuf(S.hmap, Float32Array);
  if (S.albedo) S.albedo = mapBuf(S.albedo, Uint8Array);
  for (const L of S.layers) { L.px = mapBuf(L.px, L.kind === 'base' ? Uint8Array : Int16Array); if (L.hmap) L.hmap = mapBuf(L.hmap, Float32Array); }
  for (const [k, sb] of S.shapes) S.shapes.set(k, mapBuf(sb, Uint8Array));
  S.w = w; S.h = h; syncLayers(); S.changed++;
}
function outline(c, o) { // shape = (mask ∧ shape ∧ region). side=outer paints just outside it, side=inner its border pixels
  if (!o.mask && !o.shape) fail('outline needs mask=<colors> or shape=<name> describing the shape to outline');
  const side = o.side || 'outer';
  if (side !== 'outer' && side !== 'inner') fail('side must be outer or inner');
  const sc = scope(o), nb = o.diag ? N8 : N4, inner = side === 'inner', [x0, y0, w, h] = regionOf(o);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + i, y = y0 + j, cur = get(x, y, sc.src);
    if (cur < 0 || sc.has(x, y) !== inner) continue;
    if (nb.some(([dx, dy]) => sc.has(x + dx, y + dy) !== inner)) {
      if (typeof c === 'object') putRel(x, y, cur, c.d); else put(x, y, c);
    }
  }
}
const DIRS = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
// Bevel the shape (mask ∧ region): edges facing the light go +hi ramp steps, edges facing away go -lo.
function bevel(o) {
  const L = DIRS[o.light || 'nw'];
  if (!L) fail(`light must be one of: ${Object.keys(DIRS).join(' ')}`);
  const [lx, ly] = L, depth = num(o.depth, 1, 'depth'), hi = num(o.hi, 1, 'hi'), lo = num(o.lo, 1, 'lo'), sc = scope(o);
  sc.each((x, y, c) => {
    if (S.fullbright[c]) return;
    for (let d = 1; d <= depth; d++) {
      const lit = (lx !== 0 && !sc.has(x + lx * d, y)) || (ly !== 0 && !sc.has(x, y + ly * d));
      const dark = (lx !== 0 && !sc.has(x - lx * d, y)) || (ly !== 0 && !sc.has(x, y - ly * d));
      if (!lit && !dark) continue;
      const k = o.soft ? d - 1 : 0; // soft: the bevel fades by one step per pixel inward
      if (lit !== dark) putShaded(x, y, c, lit ? Math.max(1, hi - k) : -Math.max(1, lo - k), o);
      break;
    }
  });
}
function shift(dx, dy) { // scroll with wrap — move the seams to the middle to inspect/paint over them
  const mapBuf = (src, Ctor) => {
    const dst = new Ctor(src.length);
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) dst[mod(y + dy, S.h) * S.w + mod(x + dx, S.w)] = src[y * S.w + x];
    return dst;
  };
  S.px = mapBuf(S.px, Uint8Array);
  S.hmap = mapBuf(S.hmap, Float32Array);
  if (S.albedo) S.albedo = mapBuf(S.albedo, Uint8Array);
  for (const L of S.layers) { L.px = mapBuf(L.px, L.kind === 'base' ? Uint8Array : Int16Array); if (L.hmap) L.hmap = mapBuf(L.hmap, Float32Array); }
  for (const [k, sb] of S.shapes) S.shapes.set(k, mapBuf(sb, Uint8Array));
  syncLayers(); S.changed++;
}
function flip(axis) {
  if (axis !== 'x' && axis !== 'y') fail('flip x | flip y');
  const mapBuf = (src, Ctor) => {
    const dst = new Ctor(src.length);
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) dst[y * S.w + x] = src[(axis === 'y' ? S.h - 1 - y : y) * S.w + (axis === 'x' ? S.w - 1 - x : x)];
    return dst;
  };
  S.px = mapBuf(S.px, Uint8Array);
  S.hmap = mapBuf(S.hmap, Float32Array);
  if (S.albedo) S.albedo = mapBuf(S.albedo, Uint8Array);
  for (const L of S.layers) { L.px = mapBuf(L.px, L.kind === 'base' ? Uint8Array : Int16Array); if (L.hmap) L.hmap = mapBuf(L.hmap, Float32Array); }
  for (const [k, sb] of S.shapes) S.shapes.set(k, mapBuf(sb, Uint8Array));
  syncLayers(); S.changed++;
}
// Bring an RGB(A) PNG into the palette with error-diffusion (fs) or ordered (bayerN) dithering.
function importImg(file, x, y, o) {
  const im = decodePNG(fs.readFileSync(file)), tw = num(o.w, im.w, 'w'), th = num(o.h, im.h, 'h'), D = ditherOpt(o.dither || 'fs'), spread = num(o.spread, 32, 'spread');
  const cand = o.ramps ? [...new Set(String(o.ramps).split(',').flatMap((n) => S.ramps.get(n) || fail(`unknown ramp "${n}"`)))] : null;
  const sc = scope(o);
  let e0 = new Float32Array((tw + 2) * 3), e1 = new Float32Array((tw + 2) * 3);
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const s = (Math.floor(((j + 0.5) * im.h) / th) * im.w + Math.floor(((i + 0.5) * im.w) / tw)) * 4;
      if (im.rgba[s + 3] < 128) continue;
      const add = D.kind === 'bayer' ? (bayer(D.n, i, j) - 0.5) * spread : D.kind === 'noise' ? (wnoise(x + i, y + j, D.seed) - 0.5) * spread : 0;
      const v = [0, 1, 2].map((k) => clamp(Math.round(im.rgba[s + k] + add + (D.kind === 'fs' ? e0[(i + 1) * 3 + k] : 0)), 0, 255)), c = nearest(v, cand);
      if (D.kind === 'fs') for (let k = 0; k < 3; k++) {
    const e = v[k] - S.pal[c][k];
        e0[(i + 2) * 3 + k] += (e * 7) / 16; e1[i * 3 + k] += (e * 3) / 16; e1[(i + 1) * 3 + k] += (e * 5) / 16; e1[(i + 2) * 3 + k] += e / 16;
      }
      if (sc.has(x + i, y + j)) put(x + i, y + j, c);
    }
    [e0, e1] = [e1, e0]; e1.fill(0);
  }
}

// ─────────────────────────────────────────────────────────────── height map, lighting & hatching
const getH = (x, y, src = S.hmap) => {
  if (S.wrap) return src[mod(y, S.h) * S.w + mod(x, S.w)];
  return src[clamp(y, 0, S.h - 1) * S.w + clamp(x, 0, S.w - 1)];
};
// Exact 2D Euclidean Distance Transform (Felzenszwalb-Huttenlocher), wrap-aware via 3x periodic extension.
function edt1d(f, n, outArr) {
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const r = v[k];
      s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
      if (s > z[k]) break;
      k--;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k], d = q - r;
    outArr[q] = d * d + f[r];
  }
}
function computeEDT(inside) {
  const W = S.w, H = S.h, INF = 1e12, g = new Float64Array(W * H);
  let hasOut = false;
  for (let i = 0; i < W * H; i++) if (!inside[i]) { hasOut = true; break; }
  if (!hasOut) return new Float32Array(W * H);
  const colIn = new Float64Array(S.wrap ? H * 3 : H), colOut = new Float64Array(S.wrap ? H * 3 : H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const val = inside[y * W + x] ? INF : 0;
      if (S.wrap) { colIn[y] = val; colIn[y + H] = val; colIn[y + H * 2] = val; } else colIn[y] = val;
    }
    edt1d(colIn, colIn.length, colOut);
    const off = S.wrap ? H : 0;
    for (let y = 0; y < H; y++) g[y * W + x] = colOut[y + off];
  }
  const rowIn = new Float64Array(S.wrap ? W * 3 : W), rowOut = new Float64Array(S.wrap ? W * 3 : W);
  const res = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const val = g[y * W + x];
      if (S.wrap) { rowIn[x] = val; rowIn[x + W] = val; rowIn[x + W * 2] = val; } else rowIn[x] = val;
    }
    edt1d(rowIn, rowIn.length, rowOut);
    const off = S.wrap ? W : 0;
    for (let x = 0; x < W; x++) res[y * W + x] = Math.sqrt(rowOut[x + off]);
  }
  return res;
}
function samplePath(pts, step = 0.5) {
  const segs = [];
  let L = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], len = Math.hypot(x1 - x0, y1 - y0);
    if (len > 1e-6) { segs.push({ x0, y0, x1, y1, len, s0: L }); L += len; }
  }
  const samples = [];
  if (L === 0) samples.push([pts[0][0], pts[0][1], 0.5]);
  else {
    const nSteps = Math.max(1, Math.ceil(L / step));
    let si = 0;
    for (let k = 0; k <= nSteps; k++) {
      const s = k === nSteps ? L : Math.min(L, k * step);
      while (si + 1 < segs.length && s > segs[si].s0 + segs[si].len) si++;
      const seg = segs[si], u = clamp((s - seg.s0) / seg.len, 0, 1);
      samples.push([seg.x0 + (seg.x1 - seg.x0) * u, seg.y0 + (seg.y1 - seg.y0) * u, s / L]);
    }
  }
  return samples;
}
function crackHeightCmd(a, o, HBUF, writeH) {
  const [[x0, y0], [x1, y1]] = ptsOf([need(a[1], 'x0,y0'), need(a[2], 'x1,y1')], 2, 'height crack', true);
  const depth = fnum(o.depth, 3, 'depth'), w = clamp(fnum(o.width ?? o.size, 1.2, 'width'), 1, 4);
  const nBranch = clamp(num(o.branch, 2, 'branch'), 0, 8), wobble = clamp(fnum(o.wobble, 2.5, 'wobble'), 0, 16);
  const seed = num(o.seed, 0, 'seed'), sc = scope(o), crackCol = o.color !== undefined ? col(o.color) : null;
  const lipCol = o.lip !== undefined ? (/^[+-]?\d+$/.test(String(o.lip)) ? { d: parseInt(o.lip, 10) } : col(o.lip)) : null;
  const segs = [];
  const subdiv = (ax, ay, bx, by, disp, it, salt) => {
    if (it <= 0 || Math.hypot(bx - ax, by - ay) < 2) return [[ax, ay], [bx, by]];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
    const off = (hash(Math.round(ax + bx), Math.round(ay + by), seed, salt) * 2 - 1) * disp;
    const mx = (ax + bx) * 0.5 - (dy / l) * off, my = (ay + by) * 0.5 + (dx / l) * off;
    const L = subdiv(ax, ay, mx, my, disp * 0.55, it - 1, salt + 11);
    const R = subdiv(mx, my, bx, by, disp * 0.55, it - 1, salt + 23);
    return [...L, ...R.slice(1)];
  };
  const mainPath = subdiv(x0, y0, x1, y1, wobble, 3, 201);
  segs.push(mainPath);
  for (let b = 0; b < nBranch && mainPath.length >= 3; b++) {
    const idx = clamp(Math.floor(((b + 1) / (nBranch + 1)) * (mainPath.length - 1)), 1, mainPath.length - 2);
    const [bx, by] = mainPath[idx], [px, py] = mainPath[idx - 1];
    const ang = Math.atan2(by - py, bx - px) + ((b & 1 ? 1 : -1) * (0.65 + 0.4 * hash(b, idx, seed, 217)));
    const bLen = Math.hypot(x1 - x0, y1 - y0) * (0.24 + 0.2 * hash(idx, b, seed, 219));
    segs.push(subdiv(bx, by, bx + Math.cos(ang) * bLen, by + Math.sin(ang) * bLen, wobble * 0.6, 2, 230 + b * 7));
  }
  const crackPx = new Set(), weights = new Map();
  for (let si = 0; si < segs.length; si++) {
    for (const [x, y, t] of samplePath(segs[si], 0.4)) {
      const r = Math.max(0.5, (w * (si === 0 ? 1 - 0.35 * Math.abs(t - 0.5) * 2 : 1 - t * 0.6)) / 2), reach = Math.ceil(r);
      const ix = Math.round(x), iy = Math.round(y);
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const nr = Math.hypot(dx, dy) / r;
        if (nr > 1) continue;
        const valW = (1 - nr * 0.65) * (si === 0 ? 1 : 0.7);
        for (const [sx, sy] of symPoints(ix + dx, iy + dy)) {
          if (!sc.has(sx, sy)) continue;
          const k = mod(sy, S.h) * S.w + mod(sx, S.w);
          crackPx.add(k);
          if (valW > (weights.get(k) || 0)) weights.set(k, valW);
        }
      }
    }
  }
  for (const [k, wt] of weights) writeH(k, -depth * wt);
  if (lipCol) {
    for (const k of crackPx) {
      const lx = (k % S.w) + 1, ly = ((k / S.w) | 0) + 1;
      if (!S.wrap && (lx >= S.w || ly >= S.h)) continue;
      const nk = mod(ly, S.h) * S.w + mod(lx, S.w);
      if (crackPx.has(nk) || !sc.has(lx, ly)) continue;
      const cur = sc.src[nk];
      if (!S.fullbright[cur]) { if (typeof lipCol === 'object') putRel(lx, ly, cur, lipCol.d); else put(lx, ly, lipCol); }
    }
  }
  if (crackCol !== null) {
    for (const k of crackPx) {
      const cx = k % S.w, cy = (k / S.w) | 0, cur = sc.src[k];
      if (!S.fullbright[cur]) { if (typeof crackCol === 'object') putRel(cx, cy, cur, crackCol.d); else put(cx, cy, crackCol); }
    }
  }
}
function ribsHeightCmd(a, o, writeH) {
  const val = float(need(a[1], 'val'), 'val'), rawPts = ptsOf(a.slice(2), 2, 'height ribs', true);
  const pts = rawPts.length === 2 ? samplePath(rawPts, 0.5).map(([x, y]) => [x, y]) : evalCurve(rawPts, !!o.closed, rawPts.length > 4);
  const count = clamp(fnum(o.count, 8, 'count'), 1, 64);
  const gFrac = clamp(fnum(o.depth, Math.abs(val) * 0.45, 'depth') / Math.max(0.5, Math.abs(val)), 0.05, 1);
  const sz = clamp(fnum(o.size, 6, 'size'), 1, 64), tp = parseTaper(o.taper, [100, 35]);
  const sharpPow = clamp(fnum(o.sharp, 50, 'sharp') / 50, 0.25, 3);
  const sc = scope(o), best = new Map(), grooveCol = o.color !== undefined ? col(o.color) : null, hiCol = o.hi !== undefined ? col(o.hi) : null;
  for (const [x, y, t] of samplePath(pts, 0.35)) {
    const r = (sz * evalTaper(tp, t)) / 2;
    if (r < 0.35) continue;
    const rib = Math.pow(0.5 + 0.5 * Math.cos(t * count * Math.PI * 2), sharpPow);
    const profScale = (1 - gFrac) + gFrac * rib;
    const reach = Math.ceil(r) + 1, ix = Math.round(x), iy = Math.round(y);
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const nr = Math.hypot(dx, dy) / Math.max(0.5, r);
      if (nr > 1) continue;
      const dome = o.ridge ? (1 - nr) : Math.sqrt(Math.max(0, 1 - nr * nr));
      const w = dome * profScale;
      for (const [sx, sy] of symPoints(ix + dx, iy + dy)) {
        if (!sc.has(sx, sy)) continue;
        const k = mod(sy, S.h) * S.w + mod(sx, S.w);
        const prev = best.get(k);
        if (!prev || w > prev.w) best.set(k, { w, rib, sx, sy });
      }
    }
  }
  for (const [k, info] of best) {
    writeH(k, val * info.w);
    const cur = sc.src[k];
    if (S.fullbright[cur]) continue;
    if (grooveCol !== null && info.rib < 0.25) { if (typeof grooveCol === 'object') putRel(info.sx, info.sy, cur, grooveCol.d); else put(info.sx, info.sy, grooveCol); }
    else if (hiCol !== null && info.rib > 0.88) { if (typeof hiCol === 'object') putRel(info.sx, info.sy, cur, hiCol.d); else put(info.sx, info.sy, hiCol); }
  }
}
function heightCmd(a, o) {
  const sub = a[0] || (o.from ? 'from' : need(a[0], 'height subcommand'));
  const mode = o.mode || (sub === 'set' || sub === 'clear' || sub === 'from' ? 'set' : 'add');
  if (!['add', 'max', 'set', 'smin'].includes(mode)) fail('height mode must be add | max | set | smin');
  const HBUF = activeHMap(), kSmooth = fnum(o.k ?? o.smooth, 3, 'k');
  const writeH = (i, val) => {
    const nv = mode === 'set' ? val : mode === 'max' ? Math.max(HBUF[i], val) : mode === 'smin' ? (val !== 0 ? sminH(HBUF[i], val, kSmooth) : HBUF[i]) : HBUF[i] + val;
    if (HBUF[i] !== nv) { HBUF[i] = nv; markHChanged(); }
  };
  if (sub === 'compose') {
    if (!S.layers.length) fail('height compose requires layers ("layer new ...")');
    const getL = (tok) => (/^\d+$/.test(tok) ? S.layers[parseInt(tok, 10)] : S.layers.find((l) => l.name === tok)) || fail(`no layer "${tok}"`);
    const src = getL(need(a[1], 'src layer')), dst = a[2] ? getL(a[2]) : S.layers[0];
    blendHeightBuf(dst.hmap, src.hmap, src.kind === 'paint' ? src.px : null, o.mode || src.hmode || 'smin', kSmooth);
    dst.hused = true; S.hchanged++; syncLayers();
    return;
  }
  if (sub === 'clear') {
    const v = a[1] !== undefined ? float(a[1], 'val') : fnum(o.amount, 0, 'amount');
    HBUF.fill(v); markHChanged(); syncLayers(); return;
  }
  if (sub === 'set' || sub === 'add') {
    const v = float(need(a[1] ?? o.amount, 'val'), 'val'), sc = scope(o);
    sc.each((x, y) => { const wx = mod(x, S.w), wy = mod(y, S.h); writeH(wy * S.w + wx, v); });
    syncLayers(); return;
  }
  if (sub === 'scale') {
    const f = float(need(a[1], 'pct'), 'pct') / 100, sc = scope(o);
    sc.each((x, y) => { const i = mod(y, S.h) * S.w + mod(x, S.w); HBUF[i] *= f; markHChanged(); });
    syncLayers(); return;
  }
  if (sub === 'from') {
    const srcKind = a[1] || o.from || 'luma';
    if (!['luma', 'step'].includes(srcKind)) fail('height from must be luma | step');
    const amt = fnum(o.amount, 8, 'amount'), sc = scope(o);
    sc.each((x, y, c) => {
      const t = srcKind === 'step' && S.rampOf[c] ? S.rampOf[c].i / Math.max(1, S.ramps.get(S.rampOf[c].name).length - 1) : lum(S.pal[c]) / 255;
      writeH(mod(y, S.h) * S.w + mod(x, S.w), t * amt);
    });
    syncLayers(); return;
  }
  if (sub === 'inflate') {
    const amt = fnum(o.amount, 6, 'amount'), prof = o.profile || 'round';
    if (!['round', 'dome', 'smooth', 'linear'].includes(prof)) fail('profile must be round | dome | smooth | linear');
    const sc = scope(o), W = S.w, H = S.h, ins = new Uint8Array(W * H);
    sc.each((x, y) => { ins[mod(y, H) * W + mod(x, W)] = 1; });
    const distMap = computeEDT(ins);
    let maxD = 0;
    for (let i = 0; i < W * H; i++) if (ins[i] && distMap[i] > maxD) maxD = distMap[i];
    const R = o.radius !== undefined ? fnum(o.radius, maxD, 'radius') : maxD;
    if (R <= 0) return;
    for (let i = 0; i < W * H; i++) {
      if (!ins[i]) continue;
      const u = clamp(distMap[i] / R, 0, 1);
      const p = prof === 'linear' ? u : prof === 'smooth' ? u * u * (3 - 2 * u) : prof === 'dome' ? 1 - (1 - u) * (1 - u) : Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
      writeH(i, amt * p);
    }
    syncLayers(); return;
  }
  if (sub === 'noise') {
    const seed = num(o.seed, 0, 'seed'), oct = num(o.octaves, 2, 'octaves');
    const baseSz = num(o.scale, 16, 'scale'), sx = num(o.scalex, baseSz, 'scalex'), sy = num(o.scaley, baseSz, 'scaley');
    const type = o.type || 'value', warp = num(o.warp, 0, 'warp');
    const contrast = num(o.contrast, 100, 'contrast'), bias = num(o.bias, 50, 'bias');
    if (!NOISE_TYPES.has(type)) fail(`noise type must be ${[...NOISE_TYPES].join(' | ')}`);
    const amt = fnum(o.amount, 4, 'amount');
    const lo = o.from !== undefined ? fnum(o.from, 0, 'from') : (mode === 'add' ? -amt / 2 : 0);
    const hi = o.to !== undefined ? fnum(o.to, amt, 'to') : (mode === 'add' ? amt / 2 : amt);
    const cx = Math.max(1, Math.round(S.w / sx)), cy = Math.max(1, Math.round(S.h / sy));
    const F = buildNoiseField(type, seed, cx, cy, oct, warp), sc = scope(o), gamma = bias === 50 ? 1 : Math.log(bias / 100) / Math.log(0.5);
    sc.each((x, y) => {
      const i = mod(y, S.h) * S.w + mod(x, S.w);
      let v = F[i];
      if (contrast !== 100) v = clamp((v - 0.5) * (contrast / 100) + 0.5, 0, 1);
      if (gamma !== 1) v = Math.pow(v, gamma);
      writeH(i, lo + (hi - lo) * v);
    });
    syncLayers(); return;
  }
  if (sub === 'blur') {
    const R = clamp(num(o.radius, 1, 'radius'), 1, 8), passes = clamp(num(o.passes, 1, 'passes'), 1, 8), bleed = !!o.bleed;
    const sc = scope(o), W = S.w, H = S.h;
    for (let p = 0; p < passes; p++) {
      const src = HBUF.slice();
      sc.each((x, y) => {
        let sum = 0, ws = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx, ny = y + dy;
          if (!S.wrap && (nx < 0 || ny < 0 || nx >= W || ny >= H)) continue;
          if (!bleed && !sc.has(nx, ny)) continue;
          const w = 1 / (1 + Math.hypot(dx, dy));
          sum += getH(nx, ny, src) * w; ws += w;
        }
        if (ws > 0) { HBUF[mod(y, H) * W + mod(x, W)] = sum / ws; markHChanged(); }
      });
    }
    syncLayers(); return;
  }
  if (sub === 'bevel') {
    const amt = fnum(o.amount, 6, 'amount'), depth = Math.max(1, fnum(o.depth ?? o.radius, 4, 'depth')), prof = o.profile || 'linear';
    if (!['round', 'dome', 'smooth', 'linear'].includes(prof)) fail('profile must be round | dome | smooth | linear');
    const sc = scope(o), W = S.w, H = S.h, ins = new Uint8Array(W * H);
    sc.each((x, y) => { ins[mod(y, H) * W + mod(x, W)] = 1; });
    const distMap = computeEDT(ins);
    for (let i = 0; i < W * H; i++) {
      if (!ins[i]) continue;
      const u = clamp(distMap[i] / depth, 0, 1);
      const p = prof === 'linear' ? u : prof === 'smooth' ? u * u * (3 - 2 * u) : prof === 'dome' ? 1 - (1 - u) * (1 - u) : Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
      writeH(i, amt * p);
    }
    syncLayers(); return;
  }
  if (sub === 'grad') {
    const [x0, y0, x1, y1] = [coordf(a[1], 'x0', 'x'), coordf(a[2], 'y0', 'y'), coordf(a[3], 'x1', 'x'), coordf(a[4], 'y1', 'y')];
    const lo = fnum(o.from, 0, 'from'), hi = fnum(o.to, 4, 'to'), dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy || 1;
    const isRadial = !!o.radial || o.mode === 'radial' || o.shape === 'radial';
    const sc = scope(o);
    sc.each((x, y) => {
      const u = clamp(isRadial ? Math.sqrt(((x - x0) ** 2 + (y - y0) ** 2) / L) : ((x - x0) * dx + (y - y0) * dy) / L, 0, 1);
      writeH(mod(y, S.h) * S.w + mod(x, S.w), lo + (hi - lo) * u);
    });
    syncLayers(); return;
  }
  if (sub === 'rect' || sub === 'ellipse' || sub === 'poly') {
    const sc = scope(o), seen = new Set();
    let val = 0;
    const hPlot = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      for (const [sx, sy] of symPoints(x, y)) {
        if (!sc.has(sx, sy)) continue;
        const k = mod(sy, S.h) * S.w + mod(sx, S.w);
        if (seen.has(k)) continue;
        seen.add(k); writeH(k, val);
      }
    };
    if (sub === 'rect') {
      const x = coord(a[1], 'x', 'x'), y = coord(a[2], 'y', 'y'), w = coord(a[3], 'w', 'x'), h = coord(a[4], 'h', 'y');
      val = float(need(a[5], 'val'), 'val');
      rect(hPlot, x, y, w, h, !!o.fill); syncLayers(); return;
    }
    if (sub === 'poly') {
      val = float(need(a[1], 'val'), 'val');
      poly(hPlot, ptsOf(a.slice(2), 3, 'height poly'), !!o.fill); syncLayers(); return;
    }
    const cx = coord(a[1], 'cx', 'x'), cy = coord(a[2], 'cy', 'y'), rx = coord(a[3], 'rx', 'x'), ry = coord(a[4], 'ry', 'y');
    val = float(need(a[5], 'val'), 'val');
    if (!o.soft && !o.ridge) { ellipse(hPlot, cx, cy, rx, ry, !!o.fill); syncLayers(); return; }
    const rbx = Math.max(1, rx), rby = Math.max(1, ry);
    for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
      const nr = Math.hypot(dx / rbx, dy / rby);
      if (nr > 1) continue;
      const u = 1 - nr, w = o.ridge ? u : u * u * (3 - 2 * u);
      for (const [sx, sy] of symPoints(cx + dx, cy + dy)) if (sc.has(sx, sy)) writeH(mod(sy, S.h) * S.w + mod(sx, S.w), val * w);
    }
    syncLayers(); return;
  }
  if (sub === 'stroke' || sub === 'curve' || sub === 'spline') {
    const val = float(need(a[1], 'val'), 'val'), rawPts = ptsOf(a.slice(2), sub === 'curve' ? 3 : sub === 'spline' ? 2 : 1, `height ${sub}`, true);
    const pts = sub === 'stroke' ? (o.closed && rawPts.length >= 2 ? [...rawPts, rawPts[0]] : rawPts) : evalCurve(rawPts, !!o.closed, sub === 'spline');
    const sz = clamp(fnum(o.size, 3, 'size'), 1, 128), tp = parseTaper(o.taper, [100, 100]);
    const sc = scope(o), weights = new Map();
    for (const [x, y, t] of samplePath(pts)) {
      const d = sz * evalTaper(tp, t), r = d / 2;
      if (r < 0.25) continue;
      const reach = Math.ceil(r) + 1, ix = Math.round(x), iy = Math.round(y);
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const nr = Math.hypot(dx, dy) / Math.max(0.5, r);
        if (nr > 1) continue;
        const u = 1 - nr, w = o.ridge ? u : o.soft ? u * u * (3 - 2 * u) : 1;
        for (const [sx, sy] of symPoints(ix + dx, iy + dy)) {
          if (!sc.has(sx, sy)) continue;
          const k = mod(sy, S.h) * S.w + mod(sx, S.w);
          if (w > (weights.get(k) || 0)) weights.set(k, w);
        }
      }
    }
    for (const [k, w] of weights) writeH(k, val * w);
    syncLayers(); return;
  }
  if (sub === 'crack') { crackHeightCmd(a, o, HBUF, writeH); syncLayers(); return; }
  if (sub === 'ribs') { ribsHeightCmd(a, o, writeH); syncLayers(); return; }
  fail(`unknown height subcommand "${sub}" (use: clear | set | add | scale | inflate | bevel | grad | noise | blur | from | compose | rect | ellipse | poly | stroke | curve | spline | crack | ribs)`);
}
function masonryCmd(rampName, o, isPlates = false) {
  const r = S.ramps.get(rampName) || fail(`masonry: unknown ramp "${rampName}"`);
  const style = o.style || (isPlates ? 'grid' : 'running');
  if (!['running', 'grid', 'ashlar'].includes(style)) fail('masonry style must be running | grid | ashlar');
  const sc = scope(o), [rx0, ry0, rw, rh] = regionOf(o);
  const cols = o.cols ? clamp(num(o.cols, 4, 'cols'), 1, 64) : Math.max(1, Math.round(rw / Math.max(4, num(o.w, 32, 'w'))));
  const rows = o.rows ? clamp(num(o.rows, 4, 'rows'), 1, 64) : Math.max(1, Math.round(rh / Math.max(4, num(o.h, 16, 'h'))));
  const mortar = clamp(num(o.mortar, isPlates ? 1 : 2, 'mortar'), 0, 8);
  const mortarCol = o.mortar_color !== undefined ? col(o.mortar_color, false) : r[Math.min(1, r.length - 1)];
  const bevelW = clamp(num(o.bevel, isPlates ? 2 : 3, 'bevel'), 1, 16);
  const blkH = fnum(o.height, isPlates ? 4 : 5, 'height'), vary = fnum(o.vary, isPlates ? 1 : 2, 'vary');
  const tilt = fnum(o.tilt, 1, 'tilt'), chipPct = clamp(num(o.chip, isPlates ? 0 : 35, 'chip'), 0, 100);
  const roughAmt = clamp(fnum(o.rough, isPlates ? 0 : 1.8, 'rough'), 0, 6);
  const seed = num(o.seed, 0, 'seed'), rivets = !!o.rivets || isPlates;
  const rowH = rh / rows, rowBounds = [];
  for (let ry = 0; ry < rows; ry++) {
    const ws = Array.from({ length: cols }, (_, cx) => (style === 'ashlar' ? 0.65 + 0.7 * hash(cx, ry, seed, 131) : 1));
    const sumW = ws.reduce((a, b) => a + b, 0), xs = [0];
    let acc = 0;
    for (let cx = 0; cx < cols; cx++) { acc += (ws[cx] / sumW) * rw; xs.push(cx === cols - 1 ? rw : acc); }
    const shiftX = style === 'running' && (ry & 1) ? (rw / cols) * 0.5 : 0;
    rowBounds.push({ xs, shiftX });
  }
  const nCx = Math.max(2, Math.round(S.w / 7)), nCy = Math.max(2, Math.round(S.h / 7));
  const wxField = roughAmt > 0 ? buildNoiseField('value', seed + 17, nCx, nCy, 2, 0) : null;
  const wyField = roughAmt > 0 ? buildNoiseField('value', seed + 53, nCx, nCy, 2, 0) : null;
  const midStep = Math.floor(r.length * 0.48), rivetCol = r[Math.min(r.length - 1, midStep + 3)], HBUF = activeHMap();
  sc.each((x, y) => {
    const hi = mod(y, S.h) * S.w + mod(x, S.w);
    const lx = mod(x - rx0, rw), ly = mod(y - ry0, rh);
    const wx = wxField ? (wxField[hi] - 0.5) * 2 * roughAmt : 0;
    const wy = wyField ? (wyField[hi] - 0.5) * 2 * roughAmt : 0;
    const wLy = mod(ly + wy, rh), ry = Math.min(rows - 1, Math.floor(wLy / rowH)), y0 = ry * rowH, y1 = (ry + 1) * rowH;
    const { xs, shiftX } = rowBounds[ry], uX = mod(lx + shiftX + wx, rw);
    let cx = 0;
    while (cx + 1 < cols && uX >= xs[cx + 1]) cx++;
    const x0 = xs[cx], x1 = xs[cx + 1], cw = x1 - x0, ch = y1 - y0;
    const dLeft = uX - x0, dRight = x1 - 1 - uX, dTop = wLy - y0, dBot = y1 - 1 - wLy;
    const dxEdge = Math.min(dLeft, dRight), dyEdge = Math.min(dTop, dBot);
    const cornerId = (dLeft < dRight ? 0 : 1) + (dTop < dBot ? 0 : 2);
    const chipped = chipPct > 0 && hash(cx * 4 + cornerId, ry, seed, 132) < chipPct / 100;
    const bite = chipped ? 1.6 + 2.8 * hash(cx * 4 + cornerId, ry, seed, 135) + wx * 0.4 : 0;
    const dDiag = (dxEdge + dyEdge) * 0.72 - bite;
    const dEdge = Math.min(dxEdge, dyEdge, dDiag);
    const mLocal = roughAmt > 0 ? mortar * (0.75 + 0.5 * (wxField[hi])) : mortar;
    if (dEdge < mLocal) {
      put(x, y, mortarCol);
      HBUF[hi] = -Math.max(1, blkH * 0.4); markHChanged();
      return;
    }
    const dIn = dEdge - mLocal + 1;
    const tBevel = clamp(dIn / bevelW, 0, 1);
    const bH = blkH + (hash(cx, ry, seed, 133) * 2 - 1) * vary;
    const nx = cw > 1 ? (uX - x0) / cw - 0.5 : 0, ny = ch > 1 ? (wLy - y0) / ch - 0.5 : 0;
    const tPlane = tilt * (-nx - ny);
    const surfRough = !isPlates && wxField ? (wxField[hi] - 0.5) * 1.2 * tBevel : 0;
    HBUF[hi] = bH * tBevel + tPlane * tBevel + surfRough; markHChanged();
    const stepShift = Math.round((hash(cx, ry, seed, 134) * 2 - 1) * 1.4);
    let c = r[clamp(midStep + stepShift, 1, r.length - 2)];
    if (rivets && isPlates && cw >= 10 && ch >= 10) {
      const rxD = Math.min(Math.abs(uX - (x0 + mortar + 2)), Math.abs(uX - (x1 - mortar - 3)));
      const ryD = Math.min(Math.abs(ly - (y0 + mortar + 2)), Math.abs(ly - (y1 - mortar - 3)));
      if (rxD <= 0.6 && ryD <= 0.6) { c = rivetCol; HBUF[hi] += 1.5; }
    }
    put(x, y, c);
  });
  syncLayers();
}
function glowCmd(o) {
  const sc = scope(o), W = S.w, H = S.h, nonEmit = new Uint8Array(W * H);
  let hasEmit = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = sc.src[i];
    const isEmit = o.mask ? o.mask[c] === 1 : S.fullbright[c] === 1;
    if (isEmit) hasEmit = true; else nonEmit[i] = 1;
  }
  if (!hasEmit) fail('glow: no emitter pixels found (provide mask=<colors> or place fullbright pixels)');
  const radius = Math.max(1, fnum(o.radius, 6, 'radius')), str = clamp(fnum(o.strength, 75, 'strength'), 1, 200) / 100;
  const mode = o.mode || 'mix';
  if (!['mix', 'rgb', 'tint', 'shade'].includes(mode)) fail('glow mode must be mix | rgb | tint | shade');
  const D = ditherOpt(o.dither || 'bayer4'), useNorm = !!o.normal;
  const targetRamp = o.ramp ? (S.ramps.get(o.ramp) || fail(`glow: unknown ramp "${o.ramp}"`)) : null;
  const rgbCand = o.ramps ? [...new Set(String(o.ramps).split(',').flatMap((nm) => S.ramps.get(nm) || fail(`unknown ramp "${nm}"`)))] : null;
  const distMap = computeEDT(nonEmit);
  // Find emitter color for each pixel by tracking nearest emitter in a small local search when no ramp= given
  const glowRGB = targetRamp ? S.pal[targetRamp[Math.min(targetRamp.length - 1, Math.floor(targetRamp.length * 0.72))]] : [255, 130, 35];
  const rSearch = Math.ceil(radius);
  const nearestEmitColor = (x, y) => {
    if (targetRamp) return null;
    let bestC = -1, bd = Infinity;
    for (let dy = -rSearch; dy <= rSearch; dy++) for (let dx = -rSearch; dx <= rSearch; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!S.wrap && (nx < 0 || ny < 0 || nx >= W || ny >= H)) continue;
      const i = mod(ny, H) * W + mod(nx, W);
      if (nonEmit[i]) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bestC = sc.src[i]; }
    }
    return bestC >= 0 ? bestC : null;
  };
  const Q = quantizer(D, regionOf(o)[2]);
  const [rx0, ry0, rw, rh] = regionOf(o);
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    const x = rx0 + i, y = ry0 + j, wx = mod(x, W), wy = mod(y, H), idx = wy * W + wx;
    if (!nonEmit[idx]) continue;
    const d = distMap[idx];
    if (d <= 0 || d > radius) continue;
    const c = sc.src[idx];
    if (S.fullbright[c]) continue;
    let nFactor = 1;
    if (useNorm) {
      const [dgx, dgy] = sobelGradient(distMap, wx, wy);
      const dl = Math.hypot(dgx, dgy) || 1, lx = -dgx / dl, ly = -dgy / dl;
      const [hgx, hgy] = sobelGradient(S.hmap, wx, wy);
      let nx = -hgx * 2, ny = -hgy * 2, nz = 1;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      nFactor = clamp(0.35 + 0.9 * (nx * lx + ny * ly + nz * 0.4), 0.15, 1.25);
    }
    const att = clamp(Math.pow(1 - d / radius, 1.55) * str * nFactor, 0, 1);
    if (att <= 0.01) continue;
    const emC = nearestEmitColor(wx, wy), emRamp = targetRamp || (emC !== null && S.rampOf[emC] ? S.ramps.get(S.rampOf[emC].name) : null);
    const dstRGB = emC !== null ? S.pal[emC] : glowRGB;
    const lift = Q(att * 4.5, x, y, i, j);
    if (mode === 'shade') {
      if (lift > 0) put(x, y, shadeIdx(c, lift));
      continue;
    }
    if (mode === 'rgb') {
      const mixed = [0, 1, 2].map((k) => Math.round((1 - att) * S.pal[c][k] + att * dstRGB[k]));
      put(x, y, nearest(mixed, rgbCand));
      continue;
    }
    if (mode === 'tint') {
      if (emRamp && (D.kind === 'none' ? att >= 0.4 : att > thr(D, x, y))) {
        const st = clamp(Math.round(brightnessOf(c) * (emRamp.length - 1)) + lift, 0, emRamp.length - 1);
        put(x, y, emRamp[st]);
      } else if (lift > 0) put(x, y, shadeIdx(c, lift));
      continue;
    }
    // 'mix' (default): lift brightness and warm-tint pixels passing dithered coverage
    if (emRamp && (D.kind === 'none' ? att >= 0.45 : att > thr(D, x, y))) {
      const st = clamp(Math.round(brightnessOf(c) * (emRamp.length - 1)) + Math.max(1, lift), 0, emRamp.length - 1);
      put(x, y, emRamp[st]);
    } else if (lift > 0) {
      put(x, y, shadeIdx(c, lift));
    }
  }
}
function sobelGradient(src, x, y) {
  const gx = (getH(x + 1, y - 1, src) + 2 * getH(x + 1, y, src) + getH(x + 1, y + 1, src)
            - getH(x - 1, y - 1, src) - 2 * getH(x - 1, y, src) - getH(x - 1, y + 1, src)) / 8;
  const gy = (getH(x - 1, y + 1, src) + 2 * getH(x, y + 1, src) + getH(x + 1, y + 1, src)
            - getH(x - 1, y - 1, src) - 2 * getH(x, y - 1, src) - getH(x + 1, y - 1, src)) / 8;
  return [gx, gy];
}
const OPP_DIR = { n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e', nw: 'se' };
function radialOffs(rad) {
  const offs = [];
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    if (!dx && !dy) continue;
    const d = Math.hypot(dx, dy);
    if (d <= rad + 0.25) offs.push([dx, dy, 1 / d]);
  }
  const wSum = offs.reduce((s, a) => s + a[2], 0) || 1;
  return { offs, wSum };
}
function localMeanDiff(hSrc, x, y, kernel) {
  const h0 = getH(x, y, hSrc);
  let meanH = 0;
  for (const [dx, dy, w] of kernel.offs) meanH += getH(x + dx, y + dy, hSrc) * w;
  return meanH / kernel.wSum - h0;
}
function finishLightAccum(ditherSpec) {
  if (!S.lightAccum || !S.lightAccum.active) fail('light end: no active "light begin" block');
  const A = S.lightAccum, W = S.w, H = S.h, D = ditherOpt(ditherSpec || A.dither || 'bayer4'), Q = quantizer(D, W);
  const allowedList = A.allowedRamps.size ? [...A.allowedRamps].flatMap((nm) => S.ramps.get(nm) || []) : [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    if (!A.touched[idx]) continue;
    const base = A.albedo[idx];
    if (S.fullbright[base]) continue;
    const q = Q(A.sumStep[idx], x, y, x, y);
    let colIdx = q !== 0 ? shadeIdx(base, q) : base;
    const tw = A.tintW[idx];
    if (tw > 0.01) {
      const blend = clamp(tw, 0, 1);
      const tRgb = [A.tintR[idx] / tw, A.tintG[idx] / tw, A.tintB[idx] / tw];
      const rgb = [0, 1, 2].map((k) => Math.round((1 - blend) * S.pal[colIdx][k] + blend * tRgb[k]));
      const rm = S.rampOf[base];
      const cand = rm ? [...new Set([...S.ramps.get(rm.name), ...allowedList])] : (allowedList.length ? allowedList : null);
      colIdx = nearest(rgb, cand);
    }
    put(x, y, colIdx);
  }
  S.lastLights = A.cmds.slice();
  S.lightAccum = null;
}
function lightHeight(o, record = true) {
  const dTok = o.dir || 'nw', Dvec = DIRS[dTok];
  if (!Dvec) fail(`dir must be one of: ${Object.keys(DIRS).join(' ')}`);
  const dl = Math.hypot(Dvec[0], Dvec[1]) || 1, lx0 = Dvec[0] / dl, ly0 = Dvec[1] / dl;
  const el = (clamp(fnum(o.elev, 40, 'elev'), 1, 89) * Math.PI) / 180;
  const Lx = lx0 * Math.cos(el), Ly = ly0 * Math.cos(el), Lz = Math.sin(el);
  let lo = num(o.from, -4, 'from'), hi = num(o.to, 3, 'to');
  if (o.range !== undefined) {
    const m = /^([-+]?\d+)\.\.([-+]?\d+)$/.exec(String(o.range));
    if (!m) fail(`range must be lo..hi (e.g. -4..+3), got "${o.range}"`);
    lo = parseInt(m[1], 10); hi = parseInt(m[2], 10);
  }
  const zscale = (fnum(o.strength, 100, 'strength') / 100) * 2.5;
  const D = ditherOpt(o.dither || 'bayer4'), specAmt = fnum(o.spec, 0, 'spec'), gloss = fnum(o.gloss, 16, 'gloss');
  const aoAmt = fnum(o.ao, 0, 'ao'), aoRad = clamp(num(o.ao_radius, 4, 'ao_radius'), 1, 12);
  const shSteps = clamp(num(o.shadow, 0, 'shadow'), 0, 64);
  const targetRamp = o.ramp ? (S.ramps.get(o.ramp) || fail(`light: unknown ramp "${o.ramp}"`)) : null;
  const shSpec = parseRampMix(o.shadow_ramp, o.shadow_mix, 45);
  const hiSpec = parseRampMix(o.hi_ramp ?? o.light_ramp, o.hi_mix ?? o.light_mix, 40);
  const rimTok = o.rim || (o.rim_ramp ? OPP_DIR[dTok] : null);
  let Rx = 0, Ry = 0, Rz = 0, rimAmt = 0;
  const rimSpec = parseRampMix(o.rim_ramp, o.rim_mix, 65);
  if (rimTok) {
    const Rv = DIRS[rimTok] || fail(`rim must be one of: ${Object.keys(DIRS).join(' ')}`);
    const rl = Math.hypot(Rv[0], Rv[1]) || 1, rel = (clamp(fnum(o.rim_elev, 25, 'rim_elev'), 1, 89) * Math.PI) / 180;
    Rx = (Rv[0] / rl) * Math.cos(rel); Ry = (Rv[1] / rl) * Math.cos(rel); Rz = Math.sin(rel);
    rimAmt = fnum(o.rim_strength, 2, 'rim_strength');
  }
  const accum = !!(S.lightAccum && S.lightAccum.active);
  if (accum) {
    if (record) S.lightAccum.cmds.push({ o: { ...o } });
    if (shSpec) S.lightAccum.allowedRamps.add(shSpec.name);
    if (hiSpec) S.lightAccum.allowedRamps.add(hiSpec.name);
    if (rimSpec) S.lightAccum.allowedRamps.add(rimSpec.name);
  } else if (record) {
    S.lastLights = [{ o: { ...o } }];
  }
  const hl = Math.hypot(Lx, Ly, Lz + 1) || 1, Hx = Lx / hl, Hy = Ly / hl, Hz = (Lz + 1) / hl;
  const aoKernel = aoAmt > 0 ? radialOffs(aoRad) : null;
  const hSrc = S.hmap, sc = scope(o, accum ? S.lightAccum.albedo : null), Q = quantizer(D, regionOf(o)[2]), tanEl = Math.tan(el);
  sc.each((x, y, c, i, j) => {
    if (S.fullbright[c]) return;
    const [gx, gy] = sobelGradient(hSrc, x, y);
    let nx = -gx * zscale, ny = -gy * zscale, nz = 1;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const ndotl = nx * Lx + ny * Ly + nz * Lz;
    let litFactor = 1;
    if (shSteps > 0) {
      const h0 = getH(x, y, hSrc);
      for (let t = 1; t <= shSteps; t++) {
        if (getH(Math.round(x + lx0 * t), Math.round(y + ly0 * t), hSrc) > h0 + t * tanEl) { litFactor = 0.2; break; }
      }
    }
    let sf;
    const minNdotl = -Math.cos(el);
    if (targetRamp && !accum) {
      const t = clamp((ndotl * litFactor - minNdotl) / Math.max(0.1, 1 - minNdotl), 0, 1);
      sf = lo + (hi - lo) * t;
    } else {
      sf = ndotl >= Lz ? ((ndotl - Lz) / Math.max(0.05, 1 - Lz)) * hi : ((ndotl - Lz) / Math.max(0.15, Lz - minNdotl)) * (-lo);
      if (litFactor < 1 && sf > 0) sf *= litFactor;
      if (litFactor < 1 && sf <= 0) sf = Math.min(sf, lo * 0.5);
    }
    if (specAmt > 0 && litFactor > 0.5) {
      const ndoth = Math.max(0, nx * Hx + ny * Hy + nz * Hz);
      sf += Math.pow(ndoth, gloss) * specAmt;
    }
    if (aoAmt > 0) {
      const diff = localMeanDiff(hSrc, x, y, aoKernel);
      if (diff > 0) sf -= clamp(diff / Math.max(0.5, aoRad * 0.45), 0, 1) * aoAmt;
    }
    const rimF = rimTok ? clamp((1 - nz * 0.8) * Math.max(0, nx * Rx + ny * Ry + nz * Rz), 0, 1) : 0;
    const rimSf = rimF * rimAmt;
    if (accum) {
      const idx = mod(y, S.h) * S.w + mod(x, S.w), A = S.lightAccum;
      A.touched[idx] = 1;
      A.sumStep[idx] += sf + rimSf;
      const addTint = (spec, w) => {
        if (!spec || w <= 0.01) return;
        const b = clamp(brightnessOf(c) + (sf + rimSf) * 0.06, 0, 1);
        const colRgb = S.pal[spec.ramp[clamp(Math.round(b * (spec.ramp.length - 1)), 0, spec.ramp.length - 1)]];
        A.tintR[idx] += colRgb[0] * w; A.tintG[idx] += colRgb[1] * w; A.tintB[idx] += colRgb[2] * w; A.tintW[idx] += w;
      };
      if (shSpec && sf < 0) addTint(shSpec, shSpec.mix * clamp(Math.abs(sf) / 4, 0.35, 1));
      if (hiSpec && sf > 0) addTint(hiSpec, hiSpec.mix * clamp(sf / 4, 0.35, 1));
      if (rimSpec && rimSf > 0.05) addTint(rimSpec, rimSpec.mix * rimF);
      return;
    }
    const q = Q(sf + rimSf, x, y, i, j);
    if (targetRamp) { put(x, y, targetRamp[clamp(q, 0, targetRamp.length - 1)]); return; }
    let outCol = q !== 0 ? shadeIdx(c, q) : c;
    if (shSpec && sf < -0.25) outCol = mixColorTowardRamp(c, outCol, shSpec, shSpec.mix * clamp(Math.abs(sf) / 4, 0.35, 1));
    else if (hiSpec && sf > 0.25) outCol = mixColorTowardRamp(c, outCol, hiSpec, hiSpec.mix * clamp(sf / 4, 0.35, 1));
    if (rimSpec && rimSf > 0.25) outCol = mixColorTowardRamp(c, outCol, rimSpec, rimSpec.mix * rimF);
    if (outCol !== c) put(x, y, outCol);
  });
}
function hatch(colTok, o) {
  const c = colTok ? col(colTok) : { d: num(o.shade, -1, 'shade') };
  const rel = typeof c === 'object', follow = o.follow || 'none', zone = o.in || 'all';
  if (!['none', 'contour', 'slope'].includes(follow)) fail('hatch follow must be none | contour | slope');
  if (!['all', 'shadow', 'mid', 'light'].includes(zone)) fail('hatch in= must be all | shadow | mid | light');
  const spacing = clamp(num(o.spacing, 3, 'spacing'), 1, 32), seed = num(o.seed, 0, 'seed');
  const jitter = fnum(o.jitter, 0, 'jitter'), dftAng = follow === 'none' ? -45 : 0;
  const passes = o.cross ? [fnum(o.angle, dftAng, 'angle'), fnum(o.angle, dftAng, 'angle') + 90] : [fnum(o.angle, dftAng, 'angle')];
  const sc = scope(o), seen = new Set();
  const inZone = (cur) => {
    if (zone === 'all') return true;
    const b = brightnessOf(cur);
    return zone === 'shadow' ? b <= 0.52 : zone === 'mid' ? b >= 0.25 && b <= 0.72 : b >= 0.55;
  };
  const plotHatch = (px, py) => {
    px = Math.round(px); py = Math.round(py);
    if (!sc.has(px, py)) return;
    const wx = S.wrap ? mod(px, S.w) : px, wy = S.wrap ? mod(py, S.h) : py, k = wy * S.w + wx;
    if (seen.has(k)) return;
    const cur = get(px, py, sc.src);
    if ((rel && S.fullbright[cur]) || !inZone(cur)) return;
    seen.add(k);
    if (rel) putRel(px, py, cur, c.d); else put(px, py, c);
  };
  let fieldSrc = null;
  if (follow !== 'none') {
    let minH = Infinity, maxH = -Infinity;
    sc.each((x, y) => { const h = getH(x, y); if (h < minH) minH = h; if (h > maxH) maxH = h; });
    if (maxH - minH > 1e-4) fieldSrc = S.hmap;
    else {
      const ins = new Uint8Array(S.w * S.h);
      sc.each((x, y) => { ins[mod(y, S.h) * S.w + mod(x, S.w)] = 1; });
      fieldSrc = computeEDT(ins);
    }
  }
  const [rx0, ry0, rw, rh] = regionOf(o);
  for (let pi = 0; pi < passes.length; pi++) {
    const rad = (passes[pi] * Math.PI) / 180, ca = Math.cos(rad), sa = Math.sin(rad);
    if (follow === 'none') {
      const cx = rx0 + rw / 2, cy = ry0 + rh / 2, reach = Math.ceil(Math.hypot(rw, rh));
      for (let off = -reach; off <= reach; off += spacing) {
        const jPhase = hash(Math.round(off), pi, seed, 81) * 100;
        for (let s = -reach; s <= reach; s += 0.75) {
          const jOff = jitter > 0 ? (smooth1D(s / 6 + jPhase, seed, 82 + pi) - 0.5) * 2 * jitter : 0;
          plotHatch(cx + ca * s - sa * (off + jOff), cy + sa * s + ca * (off + jOff));
        }
      }
      continue;
    }
    const occ = new Uint8Array(S.w * S.h), minSep = Math.max(1, Math.round(spacing * 0.65));
    const dirAt = (x, y) => {
      const [gx, gy] = sobelGradient(fieldSrc, Math.round(x), Math.round(y));
      let vx = follow === 'contour' ? -gy : gx, vy = follow === 'contour' ? gx : gy;
      const vl = Math.hypot(vx, vy);
      if (vl < 1e-4) return [ca, sa];
      vx /= vl; vy /= vl;
      return [vx * ca - vy * sa, vx * sa + vy * ca];
    };
    const isClear = (x, y) => {
      const ix = Math.round(x), iy = Math.round(y);
      for (let dy = -minSep; dy <= minSep; dy++) for (let dx = -minSep; dx <= minSep; dx++) {
        if (dx * dx + dy * dy > minSep * minSep) continue;
        const nx = ix + dx, ny = iy + dy;
        if (!S.wrap && (nx < 0 || ny < 0 || nx >= S.w || ny >= S.h)) continue;
        if (occ[mod(ny, S.h) * S.w + mod(nx, S.w)]) return false;
      }
      return true;
    };
    const markOcc = (pts) => {
      for (const [px, py] of pts) {
        const ix = Math.round(px), iy = Math.round(py);
        if (S.wrap || (ix >= 0 && iy >= 0 && ix < S.w && iy < S.h)) occ[mod(iy, S.h) * S.w + mod(ix, S.w)] = 1;
      }
    };
    const seeds = [];
    for (let j = 0; j < rh; j += spacing) for (let i = 0; i < rw; i += spacing) {
      const sx = rx0 + i + (hash(i, j, seed, 83 + pi) - 0.5) * spacing * 0.5;
      const sy = ry0 + j + (hash(i, j, seed, 84 + pi) - 0.5) * spacing * 0.5;
      if (sc.has(Math.round(sx), Math.round(sy))) seeds.push([sx, sy]);
    }
    const maxLen = Math.max(rw, rh) * 1.5;
    for (let si = 0; si < seeds.length; si++) {
      const [sx, sy] = seeds[si];
      if (!isClear(sx, sy)) continue;
      const allPts = [[sx, sy]];
      for (const sign of [1, -1]) {
        const branch = [];
        let cx = sx, cy = sy, px = 0, py = 0;
        for (let step = 0; step < maxLen; step++) {
          let [vx, vy] = dirAt(cx, cy);
          vx *= sign; vy *= sign;
          if (step > 0 && vx * px + vy * py < 0) { vx = -vx; vy = -vy; }
          px = vx; py = vy;
          const jOff = jitter > 0 ? (smooth1D(step / 5 + si * 3.1, seed, 85 + pi) - 0.5) * jitter : 0;
          cx += vx + -vy * jOff * 0.25; cy += vy + vx * jOff * 0.25;
          const rx = Math.round(cx), ry = Math.round(cy);
          if (!sc.has(rx, ry)) break;
          if (step > 6 && Math.hypot(cx - sx, cy - sy) < Math.max(1.5, minSep)) break;
          if (step > minSep + 1 && !isClear(cx, cy)) break;
          branch.push([cx, cy]);
        }
        markOcc(branch);
        allPts.push(...branch);
      }
      markOcc([[sx, sy]]);
      for (const [px, py] of allPts) plotHatch(px, py);
    }
  }
}
function parseLenRange(v, dfltLo = 6, dfltHi = 16) {
  if (v === undefined) return [dfltLo, dfltHi];
  const m = /^(\d+)\.\.(\d+)$/.exec(String(v));
  if (m) return [Math.max(1, +m[1]), Math.max(1, +m[2])];
  const n = clamp(int(v, 'len'), 1, 256);
  return [Math.max(1, Math.round(n * 0.6)), n];
}
function dripCmd(tok, o) {
  const dirTok = o.dir || 's', Dv = DIRS[dirTok] || fail(`dir must be one of: ${Object.keys(DIRS).join(' ')}`);
  const [dx, dy] = Dv, pxOff = -dy, pyOff = dx;
  const [lenLo, lenHi] = parseLenRange(o.len, 6, 16);
  const wid = clamp(num(o.width, 1, 'width'), 1, 3), dens = clamp(num(o.density, 45, 'density'), 1, 100) / 100;
  const seed = num(o.seed, 0, 'seed'), D = ditherOpt(o.dither || 'bayer4'), isTint = !!o.tint;
  const rTarget = tok && tok !== 'shade' && S.ramps.has(tok) ? S.ramps.get(tok) : null;
  const absCol = (!rTarget && tok !== 'shade' && tok !== undefined) ? col(tok) : null;
  const shadeAmt = num(o.shade, -3, 'shade');
  const regSc = scope({ region: o.region, protect: o.protect });
  const srcSc = (o.mask || o.shape) && o.from !== 'cavity' ? scope(o, regSc.src) : null;
  const kernel = radialOffs(2), [rx0, ry0, rw, rh] = regionOf(o), seeds = [];
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    const x = rx0 + i, y = ry0 + j;
    if (srcSc) {
      if (srcSc.has(x, y) && (o.from === 'all' || !srcSc.has(x + dx, y + dy))) seeds.push([x, y]);
    } else if (S.hchanged > 0) {
      if (localMeanDiff(S.hmap, x, y, kernel) > 0.35) seeds.push([x, y]);
    } else if (hash(x, y, seed, 300) < 0.05) {
      seeds.push([x, y]);
    }
  }
  const paintPx = (px, py, cov, step) => {
    if (!regSc.inR(px, py)) return;
    const cur = get(px, py, regSc.src);
    if (cur < 0 || S.fullbright[cur] || (o.protect && o.protect[cur])) return;
    if (cov <= (D.kind === 'none' ? 0.3 : thr(D, px, py))) return;
    if (rTarget) {
      const targetIdx = isTint ? rTarget[clamp(Math.round(brightnessOf(cur) * (rTarget.length - 1)), 0, rTarget.length - 1)] : rTarget[clamp(Math.round(rTarget.length * 0.28 + (1 - step) * 2), 0, rTarget.length - 1)];
      put(px, py, mixColorTowardRamp(cur, cur, { ramp: rTarget }, clamp(cov, 0.3, 0.9)));
      if (!isTint && cov > 0.7) put(px, py, targetIdx);
    } else if (absCol !== null) {
      if (typeof absCol === 'object') putRel(px, py, cur, Math.round(absCol.d * cov));
      else put(px, py, absCol);
    } else {
      putRel(px, py, cur, Math.round(shadeAmt * cov));
    }
  };
  for (const [sx, sy] of seeds) {
    if (hash(sx, sy, seed, 301) >= dens) continue;
    const L = Math.round(lenLo + (lenHi - lenLo) * hash(sx, sy, seed, 302));
    let cx = sx + dx, cy = sy + dy;
    for (let s = 1; s <= L; s++) {
      const t = 1 - (s - 1) / Math.max(1, L);
      if (hash(sx, sy, s, seed + 305) < 0.18) {
        const j = hash(sx, s, seed, 307) < 0.5 ? -1 : 1;
        cx += pxOff * j; cy += pyOff * j;
      }
      const hw = Math.floor(((wid - 1) * t) / 2);
      for (let w = -hw; w <= hw; w++) paintPx(cx + pxOff * w, cy + pyOff * w, t, s / L);
      cx += dx; cy += dy;
    }
  }
}
function washCmd(tok, o) {
  const rad = clamp(num(o.radius, 3, 'radius'), 1, 8), str = clamp(fnum(o.strength, 65, 'strength'), 1, 200) / 100;
  const D = ditherOpt(o.dither || 'bayer4'), sc = scope(o), kernel = radialOffs(rad);
  const rTarget = tok && tok !== 'shade' && S.ramps.has(tok) ? S.ramps.get(tok) : null;
  const absCol = (!rTarget && tok !== 'shade' && tok !== undefined) ? col(tok) : null;
  const Q = quantizer(D, regionOf(o)[2]);
  sc.each((x, y, c, i, j) => {
    if (S.fullbright[c]) return;
    let occ = 0;
    if (S.hchanged > 0) {
      occ = clamp(localMeanDiff(S.hmap, x, y, kernel) / Math.max(0.5, rad * 0.45), 0, 1);
    } else {
      let outW = 0;
      for (const [dx, dy, w] of kernel.offs) if (!sc.has(x + dx, y + dy)) outW += w;
      occ = clamp((outW / kernel.wSum) * 1.6, 0, 1);
    }
    const cov = clamp(occ * str, 0, 1);
    if (cov <= 0.05) return;
    if (rTarget) {
      if (cov > (D.kind === 'none' ? 0.35 : thr(D, x, y))) put(x, y, mixColorTowardRamp(c, shadeIdx(c, -1), { ramp: rTarget }, clamp(cov, 0.35, 0.95)));
    } else if (absCol !== null) {
      if (cov > (D.kind === 'none' ? 0.35 : thr(D, x, y))) {
        if (typeof absCol === 'object') putRel(x, y, c, Math.round(absCol.d * cov));
        else put(x, y, absCol);
      }
    } else {
      const q = Q(-3 * cov, x, y, i, j);
      if (q < 0) putRel(x, y, c, q);
    }
  });
}
function drybrushCmd(tok, o, isEdgewear = false) {
  const th = fnum(o.thresh, isEdgewear ? 0.35 : 0.45, 'thresh'), str = clamp(fnum(o.strength, 75, 'strength'), 1, 200) / 100;
  const brk = clamp(num(o.breakup, isEdgewear ? 55 : 45, 'breakup'), 0, 100) / 100, seed = num(o.seed, 0, 'seed');
  const D = ditherOpt(o.dither || 'bayer4'), sc = scope(o), kernel = radialOffs(1);
  const Ltok = o.light || o.dir || (isEdgewear ? 'nw' : null);
  let lx = 0, ly = 0;
  if (Ltok) {
    const Dv = DIRS[Ltok] || fail(`light/dir must be one of: ${Object.keys(DIRS).join(' ')}`);
    const dl = Math.hypot(Dv[0], Dv[1]) || 1; lx = Dv[0] / dl; ly = Dv[1] / dl;
  }
  const nField = brk > 0 ? buildNoiseField('value', seed + 71, Math.max(2, Math.round(S.w / 6)), Math.max(2, Math.round(S.h / 6)), 2, 0) : null;
  const rTarget = tok && S.ramps.has(tok) ? S.ramps.get(tok) : null;
  const hiCol = !rTarget ? (tok ? col(tok) : { d: num(o.hi, 2, 'hi') }) : null;
  const Q = quantizer(D, regionOf(o)[2]);
  sc.each((x, y, c, i, j) => {
    if (S.fullbright[c]) return;
    let conv = 0;
    if (S.hchanged > 0) {
      conv = -localMeanDiff(S.hmap, x, y, kernel);
      if (Ltok) {
        const [gx, gy] = sobelGradient(S.hmap, x, y), gl = Math.hypot(gx, gy) || 1;
        const align = clamp((-gx / gl) * lx + (-gy / gl) * ly, -1, 1);
        if (align < -0.2) conv *= 0.25; else conv *= 0.65 + 0.65 * align;
      }
    } else {
      let outN = 0;
      for (const [dx, dy] of N4) if (!sc.has(x + dx, y + dy)) outN++;
      conv = outN >= 2 ? outN * 0.45 : outN === 1 ? 0.5 : 0;
    }
    if (conv < th) return;
    const idx = mod(y, S.h) * S.w + mod(x, S.w);
    const nMod = nField ? clamp(1 - brk + brk * (nField[idx] * 1.4), 0, 1.2) : 1;
    const cov = clamp(((conv - th) / Math.max(0.4, th * 2)) * str * nMod, 0, 1);
    if (cov <= 0.1) return;
    if (rTarget) {
      if (cov > (D.kind === 'none' ? 0.35 : thr(D, x, y))) put(x, y, mixColorTowardRamp(c, shadeIdx(c, 1), { ramp: rTarget }, clamp(cov, 0.4, 0.95)));
    } else if (typeof hiCol === 'object') {
      const q = Q(hiCol.d * cov, x, y, i, j);
      if (q !== 0) putRel(x, y, c, q);
    } else if (cov > (D.kind === 'none' ? 0.35 : thr(D, x, y))) {
      put(x, y, hiCol);
    }
  });
}

// ─────────────────────────────────────────────────────────────── 2D CSG shape masks (shape add/sub/show/fill/outline)
const SHAPE_SUBS = new Set([
  'new', 'clear', 'select', 'list', 'drop', 'copy',
  'add', 'sub', 'and', 'intersect', 'xor', 'invert', 'not',
  'mirror', 'sym', 'grow', 'dilate', 'erode', 'rough',
  'show', 'fill', 'paint', 'outline',
]);
const SHAPE_BAD = new Set([...SHAPE_SUBS, 'radial', 'linear', 'all']);
function parseAxisOpt(v, dfltX, dfltY) {
  if (v === undefined) return [dfltX, dfltY];
  const parts = String(v).split(',');
  if (parts.length === 1) return [coordf(parts[0], 'axis', 'x'), coordf(parts[0], 'axis', 'y')];
  if (parts.length === 2) return [coordf(parts[0], 'axis', 'x'), coordf(parts[1], 'axis', 'y')];
  fail(`axis must be N or ax,ay, got "${v}"`);
}
function rasterShapeMask(rest, o) {
  const W = S.w, H = S.h, tmp = new Uint8Array(W * H), scR = o.region ? scope({ region: o.region }) : null;
  let kind = need(rest[0], 'primitive (ellipse|rect|poly|stroke|curve|spline|mask|shape)'), args = rest.slice(1);
  if (S.shapes.has(kind)) { args = [kind]; kind = 'shape'; }
  const [jx, jy] = symJitter(5);
  const P = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    for (const [sx, sy] of symPoints(x, y, jx, jy)) {
      if (scR && !scR.inR(sx, sy)) continue;
      if (S.wrap) tmp[mod(sy, H) * W + mod(sx, W)] = 1;
      else if (sx >= 0 && sy >= 0 && sx < W && sy < H) tmp[sy * W + sx] = 1;
    }
  };
  if (kind === 'ellipse') {
    ellipse(P, coord(args[0], 'cx', 'x'), coord(args[1], 'cy', 'y'), Math.max(0, coord(args[2], 'rx', 'x')), Math.max(0, coord(args[3], 'ry', 'y')), true);
  } else if (kind === 'rect') {
    const rx = coord(args[0], 'x', 'x'), ry = coord(args[1], 'y', 'y'), rw = coord(args[2], 'w', 'x'), rh = coord(args[3], 'h', 'y');
    const ctr = !!o.center || args.slice(4).includes('center');
    rect(P, ctr ? rx - Math.floor(rw / 2) : rx, ctr ? ry - Math.floor(rh / 2) : ry, rw, rh, true);
  } else if (kind === 'poly') {
    poly(P, ptsOf(args, 3, 'shape poly'), true);
  } else if (kind === 'stroke' || kind === 'curve' || kind === 'spline') {
    const rawPts = ptsOf(args, kind === 'curve' ? 3 : kind === 'spline' ? 2 : 1, `shape ${kind}`, true);
    const pts = kind === 'stroke' ? (o.closed && rawPts.length >= 2 ? [...rawPts, rawPts[0]] : rawPts) : evalCurve(rawPts, !!o.closed, kind === 'spline');
    const sz = clamp(fnum(o.size, S.brushOn ? S.brush.size : 3, 'size'), 1, 128), tp = parseTaper(o.taper, [100, 100]);
    for (const [x, y, t] of samplePath(pts)) {
      const r = (sz * evalTaper(tp, t)) / 2;
      if (r < 0.25) continue;
      const reach = Math.ceil(r), ix = Math.round(x), iy = Math.round(y);
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if (dx * dx + dy * dy <= r * r + 0.25) P(ix + dx, iy + dy);
    }
  } else if (kind === 'mask') {
    const M = maskSet(need(args[0], 'mask colors'));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (M[S.px[y * W + x]] === 1 && (!scR || scR.inR(x, y))) tmp[y * W + x] = 1;
  } else if (kind === 'shape') {
    const other = S.shapes.get(need(args[0], 'shape name')) || fail(`unknown shape "${args[0]}"`);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (other[y * W + x]) P(x, y);
  } else {
    fail(`unknown shape primitive "${kind}" (use: ellipse | rect | poly | stroke | curve | spline | mask | shape)`);
  }
  return tmp;
}
function showShapeAscii(nm, buf, o, rest) {
  const W = S.w, H = S.h;
  let cnt = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i]) cnt++;
  if (!cnt) return out(`shape "${nm}": 0 px (empty)`);
  const showAll = !!o.all || rest.includes('all');
  let x0 = 0, y0 = 0, w = W, h = H;
  if (o.region) [x0, y0, w, h] = regionOf(o);
  else if (!showAll) {
    const b = changedBounds(new Uint8Array(W * H), buf);
    const pad = 2;
    x0 = S.wrap ? b.x - pad : Math.max(0, b.x - pad);
    y0 = S.wrap ? b.y - pad : Math.max(0, b.y - pad);
    w = S.wrap ? Math.min(W, b.w + pad * 2) : Math.min(W - x0, b.x + b.w + pad - x0);
    h = S.wrap ? Math.min(H, b.h + pad * 2) : Math.min(H - y0, b.y + b.h + pad - y0);
  }
  const dw = Math.min(w, 128), dh = Math.min(h, 128);
  const xs = Array.from({ length: dw }, (_, i) => mod(x0 + i, W)), yPad = String(H - 1).length;
  out(`shape "${nm}": ${cnt} px (view ${dw}x${dh} at ${mod(x0, W)},${mod(y0, H)})${S.activeShape === nm ? ' [active]' : ''}`);
  for (let d = String(W - 1).length - 1; d >= 0; d--) out(' '.repeat(yPad + 1) + xs.map((x, i) => (d === 0 || x % 10 === 0 || i === 0 ? Math.floor(x / 10 ** d) % 10 : ' ')).join(''));
  for (let j = 0; j < dh; j++) {
    const y = mod(y0 + j, H);
    out(String(y).padStart(yPad) + ' ' + xs.map((x) => (buf[y * W + x] ? '#' : '.')).join(''));
  }
}
function shapeCmd(a, o) {
  const W = S.w, H = S.h, n = W * H;
  let nm, sub, rest;
  if (!a.length) { sub = 'list'; rest = []; }
  else if (SHAPE_SUBS.has(a[0])) {
    sub = a[0];
    if (['new', 'clear', 'select', 'drop'].includes(sub)) { nm = a[1] || S.activeShape || 'default'; rest = a.slice(2); }
    else { nm = S.activeShape || 'default'; rest = a.slice(1); }
  } else {
    nm = a[0]; sub = a[1] || 'show'; rest = a.slice(2);
    if (!SHAPE_SUBS.has(sub)) fail(`unknown shape subcommand "${sub}"`);
  }
  const checkName = (k) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || SHAPE_BAD.has(k)) fail(`bad shape name "${k}"`); };
  const needShape = (k) => S.shapes.get(k) || fail(`no shape "${k}" (create with "shape new ${k}" or "shape ${k} add ...")`);

  if (sub === 'list') {
    if (!S.shapes.size) return out('shapes: (none)');
    for (const [k, buf] of S.shapes) {
      let c = 0; for (let i = 0; i < buf.length; i++) if (buf[i]) c++;
      out(`  ${k === S.activeShape ? '*' : ' '} ${k}: ${c} px`);
    }
    return;
  }
  if (sub === 'new' || sub === 'clear') {
    checkName(nm);
    S.shapes.set(nm, new Uint8Array(n)); S.activeShape = nm;
    return out(`shape "${nm}" ready (${W}x${H})`);
  }
  if (sub === 'select') {
    const buf = needShape(nm);
    S.activeShape = nm;
    let c = 0; for (let i = 0; i < buf.length; i++) if (buf[i]) c++;
    return out(`shape "${nm}" active (${c} px)`);
  }
  if (sub === 'drop') {
    if (!S.shapes.has(nm)) fail(`no shape "${nm}"`);
    S.shapes.delete(nm);
    if (S.activeShape === nm) S.activeShape = S.shapes.size ? [...S.shapes.keys()].pop() : null;
    return out(`shape "${nm}" dropped`);
  }
  if (sub === 'copy') {
    const srcNm = need(rest[0], 'source shape'), dstNm = rest[1] || (SHAPE_SUBS.has(a[0]) ? (S.activeShape || 'default') : nm);
    checkName(dstNm);
    S.shapes.set(dstNm, needShape(srcNm).slice()); S.activeShape = dstNm;
    return out(`shape "${dstNm}" copied from "${srcNm}"`);
  }
  if (sub === 'add' || sub === 'sub' || sub === 'and' || sub === 'intersect' || sub === 'xor') {
    checkName(nm);
    let buf = S.shapes.get(nm);
    if (!buf) {
      if (sub === 'add' || sub === 'xor') { buf = new Uint8Array(n); S.shapes.set(nm, buf); S.activeShape = nm; }
      else fail(`no shape "${nm}" (create with "shape new ${nm}" first)`);
    }
    const tmp = rasterShapeMask(rest, o);
    if (sub === 'add') { for (let i = 0; i < n; i++) if (tmp[i]) buf[i] = 1; }
    else if (sub === 'sub') { for (let i = 0; i < n; i++) if (tmp[i]) buf[i] = 0; }
    else if (sub === 'and' || sub === 'intersect') { for (let i = 0; i < n; i++) buf[i] = buf[i] && tmp[i] ? 1 : 0; }
    else { for (let i = 0; i < n; i++) if (tmp[i]) buf[i] ^= 1; }
    return;
  }
  const buf = needShape(nm);
  if (sub === 'invert' || sub === 'not') {
    const sc = o.region ? scope({ region: o.region }) : null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!sc || sc.inR(x, y)) buf[y * W + x] ^= 1;
    return;
  }
  if (sub === 'mirror' || sub === 'sym') {
    const m = rest[0] || (S.sym.mode !== 'off' ? S.sym.mode : 'x');
    if (!['x', 'y', 'xy'].includes(m)) fail('shape mirror mode must be x | y | xy');
    const [ax, ay] = parseAxisOpt(o.axis, S.sym.ax ?? (W - 1) / 2, S.sym.ay ?? (H - 1) / 2);
    const doX = m === 'x' || m === 'xy', doY = m === 'y' || m === 'xy', src = buf.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!src[y * W + x]) continue;
      const mx = Math.round(2 * ax - x), my = Math.round(2 * ay - y);
      const putM = (px, py) => { if (S.wrap) buf[mod(py, H) * W + mod(px, W)] = 1; else if (px >= 0 && py >= 0 && px < W && py < H) buf[py * W + px] = 1; };
      if (doX) putM(mx, y);
      if (doY) putM(x, my);
      if (doX && doY) putM(mx, my);
    }
    return;
  }
  if (sub === 'grow' || sub === 'dilate') {
    const r = clamp(fnum(rest[0] ?? o.radius, 1, 'radius'), 0.5, 32);
    const inv = buf.map((v) => v ^ 1), dMap = computeEDT(inv);
    for (let i = 0; i < n; i++) if (!buf[i] && dMap[i] <= r + 1e-4) buf[i] = 1;
    return;
  }
  if (sub === 'erode') {
    const r = clamp(fnum(rest[0] ?? o.radius, 1, 'radius'), 0.5, 32);
    const dMap = computeEDT(buf);
    for (let i = 0; i < n; i++) if (buf[i] && dMap[i] <= r + 1e-4) buf[i] = 0;
    return;
  }
  if (sub === 'rough') {
    const A = clamp(num(o.amount, 2, 'amount'), 1, 8), P = num(o.prob, 55, 'prob') / 100, clump = clamp(num(o.clump, 3, 'clump'), 1, 32), seed = num(o.seed, 0, 'seed');
    const mode = { both: [1, 1], in: [1, 0], inner: [1, 0], out: [0, 1], outer: [0, 1] }[o.side || 'both'];
    if (!mode) fail('side must be both | in | out');
    const ins = buf.slice(), outs = ins.map((v) => v ^ 1);
    roughMask(ins, outs, A, P, clump, seed, mode, (k, _, isGrow) => { buf[k] = isGrow ? 1 : 0; });
    return;
  }
  if (sub === 'show') return showShapeAscii(nm, buf, o, rest);
  if (sub === 'fill' || sub === 'paint') {
    const c = col(need(rest[0], 'color')), sc = scope({ ...o, shape: nm });
    sc.each((x, y, cur) => { if (typeof c === 'object') putRel(x, y, cur, c.d); else put(x, y, c); });
    return;
  }
  if (sub === 'outline') {
    const c = col(need(rest[0], 'color'));
    outline(c, { ...o, shape: nm, side: o.side || 'outer' });
    return;
  }
}

// ─────────────────────────────────────────────────────────────── key chars (one char <-> palette index)
const POOL = [...'0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ#%&*+=$~^<>/|!:;,-_'];
function setKey(ch, c) {
  if (ch === undefined || [...ch].length !== 1 || ch === '.' || ch === '?') fail('key must be ONE character ("." is reserved for transparent, "?" for unknown)');
  const old = S.keys.get(ch);
  S.keys.set(ch, c);
  if (old !== undefined && S.keyOf.get(old) === ch) { S.keyOf.delete(old); for (const [k, v] of S.keys) if (v === old) { S.keyOf.set(old, k); break; } }
  S.keyOf.set(c, ch);
}
const rampOrder = () => { const names = [...S.ramps.keys()]; return (c) => (S.rampOf[c] ? names.indexOf(S.rampOf[c].name) * 1000 + S.rampOf[c].i : 1e6 + c); };
function autoKeys(used) { // colors without a key get the next free char; shades of one ramp get consecutive chars
  const ord = rampOrder();
  for (const c of used.filter((u) => !S.keyOf.has(u)).sort((a, b) => ord(a) - ord(b))) { const ch = POOL.find((p) => !S.keys.has(p)); if (!ch) break; setKey(ch, c); }
}

// ─────────────────────────────────────────────────────────────── text feedback (how the LLM "sees")
function legend(used) {
  const ord = rampOrder();
  out('legend  key = index #hex ramp:step  xcount');
  for (const c of [...used.keys()].sort((a, b) => ord(a) - ord(b))) out(`  ${S.keyOf.get(c) ?? '?'} = ${descr(c)}  x${used.get(c)}`);
  if ([...used.keys()].some((c) => !S.keyOf.has(c))) out('  (? = ran out of key chars; use view=idx)');
}
function show(x0, y0, w, h, view = 'char', cw = 1) {
  needCanvas();
  if (w < 1 || h < 1 || w > 512 || h > 512) fail('view width/height must be 1..512');
  if (!['char', 'idx', 'step', 'height'].includes(view)) fail('view must be char | idx | step | height');
  const xs = Array.from({ length: w }, (_, i) => mod(x0 + i, S.w)), pad = String(S.h - 1).length;
  out(`${view} view ${w}x${h} at ${x0},${y0} — canvas ${S.w}x${S.h}, wrap ${S.wrap ? 'on' : 'off'}; rulers show wrapped x (top) and y (left)`);
  if (view === 'height') {
    let minH = Infinity, maxH = -Infinity;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const hv = getH(x0 + i, y0 + j); if (hv < minH) minH = hv; if (hv > maxH) maxH = hv; }
    const span = maxH - minH || 1;
    for (let d = String(S.w - 1).length - 1; d >= 0; d--) out(' '.repeat(pad + 1) + xs.map((x, i) => (d === 0 || x % 10 === 0 || i === 0 ? Math.floor(x / 10 ** d) % 10 : ' ')).join(''));
    for (let j = 0; j < h; j++) {
      out(String(mod(y0 + j, S.h)).padStart(pad) + ' ' + xs.map((_, i) => {
        const hv = getH(x0 + i, y0 + j);
        return maxH === minH ? '0' : Math.round(((hv - minH) / span) * 35).toString(36);
      }).join(''));
    }
    out(`height range: ${minH.toFixed(2)} .. ${maxH.toFixed(2)} (0=min .. z=max)`);
    return;
  }
  const at = (x, y) => S.px[mod(y, S.h) * S.w + mod(x, S.w)], used = new Map();
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const c = at(x0 + i, y0 + j); used.set(c, (used.get(c) || 0) + 1); }
  autoKeys([...used.keys()]);
  if (view === 'idx') cw = 4;
  const cell = (c) => (view === 'idx' ? String(c) : view === 'step' ? (S.rampOf[c] ? S.rampOf[c].i.toString(36) : '?') : S.keyOf.get(c) ?? '?').padStart(cw);
  if (cw === 1) for (let d = String(S.w - 1).length - 1; d >= 0; d--) out(' '.repeat(pad + 1) + xs.map((x, i) => (d === 0 || x % 10 === 0 || i === 0 ? Math.floor(x / 10 ** d) % 10 : ' ')).join(''));
  else out(' '.repeat(pad + 1) + xs.map((x) => String(x).padStart(cw)).join(''));
  for (let j = 0; j < h; j++) out(String(mod(y0 + j, S.h)).padStart(pad) + ' ' + xs.map((_, i) => cell(at(x0 + i, y0 + j))).join(''));
  if (view === 'step') out('(digits = step inside the pixel\'s ramp, base 36, 0 = darkest; ? = color in no ramp)');
  legend(used);
}
function changedBounds(beforePx, afterPx) {
  const W = S.w, H = S.h, hasX = new Uint8Array(W), hasY = new Uint8Array(H);
  let count = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (beforePx[i] !== afterPx[i]) { hasX[x] = 1; hasY[y] = 1; count++; }
  }
  if (!count) return null;
  const span = (arr, n) => {
    if (!S.wrap) {
      let lo = 0, hi = n - 1;
      while (!arr[lo]) lo++;
      while (!arr[hi]) hi--;
      return [lo, hi - lo + 1];
    }
    let bestGap = -1, bestEnd = 0, run = 0;
    for (let k = 0; k < n * 2; k++) {
      if (!arr[k % n]) { run++; if (run > bestGap) { bestGap = run; bestEnd = k; } } else run = 0;
    }
    if (bestGap >= n) return [0, n];
    const start = (bestEnd + 1) % n;
    return [start, Math.max(1, n - bestGap)];
  };
  const [x, w] = span(hasX, W), [y, h] = span(hasY, H);
  return { x, y, w, h, count };
}
function showDiff(beforePx, label, view = 'char') {
  needCanvas();
  const b = changedBounds(beforePx, S.px);
  if (!b) return out(`diff${label ? ' (' + label + ')' : ''}: 0 pixels changed`);
  out(`diff${label ? ' (' + label + ')' : ''}: ${b.count} px changed in ${b.w}x${b.h} at ${b.x},${b.y}`);
  const w = Math.min(b.w, 128), h = Math.min(b.h, 128), cw = view === 'idx' ? 4 : 1;
  const used = new Map(), xs = Array.from({ length: w }, (_, i) => mod(b.x + i, S.w)), pad = String(S.h - 1).length;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = mod(b.x + i, S.w), y = mod(b.y + j, S.h), idx = y * S.w + x;
    if (beforePx[idx] !== S.px[idx]) used.set(S.px[idx], (used.get(S.px[idx]) || 0) + 1);
  }
  autoKeys([...used.keys()]);
  if (cw === 1) for (let d = String(S.w - 1).length - 1; d >= 0; d--) out(' '.repeat(pad + 1) + xs.map((x, i) => (d === 0 || x % 10 === 0 || i === 0 ? Math.floor(x / 10 ** d) % 10 : ' ')).join(''));
  else out(' '.repeat(pad + 1) + xs.map((x) => String(x).padStart(cw)).join(''));
  for (let j = 0; j < h; j++) {
    const y = mod(b.y + j, S.h);
    out(String(y).padStart(pad) + ' ' + xs.map((x) => {
      const idx = y * S.w + x;
      if (beforePx[idx] === S.px[idx]) return '.'.padStart(cw);
      const c = S.px[idx];
      return (view === 'idx' ? String(c) : view === 'step' ? (S.rampOf[c] ? S.rampOf[c].i.toString(36) : '?') : S.keyOf.get(c) ?? '?').padStart(cw);
    }).join(''));
  }
  legend(used);
}
function saveTrace(beforePx, cmdLabel) {
  if (!S.trace.active || !S.w) return;
  const b = changedBounds(beforePx, S.px);
  if (!b) return;
  fs.mkdirSync(S.trace.dir, { recursive: true });
  const pad = S.trace.pad, sc = S.trace.scale;
  const cx = S.trace.all ? 0 : (S.wrap ? b.x - pad : Math.max(0, b.x - pad));
  const cy = S.trace.all ? 0 : (S.wrap ? b.y - pad : Math.max(0, b.y - pad));
  const cw = S.trace.all ? S.w : Math.min(S.w, b.w + pad * 2);
  const ch = S.trace.all ? S.h : Math.min(S.h, b.h + pad * 2);
  const ow = cw * sc, oh = ch * sc, outPx = new Uint8Array(ow * oh);
  for (let j = 0; j < oh; j++) {
    const sy = mod(cy + Math.floor(j / sc), S.h);
    for (let i = 0; i < ow; i++) outPx[j * ow + i] = S.px[sy * S.w + mod(cx + Math.floor(i / sc), S.w)];
  }
  const safe = cmdLabel.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'cmd';
  const file = `${S.trace.dir}/${String(++S.trace.step).padStart(3, '0')}_${safe}.png`;
  fs.writeFileSync(file, encodePNG(ow, oh, outPx, S.pal));
  out(`trace: ${file} (${cw}x${ch} at ${mod(cx, S.w)},${mod(cy, S.h)}, ${b.count} px changed, ${sc}x)`);
}
function lintCanvas(o) {
  needCanvas();
  const sc = scope(o), jumpLim = clamp(num(o.jump, 3, 'jump'), 1, 32), W = S.w, H = S.h;
  const isolated = [], jumps = [], unramped = [], ditherMask = new Uint8Array(W * H), outlierVisited = new Uint8Array(W * H), outliers = [];
  const cAt = (x, y) => get(x, y, sc.src);
  sc.each((x, y, c) => {
    const wx = mod(x, W), wy = mod(y, H), idx = wy * W + wx;
    const rm = S.rampOf[c];
    if (!rm && !S.fullbright[c]) unramped.push([wx, wy]);
    // 1. Regular 2x2 repeating tile check
    const c2x = cAt(x + 2, y), c2y = cAt(x, y + 2), c1x = cAt(x + 1, y), c1y = cAt(x, y + 1);
    if (c === c2x && c === c2y && c1x >= 0 && c1y >= 0 && (c1x !== c || c1y !== c) && c1x === cAt(x + 3, y) && c1y === cAt(x, y + 3)) {
      ditherMask[idx] = 1;
    }
    // 2. Intra-ramp jumps > jumpLim (skip fullbright pixels and sharp sculpted height boundaries)
    const ch = S.hchanged > 0 ? getH(x, y) : 0;
    if (rm && !S.fullbright[c]) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nc = cAt(x + dx, y + dy), rn = nc >= 0 ? S.rampOf[nc] : null;
        if (!rn || rn.name !== rm.name || S.fullbright[nc] || Math.abs(rm.i - rn.i) <= jumpLim) continue;
        if (S.hchanged > 0 && Math.abs(ch - getH(x + dx, y + dy)) >= 1.5) continue;
        jumps.push([wx, wy, Math.abs(rm.i - rn.i)]);
      }
    }
    // 3. Isolated single-pixel noise (not part of regular checkerboard, thin 1px line, or convex height peak specular)
    if (!S.fullbright[c] && !(c1x === cAt(x - 1, y) && c1y === cAt(x, y - 1))) {
      let isPeak = false;
      if (S.hchanged > 0) {
        const avgH = (getH(x + 1, y) + getH(x - 1, y) + getH(x, y + 1) + getH(x, y - 1)) / 4;
        if (ch - avgH >= 1.5) isPeak = true;
      }
      let allFar = !isPeak;
      for (const [dx, dy] of N8) {
        if (!allFar) break;
        const nc = cAt(x + dx, y + dy);
        if (nc < 0) continue;
        if (nc === c) { allFar = false; break; }
        const rn = S.rampOf[nc];
        if (rm && rn && rn.name === rm.name && Math.abs(rm.i - rn.i) < jumpLim) { allFar = false; break; }
      }
      if (allFar) isolated.push([wx, wy]);
    }
  });
  // Connected components for large regular dither patches (>= 36 px)
  const ditherPatches = [], dVis = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!ditherMask[i] || dVis[i]) continue;
    const st = [i], cells = [];
    dVis[i] = 1;
    while (st.length) {
      const k = st.pop(), x = k % W, y = (k / W) | 0;
      cells.push([x, y]);
      for (const [dx, dy] of N4) {
        const nx = S.wrap ? mod(x + dx, W) : x + dx, ny = S.wrap ? mod(y + dy, H) : y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (ditherMask[nk] && !dVis[nk]) { dVis[nk] = 1; st.push(nk); }
      }
    }
    if (cells.length >= 36) {
      const xs = cells.map((p) => p[0]), ys = cells.map((p) => p[1]);
      ditherPatches.push({ n: cells.length, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 });
    }
  }
  // Connected specks (<= 3 px) surrounded by a single different dominant ramp
  sc.each((x, y, c) => {
    const wx = mod(x, W), wy = mod(y, H), idx = wy * W + wx;
    if (outlierVisited[idx] || S.fullbright[c] || !S.rampOf[c]) return;
    const myRamp = S.rampOf[c].name, st = [idx], comp = [], borders = new Map();
    outlierVisited[idx] = 1;
    while (st.length) {
      const k = st.pop(), cx = k % W, cy = (k / W) | 0;
      comp.push([cx, cy]);
      for (const [dx, dy] of N4) {
        const nx = S.wrap ? mod(cx + dx, W) : cx + dx, ny = S.wrap ? mod(cy + dy, H) : cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx, nc = sc.src[nk], rn = S.rampOf[nc];
        if (rn && rn.name === myRamp && sc.has(nx, ny)) {
          if (!outlierVisited[nk] && comp.length < 8) { outlierVisited[nk] = 1; st.push(nk); }
        } else if (rn) {
          borders.set(rn.name, (borders.get(rn.name) || 0) + 1);
        }
      }
    }
    if (comp.length <= 3 && borders.size === 1) {
      const [dom] = [...borders.keys()];
      outliers.push([comp[0][0], comp[0][1], myRamp, dom]);
    }
  });
  const sample = (arr, fmt) => arr.slice(0, 5).map(fmt).join(', ') + (arr.length > 5 ? ` … (+${arr.length - 5})` : '');
  let issues = 0;
  out('lint report:');
  if (isolated.length) { issues++; out(`  [noise] ${isolated.length} isolated pixel(s): ${sample(isolated, ([x, y]) => `${x},${y}`)}`); }
  if (ditherPatches.length) { issues++; out(`  [dither] ${ditherPatches.length} large regular 2x2 patch(es): ${sample(ditherPatches, (p) => `${p.x},${p.y} (${p.w}x${p.h}, ${p.n}px)`)}`); }
  if (jumps.length) { issues++; out(`  [banding] ${jumps.length} intra-ramp step jump(s) > ${jumpLim}: ${sample(jumps, ([x, y, d]) => `${x},${y} (±${d})`)}`); }
  if (outliers.length) { issues++; out(`  [ramp] ${outliers.length} stray speck(s) inside another ramp: ${sample(outliers, ([x, y, r, d]) => `${x},${y} ${r} in ${d}`)}`); }
  if (unramped.length) { issues++; out(`  [unramped] ${unramped.length} pixel(s) not in any ramp (non-fullbright): ${sample(unramped, ([x, y]) => `${x},${y}`)}`); }
  if (!issues) out('  ok: no noise, banding, stray specks, or large regular dither patches found');
  if (!o.mask && !o.region) seam();
}
function seam() { // compares the color jump across each wrap edge with the average jump inside the tile
  needCanvas();
  const d = (a, b) => Math.sqrt(dist(S.pal[a], S.pal[b]));
  const rep = (label, n, len, at) => {
    let edge = 0, inner = 0;
    for (let k = 0; k < len; k++) { edge += d(at(n - 1, k), at(0, k)); for (let p = 0; p + 1 < n; p++) inner += d(at(p, k), at(p + 1, k)); }
    edge /= len; inner /= len * Math.max(1, n - 1);
    const ratio = edge / Math.max(inner, 1);
    out(`seam ${label}: edge jump ${edge.toFixed(1)}, interior avg ${inner.toFixed(1)}, ratio ${ratio.toFixed(2)} ${ratio > 3 ? '<-- probably a visible seam: look with "zoom" across the edge' : 'ok'}`);
  };
  rep(`x (col ${S.w - 1} | col 0)`, S.w, S.h, (p, k) => S.px[k * S.w + p]);
  rep(`y (row ${S.h - 1} | row 0)`, S.h, S.w, (p, k) => S.px[p * S.w + k]);
}
function listRamps() {
  if (!S.ramps.size) return out('ramps: (none) — define with: ramp <name> <idx|a..b ...>   or: ramp auto 16');
  out('ramps (step 0 = darkest … last = lightest):');
  for (const [n, r] of S.ramps) {
    const run = r.every((v, i) => !i || v === r[i - 1] + 1);
    const tag = aliasRamps.has(n) ? ' [alias]' : autoRamps.has(n) ? ' [auto]' : '';
    out(`  ${n.padEnd(8)} ${String(r.length).padStart(2)} steps  idx ${run ? r[0] + '..' + r[r.length - 1] : r.join(',')}  ${hex(S.pal[r[0]])} … ${hex(S.pal[r[r.length - 1]])}${tag}`);
  }
}

// ─────────────────────────────────────────────────────────────── commands
const C = {};
const def = (name, usage, help, fn, draw = false, flags = []) => { C[name] = { usage, help, fn, draw, flags: new Set(flags) }; };
const ints = (a, n, names) => names.split(' ').map((nm, i) => int(a[i + n], nm));
const need = (v, what) => v ?? fail(`missing <${what}>`);

def('new', '<w> <h> [color]', 'New canvas filled with color (default index 0). Loads the built-in palette if none is set.', (a) => {
  needPal();
  const [w, h] = ints(a, 0, 'w h');
  if (w < 1 || h < 1 || w > 4096 || h > 4096) fail('canvas size must be 1..4096');
  initCanvas(w, h, a[2] !== undefined ? col(a[2], false) : 0);
});
def('palette', '[builtin | quake [file] | fullbright <idx|a..b...|clear> | file <path> | set <#hex> ...]',
  'Load a palette (clears ramps) or mark fullbright indices (protected from lighting/nearest). Files: .png .gpl .pal .hex or raw RGB.', (a) => {
  if (a[0] === 'builtin') builtinPalette();
  else if (a[0] === 'quake') {
    quakePalette(a[1]);
    out(`palette: Quake-layout ${S.pal.length} colors (${a[1] || 'built-in'}), ${S.ramps.size} ramps, fullbrights: fb_lava/fb_fire/fb_plasma/fb_runic (224..254)`);
  } else if (a[0] === 'fullbright') {
    needPal();
    if (a[1] === 'clear') { S.fullbright.fill(0); nearCache.clear(); out('fullbright: cleared'); }
    else {
      const idx = parseIndexSpec(a.slice(1));
      setFullbright(idx);
      out(`fullbright: marked ${idx.length} index(es)`);
    }
  } else if (a[0] === 'file') {
    setPalette(loadPaletteFile(need(a[1], 'path')));
    out(`palette: ${S.pal.length} colors from ${a[1]}; ramps cleared — define them: "ramp auto 16", "ramp quake", or "ramp <name> <indices>"`);
  } else if (a[0] === 'set') setPalette(a.slice(1).map(unhex));
  else if (!a.length) {
    needPal(); out(`palette: ${S.pal.length} colors`);
    for (let i = 0; i < S.pal.length; i += 8) out('  ' + S.pal.slice(i, i + 8).map((c, k) => `${String(i + k).padStart(3)}:${hex(c)}${S.fullbright[i + k] ? '*' : ' '}`).join(''));
    listRamps();
  } else fail(`unknown palette subcommand "${a[0]}"`);
});
def('ramp', '[<name> <idx | a..b | #hex> ... [alias|primary] | auto [n] | quake]', 'Define a shading ramp, dark -> light. "auto n" makes r0,r1,… from each row; "quake" sets Quake 1 material ramps + fullbrights.', (a, o) => {
  needPal();
  if (!a.length) return listRamps();
  if (a[0] === 'quake') { applyQuakeRamps(); return listRamps(); }
  if (a[0] === 'auto') {
    const n = num(a[1], 16, 'n');
    if (n < 2) fail('ramp auto: n must be >= 2');
    S.ramps.clear(); autoRamps.clear(); aliasRamps.clear();
    for (let i = 0, k = 0; i < S.pal.length; i += n, k++) setRamp('r' + k, Array.from({ length: Math.min(n, S.pal.length - i) }, (_, j) => i + j).sort((p, q) => lum(S.pal[p]) - lum(S.pal[q])), { auto: true });
    return listRamps();
  }
  setRamp(a[0], parseIndexSpec(a.slice(1)), { alias: !!o.alias, primary: !!o.primary });
});
def('key', '<char> <color>', 'Bind one character to a palette color for sprite grids and dumps. "." is always transparent.', (a) => setKey(a[0], col(a[1], false)));
def('keys', '', 'List the current key chars.', () => { for (const [ch, c] of S.keys) out(`  ${ch} = ${descr(c)}`); if (!S.keys.size) out('keys: (none)'); });
def('wrap', 'on | off', 'Wrap-around drawing (default on): anything crossing an edge continues on the opposite side, so the tile stays seamless.', (a) => {
  if (a[0] !== 'on' && a[0] !== 'off') fail('wrap on | wrap off');
  S.wrap = a[0] === 'on';
});
// ═══════════════════════════════════════════════════════════════════════════
// COMMAND REGISTRATION, BLOCKS, SCRIPT RUNNER & CLI
// ═══════════════════════════════════════════════════════════════════════════
def('brush', '[circle|square|chisel|diamond|soft|spray|bristle|chalk|mottle|sprite <name> [alpha]] [size=N] [angle=DEG] [aspect=PCT] [spacing=N|N%] [taper=e|s,e|s,m,e] [flow=PCT] [opacity=PCT] [blend=auto|mix|replace|tint|rgb] [tex_scale=N] [size_jitter=PCT] [angle_jitter=DEG] [shade_jitter=N] [flow_jitter=PCT] [jitter=N] [scatter=N] [density=PCT] [n=N] [skip=PCT] [shade=n|lo,hi] [dither=..] [rot=fixed|follow|random] [seed=N]',
  'Configure the active brush (or "brush reset" to restore defaults). Prefer "with brush ... end" so a thick brush does not stay active accidentally.', (a, o) => {
  needPal();
  if (!a.length && !Object.keys(o).length) return showBrush();
  if (a[0] === 'reset') {
    S.brush = DEFAULT_BRUSH(); S.brushOn = false; return;
  }
  applyBrushOpts(S.brush, a[0] || null, a[1] || null, o);
  S.brushOn = true;
  showBrush();
}, false, ['alpha', 'tint']);
def('with', 'brush [opts] ... end', 'Scoped brush block: configures S.brush for commands inside and restores the prior brush state at "end".', () => fail('"with" must end with a matching "end" line'));
def('end', '', 'Close a "sprite" or "with brush" block.', () => fail('"end" without matching "sprite" or "with brush"'));

def('sprite', '<name> [ramp=<r>] [outline=<c>] [shade] [mid=N] (then grid rows, then "end") | <name> row <y> "<str>" | show <name>',
  'Define a sprite from a text grid (using @keys or ramp= steps 0-9a-z and # outline), edit one row, or print a sprite.', () => fail('sprite needs a grid block (sprite <name> ... / end), "row", or "show"'));
def('anchor', '[<name> <x> <y> [w [h]] | list | clear]', 'Define a named coordinate anchor (with optional centered box size w,h) for relative expressions and region=anchor:<name>. Built-in: cx, cy, w, h.', (a) => {
  if (!a.length || a[0] === 'list') {
    if (!S.anchors.size) return out('anchors: (none; built-in: cx cy w h)');
    for (const [nm, [x, y, aw, ah]] of S.anchors) out(`  ${nm} = ${x},${y}${aw != null ? ` (${aw}x${ah})` : ''}`);
    return;
  }
  if (a[0] === 'clear') { S.anchors.clear(); return out('anchors cleared'); }
  const nm = need(a[0], 'name');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm) || ['cx', 'cy', 'w', 'h'].includes(nm)) fail(`bad anchor name "${nm}"`);
  const x = coord(a[1], 'x', 'x'), y = coord(a[2], 'y', 'y');
  const aw = a[3] !== undefined ? Math.max(1, coord(a[3], 'w', 'x')) : null;
  const ah = a[4] !== undefined ? Math.max(1, coord(a[4], 'h', 'y')) : aw;
  S.anchors.set(nm, [x, y, aw, ah]);
  out(`anchor ${nm} = ${x},${y}${aw != null ? ` (${aw}x${ah})` : ''}`);
});
def('grab', '<name> <x> <y> <w> <h> [mask=…]', 'Copy a canvas region (transparent where outside mask=) into a named sprite.', (a, o) => {
  needCanvas();
  grabSprite(need(a[0], 'name'), coord(a[1], 'x', 'x'), coord(a[2], 'y', 'y'), coord(a[3], 'w', 'x'), coord(a[4], 'h', 'y'), o);
});
def('sym', 'off | x | y | xy [axis=N|ax,ay|anchor] [jitter=N] [seed=N]', 'Mirror vector/brush/stamp/shape drawing across axis (accepts numbers or anchors, default canvas center).', (a, o) => {
  const m = need(a[0], 'mode');
  if (!['off', 'x', 'y', 'xy'].includes(m)) fail('sym must be off | x | y | xy');
  S.sym.mode = m;
  if (m === 'off') { S.sym.ax = null; S.sym.ay = null; S.sym.jitter = 0; return out('sym off'); }
  if (o.axis !== undefined) {
    const [ax, ay] = parseAxisOpt(o.axis, null, null);
    S.sym.ax = ax; S.sym.ay = ay;
  } else { S.sym.ax = null; S.sym.ay = null; }
  S.sym.jitter = clamp(num(o.jitter, 0, 'jitter'), 0, 32);
  S.sym.seed = num(o.seed, 0, 'seed');
  out(`sym ${S.sym.mode} axis=${S.sym.ax ?? 'center'},${S.sym.ay ?? 'center'} jitter=${S.sym.jitter}`);
});
def('layer', 'new [name] [shade] [hmode=add|max|over|smin] [k=2.5] | hmode <add|max|over|smin> [k=2.5] | merge [mode=replace|shade] | list | select <name|idx> | drop | clear | vis <on|off>',
  'Manage layers (overlay paint/shade layers + per-layer height blending via add|max|over|smin).', (a, o) => {
  needCanvas();
  const sub = a[0] || 'list';
  const ensureBase = () => {
    if (!S.layers.length) {
      S.layers.push({ name: 'base', kind: 'base', px: S.px.slice(), hmap: S.hmap.slice(), hused: S.hchanged > 0, hmode: 'replace', smoothR: 2.5, visible: true });
      S.activeLayer = 0;
    }
  };
  if (sub === 'new') {
    ensureBase();
    const isShade = !!o.shade || a.includes('shade');
    const nm = a.slice(1).find((t) => t !== 'shade') || `layer${S.layers.length}`;
    const hm = o.hmode || 'add';
    if (!['add', 'max', 'over', 'smin'].includes(hm)) fail('layer hmode must be add | max | over | smin');
    const sr = fnum(o.k ?? o.smooth, 2.5, 'k');
    const px = isShade ? new Int16Array(S.w * S.h) : new Int16Array(S.w * S.h).fill(-1);
    S.layers.push({ name: nm, kind: isShade ? 'shade' : 'paint', px, hmap: new Float32Array(S.w * S.h), hused: false, hmode: hm, smoothR: sr, visible: true });
    S.activeLayer = S.layers.length - 1;
    syncLayers();
    out(`layer: created "${nm}" (${isShade ? 'shade' : 'paint'}, hmode=${hm}, #${S.activeLayer})`);
  } else if (sub === 'hmode') {
    ensureBase();
    const L = S.layers[S.activeLayer];
    const hm = need(a[1], 'mode');
    if (!['add', 'max', 'over', 'smin'].includes(hm)) fail('layer hmode must be add | max | over | smin');
    L.hmode = hm;
    if ((o.k ?? o.smooth) !== undefined) L.smoothR = fnum(o.k ?? o.smooth, 2.5, 'k');
    syncLayers(); S.hchanged++;
    out(`layer: "${L.name}" hmode=${L.hmode} k=${L.smoothR}`);
  } else if (sub === 'list') {
    if (!S.layers.length) return out('layers: [0] base (single canvas)');
    S.layers.forEach((l, idx) => out(`  ${idx === S.activeLayer ? '*' : ' '} [${idx}] ${l.name} (${l.kind}${l.hused ? `, h=${l.hmode}` : ''}${l.visible ? '' : ', hidden'})`));
  } else if (sub === 'select') {
    ensureBase();
    const tok = need(a[1], 'layer');
    const idx = /^\d+$/.test(tok) ? parseInt(tok, 10) : S.layers.findIndex((l) => l.name === tok);
    if (idx < 0 || idx >= S.layers.length) fail(`no layer "${tok}"`);
    S.activeLayer = idx; syncLayers();
    out(`layer: active #${idx} "${S.layers[idx].name}"`);
  } else if (sub === 'vis') {
    ensureBase();
    const v = a[1];
    if (v !== 'on' && v !== 'off') fail('layer vis on | off');
    S.layers[S.activeLayer].visible = v === 'on';
    syncLayers();
  } else if (sub === 'clear') {
    if (!S.layers.length || S.layers[S.activeLayer].kind === 'base') fail('layer clear only clears overlay/shade layers');
    const L = S.layers[S.activeLayer];
    L.px.fill(L.kind === 'shade' ? 0 : -1); L.hmap.fill(0); L.hused = false; syncLayers(); S.changed++;
  } else if (sub === 'drop') {
    if (S.layers.length <= 1 || S.activeLayer === 0) fail('cannot drop base layer');
    const [rm] = S.layers.splice(S.activeLayer, 1);
    S.activeLayer = Math.min(S.activeLayer, S.layers.length - 1);
    if (S.layers.length === 1) { S.px = S.layers[0].px.slice(); S.hmap = S.layers[0].hmap.slice(); S.layers = []; S.activeLayer = -1; }
    syncLayers(); S.changed++;
    out(`layer: dropped "${rm.name}"`);
  } else if (sub === 'merge') {
    if (S.layers.length <= 1 || S.activeLayer === 0) fail('nothing below active layer to merge into');
    const mode = o.mode || (S.layers[S.activeLayer].kind === 'shade' ? 'shade' : 'replace');
    if (mode !== 'replace' && mode !== 'shade') fail('layer merge mode must be replace | shade');
    const top = S.layers[S.activeLayer], below = S.layers[S.activeLayer - 1];
    for (let i = 0; i < S.w * S.h; i++) {
      if (top.kind === 'shade') {
        const d = top.px[i];
        if (!d) continue;
        if (below.kind === 'shade') below.px[i] = clamp(below.px[i] + d, -32, 32);
        else if (below.px[i] >= 0 && !S.fullbright[below.px[i]]) below.px[i] = shadeIdx(below.px[i], d);
      } else if (top.px[i] >= 0) {
        if (mode === 'replace') below.px[i] = top.px[i];
        else {
          const v = top.px[i], rm = S.rampOf[v];
          const d = rm ? rm.i - (S.ramps.get(rm.name).length >> 1) : Math.round((brightnessOf(v) - 0.5) * 15);
          if (below.kind === 'shade') below.px[i] = clamp(below.px[i] + d, -32, 32);
          else if (below.px[i] >= 0 && !S.fullbright[below.px[i]]) below.px[i] = shadeIdx(below.px[i], d);
        }
      }
    }
    if (top.hused && top.hmap && below.hmap) {
      blendHeightBuf(below.hmap, top.hmap, top.kind === 'paint' ? top.px : null, top.hmode || 'add', top.smoothR || 2.5);
      below.hused = true;
    }
    S.layers.splice(S.activeLayer, 1);
    S.activeLayer--;
    if (S.layers.length === 1) { S.px = S.layers[0].px.slice(); S.hmap = S.layers[0].hmap.slice(); S.layers = []; S.activeLayer = -1; }
    syncLayers(); S.changed++;
    out(`layer: merged "${top.name}" (${mode})`);
  } else fail(`unknown layer subcommand "${sub}"`);
}, false, ['shade']);
def('checkpoint', '<name>', 'Save a named snapshot of canvas, height map, and layers.', (a) => {
  needCanvas();
  const nm = need(a[0], 'name');
  S.checkpoints.set(nm, snapState(nm));
  out(`checkpoint "${nm}" saved`);
});
def('restore', '<name>', 'Restore a previously saved checkpoint (can be undone).', (a) => {
  needCanvas();
  const nm = need(a[0], 'name'), st = S.checkpoints.get(nm) || fail(`no checkpoint "${nm}"`);
  pushUndo(`restore ${nm}`);
  restoreState(st);
  out(`checkpoint "${nm}" restored`);
});
def('undo', '[n]', 'Undo the last n drawing/height/layer operations (up to 50 steps).', (a) => {
  const n = clamp(num(a[0], 1, 'n'), 1, 50);
  if (!S.undoStack.length) fail('nothing to undo');
  let item = null;
  for (let i = 0; i < n && S.undoStack.length; i++) { item = S.undoStack.pop(); S.undoBytes -= item.bytes; }
  restoreState(item.st);
  out(`undo: restored state before "${item.st.label}" (${S.undoStack.length} left)`);
});
def('diff', '[checkpoint] [view=char|step|idx]', 'Show only the pixels changed by the last command (or since a named checkpoint).', (a, o) => {
  needCanvas();
  if (a[0]) {
    const st = S.checkpoints.get(a[0]) || fail(`no checkpoint "${a[0]}"`);
    return showDiff(st.px, `since ${a[0]}`, o.view || 'char');
  }
  if (!S.lastDiff) return out('diff: no previous drawing command yet');
  showDiff(S.lastDiff.px, S.lastDiff.cmd, o.view || 'char');
});

def('pixel', '<x> <y> <color>', 'Set one pixel (color may be relative: +n / -n shades what is there).', (a, o) => {
  needCanvas(); plotter(o, col(a[2]))(coord(a[0], 'x', 'x'), coord(a[1], 'y', 'y'));
}, true);
def('line', '<x0> <y0> <x1> <y1> <color>', '1px Bresenham line — or a brushed stroke if a brush is active (or brush options are passed).', (a, o) => {
  needCanvas();
  const x0 = coord(a[0], 'x0', 'x'), y0 = coord(a[1], 'y0', 'y'), x1 = coord(a[2], 'x1', 'x'), y1 = coord(a[3], 'y1', 'y');
  if (S.brushOn || hasBrushOpt(o)) return paintPath([[x0, y0], [x1, y1]], need(a[4], 'color'), o);
  line(plotter(o, col(a[4])), x0, y0, x1, y1);
}, true, ['alpha', 'tint']);
def('rect', '<x> <y> <w> <h> <color> [fill] [center]', 'Rectangle outline, or filled with "fill" (pass "center" to center around x,y). Wraps around edges.', (a, o) => {
  needCanvas();
  const pos = []; let ctr = o.center === true || /^(1|true|yes|on)$/i.test(String(o.center || ''));
  for (const t of a) { if (t === 'center' && pos.length >= 5) ctr = true; else pos.push(t); }
  const rx = coord(pos[0], 'x', 'x'), ry = coord(pos[1], 'y', 'y'), rw = coord(pos[2], 'w', 'x'), rh = coord(pos[3], 'h', 'y');
  rect(plotter(o, col(pos[4])), ctr ? rx - Math.floor(rw / 2) : rx, ctr ? ry - Math.floor(rh / 2) : ry, rw, rh, !!o.fill);
}, true, ['fill']);
def('ellipse', '<cx> <cy> <rx> <ry> <color> [fill]', 'Ellipse (outline or fill) centred at cx,cy with radii rx,ry.', (a, o) => {
  needCanvas();
  ellipse(plotter(o, col(a[4])), coord(a[0], 'cx', 'x'), coord(a[1], 'cy', 'y'), coord(a[2], 'rx', 'x'), coord(a[3], 'ry', 'y'), !!o.fill);
}, true, ['fill']);
const ptsOf = (toks, min, what, allowFloat = false) => {
  const fn = allowFloat ? coordf : coord;
  const pts = toks.map((t) => { const p = t.split(','); if (p.length !== 2) fail(`${what}: points are written x,y — got "${t}"`); return [fn(p[0], 'x', 'x'), fn(p[1], 'y', 'y')]; });
  if (pts.length < min) fail(`${what}: needs at least ${min} point(s)`);
  return pts;
};
def('poly', '<color> <x,y> <x,y> <x,y> ... [fill]', 'Polygon outline or filled (scanline).', (a, o) => {
  needCanvas(); poly(plotter(o, col(a[0])), ptsOf(a.slice(1), 3, 'poly'), !!o.fill);
}, true, ['fill']);
def('flood', '<x> <y> <color> [diag]', 'Flood-fill the contiguous same-color area at x,y (respects mask=/region=).', (a, o) => {
  needCanvas(); flood(coord(a[0], 'x', 'x'), coord(a[1], 'y', 'y'), col(a[2]), o);
}, true, ['diag']);
def('stroke', '<color> <x,y> <x,y> ... [closed] [brush opts]', 'Brushed polyline through the points using the active brush (supports float/anchor coords).', (a, o) => {
  needCanvas(); paintPath(ptsOf(a.slice(1), 1, 'stroke', true), need(a[0], 'color'), o);
}, true, ['closed', 'alpha', 'tint']);
def('curve', '<color> <x,y> <x,y> <x,y> [x,y ...] [closed] [brush opts]', 'Smooth brushed curve: 3 pts = quadratic bezier, 4 = cubic bezier, 5+ = Catmull-Rom spline through the points.', (a, o) => {
  needCanvas();
  const pts = ptsOf(a.slice(1), 3, 'curve', true);
  paintPath(evalCurve(pts, !!o.closed, false), need(a[0], 'color'), o, !!o.closed);
}, true, ['closed', 'alpha', 'tint']);
def('spline', '<color> <x,y> <x,y> ... [closed] [brush opts]', 'Catmull-Rom spline THROUGH every point (2+ points), optionally closed.', (a, o) => {
  needCanvas();
  const pts = ptsOf(a.slice(1), 2, 'spline', true);
  paintPath(evalCurve(pts, !!o.closed, true), need(a[0], 'color'), o, !!o.closed);
}, true, ['closed', 'alpha', 'tint']);
def('stamp', '<sprite> <x> <y> [center] [scale=N|PCT%|W,H] [shade | shade=n] [mid=N] [rot=0|90|180|270] [flipx] [flipy] [repeat=nx,ny step=sx,sy]',
  'Stamp a sprite at x,y (pass "center" to align sprite center to x,y, scale= to resize nearest-neighbor, or "shade" for relative lighting).', (a, o) => {
  needCanvas();
  const relFlag = a.includes('shade') || o.shade === true;
  const pos = []; let ctr = o.center === true || /^(1|true|yes|on)$/i.test(String(o.center || ''));
  for (const t of a) {
    if (t === 'shade') continue;
    if (t === 'center' && pos.length >= 3) { ctr = true; continue; }
    pos.push(t);
  }
  const sp = S.sprites.get(pos[0]) || fail(`no sprite "${pos[0]}"`);
  const sh = typeof o.shade === 'string' ? int(o.shade, 'shade') : 0;
  stamp(sp, coord(pos[1], 'x', 'x'), coord(pos[2], 'y', 'y'), { ...o, _relShade: relFlag, _shade: sh, _center: ctr });
}, true, ['flipx', 'flipy', 'shade']);
def('scatter', '<sprite[,sprite…]> <n> [seed=N] [min=D] [inside] [rot=any|0|90..] [flip] [shade=n|lo,hi] [mask=…] [region=…]', 'Scatter n seeded copies of the sprite(s). Centre must land inside the scope; min = minimum distance between centres.', (a, o) => {
  needCanvas();
  const sps = need(a[0], 'sprite').split(',').map((nm) => S.sprites.get(nm) || fail(`no sprite "${nm}"`));
  scatter(sps, int(a[1], 'n'), o);
}, true, ['flip', 'inside']);
def('grad', '<ramp|shade> <x0> <y0> <x1> <y1> [from=a to=b] [dither=…] [mode=linear|radial] [radial] [tint [prob=P]]', 'Gradient in RAMP STEPS, dithered. "shade" shifts what is already there; a ramp name paints that ramp (tint keeps the underlying lightness).', (a, o) => {
  needCanvas(); grad(need(a[0], 'ramp|shade'), coordf(a[1], 'x0', 'x'), coordf(a[2], 'y0', 'y'), coordf(a[3], 'x1', 'x'), coordf(a[4], 'y1', 'y'), o);
}, true, ['tint', 'radial']);
def('noise', '<ramp|shade> [type=value|turbulence|ridged|voronoi|cracks|cells] [scale=N|scalex=N scaley=N] [octaves=1..6] [warp=N] [from=a to=b] [contrast=%] [bias=%] [seed=N] [tint [prob=P]]', 'Tileable noise field mapped to ramp steps (like grad, but noisy). Great for stone grain, rust, moss, cloudy dirt.', (a, o) => {
  needCanvas(); noiseField(need(a[0], 'ramp|shade'), o);
}, true, ['tint']);
def('dfill', '<color> <pct> [bayer=2|4|8 | noise=SEED]', 'Pattern fill: paints pct% of the scoped pixels with an ordered grid or seeded grain.', (a, o) => {
  needCanvas(); dfill(col(a[0]), int(a[1], 'pct'), o);
}, true);
def('rough', 'mask=<shape> [amount=1..8] [prob=P] [side=both|in|out] [clump=N] [seed=N]', 'Make the edge of a shape irregular (erode / grow by seeded, clumped noise). Do this BEFORE bevel/height so light follows the broken edge.', (a, o) => { needCanvas(); rough(o); }, true);
def('chip', 'mask=<shape> [prob=P] [size=1..3] [face=n] [seed=N]', 'Knock chunks off convex corners; face=n shades the freshly exposed pixels.', (a, o) => { needCanvas(); chip(o); }, true);
def('smudge', '[radius=N] [strength=%] [dir=x|y|d1|d2|n|s|e|w…] [len=N] [passes=N] [protect=…] [blend=ramp|nearest ramps=a,b] [mask=…] [seed=N]', 'Blur inside the palette: mixes ramp steps of same-ramp neighbours, so stone never bleeds into moss. dir= gives a directional drag.', (a, o) => { needCanvas(); smudge(o); }, true);
def('cavity', '[mask=<shape>] [against=<colors>] [radius=1..6] [lo=N] [min=%] [dither=…] [seed=N]', 'Ambient occlusion / contact shadow: darkens pixels crowded by what is outside the shape (or by "against" colors).', (a, o) => { needCanvas(); cavity(o); }, true);
def('bevel', '[mask=<shape>] [region=x,y,w,h] [light=n|ne|e|se|s|sw|w|nw] [depth=N] [hi=N] [lo=N] [soft]', 'Edge lighting: edges facing the light get +hi ramp steps, edges facing away -lo. soft fades one step per pixel inward.', (a, o) => { needCanvas(); bevel(o); }, true, ['soft']);
def('height', 'inflate|bevel|add|set|scale|grad|noise|blur|from|compose|rect|ellipse|poly|stroke|curve|spline|crack|ribs|clear ...',
  'Sculpt the parallel height channel (supports mode=add|max|set|smin, branched cracks, and periodic ribs along curves).', (a, o) => {
  needCanvas(); heightCmd(a, o);
}, false, ['bleed', 'fill', 'soft', 'ridge', 'closed', 'radial']);
def('masonry', '<ramp> [style=running|grid|ashlar] [w=32 h=16 | cols=N rows=N] [mortar=2] [mortar_color=<c>] [bevel=3] [height=5] [vary=2] [tilt=1] [rough=1.8] [chip=35] [rivets] [seed=N]',
  'Generate seamless beveled stone blocks or plates (writes organic edges, color, and height per block).', (a, o) => {
  needCanvas(); masonryCmd(need(a[0], 'ramp'), o, false);
}, true, ['rivets']);
def('plates', '<ramp> [w=32 h=32 | cols=N rows=N] [mortar=1] [bevel=2] [height=4] [vary=1] [tilt=1] [rivets] [seed=N]',
  'Generate seamless riveted metal plates (shortcut for "masonry style=grid mortar=1 rivets").', (a, o) => {
  needCanvas(); masonryCmd(need(a[0], 'ramp'), o, true);
}, true, ['rivets']);
def('glow', '[mask=<emitters>] [radius=6] [ramp=<name>] [strength=75] [mode=mix|rgb|tint|shade] [dither=bayer4] [normal] [ramps=a,b]',
  'Cast local colored light around fullbright (or masked) pixels using EDT distance and optional surface normals.', (a, o) => {
  needCanvas(); glowCmd(o);
}, true, ['normal']);
def('emit', '[mask=<emitters>] [radius=6] [ramp=<name>] [strength=75] [mode=mix|rgb|tint|shade] [dither=bayer4] [normal] [ramps=a,b]',
  'Alias for "glow".', (a, o) => {
  needCanvas(); glowCmd(o);
}, true, ['normal']);
def('albedo', '[save|restore|clear]', 'Snapshot unlit base colors into S.albedo (or restore them) for non-destructive relighting.', (a) => {
  needCanvas();
  const sub = a[0] || 'save';
  if (sub === 'save') { S.albedo = S.px.slice(); out('albedo saved'); }
  else if (sub === 'clear') { S.albedo = null; out('albedo cleared'); }
  else if (sub === 'restore') {
    if (!S.albedo) fail('albedo restore: nothing saved (run "albedo save" or "light begin")');
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) put(x, y, S.albedo[y * S.w + x]);
  } else fail('albedo must be save | restore | clear');
});
def('light', '[begin [reset] | end | height] [dir=nw] [elev=40] [range=-4..+3] [shadow_ramp=<r[:pct%]>] [hi_ramp=<r[:pct%]>] [rim=<dir>] [rim_ramp=<r[:pct%]>] [rim_strength=2] [spec=N] [ao=N] [shadow=N] ...',
  'Shade using normals + optional hue-shifting + rim light. Wrap multiple lights in "light begin" ... "light end" for float accumulation over albedo.', (a, o) => {
  needCanvas();
  if (a[0] === 'begin') {
    if (!S.albedo || o.reset || a.includes('reset')) S.albedo = S.px.slice();
    S.lightAccum = {
      active: true, albedo: S.albedo.slice(), sumStep: new Float32Array(S.w * S.h),
      tintR: new Float32Array(S.w * S.h), tintG: new Float32Array(S.w * S.h), tintB: new Float32Array(S.w * S.h), tintW: new Float32Array(S.w * S.h),
      touched: new Uint8Array(S.w * S.h), allowedRamps: new Set(), dither: o.dither || 'bayer4', cmds: [],
    };
    return;
  }
  if (a[0] === 'end') { finishLightAccum(o.dither); return; }
  lightHeight(o);
}, true, ['reset']);
def('relight', '[dither=bayer4]', 'Replay the saved light stack non-destructively over S.albedo and current S.hmap.', (a, o) => {
  needCanvas();
  if (!S.albedo || !S.lastLights.length) fail('relight needs "albedo save" (or "light begin") and at least one prior "light" command');
  S.lightAccum = {
    active: true, albedo: S.albedo.slice(), sumStep: new Float32Array(S.w * S.h),
    tintR: new Float32Array(S.w * S.h), tintG: new Float32Array(S.w * S.h), tintB: new Float32Array(S.w * S.h), tintW: new Float32Array(S.w * S.h),
    touched: new Uint8Array(S.w * S.h), allowedRamps: new Set(), dither: o.dither || 'bayer4', cmds: [],
  };
  for (const item of S.lastLights) lightHeight(item.o, true);
  finishLightAccum(o.dither);
}, true);
def('hatch', '[color] [in=all|shadow|mid|light] [mask=…] [region=…] [follow=none|contour|slope] [angle=-30] [spacing=3] [shade=-1] [jitter=1] [cross] [seed=N]',
  'Draw directional or contour-following hatch strokes (optionally limited to shadow/mid/light tones).', (a, o) => {
  needCanvas(); hatch(a[0], o);
}, true, ['cross']);
def('drip', '[color|ramp|shade] [from=cavity|mask|all] [dir=s|n|e|w] [len=6..16] [width=1..3] [density=45] [shade=-3] [tint] [dither=…] [protect=…] [seed=N]',
  'Cast gravity-driven weathering drips from crevices, mortar, rivets, or masked shapes.', (a, o) => {
  needCanvas(); dripCmd(a[0], o);
}, true, ['tint']);
def('wash', '[color|ramp|shade] [radius=3] [strength=65] [dither=…] [mask=…] [shape=…] [region=…]',
  'Pool grime, verdigris, or shadow wash inside concave height crevices and corners.', (a, o) => {
  needCanvas(); washCmd(a[0], o);
}, true);
def('drybrush', '[color|ramp|+n] [thresh=0.45] [strength=75] [breakup=45] [light=dir] [hi=+2] [dither=…] [seed=N]',
  'Highlight convex ridges and chipped edges on the height map with noise breakup.', (a, o) => {
  needCanvas(); drybrushCmd(a[0], o, false);
}, true);
def('edgewear', '[color|ramp|+n] [thresh=0.35] [strength=75] [breakup=55] [light=nw] [hi=+2] [dither=…] [seed=N]',
  'Alias for directional convex edge wear ("drybrush light=nw breakup=55").', (a, o) => {
  needCanvas(); drybrushCmd(a[0], o, true);
}, true);
def('outline', '<color> mask=<shape> [side=outer|inner] [diag]', 'Draw an outline just outside (or just inside) a shape.', (a, o) => { needCanvas(); outline(col(a[0]), o); }, true, ['diag']);
def('pixelate', '<n> [mask=…] [region=…]', 'Each n×n block becomes its most frequent palette index.', (a, o) => { needCanvas(); pixelate(int(a[0], 'n'), o); }, true);
def('resize', '<w> <h>', 'Nearest-neighbour resize of the whole canvas (and height/layers).', (a) => { needCanvas(); resize(int(a[0], 'w'), int(a[1], 'h')); });
def('shift', '<dx> <dy>', 'Scroll the canvas with wrap (move seams to the middle to inspect or paint over them).', (a) => { needCanvas(); shift(int(a[0], 'dx'), int(a[1], 'dy')); });
def('flip', 'x | y', 'Mirror the canvas.', (a) => { needCanvas(); flip(a[0]); });
def('import', '<file.png> <x> <y> [w=N h=N] [dither=fs|bayerN|noise] [spread=N] [ramps=a,b]', 'Quantize an RGB PNG into the palette (optionally only into some ramps) and paint it at x,y.', (a, o) => {
  needCanvas(); importImg(need(a[0], 'file'), coord(a[1], 'x', 'x'), coord(a[2], 'y', 'y'), o);
}, true);
def('shape', '[name] new|clear|select|list|drop|copy|add|sub|and|xor|invert|mirror|grow|erode|rough|show|fill|outline ...',
  '2D CSG boolean mask builder (add/sub/and/xor ellipse|rect|poly|stroke|curve|spline|mask|shape), ASCII silhouette preview ("shape show"), fill/outline, or use shape=<name> in any command.', (a, o) => {
  needCanvas(); shapeCmd(a, o);
}, false, ['all', 'closed', 'diag']);
def('dump', '[view=char|idx|step|height] [region=x,y,w,h|anchor:name]', 'Print the whole canvas (or region=) as text (char = key letters + legend; height = relief map).', (a, o) => {
  needCanvas();
  const [rx, ry, rw, rh] = o.region ? regionOf(o) : [0, 0, Math.min(S.w, 512), Math.min(S.h, 512)];
  show(rx, ry, Math.min(rw, 512), Math.min(rh, 512), o.view || 'char');
});
def('zoom', '<x> <y> <w> <h> [view=char|idx|step|height]', 'Print a wrapped window of the canvas as text (x/y may be negative: look across the seam).', (a, o) => {
  needCanvas(); show(coord(a[0], 'x', 'x'), coord(a[1], 'y', 'y'), coord(a[2], 'w', 'x'), coord(a[3], 'h', 'y'), o.view || 'char');
});
def('lint', '[mask=…] [region=…] [jump=3]', 'Check for isolated noise pixels, large regular 2x2 dither patches, intra-ramp jumps > jump, stray ramp specks, and tile seams.', (a, o) => lintCanvas(o));
def('trace', 'on <dir> [scale=4] [pad=4] [all] | off', 'Save an upscaled PNG crop after each drawing command that changes pixels.', (a, o) => {
  const sub = need(a[0], 'on|off');
  if (sub === 'off') { S.trace.active = false; return out('trace off'); }
  if (sub !== 'on') fail('trace on <dir> | trace off');
  S.trace.dir = need(a[1], 'dir'); S.trace.scale = clamp(num(o.scale, S.trace.scale, 'scale'), 1, 32);
  S.trace.pad = clamp(num(o.pad, S.trace.pad, 'pad'), 0, 64); S.trace.all = !!o.all; S.trace.active = true;
  out(`trace on -> ${S.trace.dir} (scale=${S.trace.scale}x pad=${S.trace.pad})`);
}, false, ['all']);
def('seam', '', 'Measure the colour jump across the wrap edges vs. inside the tile.', () => seam());
def('info', '', 'Canvas size, wrap mode, palette size, active brush, sym, layers.', () => {
  needPal();
  out(`canvas ${S.w || 'none'}x${S.h || ''} wrap=${S.wrap ? 'on' : 'off'} sym=${S.sym.mode} layers=${S.layers.length || 1} palette=${S.pal.length} colors, ${S.ramps.size} ramps, ${S.keys.size} keys, ${S.sprites.size} sprites`);
  showBrush();
});
def('save', '<file.png> [scale=N] [tile=N]', 'Write an indexed 8-bit PNG (palette embedded). tile=N repeats the canvas N×N to preview tiling; scale=N upsizes with nearest-neighbour.', (a, o) => {
  needCanvas();
  const f = need(a[0], 'file'), sc = num(o.scale, 1, 'scale'), ti = num(o.tile, 1, 'tile');
  if (sc < 1 || sc > 32 || ti < 1 || ti > 16) fail('save: scale 1..32, tile 1..16');
  const W = S.w * ti * sc, H = S.h * ti * sc;
  if (W > 8192 || H > 8192) fail(`save: output ${W}x${H} too large (max 8192)`);
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const sy = Math.floor(y / sc) % S.h; for (let x = 0; x < W; x++) px[y * W + x] = S.px[sy * S.w + (Math.floor(x / sc) % S.w)]; }
  fs.writeFileSync(f, encodePNG(W, H, px, S.pal));
  out(`saved ${f}: ${W}x${H}px (canvas ${S.w}x${S.h}${ti > 1 ? `, tiled ${ti}x${ti}` : ''}${sc > 1 ? `, scale ${sc}x` : ''}, ${S.pal.length}-color palette)`);
});

// ─────────────────────────────────────────────────────────────── option parser, script runner, CLI
const KNOWN = new Set('against all alpha amount angle angle_jitter ao ao_radius aspect axis bayer bevel bias bleed blend branch breakup bristles brush center chip clump cols color contrast count cross density depth dir dither elev face fill flow flow_jitter follow from gloss h height hi hi_mix hi_ramp hmode in jitter jump k len light light_mix light_ramp lip lo mask mid min mode mortar mortar_color n noise normal octaves opacity outline pad passes prob profile protect radial radius ramp ramps range region repeat reset ridge rim rim_elev rim_mix rim_ramp rim_strength rivets rot rough round rows scale scalex scaley scatter seed shade shade_jitter shadow shadow_mix shadow_ramp shape sharp side size size_jitter skip smooth soft spacing spec spread step strength style sym taper tex_scale thresh tile tilt tint to type vary view w warp width wobble'.split(' '));
const parseRegion = (v) => {
  const s = String(v);
  if (s.startsWith('anchor:')) {
    const parts = s.slice(7).split(',');
    if (parts.length < 1 || parts.length > 3) fail(`region=anchor:<name>[,w[,h]] — got "${v}"`);
    const nm = parts[0];
    let base = S.anchors.get(nm);
    if (!base && S.w > 0 && (nm === 'cx' || nm === 'cy')) base = [Math.floor(S.w / 2), Math.floor(S.h / 2), null, null];
    if (!base) fail(`unknown anchor "${nm}" in region="${v}"`);
    const rw = parts[1] !== undefined ? coord(parts[1], 'region.w', 'x') : base[2];
    const rh = parts[2] !== undefined ? coord(parts[2], 'region.h', 'y') : parts[1] !== undefined ? rw : base[3];
    if (rw == null || rh == null) fail(`region=anchor:${nm} needs a size: use "anchor ${nm} <x> <y> <w> <h>" or "region=anchor:${nm},w,h"`);
    if (rw < 1 || rh < 1) fail('region w and h must be >= 1');
    return [base[0] - Math.floor(rw / 2), base[1] - Math.floor(rh / 2), rw, rh];
  }
  const p = s.split(',');
  if (p.length !== 4) fail(`region must be x,y,w,h or anchor:<name>[,w,h] — got "${v}"`);
  const r = [coord(p[0], 'region.x', 'x'), coord(p[1], 'region.y', 'y'), coord(p[2], 'region.w', 'x'), coord(p[3], 'region.h', 'y')];
  if (r[2] < 1 || r[3] < 1) fail('region w and h must be >= 1');
  return r;
};
function parseArgs(toks, flags, warn, rawMode = false) {
  const a = [], o = {};
  for (const t of toks) {
    const m = /^([^=]+)=(.*)$/s.exec(t);
    if (m) {
      const [, k, v] = m;
      if (flags.has(k) && /^(0|1|off|on|false|true|no|yes)$/i.test(v)) o[k] = !/^(0|off|false|no)$/i.test(v);
      else if (rawMode) o[k] = v;
      else {
        if (!KNOWN.has(k)) warn(`unknown option "${k}=" (ignored)`);
        o[k] = k === 'region' ? parseRegion(v) : (k === 'mask' || k === 'protect' || k === 'against') ? maskSet(v) : v;
      }
    } else if (flags.has(t)) o[t] = true;
    else a.push(t);
  }
  return { a, o };
}
const tokenize = (s) => (s.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"(.*)"$/, '$1'));
function stripInlineComment(s) {
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') { inQ = !inQ; continue; }
    if (!inQ && s[i] === '#' && i > 0 && /\s/.test(s[i - 1]) && !/^#([0-9a-f]{3}|[0-9a-f]{6})(\s|$)|^#=/i.test(s.slice(i))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}
function overview() {
  out(`paltex — palette-first pixel-art texture tool (Quake 1 / Doom era). Run:  node paltex.mjs script.ptx   |   node paltex.mjs - <<'EOF' … EOF
Every pixel is a palette index; no command can create a colour outside the palette.
COLORS   index | ramp:step (stone:7, -1 = lightest) | @key | #hex (snaps to nearest) | +n / -n (shade what is already there, in ramp steps)
SCOPE    any drawing command accepts  mask=stone,rust:3,@a  (only pixels currently of those colours; ramp name = all its shades; ! inverts),
         shape=<name>  (!inverts CSG mask),  and  region=x,y,w,h | anchor:<name>[,w,h]  (wraps across edges). Tested against a pre-command snapshot.
FLOW     new → anchors + shape CSG (add/sub + "shape show" ASCII silhouette) → fill/outline → rough/chip → height → light + cavity → brush/hatch → lint/diff/seam → save
SCRIPT   one command per line, "#" starts a comment, "sprite <name>" … "end" and "with brush" … "end".
`);
}
function helpCmd(name) {
  if (name) { const c = C[name]; if (!c) fail(`no command "${name}"`); return out(`${name} ${c.usage}\n  ${c.help}`); }
  overview();
  out('COMMANDS');
  for (const [n, c] of Object.entries(C)) out(`  ${n} ${c.usage}\n      ${c.help}`);
}
def('help', '[command]', 'Overview, or the usage of one command.', (a) => helpCmd(a[0]));

function runScript(text, label = 'script') {
  const lines = text.split(/\r?\n/);
  let nCmd = 0, nWarn = 0;
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n], trimmed = raw.trim();
    if (!trimmed || trimmed[0] === '#') continue;
    const toks0 = tokenize(trimmed), name = toks0[0];
    const warn = (m) => { nWarn++; out(`warning ${label}:${n + 1}: ${m}`); };
    try {
      const cmd = C[name] || fail(`unknown command "${name}" — run "help" for the list`);
      if (name === 'with') {
        const clean = stripInlineComment(trimmed), toks = tokenize(clean);
        if (toks[1] !== 'brush') fail('only "with brush [opts]" is supported');
        S.brushStack.push({ brush: { ...S.brush, taper: [...S.brush.taper], shade: [...S.brush.shade] }, brushOn: S.brushOn });
        const { a, o } = parseArgs(toks.slice(2), C.brush.flags, warn);
        if (a.length || Object.keys(o).length) {
          needPal();
          applyBrushOpts(S.brush, a[0] || null, a[1] || null, o);
          S.brushOn = true;
        }
        nCmd++; continue;
      }
      if (name === 'end') {
        if (!S.brushStack.length) fail('"end" without matching "sprite" or "with brush"');
        const prev = S.brushStack.pop();
        S.brush = prev.brush; S.brushOn = prev.brushOn;
        nCmd++; continue;
      }
      if (name === 'sprite') {
        const clean = stripInlineComment(trimmed), toks = tokenize(clean);
        if (toks[1] === 'show') {
          const { a, o } = parseArgs(toks.slice(2), new Set(), warn);
          showSprite(need(a[0], 'sprite'), o.view || 'char');
          nCmd++; continue;
        }
        const sname = need(toks[1], 'sprite name');
        if (toks[2] === 'show') {
          const { o } = parseArgs(toks.slice(3), new Set(), warn);
          showSprite(sname, o.view || 'char');
          nCmd++; continue;
        }
        if (toks[2] === 'row') {
          editSpriteRow(sname, int(toks[3], 'row'), need(toks[4], 'row string'));
          nCmd++; continue;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sname)) fail(`bad sprite name "${sname}"`);
        needPal();
        const { o } = parseArgs(toks.slice(2), new Set(['shade']), warn, true);
        const meta = { ramp: o.ramp || null, shade: !!o.shade, mid: o.mid !== undefined ? int(o.mid, 'mid') : undefined, overrides: new Map() };
        if (o.outline !== undefined) meta.outline = col(o.outline, false);
        for (const [k, v] of Object.entries(o)) {
          if ([...k].length === 1 && k !== '.') meta.overrides.set(k, col(v, false));
          else if (!['ramp', 'outline', 'shade', 'mid'].includes(k)) warn(`unknown sprite option "${k}=" (ignored)`);
        }
        const rows = [];
        let k = n + 1;
        for (; k < lines.length && lines[k].trim() !== 'end'; k++) { const r = lines[k].replace(/\s+$/, ''); if (r) rows.push(r); }
        if (k >= lines.length) fail(`sprite "${sname}" has no closing "end"`);
        S.sprites.set(sname, parseSprite(rows, meta.ramp || meta.shade || meta.outline !== undefined || meta.overrides.size ? meta : null));
        n = k; nCmd++;
        continue;
      }
      // inline comments: " # …" (never for "key", where "#" is a legal key char)
      const toks = name === 'key' ? toks0 : tokenize(stripInlineComment(trimmed));
      const { a, o } = parseArgs(toks.slice(1), cmd.flags, warn);
      o._warn = warn;
      const isShapeDraw = name === 'shape' && toks.slice(1).some((t) => t === 'fill' || t === 'paint' || t === 'outline');
      const shapeMut = name === 'shape' && a.length > 0 && a[0] !== 'list' && a[0] !== 'show' && a[1] !== 'show';
      const deferLight = name === 'light' && (a[0] === 'begin' || (a[0] !== 'end' && S.lightAccum?.active));
      const isDraw = (cmd.draw && !deferLight) || isShapeDraw || name === 'relight' || (name === 'albedo' && a[0] === 'restore');
      const mutates = isDraw || shapeMut || ['height', 'resize', 'shift', 'flip', 'albedo'].includes(name) || (name === 'layer' && a[0] && a[0] !== 'list');
      const skipUndo = name === 'undo' || name === 'restore';
      if (mutates && !skipUndo && S.w) pushUndo(toks.join(' ').slice(0, 50));
      const beforePx = (isDraw || (name === 'layer' && a[0] && a[0] !== 'list')) && S.w ? S.px.slice() : null;
      const before = S.changed, hBefore = S.hchanged;
      S.cmdSeq++;
      const prevSym = (name !== 'sym' && o.sym !== undefined) ? { ...S.sym } : null;
      if (prevSym) {
        if (!['off', 'x', 'y', 'xy'].includes(o.sym)) fail('sym= must be off | x | y | xy');
        S.sym.mode = o.sym;
        if (o.axis !== undefined && name !== 'shape') {
          const [ax, ay] = parseAxisOpt(o.axis, S.sym.ax, S.sym.ay);
          S.sym.ax = ax; S.sym.ay = ay;
        }
      }
      try { cmd.fn(a, o); } finally { if (prevSym) S.sym = prevSym; }
      nCmd++;
      if (beforePx) {
        S.lastDiff = { px: beforePx, cmd: toks.join(' ').slice(0, 60) };
        saveTrace(beforePx, name);
      }
      if (isDraw && S.changed === before) warn(`"${toks.join(' ').slice(0, 70)}" changed 0 pixels (mask/region matched nothing, or colours already equal)`);
      if (name === 'height' && a[0] !== 'clear' && S.hchanged === hBefore) warn(`"${toks.join(' ').slice(0, 70)}" changed 0 height samples`);
    } catch (e) {
      out(`error ${label}:${n + 1}: ${trimmed.slice(0, 120)}\n  ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (S.brushStack.length) {
    out(`error ${label}: unclosed "with brush" block (missing "end")`);
    process.exitCode = 1;
    return;
  }
  out(`ok: ${nCmd} commands, ${nWarn} warning(s)${S.w ? `, canvas ${S.w}x${S.h}` : ''}`);
}
(function main() {
  const args = process.argv.slice(2), pos = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--trace') { S.trace.active = true; S.trace.dir = args[++i] || fail('--trace requires <dir>'); }
    else if (t === '--trace-scale') S.trace.scale = clamp(int(args[++i], 'trace-scale'), 1, 32);
    else if (t === '--trace-pad') S.trace.pad = clamp(int(args[++i], 'trace-pad'), 0, 64);
    else if (t === '--trace-all') S.trace.all = true;
    else pos.push(t);
  }
  const [arg, ...rest] = pos;
  try {
    if (!arg || arg === 'help' || arg === '-h' || arg === '--help') return helpCmd(rest[0]);
    if (arg === '-') return runScript(fs.readFileSync(0, 'utf8'), 'stdin');
    runScript(fs.readFileSync(arg, 'utf8'), arg);
  } catch (e) { out(`error: ${e.message}`); process.exitCode = 1; }
})();
