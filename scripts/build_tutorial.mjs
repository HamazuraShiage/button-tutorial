#!/usr/bin/env node
/** Build real, permanently annotated screenshots and a self-contained offline tutorial. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const DEFAULT_FONT = 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, WenQuanYi Zen Hei, sans-serif';
const HELP = `按钮级图文教程生成器

用法：
  node build_tutorial.mjs <manifest.json> --out <目录>
    [--node-modules <绝对 node_modules 路径>] [--font-family <字体族>]

清单中的截图路径相对于清单文件；坐标使用 EXIF 正规化后的显示方向像素。
生成 index.html 和 images/*.png；HTML 内嵌图片，可单独离线打开。
依赖 Sharp；不会自动安装依赖，也不会生成 PDF 或压缩包。
`;

function fail(message) { throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name}：必须是非空字符串。`);
  return value.trim();
}
function optionalString(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${name}：必须是字符串。`);
  return value.trim();
}
function xml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function letters(index) {
  let text = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text;
  return text;
}
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (['--out', '--node-modules', '--font-family'].includes(value)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`${value} 后需要一个参数。`);
      if (args[value]) fail(`${value} 不能重复。`);
      args[value] = argv[++i];
    } else if (value.startsWith('-')) fail(`未知参数：${value}。使用 --help 查看用法。`);
    else if (args.manifest) fail('只能指定一个清单文件。');
    else args.manifest = value;
  }
  if (!args.manifest || !args['--out']) fail('需要清单文件和 --out 目录。使用 --help 查看用法。');
  if (args['--node-modules'] && !path.isAbsolute(args['--node-modules'])) fail('--node-modules 必须是绝对路径。');
  if (args['--font-family'] !== undefined) requiredString(args['--font-family'], '--font-family');
  return args;
}
function loadSharp(nodeModules) {
  const requires = [createRequire(import.meta.url)];
  if (nodeModules) requires.push(createRequire(path.join(path.dirname(nodeModules), 'package.json')));
  for (const require of requires) {
    try { return require('sharp'); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_DLOPEN_FAILED') fail(`无法加载 Sharp：${error.message}`);
    }
  }
  fail('找不到可用的 Sharp。请使用已安装 Sharp 的 Node 环境，或传入 --node-modules <绝对 node_modules 路径>；生成器不会自动安装依赖。');
}
function rectangle(value, name, width, height, xywh = false) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) fail(`${name}：需要四个有限数字。`);
  const [x, y, a, b] = value;
  const result = { x, y, w: xywh ? a : a - x, h: xywh ? b : b - y };
  if (result.w <= 0 || result.h <= 0) fail(`${name}：矩形宽高必须大于 0。`);
  if (x < 0 || y < 0 || x + result.w > width || y + result.h > height) fail(`${name}：坐标越界，显示方向截图尺寸为 ${width} × ${height}。`);
  return result;
}
function overlaps(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && a.x + a.w > b.x - gap && a.y < b.y + b.h + gap && a.y + a.h > b.y - gap;
}
function center(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
function edgeToward(rect, point) {
  const c = center(rect), dx = point.x - c.x, dy = point.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: rect.y };
  const f = Math.min(dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx), dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy));
  return { x: c.x + dx * f, y: c.y + dy * f };
}
function segmentCrosses(a, b, r) {
  // Intersect the rectangle's interior, allowing a line to end on its border.
  const epsilon = 0.05;
  const bounds = [r.x + epsilon, r.y + epsilon, r.x + r.w - epsilon, r.y + r.h - epsilon];
  let low = 0, high = 1;
  const delta = [b.x - a.x, b.y - a.y], origin = [a.x, a.y];
  for (let axis = 0; axis < 2; axis++) {
    if (Math.abs(delta[axis]) < 1e-9) {
      if (origin[axis] < bounds[axis] || origin[axis] > bounds[axis + 2]) return false;
    } else {
      let t1 = (bounds[axis] - origin[axis]) / delta[axis], t2 = (bounds[axis + 2] - origin[axis]) / delta[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      low = Math.max(low, t1); high = Math.min(high, t2);
      if (low > high) return false;
    }
  }
  return low <= high && high > 1e-6 && low < 1 - 1e-6;
}
function arrowRoute(label, target, protectedRects, width, height, stroke, stepName) {
  const start = edgeToward(label, center(target)), end = edgeToward(target, center(label));
  const clearance = Math.max(6, stroke * 1.5);
  const obstacles = [label, target, ...protectedRects.map(r => ({ x: r.x - clearance, y: r.y - clearance, w: r.w + clearance * 2, h: r.h + clearance * 2 }))];
  const visible = (a, b) => !obstacles.some(r => segmentCrosses(a, b, r));
  if (visible(start, end)) return [start, end];
  const points = [start, end];
  for (const rect of obstacles) for (const x of [rect.x - clearance, rect.x + rect.w + clearance]) for (const y of [rect.y - clearance, rect.y + rect.h + clearance]) {
    if (x >= clearance && x <= width - clearance && y >= clearance && y <= height - clearance && !obstacles.some(r => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h)) points.push({ x, y });
  }
  const distance = Array(points.length).fill(Infinity), previous = Array(points.length).fill(-1), visited = new Set();
  distance[0] = 0;
  for (let count = 0; count < points.length; count++) {
    let u = -1;
    for (let i = 0; i < points.length; i++) if (!visited.has(i) && (u < 0 || distance[i] < distance[u])) u = i;
    if (u < 0 || !Number.isFinite(distance[u])) break;
    if (u === 1) {
      const route = [];
      for (let i = u; i >= 0; i = previous[i]) route.unshift(points[i]);
      return route;
    }
    visited.add(u);
    for (let v = 0; v < points.length; v++) if (!visited.has(v) && visible(points[u], points[v])) {
      const candidate = distance[u] + Math.hypot(points[u].x - points[v].x, points[u].y - points[v].y);
      if (candidate < distance[v]) { distance[v] = candidate; previous[v] = u; }
    }
  }
  fail(`${stepName}：箭头无法避开保护区域。请调整 callout 或 protected，留出指向目标的通道。`);
}

function createMeasurer(sharp, fontFamily, fontSize) {
  const cache = new Map();
  return async text => {
    if (!text.trim()) return 0;
    if (cache.has(text)) return cache.get(text);
    const width = Math.max(64, Math.ceil([...text].length * fontSize * 2 + 32));
    if (width > 32768) fail('单行文字过长，请拆分 on_image_text。');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.ceil(fontSize * 3 + 20)}"><text xml:space="preserve" x="8" y="${fontSize * 1.5 + 8}" font-family="${xml(fontFamily)}" font-size="${fontSize}" font-weight="650" fill="#111">${xml(text)}</text></svg>`;
    const { info } = await sharp(Buffer.from(svg)).trim({ background: '#00000000', threshold: 0 }).png().toBuffer({ resolveWithObject: true });
    const measured = info.width + 3; // Reserve antialiasing/italic overhang pixels.
    cache.set(text, measured);
    return measured;
  };
}
export async function wrapText(paragraphs, maxWidth, measure, stepName) {
  const lines = [];
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
  for (const paragraph of paragraphs.flatMap(p => p.replace(/\r\n?/g, '\n').split('\n'))) {
    if (!paragraph) { lines.push(''); continue; }
    const chars = [...segmenter.segment(paragraph)].map(s => s.segment);
    let begin = 0;
    while (begin < chars.length) {
      let low = 1, high = chars.length - begin, fit = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2), width = await measure(chars.slice(begin, begin + middle).join(''));
        if (width <= maxWidth) { fit = middle; low = middle + 1; } else high = middle - 1;
      }
      if (!fit) fail(`${stepName}：文字框太窄，连一个字符都放不下。请加宽 callout 或减小 font_size。`);
      // Prefer an ASCII word boundary while permitting long URLs/words to wrap.
      if (begin + fit < chars.length) {
        const fragment = chars.slice(begin, begin + fit);
        const space = fragment.lastIndexOf(' ');
        if (space > fragment.length * 0.6) fit = space + 1;
      }
      lines.push(chars.slice(begin, begin + fit).join('').trimEnd());
      begin += fit;
      while (chars[begin] === ' ') begin++;
    }
  }
  return lines;
}

async function layoutCallout(step, sharp, fontFamily, fontSize) {
  const { width, height, target, protectedRects, name } = step;
  const padding = Math.max(10, Math.round(fontSize * 0.53)), gap = Math.max(8, Math.round(fontSize * 0.45));
  const lineHeight = Math.ceil(fontSize * 1.4);
  const measure = createMeasurer(sharp, fontFamily, fontSize);
  const badgeWidth = Math.max(Math.ceil(fontSize * 1.6), await measure(step.id) + padding);
  const minimumWidth = badgeWidth + gap + padding * 2 + fontSize * 2;
  const getLayout = async boxWidth => {
    const lines = await wrapText(step.paragraphs, boxWidth - padding * 2 - badgeWidth - gap, measure, name);
    return { lines, neededHeight: padding * 2 + Math.max(Math.ceil(fontSize * 1.6), lineHeight * lines.length) };
  };
  const free = rect => ![target, ...protectedRects].some(r => overlaps(rect, r, gap));
  if (step.callout) {
    const box = step.callout;
    if (box.w < minimumWidth) fail(`${name}：callout 太窄，无法显示步骤编号和文字；至少需要 ${Math.ceil(minimumWidth)} 像素宽。`);
    if (!free(box)) fail(`${name}：callout 覆盖目标或 protected 保护区域（包括文字框安全间距 ${gap} 像素）。请重新定位。`);
    const layout = await getLayout(box.w);
    if (layout.neededHeight > box.h) fail(`${name}：callout 高度 ${box.h} 放不下文字，至少需要 ${layout.neededHeight} 像素；不会截字。请加高框、缩短图中文字或减小字号。`);
    return { box, ...layout, padding, lineHeight, badgeWidth, gap };
  }
  const margin = Math.max(8, Math.round(fontSize * 0.4));
  const maxWidth = width - margin * 2;
  const widths = [...new Set([Math.min(520, width * 0.42), Math.min(680, width * 0.6), maxWidth].map(n => Math.floor(Math.min(maxWidth, Math.max(minimumWidth, n)))))];
  let best;
  for (const boxWidth of widths) {
    if (boxWidth < minimumWidth) continue;
    const layout = await getLayout(boxWidth), boxHeight = layout.neededHeight;
    if (boxHeight > height - margin * 2) continue;
    const xs = new Set([margin, width - margin - boxWidth, target.x - gap - boxWidth, target.x + target.w + gap, target.x + target.w / 2 - boxWidth / 2]);
    const ys = new Set([margin, height - margin - boxHeight, target.y - gap - boxHeight, target.y + target.h + gap, target.y + target.h / 2 - boxHeight / 2]);
    for (let x = margin; x <= width - margin - boxWidth; x += Math.max(24, Math.floor(width / 16))) xs.add(x);
    for (let y = margin; y <= height - margin - boxHeight; y += Math.max(24, Math.floor(height / 20))) ys.add(y);
    for (const x of xs) for (const y of ys) {
      const box = { x: Math.round(x), y: Math.round(y), w: boxWidth, h: boxHeight };
      if (box.x < margin || box.y < margin || box.x + box.w > width - margin || box.y + box.h > height - margin || !free(box) || overlaps(box, target, Math.max(gap, fontSize * 2))) continue;
      const c = center(box), t = center(target);
      const score = Math.hypot(c.x - t.x, c.y - t.y) + box.w * box.h / (width * height) * 100;
      if (!best || score < best.score) best = { box, ...layout, score };
    }
  }
  if (!best) fail(`${name}：截图内没有容纳文字且避开目标与保护区域的位置。请缩短 on_image_text、调整字号，或提供可用的 callout [x,y,width,height]。`);
  return { ...best, padding, lineHeight, badgeWidth, gap };
}

function annotationSvg(step, style) {
  const { width, height, target, layout, route, fontSize } = step;
  const { box, padding, badgeWidth, lineHeight, gap, lines } = layout;
  const stroke = Math.max(3, Math.round(fontSize * 0.16));
  const points = route.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const textX = box.x + padding + badgeWidth + gap;
  const textY = box.y + (box.h - lineHeight * lines.length) / 2 + fontSize;
  const rounded = Math.max(8, fontSize * 0.4);
  const targetBox = { x: Math.max(stroke / 2, target.x - stroke), y: Math.max(stroke / 2, target.y - stroke), w: Math.min(width - stroke / 2, target.x + target.w + stroke) - Math.max(stroke / 2, target.x - stroke), h: Math.min(height - stroke / 2, target.y + target.h + stroke) - Math.max(stroke / 2, target.y - stroke) };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><marker id="tip" markerWidth="${Math.max(24, fontSize)}" markerHeight="${Math.max(24, fontSize)}" viewBox="0 0 14 14" refX="12" refY="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M2 1 L12 7 L2 13 L5 7 Z" fill="${style.accent}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></marker></defs>
<rect x="${targetBox.x}" y="${targetBox.y}" width="${targetBox.w}" height="${targetBox.h}" rx="${Math.min(rounded, target.h / 4, target.w / 4)}" fill="none" stroke="#fff" stroke-width="${stroke + 3}"/>
<rect x="${targetBox.x}" y="${targetBox.y}" width="${targetBox.w}" height="${targetBox.h}" rx="${Math.min(rounded, target.h / 4, target.w / 4)}" fill="none" stroke="${style.accent}" stroke-width="${stroke}"/>
<polyline points="${points}" fill="none" stroke="#fff" stroke-width="${stroke + 5}" stroke-linecap="round" stroke-linejoin="round"/>
<polyline points="${points}" fill="none" stroke="${style.accent}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#tip)"/>
<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${rounded}" fill="${style.background}" stroke="${style.accent}" stroke-width="${Math.max(2, stroke * 0.7)}"/>
<rect x="${box.x + padding}" y="${box.y + (box.h - fontSize * 1.6) / 2}" width="${badgeWidth}" height="${fontSize * 1.6}" rx="${fontSize * 0.3}" fill="${style.accent}"/>
<text xml:space="preserve" x="${box.x + padding + badgeWidth / 2}" y="${box.y + box.h / 2 + fontSize * 0.34}" text-anchor="middle" font-family="${xml(style.fontFamily)}" font-size="${fontSize}" font-weight="800" fill="#fff">${xml(step.id)}</text>
${lines.map((line, index) => `<text xml:space="preserve" x="${textX}" y="${textY + index * lineHeight}" font-family="${xml(style.fontFamily)}" font-size="${fontSize}" font-weight="650" fill="#222b35">${xml(line)}</text>`).join('\n')}
</svg>`;
}

function metadataHtml(app) {
  const names = { name: '软件', version: '版本', device: '设备', system: '系统', browser: '浏览器', capture_date: '截图日期' };
  return Object.entries(names).filter(([key]) => app[key]).map(([key, name]) => `<span>${name}：${xml(app[key])}</span>`).join('');
}
function makeHtml(manifest, steps, app, accent) {
  const intro = [['开始前', manifest.start], ['完成后', manifest.finish]].map(([label, text]) => `<div><strong>${label}</strong><p>${xml(text)}</p></div>`).join('');
  const navigation = steps.map((step, index) => `<a href="#step-${index + 1}" data-nav="${index + 1}"><b>${xml(step.id)}</b><span>${xml(step.title)}</span><i aria-hidden="true"></i></a>`).join('');
  const cards = steps.map((step, index) => `<article class="step" id="step-${index + 1}">
<header><span class="badge">${xml(step.id)}</span><h2>${xml(step.title)}</h2><label class="check"><input type="checkbox" data-step="${index + 1}" aria-label="标记步骤 ${xml(step.id)} 已完成"> 已完成</label></header>
${step.where ? `<p class="where"><strong>从这里开始：</strong>${xml(step.where)}</p>` : ''}
<button type="button" class="image-button" data-enlarge="${index + 1}" aria-label="放大步骤 ${xml(step.id)} 的标注图片"><img id="image-${index + 1}" src="data:image/png;base64,${step.png.toString('base64')}" alt="步骤 ${xml(step.id)}：${xml(step.paragraphs.join('；'))}" width="${step.width}" height="${step.height}" loading="${index ? 'lazy' : 'eager'}"></button>
<div class="image-tools"><span>点图片可放大查看</span><button type="button" data-save="${index + 1}" data-name="${xml(step.filename)}">保存这张标注图</button></div>
${step.zoomPng ? `<details class="zoom"><summary>查看按钮局部放大</summary><button type="button" class="image-button" data-zoom="${index + 1}" aria-label="放大步骤 ${xml(step.id)} 的局部图片"><img id="zoom-${index + 1}" src="data:image/png;base64,${step.zoomPng.toString('base64')}" alt="步骤 ${xml(step.id)} 的真实界面局部放大" width="${step.zoomWidth}" height="${step.zoomHeight}" loading="lazy"></button><button type="button" data-save-zoom="${index + 1}" data-name="${xml(step.zoomFilename)}">保存局部图</button></details>` : ''}
<dl><div><dt>现在这样做</dt><dd>${xml(step.action)}</dd></div><div class="result"><dt>看到这个，就做对了</dt><dd>${xml(step.result)}</dd></div>${step.tip ? `<div class="tip"><dt>卡住时看这里</dt><dd>${xml(step.tip)}</dd></div>` : ''}</dl>
<footer>${index ? `<a href="#step-${index}">← 上一步</a>` : '<span></span>'}${index < steps.length - 1 ? `<a href="#step-${index + 2}">下一步 →</a>` : '<a href="#finish">检查完成结果 →</a>'}</footer>
</article>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(manifest.title)}</title>
<style>
:root{--accent:${accent};--ink:#202b35;--muted:#586776;--paper:#fff;--line:#dce3e8}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:26px}body{margin:0;background:#f4f6f8;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.75}button,a,input,summary{touch-action:manipulation}button,a,summary{outline-offset:5px}button{font:inherit;cursor:pointer}a{color:var(--ink)}.layout{max-width:1540px;margin:auto;display:grid;grid-template-columns:260px minmax(0,1fr);gap:30px;padding:32px 28px}.sidebar{position:sticky;top:22px;align-self:start;max-height:calc(100vh - 44px);overflow:auto}.sidebar h2{margin:0;font-size:21px}.progress{color:var(--muted);margin:8px 0 16px}.nav{display:grid;gap:7px}.nav a{display:flex;align-items:center;gap:10px;text-decoration:none;padding:8px 10px;border-radius:8px;background:#fff;border:1px solid var(--line);font-size:14px}.nav b{background:#fff0e9;color:#9d3429;min-width:27px;text-align:center;border-radius:6px}.nav span{flex:1}.nav i{font-style:normal;color:#26704d}.nav a.done i:after{content:'✓'}.nav a.current{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}main{min-width:0}.intro,.step,.finish{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:30px;margin-bottom:28px}.eyebrow{font-size:13px;letter-spacing:.1em;font-weight:750;color:#9d3429;margin:0 0 8px}h1{font-size:clamp(25px,3vw,40px);line-height:1.35;margin:0 0 16px}.goal{font-size:19px;white-space:pre-wrap}.metadata{display:flex;flex-wrap:wrap;gap:5px 18px;color:var(--muted);font-size:13px;margin:18px 0}.readme{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding-top:18px;border-top:1px solid var(--line)}.readme p{margin:6px 0 0;white-space:pre-wrap}.step{scroll-margin-top:26px}.step header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}.badge{background:var(--accent);color:#fff;padding:3px 13px;border-radius:9px;font-weight:800;font-size:22px}.step h2{font-size:23px;line-height:1.45;margin:0;flex:1;min-width:150px}.check{font-size:14px;white-space:nowrap;display:flex;align-items:center;gap:5px;color:var(--muted)}.check input{width:21px;height:21px;accent-color:var(--accent)}.where{color:var(--muted);white-space:pre-wrap}.image-button{border:1px solid var(--line);background:#e9edf1;padding:0;display:block;width:100%;border-radius:10px;overflow:hidden;cursor:zoom-in}.image-button img{display:block;width:100%;height:auto}.image-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:9px 0 22px;font-size:13px;color:var(--muted)}.image-tools button,.zoom>button{background:#fff;border:1px solid #c7d1da;border-radius:7px;padding:5px 12px;color:var(--ink)}dl{display:grid;gap:12px;margin:0}dl>div{background:#f5f7f9;border-radius:10px;padding:15px 18px}dt{font-size:13px;font-weight:750;color:#526273;margin-bottom:4px}dd{font-size:18px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}dl .result{background:#eef8f0}dl .tip{background:#fff7e5}.step footer{display:flex;justify-content:space-between;border-top:1px solid var(--line);margin-top:24px;padding-top:16px;font-size:15px}.step footer a{text-decoration:none}.finish h2{margin:0 0 12px;font-size:26px}.finish p{white-space:pre-wrap}.finish a{font-size:14px}.zoom{margin:16px 0 24px}.zoom summary{cursor:pointer;color:#586776}.zoom .image-button{max-width:760px;margin:12px auto}.zoom>button{margin-top:8px}dialog{border:0;padding:0;border-radius:12px;max-width:96vw;max-height:96vh;background:#18212b;color:#fff;overflow:auto}dialog::backdrop{background:#000c}.modal-bar{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;gap:20px;align-items:center;background:#18212bf2;padding:10px 15px}.modal-bar button{color:#fff;border:1px solid #7c8895;background:transparent;border-radius:6px;padding:3px 12px}dialog img{display:block;max-width:none;height:auto}noscript{display:block;padding:12px;background:#fff0c5}.muted{color:var(--muted);font-size:13px}@media(max-width:850px){.layout{display:block;padding:18px 12px}.sidebar{position:static;max-height:none;margin:0 0 18px}.sidebar h2{font-size:18px}.progress{margin:4px 0 10px}.nav{display:flex;overflow:auto;padding-bottom:5px}.nav a{flex:0 0 auto;max-width:220px}.nav span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.intro,.step,.finish{padding:20px 16px;border-radius:12px;margin-bottom:18px}.step h2{font-size:21px}.check{margin-left:auto}.readme{grid-template-columns:1fr}.image-tools{align-items:flex-start;font-size:12px}.image-tools button{white-space:nowrap}dd{font-size:17px}}@media print{.layout{display:block;padding:0}.sidebar,.image-tools,.check,.step footer,dialog{display:none}.intro,.step,.finish{break-inside:avoid;box-shadow:none}.image-button{border:0}body{background:white}}
</style></head><body><noscript>教程图片和文字仍可离线阅读；勾选记忆、放大和保存按钮需要浏览器允许 JavaScript。也可直接保存 images 文件夹中的 PNG。</noscript>
<div class="layout"><aside class="sidebar"><h2>照着图片，一步一步做</h2><p class="progress" aria-live="polite" id="progress">已完成 0 / ${steps.length} 步</p><nav class="nav" aria-label="步骤导航">${navigation}</nav></aside><main>
<section class="intro"><p class="eyebrow">按钮级图文教程</p><h1>${xml(manifest.title)}</h1><p class="goal">${xml(manifest.goal)}</p><div class="metadata">${metadataHtml(app)}</div><div class="readme">${intro}</div><p class="muted">先看图上的文字和箭头，再做一个动作。看到对应结果后勾选“已完成”。</p></section>
${cards}
<section class="finish" id="finish"><h2>做到这里，就完成了</h2><p>${xml(manifest.finish)}</p><a href="#step-1">回到第一步</a></section></main></div>
<dialog id="lightbox" aria-label="标注图片放大查看"><div class="modal-bar"><span>可滚动查看完整图片 · 按 Esc 关闭</span><button type="button" id="close-lightbox">关闭</button></div><img id="large-image" alt=""></dialog>
<script>
(() => {
  'use strict';
  const boxes = [...document.querySelectorAll('input[data-step]')];
  const key = 'button-tutorial:' + document.title + ':' + boxes.length;
  let saved = [];
  try { const parsed = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch (_) {}
  function update() {
    document.getElementById('progress').textContent = '已完成 ' + boxes.filter(b => b.checked).length + ' / ' + boxes.length + ' 步';
    boxes.forEach(box => { const nav = document.querySelector('[data-nav="' + box.dataset.step + '"]'); if (nav) nav.classList.toggle('done', box.checked); });
  }
  boxes.forEach(box => {
    box.checked = saved.includes(box.dataset.step);
    box.addEventListener('change', () => { update(); try { localStorage.setItem(key, JSON.stringify(boxes.filter(b => b.checked).map(b => b.dataset.step))); } catch (_) {} });
  });
  update();
  const dialog = document.getElementById('lightbox'), large = document.getElementById('large-image');
  function enlarge(source) { if (!source) return; large.src = source.src; large.alt = source.alt; if (typeof dialog.showModal === 'function') dialog.showModal(); else { const link = document.createElement('a'); link.href = source.src; link.target = '_blank'; link.rel = 'noopener'; link.click(); } }
  document.getElementById('close-lightbox').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => large.removeAttribute('src'));
  document.querySelectorAll('[data-enlarge]').forEach(button => button.addEventListener('click', () => enlarge(document.getElementById('image-' + button.dataset.enlarge))));
  document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => enlarge(document.getElementById('zoom-' + button.dataset.zoom))));
  function download(button, source) { const link = document.createElement('a'); link.href = source.src; link.download = button.dataset.name; document.body.appendChild(link); link.click(); link.remove(); }
  document.querySelectorAll('[data-save]').forEach(button => button.addEventListener('click', () => download(button, document.getElementById('image-' + button.dataset.save))));
  document.querySelectorAll('[data-save-zoom]').forEach(button => button.addEventListener('click', () => download(button, document.getElementById('zoom-' + button.dataset.saveZoom))));
  function current() { const match = location.hash.match(/^#step-(\\d+)$/); document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('current', Boolean(match && a.dataset.nav === match[1]))); }
  window.addEventListener('hashchange', current); current();
})();
</script></body></html>`;
}

async function canonicalPath(filename) {
  try { return await fs.realpath(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(filename);
    if (parent === filename) return filename;
    return path.join(await canonicalPath(parent), path.basename(filename));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const sharp = loadSharp(args['--node-modules']);
  const manifestPath = path.resolve(args.manifest), out = path.resolve(args['--out']);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (error) { fail(`无法读取 JSON 清单 ${manifestPath}：${error.message}`); }
  if (!object(manifest)) fail('清单根节点必须是对象。');
  for (const field of ['title', 'goal', 'start', 'finish']) manifest[field] = requiredString(manifest[field], field);
  const app = manifest.application === undefined ? {} : manifest.application;
  if (!object(app)) fail('application 必须是对象。');
  for (const key of ['name', 'version', 'device', 'system', 'browser', 'capture_date']) if (app[key] !== undefined) app[key] = optionalString(app[key], `application.${key}`);
  const config = manifest.style === undefined ? {} : manifest.style;
  if (!object(config)) fail('style 必须是对象。');
  for (const color of ['accent', 'background']) if (config[color] !== undefined && (typeof config[color] !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(config[color]))) fail(`style.${color} 必须是十六进制颜色，如 #e5483b。`);
  if (config.font_size !== undefined && (typeof config.font_size !== 'number' || !Number.isFinite(config.font_size) || config.font_size <= 0)) fail('style.font_size 必须是有效正数。');
  if (config.font_family !== undefined) requiredString(config.font_family, 'style.font_family');
  const style = { accent: config.accent || '#df3f32', background: config.background || '#fff9eb', fontFamily: args['--font-family'] || config.font_family || DEFAULT_FONT };
  if (!Array.isArray(manifest.steps) || manifest.steps.length === 0) fail('steps 必须是非空数组。');
  const steps = [], ids = new Set(), inputs = new Set([await canonicalPath(manifestPath)]);
  for (const [index, raw] of manifest.steps.entries()) {
    if (!object(raw)) fail(`步骤 ${index + 1} 必须是对象。`);
    const id = raw.id === undefined ? letters(index) : requiredString(raw.id, `步骤 ${index + 1}.id`);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) fail(`步骤 ${id}：id 只能包含 1–32 个英文字母、数字、下划线和短横线。`);
    if (ids.has(id)) fail(`步骤 ${id}：id 重复。`);
    ids.add(id);
    const name = `步骤 ${id}`, step = { id, name, index };
    for (const key of ['title', 'shot', 'action', 'result']) step[key] = requiredString(raw[key], `${name}.${key}`);
    for (const key of ['where', 'tip']) step[key] = optionalString(raw[key], `${name}.${key}`);
    const paragraphs = Array.isArray(raw.on_image_text) ? raw.on_image_text : [raw.on_image_text];
    if (!paragraphs.length) fail(`${name}.on_image_text 必须是非空字符串或非空字符串数组。`);
    step.paragraphs = paragraphs.map((value, i) => requiredString(value, `${name}.on_image_text[${i}]`));
    step.shotPath = path.resolve(path.dirname(manifestPath), step.shot);
    let input, metadata;
    try { input = await fs.readFile(step.shotPath); metadata = await sharp(input, { animated: true }).metadata(); }
    catch (error) { fail(`${name}：无法读取截图 ${step.shotPath}：${error.message}`); }
    if (!['png', 'jpeg', 'webp'].includes(metadata.format)) fail(`${name}：仅支持 PNG、JPEG、WebP 截图。`);
    if ((metadata.pages || 1) !== 1) fail(`${name}：不支持多帧或动画截图，请先提供单帧图片。`);
    try {
      const normal = await sharp(input).rotate().png().toBuffer({ resolveWithObject: true });
      step.normalized = normal.data; step.width = normal.info.width; step.height = normal.info.height;
    } catch (error) { fail(`${name}：截图方向正规化失败：${error.message}`); }
    inputs.add(await canonicalPath(step.shotPath));
    step.target = rectangle(raw.target, `${name}.target`, step.width, step.height);
    step.callout = raw.callout === undefined ? undefined : rectangle(raw.callout, `${name}.callout`, step.width, step.height, true);
    if (raw.protected !== undefined && !Array.isArray(raw.protected)) fail(`${name}.protected 必须是矩形数组。`);
    step.protectedRects = (raw.protected || []).map((value, i) => rectangle(value, `${name}.protected[${i}]`, step.width, step.height));
    step.zoom = raw.zoom === undefined ? undefined : rectangle(raw.zoom, `${name}.zoom`, step.width, step.height);
    step.fontSize = config.font_size || Math.max(18, Math.min(36, Math.round(Math.min(step.width, step.height) * 0.042)));
    try {
      step.layout = await layoutCallout(step, sharp, style.fontFamily, step.fontSize);
      step.route = arrowRoute(step.layout.box, step.target, step.protectedRects, step.width, step.height, Math.max(3, Math.round(step.fontSize * 0.16)), name);
    } catch (error) { if (error.message.startsWith(name)) throw error; fail(`${name}：排版失败：${error.message}`); }
    const stem = `${String(index + 1).padStart(2, '0')}-${id}`;
    step.filename = `${stem}.png`; step.outputPath = path.join(out, 'images', step.filename);
    if (step.zoom) step.zoomFilename = `${stem}-zoom.png`;
    steps.push(step);
  }
  const htmlPath = path.join(out, 'index.html');
  const outputs = [htmlPath, ...steps.map(step => step.outputPath)];
  for (const output of outputs) if (inputs.has(await canonicalPath(output))) fail(`输出路径会覆盖输入清单或原始截图：${output}。请选择其他 --out 目录。`);
  // Finish all validation and rendering in memory before creating the output folder.
  for (const step of steps) {
    try {
      step.png = await sharp(step.normalized).composite([{ input: Buffer.from(annotationSvg(step, style)), top: 0, left: 0 }]).png().toBuffer();
      if (step.zoom) {
        const z = step.zoom, left = Math.floor(z.x), top = Math.floor(z.y), width = Math.ceil(z.x + z.w) - left, height = Math.ceil(z.y + z.h) - top;
        const crop = await sharp(step.normalized).extract({ left, top, width, height }).png().toBuffer();
        const target = step.target;
        const local = { x: Math.max(0, target.x - left), y: Math.max(0, target.y - top), x2: Math.min(width, target.x + target.w - left), y2: Math.min(height, target.y + target.h - top) };
        const rect = local.x2 > local.x && local.y2 > local.y ? `<rect x="${local.x}" y="${local.y}" width="${local.x2 - local.x}" height="${local.y2 - local.y}" fill="none" stroke="${style.accent}" stroke-width="3"/>` : '';
        const marked = await sharp(crop).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rect}</svg>`) }]).png().toBuffer();
        const scale = Math.max(1, Math.min(2, 1000 / width));
        const zoom = await sharp(marked).resize({ width: Math.round(width * scale), kernel: 'nearest' }).png().toBuffer({ resolveWithObject: true });
        step.zoomPng = zoom.data; step.zoomWidth = zoom.info.width; step.zoomHeight = zoom.info.height;
      }
    } catch (error) { fail(`${step.name}：图片渲染失败：${error.message}`); }
  }
  const html = makeHtml(manifest, steps, app, style.accent);
  await fs.mkdir(path.join(out, 'images'), { recursive: true });
  for (const step of steps) {
    await fs.writeFile(step.outputPath, step.png);
  }
  await fs.writeFile(htmlPath, html, 'utf8');
  console.log(JSON.stringify({ html: htmlPath, images: steps.map(step => step.outputPath), steps: steps.length }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
}
