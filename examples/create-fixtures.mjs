#!/usr/bin/env node
/** Synthetic layout fixtures. These are not screenshots of any application. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const font = 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, WenQuanYi Zen Hei, sans-serif';

function svg(width, height, content) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#eef2f6"/>
  <g font-family="${font}" fill="#263546">${content}</g>
  </svg>`);
}

const landscape = svg(1400, 900, `
  <rect x="0" y="0" width="1400" height="128" fill="#fff0bc"/>
  <text x="60" y="58" font-size="34" font-weight="700">合成排版测试图 · 不是实机截图</text>
  <text x="60" y="99" font-size="23">横屏素材 / 仅检查文字、箭头、避让和局部放大</text>
  <rect x="50" y="164" width="1300" height="676" rx="20" fill="#ffffff" stroke="#c9d3df" stroke-width="2"/>
  <text x="90" y="218" font-size="28" font-weight="650">虚构的排版测试面板</text>
  <rect x="1060" y="250" width="240" height="76" rx="14" fill="#2563a6"/>
  <text x="1180" y="299" font-size="30" font-weight="650" text-anchor="middle" fill="#ffffff">选择示例</text>
  <rect x="90" y="390" width="1210" height="206" rx="14" fill="#f1f5fa"/>
  <text x="120" y="445" font-size="27">这块留白用于观察图内标注的位置。</text>
  <text x="120" y="492" font-size="24" fill="#607088">按钮、面板与文字均为自制素材，不对应任何真实软件。</text>
  <text x="120" y="540" font-size="24" fill="#607088">真实教程必须另行采集实机截图。</text>
  <rect x="90" y="650" width="610" height="140" rx="14" fill="#eaf8ee" stroke="#77b48a" stroke-width="2"/>
  <text x="120" y="700" font-size="27" font-weight="650">保护区域：请保留这段文字</text>
  <text x="120" y="747" font-size="24">标注框与箭头应避开这里。</text>
  <text x="1340" y="878" text-anchor="end" font-size="22" fill="#607088">1400 × 900 / 合成素材</text>
`);

const portrait = svg(900, 1500, `
  <rect x="0" y="0" width="900" height="158" fill="#fff0bc"/>
  <text x="45" y="62" font-size="34" font-weight="700">合成排版测试图 · 不是实机截图</text>
  <text x="45" y="112" font-size="24">竖屏素材 / 仅验证渲染效果</text>
  <rect x="60" y="205" width="780" height="1200" rx="26" fill="#ffffff" stroke="#c9d3df" stroke-width="2"/>
  <text x="110" y="275" font-size="32" font-weight="650">竖屏排版测试</text>
  <rect x="110" y="325" width="680" height="225" rx="18" fill="#f1f5fa"/>
  <text x="145" y="385" font-size="28">这是一张自制的静态图。</text>
  <text x="145" y="438" font-size="25" fill="#607088">没有真实账号，也没有用户作品。</text>
  <text x="145" y="490" font-size="25" fill="#607088">下方留白用于放置中文动作标注。</text>
  <rect x="210" y="920" width="480" height="100" rx="20" fill="#2563a6"/>
  <text x="450" y="983" text-anchor="middle" font-size="34" font-weight="650" fill="#ffffff">显示测试结果</text>
  <rect x="110" y="1110" width="680" height="220" rx="18" fill="#eaf8ee" stroke="#77b48a" stroke-width="2"/>
  <text x="145" y="1175" font-size="30" font-weight="650">保护区域</text>
  <text x="145" y="1230" font-size="27">这里的说明应该保持完整可读。</text>
  <text x="145" y="1285" font-size="24" fill="#496b54">这是排版检查，不是软件交互验证。</text>
  <text x="840" y="1460" text-anchor="end" font-size="24" fill="#607088">900 × 1500 / 合成素材</text>
`);

await fs.mkdir(directory, { recursive: true });
for (const [name, buffer] of [['landscape.png', landscape], ['portrait.png', portrait]]) {
  await sharp(buffer).png().toFile(path.join(directory, name));
}
console.log(`已生成合成排版测试素材：${directory}`);
