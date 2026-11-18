#!/usr/bin/env node
// 下载 OpenCC 繁简字表到 ../data（只需跑一次）。
// 没有它，繁简写法的歌手名（牛尾憲輔 vs 牛尾宪辅）永远匹配不上。
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.NEAM_DATA || process.env.QQAM_DATA || path.join(__dirname, '..', 'data');
const BASE = 'https://cdn.jsdelivr.net/npm/opencc-data@1.0.5/data/';
const FILES = ['TSCharacters.txt', 'TSPhrases.txt'];

function get(url, depth = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' }, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth > 0) {
        res.resume();
        const nx = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return resolve(get(nx, depth - 1));
      }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(DATA_DIR, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100) { console.log(`已存在，跳过：${f}`); continue; }
    const r = await get(BASE + f);
    if (r.status !== 200 || r.body.length < 100) { console.error(`下载失败 ${f}: HTTP ${r.status}`); continue; }
    fs.writeFileSync(dest, r.body, 'utf8');
    console.log(`已下载 ${f}  (${r.body.length} 字节, ${r.body.trim().split('\n').length} 行)`);
  }
  console.log('数据目录：' + DATA_DIR);
})();
