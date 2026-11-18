#!/usr/bin/env node
// 取一个可用的 Apple Music 目录检索 token，并探测哪些区可用。
//
// 为什么不用 iTunes 的公开 /search 接口：它限流极狠，实测连续跑几百次后
// 会对本机 IP 直接回 403/429（连 example.com 之外的任何 /search 都拒绝），
// 而 /lookup 却仍然正常——说明是端点级限流，不是 IP 被封。
// Apple Music 网页播放器用的是 amp-api.music.apple.com，配额宽松得多。
//
// 用法:
//   node get-am-token.js [token输出文件] [--storefronts jp,cn,hk]
//
// token 会写进文件（默认 ../data/am-token.txt），不打印到终端。
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.NEAM_DATA || process.env.QQAM_DATA || path.join(__dirname, '..', 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const JWT = /eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g;

function get(url, headers = {}, depth = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers }, timeout: 40000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth > 0) {
        res.resume();
        const nx = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return resolve(get(nx, headers, depth - 1));
      }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const dec = s => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch (e) { return null; } };

function ampHeaders(token) {
  return { Authorization: 'Bearer ' + token, Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/', Accept: 'application/json' };
}

async function probe(token, sf) {
  const r = await get(`https://amp-api.music.apple.com/v1/catalog/${sf}/search?types=songs&limit=1&term=test`, ampHeaders(token));
  let n = 0;
  try { n = (JSON.parse(r.body)?.results?.songs?.data || []).length; } catch (e) {}
  return { sf, status: r.status, ok: r.status === 200 };
}

(async () => {
  const args = process.argv.slice(2);
  const storefrontsArg = (args.indexOf('--storefronts') !== -1) ? args[args.indexOf('--storefronts') + 1] : 'jp,cn,hk';
  const storefronts = storefrontsArg.split(',').map(s => s.trim()).filter(Boolean);
  const outFile = args.find(a => !a.startsWith('--') && a !== storefrontsArg)
    || path.join(DATA_DIR, 'am-token.txt');

  console.log('从 music.apple.com 网页播放器提取目录 token ...');
  const page = await get('https://music.apple.com/jp/new');
  // 注意包名里带 '~'（index~xxxx.js），正则必须放行它
  const srcs = [...new Set((page.body.match(/src="[^"]+\.js[^"]*"/g) || []).map(s => s.slice(5, -1)))];
  if (!srcs.length) { console.error('没有找到 JS bundle，页面结构可能变了'); process.exit(1); }

  const toks = new Set();
  for (const s of srcs) {
    const js = await get(s.startsWith('http') ? s : 'https://music.apple.com' + s);
    if (js.status !== 200) continue;
    for (const h of js.body.match(JWT) || []) toks.add(h);
  }
  console.log(`候选 token：${toks.size} 个`);

  for (const t of toks) {
    const hd = dec(t.split('.')[0]) || {};
    const pl = dec(t.split('.')[1]) || {};
    const results = [];
    for (const sf of storefronts) { results.push(await probe(t, sf)); await new Promise(r => setTimeout(r, 500)); }
    const okSf = results.filter(r => r.ok).map(r => r.sf);
    console.log(`  kid=${hd.kid || '?'} iss=${pl.iss || '?'} len=${t.length} → 可用区: ${okSf.join(',') || '(无)'}`);
    if (okSf.length) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, t, 'utf8');
      const exp = pl.exp ? new Date(pl.exp * 1000).toISOString() : '?';
      console.log(`已保存可用 token 到 ${outFile}  (kid=${hd.kid}, 过期 ${exp})`);
      console.log(`可用区：${okSf.join(', ')}`);
      const unusable = results.filter(r => !r.ok).map(r => `${r.sf}(HTTP ${r.status})`);
      if (unusable.length) console.log(`这些区这个 token 不可用：${unusable.join(', ')}`);
      return;
    }
  }
  console.error('没有找到可用 token。');
  process.exit(1);
})();
