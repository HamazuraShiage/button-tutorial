import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execute = promisify(execFile);
const generator = fileURLToPath(new URL('../scripts/build_tutorial.mjs', import.meta.url));
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'button-tutorial-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const screenshot = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700">
    <rect width="1000" height="700" fill="#edf2f7"/>
    <text x="30" y="35" font-family="sans-serif" font-size="22">TEST FIXTURE — NOT A REAL SOFTWARE SCREENSHOT</text>
    <rect x="700" y="470" width="200" height="90" fill="#3178c6"/>
    <text x="735" y="525" font-family="sans-serif" font-size="24" fill="white">TEST BUTTON</text>
  </svg>`)).png().toBuffer();
  await fs.writeFile(path.join(root, 'shot.png'), screenshot);
  const manifest = {
    title: 'TEST FIXTURE tutorial',
    goal: 'Click the test button.',
    start: 'A clearly marked test fixture is open.',
    finish: 'The test button has been identified.',
    style: { font_size: 24, font_family: 'sans-serif' },
    steps: [{
      title: 'Locate the test button',
      shot: 'shot.png',
      target: [700, 470, 900, 560],
      callout: [40, 60, 500, 140],
      on_image_text: 'Click the test button',
      action: 'Click TEST BUTTON in this test fixture.',
      result: 'The test button is selected.',
    }],
  };
  return { root, screenshot, manifest, out: path.join(root, 'output') };
}

async function run(f, out = f.out) {
  const manifestPath = path.join(f.root, 'steps.json');
  await fs.writeFile(manifestPath, JSON.stringify(f.manifest));
  try {
    const result = await execute(process.execPath, [generator, manifestPath, '--out', out], { timeout: 30_000 });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

async function assertAbsent(filename) {
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
}

test('CLI creates a permanently annotated PNG and a self-contained HTML without changing its source', async t => {
  const f = await fixture(t);
  const before = hash(await fs.readFile(path.join(f.root, 'shot.png')));
  const result = await run(f);
  assert.equal(result.code, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.steps, 1);
  const png = await fs.readFile(report.images[0]);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1000);
  assert.equal(metadata.height, 700);
  // A pixel inside the callout changes in the PNG itself, independently of HTML.
  const pixel = input => sharp(input).extract({ left: 50, top: 70, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.notDeepEqual(await pixel(png), await pixel(f.screenshot));

  const html = await fs.readFile(report.html, 'utf8');
  const embedded = [...html.matchAll(/<img\b[^>]*\bsrc="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)];
  assert.equal(embedded.length, 1);
  assert.deepEqual(Buffer.from(embedded[0][1], 'base64'), png);
  assert.doesNotMatch(html, /<(?:script|img)\b[^>]*\bsrc="(?:https?:|\.\/|images\/)/);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref="(?:https?:|\.\/)/);
  assert.equal(hash(await fs.readFile(path.join(f.root, 'shot.png'))), before);
});

test('a missing screenshot in a later step leaves no partial output', async t => {
  const f = await fixture(t);
  f.manifest.steps.push({ ...f.manifest.steps[0], shot: 'missing.png' });
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /无法读取截图/);
  await assertAbsent(f.out);
});

test('out-of-bounds targets fail before any output is created', async t => {
  const f = await fixture(t);
  f.manifest.steps[0].target = [900, 470, 1100, 560];
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /target.*坐标越界/);
  await assertAbsent(f.out);
});

test('a callout covering the target fails before any output is created', async t => {
  const f = await fixture(t);
  f.manifest.steps[0].callout = [680, 450, 300, 150];
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /callout 覆盖目标/);
  await assertAbsent(f.out);
});

test('text that cannot fit in the callout fails instead of being cut off', async t => {
  const f = await fixture(t);
  f.manifest.steps[0].callout = [40, 60, 500, 20];
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /callout 高度.*放不下文字/);
  await assertAbsent(f.out);
});

test('an output path colliding with a source screenshot preserves that screenshot', async t => {
  const f = await fixture(t);
  const out = path.join(f.root, 'existing');
  const source = path.join(out, 'images', '01-A.png');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, f.screenshot);
  f.manifest.steps[0].shot = path.relative(f.root, source);
  const before = hash(await fs.readFile(source));
  const result = await run(f, out);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /覆盖输入清单或原始截图/);
  assert.equal(hash(await fs.readFile(source)), before);
  assert.deepEqual(await fs.readdir(path.dirname(source)), ['01-A.png']);
  await assertAbsent(path.join(out, 'index.html'));
});
