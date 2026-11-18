#!/usr/bin/env node
// 把匹配报告的命中结果「换籍」成国区可下载 URL。
//
// 为什么需要这一步（2026-10-06 实测）：
//   本机 wrapper-lite 的 token 是**国区专属**（/status → regions:["cn"]）。amdl 拿密钥时
//   是按**曲目 id 去国区目录**换的：id 不在国区 → `/key` 直接 500，怎么换区 URL、
//   换 storefront 配置、重启后端都下不动；id 在国区才能下。
//   而匹配阶段为了找全，是在 jp/cn/hk 三区一起检索的，命中的常常是日区/港区那份 id。
//   实测 12 首歌单里 6 首因此下不动，其中 4 首在国区有**另一个 id** 的等价发行版，
//   换成国区 URL 后立刻成功。
//
// 用法:
//   node resolve-downloadable.js <前缀>-report.json [--out <前缀>] [--all]
//
// 产出:
//   <out>-download-cn.txt   只有「国区下得动」的 URL，直接喂给 amdl / Invoke-AmDownloadList.ps1
//   <out>-cn-report.md      逐首判定：原 id 可用 / 换成国区发行版 / 国区无资产
//
// 注意：本脚本只判断**有没有**，不判断**是不是无损**。国区存在但只上架 AAC 的曲目
// （实测 `東の空から始まる世界`）会照样列进来，下完请用 verify-alac.js 复核音质。
const https = require('https');
const fs = require('fs');
const path = require('path');
const S = require('./score.js');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const reportFile = argv.find(a => a.endsWith('.json'));
if (!reportFile) { console.error('用法: node resolve-downloadable.js <前缀>-report.json [--out <前缀>] [--all]'); process.exit(2); }
const ALL = argv.includes('--all');
const OUT = opt('out', reportFile.replace(/\.json$/, ''));
const TOKEN = fs.readFileSync(path.join(S.DATA_DIR, 'am-token.txt'), 'utf8').trim();
const MIN_INTERVAL = parseInt(opt('min-interval', '900'), 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const AUTO = new Set(['A-name', 'B-duration+album']);
const results = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const targets = results.filter(r => r.best && (ALL || AUTO.has(r.verdict)));
if (!targets.length) { console.error('报告里没有可下载的命中（用 --all 把 C 档也带上）'); process.exit(2); }
console.log(`待换籍 ${targets.length} / ${results.length} 首`);

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
  return (r.ok && r.data.data?.[0]?.attributes) || null;
};
const searchSongs = async (sf, term) => {
  const r = await api(`https://amp-api.music.apple.com/v1/catalog/${sf}/search?types=songs&limit=25&term=${encodeURIComponent(term)}`);
  return (r.ok && r.data.results?.songs?.data) || [];
};

(async () => {
  const rows = [];
  for (const r of targets) {
    const ne = { name: r.name, artist: r.artist, duration: r.duration };
    const b = r.best;
    let cn = await byId('cn', b.id);
    let how;
    if (cn) how = '原 id 在国区，直接可用';
    else {
      // 国区没有这个 id：按曲名+歌手在国区找同一首的另一个发行版
      const seen = new Map();
      for (const term of S.titleCandidates(ne.name).slice(0, 2).concat([`${S.titleCandidates(ne.name)[0]} ${S.tokens(ne.artist)[0]}`.trim()])) {
        for (const c of await searchSongs('cn', term)) {
          const at = c.attributes || {};
          const sc = S.scorePair(ne.name, ne.artist, at.name, at.artistName);
          const dur = (ne.duration && at.durationInMillis) ? Math.abs(ne.duration - at.durationInMillis / 1000) : null;
          if (sc.tScore >= 0.9 && sc.aScore >= 0.6 && (dur == null || dur <= 3) && !S.versionMismatch(ne.name, at.name)) {
            const score = sc.score - (dur || 0) * 0.01;
            if (!seen.has(c.id) || seen.get(c.id).score < score) seen.set(c.id, { at, sc, dur, score, id: c.id });
          }
        }
      }
      const best = [...seen.values()].sort((a, b2) => b2.score - a.score)[0];
      if (best) { cn = best.at; how = `换成国区发行版（id ${best.id}，曲名 ${(best.sc.tScore * 100).toFixed(0)}% 歌手 ${(best.sc.aScore * 100).toFixed(0)}%${best.dur != null ? ' 时长Δ' + best.dur.toFixed(1) + 's' : ''}）`; }
      else how = '国区目录没有这个 id，也没搜到等价发行版';
    }
    const verdict = cn ? '✔ 可下' : '✖ 国区无资产';
    rows.push({ idx: r.idx, name: r.name, artist: r.artist, ne_sid: r.sid, verdict, how,
      apple: cn ? cn.name : (b.name || ''), appleArtist: cn ? cn.artistName : (b.artistName || ''),
      sf: cn ? 'cn' : '', url: cn ? cn.url : '', origin: b.storefront || '' });
    console.log(`${String(r.idx).padStart(3)} ${verdict}  ${r.name}  →  ${cn ? cn.name : '(无)'}  ${how}`);
  }

  // 去重：同一 Apple trackId 只保留第一次出现，重复项标 duplicate（否则第二次必撞 Track already exists）
  // 按 `?i=<trackId>` 比较而非整串 URL：同一 trackId 在专辑段不同的链接也必须算重复。
  // 没有 `i=` 的（整张专辑链接）退回整串 URL 比较，保持原有行为。
  const dedupeKey = u => { const m = /[?&]i=(\d+)/.exec(u || ''); return m ? 'i:' + m[1] : (u || '') };
  const seenKey = new Set();
  for (const r of rows) {
    const key = dedupeKey(r.url);
    if (key && seenKey.has(key)) r.duplicate = true;
    else if (key) seenKey.add(key);
  }
  const urls = rows.filter(r => r.url && !r.duplicate).map(r => r.url);
  fs.writeFileSync(OUT + '-download-cn.txt', urls.join('\n') + (urls.length ? '\n' : ''), 'utf8');
  // 汇总必须分三项数：可下 / 重复（同一 Apple id 被多首指向）/ 无资产，否则重复被算成无资产
  const noAsset = rows.filter(r => !r.url).length;
  const dupCount = rows.filter(r => r.duplicate).length;
  const L = ['# 国区可下载性核对', '',
    `来源：${path.basename(reportFile)}　共 ${rows.length} 首　可下 ${urls.length}　重复 ${dupCount}　国区无资产 ${noAsset}`, '',
    '| # | 网易云曲名 | 网易云歌手 | 判定 | 国区曲目 | 说明 | 原命中区 |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    L.push(`| ${r.idx} | ${String(r.name).replace(/\|/g, '\\|')} | ${String(r.artist).replace(/\|/g, '\\|')} | ${r.verdict} | ${String(r.apple).replace(/\|/g, '\\|')} | ${r.how} | ${r.origin} |`);
  }
  L.push('', '> 只判断「国区有没有」，不判断是不是无损：国区只上架 AAC 的曲目也会列进来，下完请用 `verify-alac.js` 复核。');
  fs.writeFileSync(OUT + '-cn-report.md', L.join('\n'), 'utf8');
  // 机器可读结果：后续下载按 idx 回连 pl.json / pl-report.json，不解析 md
  fs.writeFileSync(OUT + '-download-cn.json', JSON.stringify(rows, null, 1), 'utf8');
  console.log(`\n可下 ${urls.length} / ${rows.length}（重复 ${dupCount}，无资产 ${noAsset}）`);
  console.log(`产出：${OUT}-download-cn.txt / ${OUT}-download-cn.json / ${OUT}-cn-report.md`);
})();
