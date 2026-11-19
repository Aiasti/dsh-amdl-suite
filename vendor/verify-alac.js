#!/usr/bin/env node
// 不用 ffprobe 也能验音质：直接解析 MP4 里的 ALAC magic cookie。
// Windows 侧没有 ffprobe/ffmpeg，所以自带这个（与 qq-to-apple-match 同一份实现）。
//
// 用法:
//   node verify-alac.js <目录或文件...>
//
// 能区分：ALAC(位深/采样率/声道) / AAC 有损（Apple 无无损母带时的降级）/ 无法解析
const fs = require('fs');
const path = require('path');

const VALID_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000]);
const VALID_DEPTH = new Set([16, 20, 24, 32]);

function probe(file) {
  const buf = fs.readFileSync(file);
  const tag = Buffer.from('alac', 'latin1');
  let i = buf.indexOf(tag);
  while (i !== -1) {
    // cookie 起点有两种可能，取能解出合法参数的那个
    for (const off of [i + 8, i + 4]) {
      if (off + 24 > buf.length) continue;
      const bitDepth = buf.readUInt8(off + 5);
      const numChannels = buf.readUInt8(off + 9);
      const sampleRate = buf.readUInt32BE(off + 20);
      if (VALID_DEPTH.has(bitDepth) && VALID_RATES.has(sampleRate) && numChannels >= 1 && numChannels <= 8) {
        return { codec: 'alac', bitDepth, sampleRate, numChannels, mb: buf.length / 1048576,
          tier: sampleRate > 48000 ? 'Hi-Res Lossless' : 'Lossless' };
      }
    }
    i = buf.indexOf(tag, i + 1);
  }
  const aac = buf.includes(Buffer.from('mp4a', 'latin1')) || buf.includes(Buffer.from('esds', 'latin1'));
  return { codec: aac ? 'aac' : 'unknown', mb: buf.length / 1048576 };
}

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : (/\.(m4a|mp4)$/i.test(e.name) ? [path.join(d, e.name)] : []));
}

const args = process.argv.slice(2);
if (!args.length) { console.error('用法: node verify-alac.js <目录或 .m4a 文件...>'); process.exit(2); }

let files = [];
for (const a of args) {
  const st = fs.statSync(a);
  files = files.concat(st.isDirectory() ? walk(a) : [a]);
}
if (!files.length) { console.log('没有找到 .m4a 文件'); process.exit(0); }

if (files.length <= 5) {
  for (const f of files) console.log(JSON.stringify({ file: path.basename(f), ...probe(f) }));
} else {
  const stats = {}; let totalMB = 0, aac = 0, unknown = 0;
  for (const f of files) {
    const r = probe(f);
    if (r.codec === 'aac') { aac++; continue; }
    if (r.codec !== 'alac') { unknown++; continue; }
    const k = `${r.bitDepth}-bit / ${r.sampleRate} Hz / ${r.numChannels}ch  ${r.tier}`;
    stats[k] = (stats[k] || 0) + 1;
    totalMB += r.mb;
  }
  console.log(`文件 ${files.length} | 无损合计 ${totalMB.toFixed(1)} MB`);
  console.log(`AAC 有损（无无损母带而降级）: ${aac}${unknown ? ' | 无法解析: ' + unknown : ''}`);
  for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
}
