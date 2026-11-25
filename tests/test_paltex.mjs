import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PALTEX = path.resolve(__dirname, '../paltex.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'paltex-test-'));
const TRACE_DIR = path.join(SCRATCH, 'trace_out');

function runPTX(script, extraArgs = []) {
  return execFileSync('node', [PALTEX, ...extraArgs, '-'], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function readPNGInfo(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, 'valid PNG header');
  let p = 8, w = 0, h = 0, plte = null, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); }
    else if (type === 'PLTE') { plte = []; for (let i = 0; i < len; i += 3) plte.push([d[i], d[i + 1], d[i + 2]]); }
    else if (type === 'IDAT') idat.push(d);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (w + 1)], 0, 'filter 0');
    for (let x = 0; x < w; x++) px[y * w + x] = raw[y * (w + 1) + 1 + x];
  }
  return { w, h, plte, px };
}

console.log('1. Testing help & syntax...');
const helpOut = execFileSync('node', [PALTEX, 'help'], { encoding: 'utf8' });
for (const cmd of ['grab', 'sym', 'layer', 'checkpoint', 'restore', 'undo', 'diff', 'height', 'light', 'hatch', 'lint', 'trace', 'with']) {
  assert.match(helpOut, new RegExp(`\\b${cmd}\\b`), `help mentions ${cmd}`);
}

console.log('2. Testing ramp-step sprites, row editing, sprite show, inline # comments, grab, and stamp shade...');
{
  const outPng = path.join(SCRATCH, 't_sprites.png');
  const stdout = runPTX(`
new 32 32 stone:4
sprite skull ramp=bone outline=stone:0 *=blood:12
..####..
.#9ba9#.
.#*88*#.
..5445..
end
sprite skull row 2 ".#a*8a#." # inline comment test
sprite show skull view=step
stamp skull 4 4
grab copy 4 4 8 4 mask=bone,stone:0,blood:12
stamp copy 20 4
# test stamp shade as relative lighting layer on uniform stone:6
rect 0 16 32 16 stone:6 fill
sprite lightblob shade
.48c.
48fc8
end
stamp lightblob 8 20 shade
zoom 8 20 5 2 view=step
save "${outPng}"
`);
  assert.match(stdout, /sprite "skull" 8x4 \(ramp=bone\)/);
  assert.match(stdout, /grabbed 8x4/);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const im = readPNGInfo(outPng);
  // Check row 2 edit: col 2 in skull at x=4 => x=6, y=6 should be bone:10 ('a')
  const bone10 = 12 * 16 + 10; // bone is 13th builtin ramp (index 12)
  assert.equal(im.px[6 * 32 + 6], bone10, 'row edit applied bone:a');
  // Check copy grabbed and stamped at x=20
  assert.equal(im.px[6 * 32 + 22], bone10, 'grabbed sprite matches');
  // Check stamp shade at (8,20): '4' -> 4-8 = -4 -> stone:6-4 = stone:2
  const stoneIdx = 2 * 16;
  assert.equal(im.px[20 * 32 + 9], stoneIdx + 2, 'stamp shade darkens (-4)');
  assert.equal(im.px[21 * 32 + 10], stoneIdx + 13, 'stamp shade brightens (+7 -> clamped to 13 or 15)');
  assert.equal(im.px[20 * 32 + 10], stoneIdx + 6, 'stamp shade step 8 is neutral (0)');
}

console.log('3. Testing sym, with brush, bristle, undo, checkpoint, restore, diff...');
{
  const outPng = path.join(SCRATCH, 't_sym_undo.png');
  const stdout = runPTX(`
    new 64 64 stone:2
    sym x axis=31.5
    pixel 10 10 bone:12
    # Test relative shading across center without double-applying
    line 28 20 35 20 +3
    diff
    with brush bristle n=5 size=7 skip=20 shade=-1,+1 seed=7
      stroke bone:8 8,30 24,45
    end
    # Ensure brush reset back to default 1px line after "end"
    info
    checkpoint mid
    rect 0 0 64 64 blood:8 fill
    undo
    restore mid
    line 0 60 10 60 bone:15
    save "${outPng}"
  `);
  assert.match(stdout, /brush circle .* \[default\]/);
  assert.match(stdout, /undo: restored state/);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const im = readPNGInfo(outPng);
  // Sym x=10 -> 63-10 = 53
  const bone12 = 12 * 16 + 12;
  assert.equal(im.px[10 * 64 + 10], bone12);
  assert.equal(im.px[10 * 64 + 53], bone12, 'sym mirrored pixel');
  // Crossing center at y=20, x=31 and 32 should be stone:5 (+3 once, not +6!)
  const stone5 = 2 * 16 + 5;
  assert.equal(im.px[20 * 64 + 31], stone5, 'relative line across sym axis does not double-shade');
  assert.equal(im.px[20 * 64 + 32], stone5, 'relative line across sym axis does not double-shade (right)');
  // Line at y=60 after "with brush ... end" should be 1px thin (y=59 untouched!)
  assert.equal(im.px[60 * 64 + 5], 12 * 16 + 15, '1px line after with-end');
  assert.equal(im.px[59 * 64 + 5], 2 * 16 + 2, '1px line did not leak thick brush');
}

console.log('4. Testing palette quake, fullbright, and layers (paint + shade)...');
{
  const outPng = path.join(SCRATCH, 't_layers_fb.png');
  const stdout = runPTX(`
    palette quake
    new 32 32 grey:8
    # Put fullbright lava eyes at (10,10) and (20,10)
    pixel 10 10 230
    pixel 20 10 245
    # Create shade layer and darken the whole canvas; fullbright must survive untouched!
    layer new shadows shade
    rect 0 0 32 32 -4 fill
    layer merge mode=shade
    # Create paint layer with grey:12 (+4 from mid=8) and merge with mode=shade
    layer new hilight
    rect 4 4 8 8 grey:12
    layer merge mode=shade
    # Global grad shade should also preserve fullbright
    grad shade 0 0 31 31 from=-2 to=2 dither=none
    save "${outPng}"
  `);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const im = readPNGInfo(outPng);
  assert.equal(im.px[10 * 32 + 10], 230, 'fullbright 230 protected from shade layer and grad');
  assert.equal(im.px[10 * 32 + 20], 245, 'fullbright 245 protected from shade layer and grad');
  // Pixel (4,4) was grey:8 -> -4 (grey:4) -> +4 from grey:12 (grey:8) -> grad at 4,4 (~-1) -> darker than grey:8, != grey:8
  assert.notEqual(im.px[0], 8, 'non-fullbright pixels were shaded');
}

console.log('5. Testing height (inflate, add, noise, blur, from=luma), light, hatch, lint, and --trace...');
{
  const outPng = path.join(SCRATCH, 't_height_light.png');
  const stdout = runPTX(`
    new 64 64 stone:5
    ellipse 32 32 20 20 bone:8 fill
    ellipse 24 28 4 4 stone:2 fill
    ellipse 40 28 4 4 stone:2 fill
    height inflate mask=bone amount=8 profile=round
    height add -4 mask=stone:2 region=16,20,32,16
    height noise type=value scale=8 amount=1 mode=add mask=bone seed=3
    height blur radius=1 mask=bone
    dump view=height region=20,20,24,24
    light height dir=nw elev=40 range=-4..+3 dither=bayer4 spec=2 ao=2 mask=bone
    hatch mask=bone follow=contour angle=-25 spacing=4 shade=-1 jitter=1
    lint
    save "${outPng}" scale=2
  `, ['--trace', TRACE_DIR, '--trace-scale', '4']);
  assert.match(stdout, /height range:/);
  assert.match(stdout, /lint report:/);
  assert.match(stdout, /trace:/);
  const traceFiles = fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith('.png'));
  assert.ok(traceFiles.length >= 4, `expected >= 4 trace PNGs, got ${traceFiles.length}`);
  const im = readPNGInfo(outPng);
  assert.equal(im.w, 128);
  // Check directional NW lighting on skull: average step in NW quadrant vs SE quadrant
  let nwSum = 0, nwCnt = 0, seSum = 0, seCnt = 0;
  for (let y = 14; y < 30; y++) for (let x = 14; x < 30; x++) {
    const c = im.px[(y * 2) * 128 + (x * 2)];
    if (c >= 12 * 16 && c < 13 * 16) { nwSum += c % 16; nwCnt++; }
  }
  for (let y = 34; y < 50; y++) for (let x = 34; x < 50; x++) {
    const c = im.px[(y * 2) * 128 + (x * 2)];
    if (c >= 12 * 16 && c < 13 * 16) { seSum += c % 16; seCnt++; }
  }
  const nwAvg = nwSum / nwCnt, seAvg = seSum / seCnt;
  assert.ok(nwAvg > seAvg + 1.0, `NW avg (${nwAvg.toFixed(2)}) should be noticeably brighter than SE avg (${seAvg.toFixed(2)}) under dir=nw`);
}

console.log('6. Testing lint detection on intentional defects + brush/dither warnings...');
{
  const stdout = runPTX(`
    new 64 64 stone:8
    # Large bayer=2 fill triggers warning and lint [dither]
    dfill stone:6 50 bayer=2
    # Isolated stray speck of blood inside stone
    pixel 30 30 blood:14
    # Sharp intra-ramp jump > 3
    rect 5 5 6 6 stone:15 fill
    # Oversize brush warning inside small region
    stroke stone:4 10,10 14,10 size=12 region=8,8,8,8
    lint
  `);
  assert.match(stdout, /warning .* dfill bayer=2/);
  assert.match(stdout, /warning .* brush size=12 exceeds region/);
  assert.match(stdout, /\[dither\]/);
  assert.match(stdout, /\[banding\]/);
  assert.match(stdout, /\[ramp\]/);
}

console.log('7. Generating showcase Quake-era carved skull wall tile (visual inspection)...');
{
  const outPng = path.join(SCRATCH, 'showcase_skull_wall.png');
  const stdout = runPTX(`
    palette quake
    new 128 128 slate:4

    # Recessed stone mortar grid + beveled blocks
    rect 0 0 128 128 slate:2
    line 0 64 127 64 slate:2
    line 64 0 64 63 slate:2
    line 32 64 32 127 slate:2
    line 96 64 96 127 slate:2
    rough mask=slate:2 amount=2 prob=65 clump=3 seed=11
    noise slate type=ridged scale=24 octaves=3 from=3 to=7 mask=!slate:2 seed=5
    height from=step amount=3 mask=!slate:2
    height set -2 mask=slate:2
    height blur radius=1 passes=2

    # Central carved bone skull medallion using sym x!
    sym x axis=63.5
    ellipse 64 58 28 30 flesh:6 fill
    rect 48 78 32 18 flesh:6 fill
    sym off
    rough mask=flesh amount=2 prob=55 clump=3 side=both seed=21
    outline slate:1 mask=flesh side=outer

    # Carve brow, eye sockets, nasal cavity, teeth using sym x
    sym x axis=63.5
    ellipse 51 54 7 6 slate:1 fill
    poly slate:1 63,62 58,72 63,72 fill
    line 52 80 52 94 slate:1
    line 58 80 58 94 slate:1
    sym off

    # 3D cushion volume + carved depth + lighting + contour hatching
    height inflate mask=flesh amount=10 profile=round mode=set
    height add -5 mask=slate:1 region=32,30,64,66
    height noise type=value scale=10 amount=1.5 mode=add mask=flesh seed=9
    height blur radius=1 mask=flesh

    light height dir=nw elev=38 range=-4..+4 dither=bayer4 spec=2 ao=3 ao_radius=4 shadow=8 mask=flesh,slate:4,slate:5,slate:6,slate:7,slate:3
    hatch mask=flesh follow=contour angle=-25 spacing=4 shade=-1 jitter=1

    # Bristle brush weathered grime streaks & moss
    with brush bristle n=5 size=7 skip=25 shade=-1,+1 seed=42
      stroke moss:5 12,4 22,28 mask=!flesh
      stroke moss:5 104,64 114,96 mask=!flesh
    end

    # Glowing fullbright Quake eyes & runic embers (224..254)
    sym x axis=63.5
    ellipse 51 54 3 2 227 fill
    pixel 51 54 231
    sym off

    # Re-run global shade pass over canvas: fullbright eyes stay glowing!
    grad shade 0 0 0 127 from=1 to=-1 dither=bayer4

    lint
    save "${outPng}" scale=3
  `);
  console.log(stdout);
  assert.match(stdout, /ok: 41 commands, 0 warning\(s\)/, 'showcase script runs with 0 warnings');
  const im = readPNGInfo(outPng);
  assert.equal(im.w, 384);
  // Verify fullbright center of eyes remained untouched (231)!
  assert.equal(im.px[(54 * 3) * 384 + (51 * 3)], 231, 'left eye core stayed fullbright 231');
  assert.equal(im.px[(54 * 3) * 384 + (76 * 3)], 231, 'right mirrored eye core stayed fullbright 231');
}

console.log('8. Testing edge cases: wrap off, nested with brush, sym xy + jitter, trace on/off, layer select/vis/drop, #hex fullbright exclusion...');
{
  const trace2 = path.join(SCRATCH, 'trace_script');
  fs.rmSync(trace2, { recursive: true, force: true });
  const outPng = path.join(SCRATCH, 't_edge.png');
  const stdout = runPTX(`
    palette quake
    new 32 32 grey:6
    wrap off
    # #ff6f07 is an exact match for fb_fire (fullbright 235), nearest() must pick a non-fullbright ramp color instead!
    pixel 2 2 #ff6f07
    # Test nested with brush
    with brush circle size=6
      with brush square size=2
        line 4 4 10 4 grey:12
      end
      # outer brush size=6 should now be restored
      info
    end
    # inner and outer ended -> back to default
    info
    # Test sym xy + jitter and trace on/off
    trace on "${trace2}" scale=2 pad=2
    sym xy axis=15.5 jitter=1 seed=3
    pixel 5 5 grey:15
    sym off
    trace off
    # Test wrap=off height inflate + light + hatch + diff + lint
    ellipse 16 16 8 8 brown:8 fill
    height inflate mask=brown amount=5 profile=dome
    light height dir=nw elev=45 range=-3..+3 mask=brown
    hatch mask=brown follow=contour spacing=3 shade=-1
    diff
    lint
    # Test layer select / vis / clear / drop / undo 2
    layer new a
    pixel 0 0 grey:15
    layer new b
    pixel 1 1 grey:15
    layer select a
    layer vis off
    layer vis on
    layer select b
    layer clear
    layer drop
    undo 2
    save "${outPng}"
  `);
  assert.match(stdout, /size=6 .* \[active\]/);
  assert.match(stdout, /\[default\]/);
  assert.match(stdout, /trace off/);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const tFiles = fs.readdirSync(trace2).filter((f) => f.endsWith('.png'));
  assert.equal(tFiles.length, 1, 'trace on/off only traced the command inside trace block');
  const im = readPNGInfo(outPng);
  // Pixel (2,2) snapped via #hex must NOT be >= 224 (fullbright)
  assert.ok(im.px[2 * 32 + 2] < 224, `nearest() avoided fullbright (got ${im.px[2 * 32 + 2]})`);
}

console.log('9. Testing painterly brush system (steps 1-4): flow, opacity, spacing%, ramp mixing, dynamics, chalk, mottle, sprite alpha...');
{
  const outPng = path.join(SCRATCH, 't_painterly.png');
  const stdout = runPTX(`
new 96 64 stone:4
# Band 1 (top): ramp mixing at 50% opacity on stone:4 with stone:12 -> ~stone:8
with brush circle size=8 spacing=25% flow=50 opacity=50 blend=mix dither=none
  stroke stone:12 8,10 88,10
end
# Band 2: low flow buildup (25% flow, 100% opacity) + crossing over itself builds stronger coverage
with brush soft size=10 spacing=20% flow=25 opacity=100 dither=none
  stroke stone:14 10,24 86,24
  stroke stone:14 48,18 48,30
end
# Band 3: chalk & mottle procedural world-space tips + dynamics
with brush chalk size=10 spacing=30% tex_scale=4 flow=65 opacity=90 size_jitter=30 angle_jitter=45 shade_jitter=1 flow_jitter=25 seed=12
  stroke bone:11 10,40 86,40
end
with brush mottle size=12 spacing=35% tex_scale=6 flow=50 opacity=80 blend=rgb ramps=stone,moss seed=5
  stroke moss:9 10,54 86,54
end
# Band 4: sprite alpha mask
sprite tip shade
.484.
48f84
.484.
end
with brush sprite tip alpha size=7 spacing=40% flow=70 opacity=85 blend=mix
  stroke stone:14 15,32 80,32
end
save "${outPng}" scale=3
`);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const im = readPNGInfo(outPng);
  const stoneIdx = 2 * 16;
  // Center of Band 1 (x=48, y=10) at scale=3: 50% mix between stone:4 and stone:12 should be stone:8!
  const mixPx = im.px[(10 * 3) * (96 * 3) + (48 * 3)];
  assert.equal(mixPx, stoneIdx + 8, `50% mix between stone:4 and stone:12 should equal stone:8 (got ${mixPx - stoneIdx})`);
  // Intersection of Band 2 (x=48, y=24) had more passes so should be >= single pass (x=20, y=24)
  const singlePass = im.px[(24 * 3) * (96 * 3) + (20 * 3)] - stoneIdx;
  const doublePass = im.px[(24 * 3) * (96 * 3) + (48 * 3)] - stoneIdx;
  assert.ok(doublePass >= singlePass && singlePass > 4, `buildup (${doublePass}) >= single (${singlePass}) > base (4)`);
}

console.log('10. Testing full Quake-relief package: anchors, hue-shift, height bevel/stroke/grad, masonry/plates, glow/emit...');
{
  const outPng = path.join(SCRATCH, 't_package.png');
  const stdout = runPTX(`
    palette quake
    new 64 64 slate:4
    anchor center cx cy
    masonry slate style=running w=32 h=16 mortar=2 bevel=3 height=5 vary=2 chip=20 seed=3
    plates rust w=32 h=16 mortar=1 bevel=2 height=4 region=0,0,64,16
    height bevel mask=rust depth=3 amount=4 profile=linear mode=set region=0,0,64,16
    height stroke -3 center-12,center center+12,center size=4 soft
    height grad 0 16 0 64 from=2 to=0 mode=add mask=!slate:1
    light height dir=nw elev=40 range=-4..+4 dither=bayer4 spec=2 ao=2
    # Glowing rune at center
    pixel center center 231
    pixel center-1 center 228
    pixel center+1 center 228
    glow radius=8 ramp=fb_warm strength=85 normal mode=mix
    save "${outPng}" scale=2
  `);
  assert.match(stdout, /anchor center = 32,32/);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const im = readPNGInfo(outPng);
  // Center pixel stays fullbright 231 after glow
  assert.equal(im.px[(32 * 2) * 128 + (32 * 2)], 231, 'emitter center kept fullbright');
  // Neighbor right next to emitter (34, 32) should have received warm glow (fb_warm indices >= 224 or lifted step)
  const near = im.px[(32 * 2) * 128 + (34 * 2)];
  assert.ok(near >= 224 || (near % 16) >= 5, `glow illuminated nearby stone (idx=${near})`);
}

console.log('11. Testing relative anchors (region=anchor:...), sym axis=anchor, stamp center & scale, rect center, and CSG 2D shape commands...');
{
  const outPng = path.join(SCRATCH, 't_csg_anchors.png');
  const stdout = runPTX(`
    palette quake
    new 64 64 slate:3

    # Anchor with optional centered box size w,h
    anchor skull cx cy-2 40 44
    anchor eye 22 28 10 8

    # CSG 2D composite silhouette using sym anchored on skull!
    sym x axis=skull.x-0.5
    shape skull new
    shape skull add ellipse skull skull 16 18
    shape skull add rect skull skull+12 20 14 center
    shape skull sub ellipse eye eye 4 3
    shape skull sub poly skull-1,skull+10 skull-5,skull+16 skull-1,skull+16
    shape skull add stroke skull-10,skull-18 skull-18,skull-12 size=3
    sym off

    # Test copy, grow, erode, mirror, invert, xor, and, undo
    shape copy skull tmp_s
    shape tmp_s grow 1
    shape tmp_s erode 1
    shape tmp_s xor rect skull skull 12 12 center
    shape tmp_s invert
    shape drop tmp_s

    # Validate ASCII silhouette in stdout before any shading/height
    shape skull show

    # Fill + outline + 3D relief scoped directly via shape=skull and region=anchor:skull
    shape skull rough amount=1 prob=40 seed=7
    shape skull fill flesh:7
    shape skull outline slate:1 side=outer
    height inflate shape=skull amount=8 profile=round mode=set
    noise slate type=value scale=12 from=2 to=5 shape=!skull mask=!slate:1 seed=3
    light height dir=nw elev=40 range=-3..+3 shape=skull

    # Centered 4x4 rect at (6,6) -> covers [4..7] x [4..7]
    rect 6 6 4 4 22 fill center

    # Anchor region tint + stamp center & scale on anchor
    dfill blood:6 50 region=anchor:eye bayer=4
    key b 231
    sprite spark2
.b.
bbb
.b.
    end
    # Stamp centered & 2x scaled on eye, mirrored with sym!
    sym x axis=skull.x-0.5
    stamp spark2 eye eye center scale=2
    sym off
    # Also test percentage scaling
    stamp spark2 14 8 center scale=150%

    # Also test dump region=anchor:skull
    dump view=char region=anchor:skull,16,16
    lint
    save "${outPng}" scale=2
  `);
  assert.match(stdout, /anchor skull = 32,30 \(40x44\)/);
  assert.match(stdout, /shape "skull": \d+ px \(view /);
  assert.match(stdout, /sym x axis=31\.5/);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const im = readPNGInfo(outPng);
  // Centered rect at (6,6) 4x4 covers [4..7] x [4..7]
  assert.equal(im.px[(4 * 2) * 128 + (4 * 2)], 22, 'centered rect covered top-left (4,4)');
  assert.equal(im.px[(7 * 2) * 128 + (7 * 2)], 22, 'centered rect covered bottom-right (7,7)');
  assert.notEqual(im.px[(8 * 2) * 128 + (8 * 2)], 22, 'centered rect excluded outside corner (8,8)');
  // Centered 2x scaled 3x3 cross (6x6) on eye=(22,28) places top-left at (22-3, 28-3) = (19,25); center pixel at (22,28) must be 231!
  assert.equal(im.px[(28 * 2) * 128 + (22 * 2)], 231, 'centered scaled stamp landed at eye anchor');
  assert.equal(im.px[(28 * 2) * 128 + (41 * 2)], 231, 'sym-mirrored stamp landed at opposite eye');
}

console.log('12. Testing bug fixes: separate Quake fullbrights + bone alias, grad radial + shape= bool exprs, sym=, float coords, height-aware lint...');
{
  const outPng = path.join(SCRATCH, 't_fixes.png');
  const stdout = runPTX(`
    palette quake
    new 64 64 slate:3

    # Verify separate fullbright ramps + bone alias ramp work directly
    pixel 2 2 fb_lava:4
    pixel 4 2 fb_fire:4
    pixel 6 2 fb_plasma:4
    pixel 8 2 fb_runic:4
    pixel 10 2 bone:8

    # Build two shapes and combine via inline boolean expression: (body|brow)&!hole
    shape body new
    shape body add ellipse 32 32 16 16
    shape brow new
    shape brow add rect 20 18 24 6
    shape hole new
    shape hole add ellipse 32 32 6 6

    # Paint via inline boolean expression + radial grad WITHOUT colliding with shape=
    shape body fill bone:6
    shape hole fill slate:3
    grad mud 32 32 48 32 from=4 to=12 mode=radial shape=(body|brow)&!hole
    height grad 32 32 48 32 from=8 to=0 radial shape=body&!hole

    # Per-command sym=x without leaving global sym enabled, plus float curve coords
    ellipse 24 24 2 2 fb_plasma:6 fill sym=x axis=31.5
    info
    curve bone:12 31.5,14 20.5,24 26.5,38 size=2
    height stroke 4 31.5,42 31.5,52 size=2 soft

    # Crisp ridge peak & sharp height step transition should not emit false [noise]/[banding]
    rect 4 40 10 10 slate:1 fill
    height set 6 region=4,40,5,10
    rect 4 40 10 10 slate:12 region=4,40,5,10 fill
    pixel 20 50 slate:15
    height set 5 region=20,50,1,1
    lint region=4,40,20,14

    save "${outPng}"
  `);
  assert.match(stdout, /fullbrights: fb_lava\/fb_fire\/fb_plasma\/fb_runic/);
  assert.match(stdout, /sym=off/);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  // Ensure clean ridge / height-edge section had no false [noise] or [banding]
  assert.doesNotMatch(stdout, /\[noise\]/);
  assert.doesNotMatch(stdout, /\[banding\]/);
  const im = readPNGInfo(outPng);
  assert.ok(im.px[2 * 64 + 2] >= 224 && im.px[2 * 64 + 2] <= 231, 'fb_lava index in 224..231');
  assert.ok(im.px[2 * 64 + 4] >= 232 && im.px[2 * 64 + 4] <= 239, 'fb_fire index in 232..239');
  assert.ok(im.px[2 * 64 + 6] >= 240 && im.px[2 * 64 + 6] <= 247, 'fb_plasma index in 240..247');
  assert.ok(im.px[2 * 64 + 8] >= 248 && im.px[2 * 64 + 8] <= 254, 'fb_runic index in 248..254');
  // Hole at center (32,32) excluded by &!hole stayed slate:3 (35) instead of mud radial grad
  assert.equal(im.px[32 * 64 + 32], 2 * 16 + 3, 'center hole protected from grad via shape=(body|brow)&!hole');
  // Inside body ring at (40,32) received mud ramp (row 11: 176..191)
  assert.ok(im.px[32 * 64 + 40] >= 11 * 16 && im.px[32 * 64 + 40] < 12 * 16, 'radial grad painted inside body&!hole');
  // Per-command sym=x mirrored (24,24) -> (39,24)
  assert.ok(im.px[24 * 64 + 24] >= 240 && im.px[24 * 64 + 24] <= 247, 'left sym=x fb_plasma eye');
  assert.ok(im.px[24 * 64 + 39] >= 240 && im.px[24 * 64 + 39] <= 247, 'right sym=x mirrored fb_plasma eye');
}

console.log('13. Testing artistic Pass 2 tools with deep pixel/height verification (hue-shift light/cavity/bevel, rim, relight, smin, ribs, crack, drip terrain, wash, drybrush, hatch in=)...');
{
  const outPng = path.join(SCRATCH, 't_pass2_tools.png');
  const stdout = runPTX(`
    palette quake
    new 64 64 slate:5

    # 1) Layer hmap smooth union (smin): base dome + horns layer merged cleanly
    shape base_dome new
    shape base_dome add ellipse 32 34 16 14
    shape base_dome fill bone:7
    height inflate shape=base_dome amount=7 profile=round mode=set

    layer new horns hmode=smin k=3
    shape horn new
    shape horn add curve 18,30 12,18 22,12 size=6 sym=x axis=31.5
    shape horn fill mud:7
    height ribs 7 18,30 12,18 22,12 count=6 depth=2 size=6 taper=100,45 color=-2 hi=+1 sym=x axis=31.5
    layer merge

    # Socket hole for drip
    shape socket new
    shape socket add ellipse 32 34 3 3
    shape socket fill slate:1
    height set -3 shape=socket

    # 2) Multi-light block with hue-shifting (purple shadow + gold hi + teal rim)
    albedo save
    light begin
      light height dir=nw elev=40 range=-4..+4 shadow_ramp=purple:65% hi_ramp=gold:50% ao=2 shape=base_dome|horn
      light height dir=se elev=25 range=0..+2 rim=se rim_ramp=teal:85% rim_strength=2 shape=base_dome|horn
    light end

    # 3) Check wash on a concave pit (top-right corner: outer ring height=5, inner 4x4 pit height=0)
    rect 46 6 12 12 mud:7 fill
    height set 5 region=46,6,12,12
    height set 0 region=50,10,4,4
    wash slate radius=2 strength=85 dither=none region=46,6,12,12

    # 4) Check drybrush/edgewear on convex ridge block (bottom-left: 6x6 block at height=6)
    rect 6 46 8 8 mud:5 fill
    height set 6 region=6,46,8,8
    edgewear +4 thresh=0.4 strength=100 breakup=0 light=nw dither=none region=6,46,8,8

    # 5) Check cavity with purple hue-shift at 60% mix
    rect 24 4 8 8 grey:12 fill
    rect 26 6 4 4 mud:8 fill
    cavity mask=mud radius=2 lo=3 min=10 shadow_ramp=purple:60% dither=none region=24,4,8,8

    # 6) Check branched crack with color & lip (on left cheek, separate from drip test zone)
    height crack 16,32 24,38 depth=3 width=1 branch=2 wobble=2 color=slate:0 lip=+2 seed=5

    # 7) Drip stopped/deflected by an elevated wall (bar at y=43 height=10 blocks downward drip from 32,37!)
    height set 10 region=26,43,12,3
    drip blood:5 shape=socket dir=s len=12..14 width=1 density=100 dither=none

    # 8) Split dark/bright hatch in=shadow test
    rect 4 4 4 8 grey:2 fill
    rect 8 4 4 8 grey:14 fill
    hatch region=4,4,8,8 in=shadow spacing=1 shade=-1

    lint
    save "${outPng}" scale=2
  `);
  assert.match(stdout, /layer: created "horns" .* hmode=smin/);
  assert.match(stdout, /ok: .* 0 warning\(s\)/);
  const im = readPNGInfo(outPng);
  const pxAt = (x, y) => im.px[(y * 2) * 128 + (x * 2)];
  const rampOfIdx = (i) => Math.floor(i / 16);
  // Check rim teal (row 10 = 160..175) appeared on SE edge of dome (~46, 38..40) or shadow shifted toward purple (row 8 = 128..143)
  let sawPurple = false, sawTeal = false;
  for (let y = 20; y < 50; y++) for (let x = 16; x < 50; x++) {
    const r = rampOfIdx(pxAt(x, y));
    if (r === 8) sawPurple = true;
    if (r === 10) sawTeal = true;
  }
  assert.ok(sawPurple, 'light shadow_ramp=purple shifted dome/horn shadow pixels into purple ramp');
  assert.ok(sawTeal, 'light rim_ramp=teal painted grazing rim edge into teal ramp');

  // Check wash darkened center of concave pit (51,11) relative to flat outer rim (47,7)
  assert.ok(pxAt(51, 11) % 16 < pxAt(47, 7) % 16 || rampOfIdx(pxAt(51, 11)) === 2, 'wash darkened/tinted concave pit center');
  // Check directional edgewear light=nw lifted NW top-left corner (6,46) more than SE corner (13,53)
  assert.ok((pxAt(6, 46) % 16) > (pxAt(13, 53) % 16), 'edgewear light=nw brightened NW corner over SE corner');
  // Check cavity at 60% mix shifted mud border pixels into purple (row 8) or darkened them
  assert.ok(pxAt(26, 6) !== 11 * 16 + 8, 'cavity modified border of mud block at 60% mix');
  // Check drip painted blood (row 4) before wall (around x=31..33, y=40), but did NOT cross tall barrier at y=43 to reach y=46
  assert.ok([31, 32, 33].some((x) => rampOfIdx(pxAt(x, 40)) === 4), 'drip painted blood before barrier (y=40)');
  assert.ok([30, 31, 32, 33, 34].every((x) => rampOfIdx(pxAt(x, 46)) !== 4), 'drip stopped before elevated wall at y=43');
  // Check crack color landed (dark slate:0 = 32 on path start 16,32)
  assert.equal(pxAt(16, 32), 32, 'crack painted start fissure slate:0');
  // Check hatch in=shadow skipped bright grey:14 half, darkened grey:2 half
  assert.equal(pxAt(10, 6), 14, 'hatch in=shadow preserved bright grey:14 half');
  assert.ok(pxAt(6, 6) < 2, 'hatch in=shadow darkened grey:2 half');
}

console.log('14. Testing bug-fix regressions: height compose no-double, smin valley > max, light begin fresh vs keep, relight + paint_over, per-light ramp/dither, lint solitary [noise]...');
{
  // A) height compose without layer drop must equal height compose + layer drop, and mode=set works; smin valley > max
  const hComposeKeep = runPTX(`
    new 32 32 stone:4
    height set 4 region=0,0,16,32
    layer new dome2
    height set 6 region=8,0,16,32
    height compose dome2 base mode=max
    dump view=height region=8,0,8,4
  `);
  const hComposeDrop = runPTX(`
    new 32 32 stone:4
    height set 4 region=0,0,16,32
    layer new dome2
    height set 6 region=8,0,16,32
    height compose dome2 base mode=max
    layer drop
    dump view=height region=8,0,8,4
  `);
  const rangeRe = /height range: ([\d.-]+) \.\. ([\d.-]+)/;
  assert.equal(hComposeKeep.match(rangeRe)[2], hComposeDrop.match(rangeRe)[2], 'height compose without layer drop does not double-apply height');

  const hComposeSet = runPTX(`
    new 16 16 stone:4
    height set 8 region=0,0,16,16
    layer new top
    height set 3 region=4,4,8,8
    height compose top base mode=set
    dump view=height region=6,6,2,2
  `);
  assert.match(hComposeSet, /height range: 3\.00 \.\. 3\.00/, 'height compose mode=set overwrote destination with 3.00');

  // B) smin valley height > max valley height right at equal-height midpoint (16,16)
  const hMaxOut = runPTX(`
    new 32 32 stone:4
    height ellipse 12 16 6 6 6 fill soft
    height ellipse 20 16 6 6 6 mode=max fill soft
    zoom 16 16 1 1 view=height
  `);
  const hSminOut = runPTX(`
    new 32 32 stone:4
    height ellipse 12 16 6 6 6 fill soft
    height ellipse 20 16 6 6 6 mode=smin k=3 fill soft
    zoom 16 16 1 1 view=height
  `);
  const maxVal = parseFloat(hMaxOut.match(/height range: [\d.-]+ \.\. ([\d.-]+)/)[1]);
  const sminVal = parseFloat(hSminOut.match(/height range: [\d.-]+ \.\. ([\d.-]+)/)[1]);
  assert.ok(sminVal > maxVal + 0.3, `smin valley (${sminVal}) lifted cleanly above max (${maxVal})`);

  // C) light begin captures fresh px (preserving new blood rect), light begin keep reuses old albedo, relight preserves paint_over, per-light ramp/dither work
  const outPng = path.join(SCRATCH, 't_regressions.png');
  const regOut = runPTX(`
    palette quake
    new 32 32 mud:6
    height ellipse 5 5 3 3 4 fill soft
    albedo save
    # Draw blood AFTER albedo save; plain "light begin" must NOT clobber blood!
    rect 2 2 6 6 blood:8 fill
    light begin
      light height dir=nw range=-2..+2 dither=none
    light end
    # Now explicitly test "keep" restores saved albedo, and per-light ramp=rust works inside light begin..end
    light begin keep
      light height dir=nw range=2..10 ramp=rust dither=none region=16,0,16,32
    light end
    # Paint overlay detail ABOVE base, add height bump, then relight -> base updates & overlay detail survives!
    layer new paint_over
    rect 4 16 4 4 fb_lava:6 fill
    rect 10 16 4 4 blood:12 fill
    height ellipse 20 20 4 4 6 fill soft
    relight
    save "${outPng}"
  `);
  assert.match(regOut, /ok: .* 0 warning\(s\)/);
  const imReg = readPNGInfo(outPng);
  // (4,4) stayed in blood ramp (row 4: 64..79) after first light begin
  assert.equal(Math.floor(imReg.px[4 * 32 + 4] / 16), 4, 'fresh light begin preserved newly painted blood rect');
  // (20,20) inside right half painted by per-light ramp=rust (row 5: 80..95)
  assert.equal(Math.floor(imReg.px[20 * 32 + 20] / 16), 5, 'per-light ramp=rust worked inside light begin..end');
  // (11,17) on paint_over layer survived relight untouched (blood:12 = 76)
  assert.equal(imReg.px[17 * 32 + 11], 4 * 16 + 12, 'relight preserved paint_over overlay layer');

  // D) lint catches solitary pixel [noise] on flat uniform background
  const lintOut = runPTX(`
    new 16 16 stone:6
    pixel 8 8 stone:15
    lint
  `);
  assert.match(lintOut, /\[noise\] 1 isolated pixel\(s\): 8,8/);
}

// ── 15. Bloco 3: state save/load, include, dump halfblock/luma, bounds, probe, sheet, lint extensions
console.log('15. Bloco 3: state, include, dump halfblock/luma, bounds, probe, sheet, lint JSON/overlay');
{
  const ptxsFile = path.join(SCRATCH, 'state_test.ptxs');
  const incFile = path.join(SCRATCH, 'inc_part.ptx');
  const circA = path.join(SCRATCH, 'circ_a.ptx');
  const circB = path.join(SCRATCH, 'circ_b.ptx');
  const sheetPng = path.join(SCRATCH, 'sheet_out.png');
  const cliSheetPng = path.join(SCRATCH, 'cli_sheet.png');
  const overlayPng = path.join(SCRATCH, 'lint_overlay.png');
  const verifyPng = path.join(SCRATCH, 'state_verify.png');

  fs.writeFileSync(incFile, `
    shape badge new
    shape badge add ellipse 16 16 6 6
    shape badge fill rust:10
    height ellipse 16 16 6 6 4 fill soft
  `);
  fs.writeFileSync(circA, `include circ_b.ptx\n`);
  fs.writeFileSync(circB, `include circ_a.ptx\n`);

  // A) include + state save + dump halfblock/luma + bounds + probe + sheet
  const outA = runPTX(`
    palette quake
    new 32 32 slate:2
    include "${incFile.replace(/\\/g, '/')}"
    anchor center 16 16
    layer new detail
    pixel 16 16 fb_lava:4
    bounds bg=slate:2
    probe 16 16
    dump view=luma scale=2
    dump halfblock scale=2
    sheet "${sheetPng.replace(/\\/g, '/')}" scale=3
    state save "${ptxsFile.replace(/\\/g, '/')}"
  `);
  assert.match(outA, /ok: .* 0 warning\(s\)/);
  assert.match(outA, /bounds: x=10 y=10 w=13 h=13/);
  assert.match(outA, /probe 16,16: idx=228 .* \[FB\] h=4\.00 layer=detail shapes=\[badge\]/);
  assert.match(outA, /luma view 32x32 \(scale=2 -> 16x16\)/);
  assert.match(outA, /\u2580/);
  assert.ok(fs.existsSync(sheetPng), 'sheet PNG created');
  const sheetBuf = fs.readFileSync(sheetPng);
  assert.equal(sheetBuf.readUInt32BE(0), 0x89504e47, 'sheet is valid PNG');
  assert.equal(sheetBuf[25], 2, 'sheet is RGB PNG (color type 2)');

  // B) state load in a fresh process preserves px, hmap, layers, shapes, anchors
  const outB = runPTX(`
    state load "${ptxsFile.replace(/\\/g, '/')}"
    probe 16 16
    probe 12 16
    shape badge show
    save "${verifyPng.replace(/\\/g, '/')}"
  `);
  assert.match(outB, /state loaded:/);
  assert.match(outB, /probe 16,16: idx=228 .* \[FB\] h=4\.00 layer=detail shapes=\[badge\]/);
  assert.match(outB, /probe 12,16: .* ramp=rust:10/);
  const imVerify = readPNGInfo(verifyPng);
  assert.equal(imVerify.px[16 * 32 + 16], 228, 'loaded state preserved fullbright pixel');
  assert.equal(imVerify.px[16 * 32 + 12], 5 * 16 + 10, 'loaded state preserved rust:10 pixel');

  // C) circular include fails cleanly
  assert.throws(() => runPTX(`include "${circA.replace(/\\/g, '/')}"\n`), (err) => {
    assert.match(String(err.stdout || '') + String(err.stderr || '') + err.message, /circular include/);
    return true;
  }, 'circular include exits non-zero');

  // D) lint histogram, json, overlay, repeat detection, and CLI --sheet
  const lintJsonOut = runPTX(`
    palette quake
    new 32 32 slate:6
    # Periodic 8px horizontal stripes -> triggers [repeat] at dx=8
    rect 0 0 2 32 slate:14 fill
    rect 8 0 2 32 slate:14 fill
    rect 16 0 2 32 slate:14 fill
    rect 24 0 2 32 slate:14 fill
    pixel 4 4 slate:15
    lint json overlay="${overlayPng.replace(/\\/g, '/')}"
  `);
  assert.ok(fs.existsSync(overlayPng), 'lint overlay PNG created');
  const jsonLine = lintJsonOut.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  assert.ok(jsonLine, 'lint json emitted JSON line');
  const parsed = JSON.parse(jsonLine);
  assert.ok(parsed.isolated.length >= 1, 'JSON reports isolated noise pixel');
  assert.ok(parsed.histogram && parsed.histogram.zones.length === 5, 'JSON includes 5-zone tonal histogram');
  assert.ok(parsed.repetition && parsed.repetition.dx === 8, `JSON detected repetition at dx=8 (got ${JSON.stringify(parsed.repetition)})`);

  // E) CLI --sheet flag
  const cliScript = path.join(SCRATCH, 'cli_sheet_test.ptx');
  fs.writeFileSync(cliScript, `new 16 16 stone:8\nrect 2 2 12 12 stone:14 fill\n`);
  const cliRes = execFileSync(process.execPath, [PALTEX, cliScript, '--sheet', cliSheetPng], { encoding: 'utf8' });
  assert.match(cliRes, /sheet saved:/);
  assert.ok(fs.existsSync(cliSheetPng), '--sheet CLI flag created contact sheet PNG');
}

// ── 16. Bloco 4 (linguagem & curvas): let, expressões, for/repeat, macro, stamp_along/scatter_along, --strict
console.log('16. Bloco 4 (linguagem): let, math exprs, for/repeat, macro, stamp_along/scatter_along, --strict');
{
  const langPng = path.join(SCRATCH, 'lang_test.png');
  const alongPng = path.join(SCRATCH, 'along_test.png');

  // A) let, ; chaining, {expr}, inline exprs, anchor.prop, for inline + block, repeat, macro
  const langOut = runPTX(`
    palette quake
    new 64 64 slate:2
    anchor eye 20 20 8 6
    let cx = 32; let brow_y = 10; let tooth_y = brow_y+20
    # Inline expr + anchor property expr
    pixel cx-14 eye.y+eye.h/2 fb_lava:6
    # Inline for loop with {expr}
    for i 0..5: rect {10+i*6} {tooth_y} 4 6 bone:9 fill
    # Block repeat loop
    repeat 3 k
      pixel {4+k*2} 50 fb_plasma:5
    end
    # Macro with numeric + string params; must not leak param names to outer scope
    let x = 99
    macro stud x y col
      rect {x-1} {y-1} 3 3 {col} fill
    end
    stud 50 12 rust:12
    stud 56 12 gold:12
    # Verify outer x=99 survived macro call
    pixel x-40 50 fb_runic:4
    save "${langPng.replace(/\\/g, '/')}"
  `);
  assert.match(langOut, /ok: .* 0 warning\(s\)/);
  const imLang = readPNGInfo(langPng);
  // cx-14 = 18, eye.y+eye.h/2 = 23 -> fb_lava:6 (230)
  assert.equal(imLang.px[23 * 64 + 18], 230, 'inline expr cx-14 and eye.y+eye.h/2 evaluated');
  // 6 teeth at x=10,16,22,28,34,40, y=30
  for (let i = 0; i < 6; i++) {
    assert.notEqual(imLang.px[30 * 64 + (10 + i * 6)], 2 * 16 + 2, `for loop tooth ${i} painted`);
  }
  // repeat 3 k -> (4,50), (6,50), (8,50)
  assert.equal(imLang.px[50 * 64 + 8], 245, 'repeat block loop painted third pixel');
  // macro studs at (50,12) rust:12 and (56,12) gold:12
  assert.equal(Math.floor(imLang.px[12 * 64 + 50] / 16), 5, 'macro drew rust stud');
  assert.equal(Math.floor(imLang.px[12 * 64 + 56] / 16), 6, 'macro drew gold stud');
  // outer x=99 -> 99-40 = 59
  assert.equal(imLang.px[50 * 64 + 59], 252, 'macro parameter did not clobber outer variable x');

  // B) stamp_along and scatter_along with rot=follow
  const alongOut = runPTX(`
    palette quake
    new 64 64 slate:2
    key # fb_lava:6
    key * fb_fire:6
    sprite bar
      .....
      #####
      .....
    end
    sprite arrow
      ..*..
      .****
      ..*..
    end
    stamp_along arrow curve 8,48 24,16 48,16 56,48 count=5 rot=follow
    scatter_along arrow,bar line 8,58 56,58 count=4 rot=0 seed=7
    save "${alongPng.replace(/\\/g, '/')}"
  `);
  assert.match(alongOut, /ok: .* 0 warning\(s\)/);
  const imAlong = readPNGInfo(alongPng);
  // Check pixels near curve start (8,48), middle (~32,16), end (56,48) have fb_fire
  const hasFireNear = (cx, cy) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const c = imAlong.px[(cy + dy) * 64 + (cx + dx)];
      if (c >= 232 && c <= 239) return true;
    }
    return false;
  };
  assert.ok(hasFireNear(8, 48), 'stamp_along stamped at curve start');
  assert.ok(hasFireNear(32, 20) || hasFireNear(32, 16), 'stamp_along stamped near curve apex');
  assert.ok(hasFireNear(56, 48), 'stamp_along stamped at curve end');

  // C) --strict turns warnings into fatal exit code != 0
  assert.throws(() => runPTX(`new 16 16 stone:4\nrect 0 0 16 16 stone:4 fill\n`, ['--strict']), (err) => {
    assert.match(String(err.stdout || '') + String(err.stderr || '') + err.message, /changed 0 pixels/);
    return true;
  }, '--strict failed on 0-pixel-changed warning');
  assert.throws(() => runPTX(`new 16 16 stone:4\nrect 0 0 4 4 stone:8 fill bogus=1\n`, ['--strict']), (err) => {
    assert.match(String(err.stdout || '') + String(err.stderr || '') + err.message, /unknown option/);
    return true;
  }, '--strict failed on unknown option warning');
}



fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log('ALL TESTS PASSED!');
