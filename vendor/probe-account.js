#!/usr/bin/env node
// 账号区复核：D 档不等于「账号区没有」。
//
// 旧流程里 D-no 的 best 被置 null，换籍脚本只处理 A/B，于是「账号区到底有没有」
// 对 C/D 档从未执行。本脚本只做只读探测，产物 `pl-review-account.*` 永远不进下载清单。
//
// 用法:
//   node probe-account.js <前缀>-report.json --storefront cn [--out 前缀] [--limit 20]
const https = require('https');
const fs = require('fs');
const path = require('path');
const S = require('./score.js');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const reportFile = argv.find(a => a.endsWith('.json'));
if (!reportFile) { console.error('用法: node probe-account.js <前缀>-report.json --storefront cn [--out 前缀] [--limit N]'); process.exit(2); }

const STOREFRONT = String(opt('storefront', 'cn')).trim() || 'cn';
const OUT = opt('out', reportFile.replace(/\.json$/, '') + '-review-account');
const LIMIT = parseInt(opt('limit', '20'), 10);
const MIN_INTERVAL = parseInt(opt('min-interval', '900'), 10);

const TOKEN = fs.readFileSync(path.join(S.DATA_DIR, 'am-token.txt'), 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const reviewRows = results.filter(r => r.verdict === 'D-no' || String(r.verdict || '').startsWith('C-'));

let last = 0;
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: 'Bearer ' + TOKEN, Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' },
      timeout: 30000,
    }, res => { let d = ''; res.setEncoding('utf8'); res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function api(url) {
  const wait = last + MIN_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  for (let n = 0; n < 3; n++) {
    try {
      const r = await get(url);
      if (r.status === 200) return { ok: true, data: JSON.parse(r.body) };
      if (r.status === 429 || r.status === 403) { await sleep(30000); continue; }
      return { ok: false, status: r.status };
    } catch (e) { await sleep(1500); }
  }
  return { ok: false };
}
const byId = async (sf, id) => {
  const r = await api(`https://amp-api.music.apple.com/v1/catalog/${sf}/songs/${id}`);
  const at = r.ok && r.data.data?.[0]?.attributes;
  return at ? { ...at, id } : null;
};
const searchSongs = async (sf, term) => {
  const r = await api(`https://amp-api.music.apple.com/v1/catalog/${sf}/search?types=songs&limit=25&term=${encodeURIComponent(term)}`);
  return (r.ok && r.data.results?.songs?.data) || [];
};

const scoreOf = (r, at) => {
  const sc = S.scorePair(r.name, r.artist, at.name, at.artistName);
  const dur = (r.duration && at.durationInMillis) ? Math.abs(r.duration - at.durationInMillis / 1000) : null;
  return { ...sc, dur };
};

(async () => {
  const rows = [];
  let probed = 0;
  for (const r of reviewRows) {
    const base = { idx: r.idx, ne_sid: r.sid, name: r.name, artist: r.artist, verdict: r.verdict, storefront: STOREFRONT, auto: false };
    const cands = Array.isArray(r.candidates) ? r.candidates : [];
    const ids = [...new Set([r.best?.id, ...cands.map(c => c.id)].filter(Boolean))].slice(0, 3);
    if (ids.length === 0) {
      rows.push({ ...base, how: '没有候选，未探测', apple: null });
      continue;
    }
    if (probed >= LIMIT) {
      rows.push({ ...base, how: `超过探测上限 ${LIMIT}，未探测`, apple: null });
      continue;
    }
    probed++;

    let hit = null;
    let how = '';
    for (const id of ids) {
      const at = await byId(STOREFRONT, id);
      if (at) { hit = at; how = '账号区存在同一 Apple id'; break; }
    }

    // C 档才允许补一次按名搜索；D 档只做候选 id 的 byId，控制调用量。
    if (!hit && String(r.verdict || '').startsWith('C-')) {
      const term = `${r.best?.titleForm || S.titleCandidates(r.name)[0] || r.name} ${S.tokens(r.artist)[0] || ''}`.trim();
      const seen = [];
      for (const c of await searchSongs(STOREFRONT, term)) {
        const at = { ...(c.attributes || {}), id: c.id };
        const sc = scoreOf(r, at);
        if (sc.aScore >= 0.9 && sc.tScore >= 0.7 && sc.dur != null && sc.dur <= 1.5 && !S.versionMismatch(r.name, at.name)) {
          seen.push({ at, sc });
        }
      }
      seen.sort((a, b) => b.sc.score - a.sc.score);
      if (seen[0]) {
        hit = seen[0].at;
        how = `账号区搜索命中（曲名 ${(seen[0].sc.tScore * 100).toFixed(0)}% 时长Δ${seen[0].sc.dur.toFixed(1)}s）`;
      }
    }

    const apple = hit ? (() => {
      const sc = scoreOf(r, hit);
      return { id: hit.id, name: hit.name, artistName: hit.artistName, albumName: hit.albumName, url: hit.url,
        tScore: sc.tScore, aScore: sc.aScore, durDelta: sc.dur };
    })() : null;
    rows.push({ ...base, how: hit ? how : '账号区未找到等价发行版', apple });
    console.log(`${String(r.idx).padStart(3)} ${hit ? '✔' : '✖'}  ${r.name}  →  ${hit ? hit.name : '(无)'}`);
  }

  const found = rows.filter(r => r.apple).length;
  const md = ['# 账号区复核', '',
    `来源：${path.basename(reportFile)}　账号区：${STOREFRONT}　复核 ${rows.length} 首　命中 ${found} 首　未自动下载`, '',
    '| # | 网易云曲名 | 判定 | 账号区 | 账号区曲目 | 相似度 | 时长Δ | 链接 | 说明 |',
    '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const a = r.apple;
    md.push(`| ${r.idx} | ${String(r.name).replace(/\|/g, '\\|')} | ${r.verdict} | ${r.storefront} | ${a ? String(a.name).replace(/\|/g, '\\|') : ''} | ${a ? (a.tScore * 100).toFixed(0) + '%' : ''} | ${a && a.durDelta != null ? a.durDelta.toFixed(1) + 's' : ''} | ${a ? a.url : ''} | ${r.how} |`);
  }
  md.push('', '> 只做复核，不下载、不修改 `pl-download-cn.json`；确认后再用 `amdl_download({ urls: [...] })` 补下。');

  fs.writeFileSync(OUT + '.json', JSON.stringify(rows, null, 1), 'utf8');
  fs.writeFileSync(OUT + '.md', md.join('\n'), 'utf8');
  console.log(`\n账号区复核：${rows.length} 首中 ${found} 首命中（未自动下载）`);
  console.log(`产出：${OUT}.json / ${OUT}.md`);
})();
