#!/usr/bin/env node
// 把网易云歌单逐首匹配到 Apple Music（可跨多个区），产出可下载清单 + 人工复核报告。
//
// 用法:
//   node match.js <netease-playlist.json> [--token <am-token.txt>] [--storefronts jp,cn,hk]
//                 [--out <前缀>] [--limit N] [--min-interval 900] [--concurrency 2]
//
// 产出 <前缀>-report.json / -report.csv / -report.md / -download.txt
// 只有 A-name 与 B-duration+album 且无版本冲突的，才建议直接交给下载器；
// 其余一律进复核清单——实测「只靠时长」和「只靠专辑」都会批量产假匹配。
//
// 与 QQ 版的差别：网易云的曲名常是「中文本名 + 外文名」拼成一串，
// 搜索词和相似度都按文种拆开算（见 score.js 的 titleCandidates/titleSimDetail），
// 报告里命中「拆出来的某一段」时会标 (拆段)，便于人工留意。
const https = require('https');
const fs = require('fs');
const path = require('path');
const S = require('./score.js');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const playlistFile = argv.find(a => a.endsWith('.json'));
if (!playlistFile) { console.error('用法: node match.js <netease-playlist.json> [--token f] [--storefronts jp,cn,hk] [--out 前缀]'); process.exit(2); }

const DATA_DIR = S.DATA_DIR;
const tokenFile = opt('token', path.join(DATA_DIR, 'am-token.txt'));
const STOREFRONTS = String(opt('storefronts', 'jp,cn,hk')).split(',').map(s => s.trim()).filter(Boolean);
const OUT_PREFIX = opt('out', playlistFile.replace(/\.json$/, '') + '-match');
const LIMIT = parseInt(opt('limit', '0'), 10);
const MIN_INTERVAL = parseInt(opt('min-interval', '900'), 10);
const CONCURRENCY = parseInt(opt('concurrency', '2'), 10);
const COOLDOWN = 30000;
const MAX_TERMS = parseInt(opt('max-terms', '4'), 10);

if (!fs.existsSync(tokenFile)) { console.error(`找不到 token 文件 ${tokenFile}，先跑 node get-am-token.js`); process.exit(2); }
const TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();

const playlist = JSON.parse(fs.readFileSync(playlistFile, 'utf8'));
const tracks = (playlist.tracks || playlist).slice();
if (LIMIT > 0) tracks.length = Math.min(tracks.length, LIMIT);
console.log(`歌单 ${playlist.meta?.name || playlistFile}：${tracks.length} 首 | 检索区 ${STOREFRONTS.join(',')}`);

const REPORT = OUT_PREFIX + '-report.json';
let results = [];
if (fs.existsSync(REPORT)) { try { results = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch (e) { results = []; } }
const done = new Set(results.map(r => r.idx));

// ---------- 限流 HTTP ----------
let reqCount = 0, okCount = 0, rlCount = 0, cooldownUntil = 0, lastStart = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gate() {
  for (;;) {
    const now = Date.now();
    if (now < cooldownUntil) { await sleep(Math.min(1000, cooldownUntil - now)); continue; }
    const w = lastStart + MIN_INTERVAL - now;
    if (w > 0) { await sleep(w); continue; }
    lastStart = Date.now(); return;
  }
}
function once(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: 'Bearer ' + TOKEN, Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36', 'Accept-Encoding': 'identity' }, timeout: 30000 }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
// 返回 {ok:true,data} / {ok:false}；429/403 时全局冷却后重试
async function api(pathAndQuery) {
  for (let n = 0; n < 4; n++) {
    await gate(); reqCount++;
    let r; try { r = await once('https://amp-api.music.apple.com' + pathAndQuery); } catch (e) { await sleep(1200); continue; }
    if (r.status === 200) { okCount++; try { return { ok: true, data: JSON.parse(r.body) }; } catch (e) { return { ok: false }; } }
    if (r.status === 429 || r.status === 403) { rlCount++; cooldownUntil = Date.now() + COOLDOWN; continue; }
    return { ok: false };
  }
  return { ok: false };
}
// 重要：空结果 ≠ 请求失败。用 [] || x 之类的写法会把两者混为一谈，
// 于是「这区没有」被误记成「重试」，报告就不可信了。
async function search(term, sf) {
  const r = await api(`/v1/catalog/${sf}/search?types=songs&limit=25&term=${encodeURIComponent(term)}`);
  if (!r.ok) return { candidates: null, failed: true };
  return { candidates: (r.data?.results?.songs?.data || []).map(c => ({ id: c.id, attributes: c.attributes })), failed: false };
}

// ---------- 单曲处理 ----------
async function processTrack(ne) {
  const artist = S.tokens(ne.artist)[0] || ne.artist;
  const forms = S.titleCandidates(ne.name);
  const terms = [];
  for (const f of forms.slice(0, MAX_TERMS)) terms.push(`${f} ${artist}`.trim());
  for (const f of forms.slice(0, MAX_TERMS)) terms.push(f);
  const uniqTerms = [...new Set(terms)].filter(Boolean);

  let best = null, bestTier = 'D-no', anyOk = false, anyFail = false;
  const pool = new Map();   // 候选池：D 档也留证据，人工复核时能看到「最接近的是什么」
  outer:
  for (const sf of STOREFRONTS) {
    for (const term of uniqTerms) {
      const { candidates, failed } = await search(term, sf);
      if (failed) { anyFail = true; continue; }
      anyOk = true;
      for (const c of candidates) {
        const at = c.attributes || {};
        const s = S.scorePair(ne.name, ne.artist, at.name, at.artistName);
        const detail = S.titleSimDetail(ne.name, at.name);
        const durDelta = (ne.duration && at.durationInMillis) ? Math.abs(ne.duration - at.durationInMillis / 1000) : null;
        const albumSim = (ne.album && at.albumName) ? S.sim(ne.album, at.albumName) : null;
        const vm = S.versionMismatch(ne.name, at.name);
        let tier = S.tierOf({ tScore: s.tScore, aScore: s.aScore, durDelta, albumSim, versionMismatch: vm });
        // 版本不符（伴奏/卡拉OK/翻奏）不能算自动可下
        if (vm && (tier === 'A-name' || tier === 'B-duration+album')) tier = 'C-duration-only';
        const fullForm = S.clean(ne.name);
        const rec = { ...s, tier, durDelta, albumSim, versionMismatch: vm, id: c.id,
          name: at.name, artistName: at.artistName, albumName: at.albumName, url: at.url,
          isrc: at.isrc, durationInMillis: at.durationInMillis, storefront: sf, storefronts: [sf],
          titleForm: detail.form, partialTitle: detail.form !== fullForm && detail.form !== S.stripTitle(fullForm) };
        const rank = t => S.RANK[t === 'A-name' ? 'exact' : t === 'B-duration+album' ? 'likely' : t === 'D-no' ? 'none' : 'ambiguous'];
        const better = !best || rank(tier) > rank(bestTier) || (tier === bestTier && rec.score > best.score);
        if (better) { best = rec; bestTier = tier; }
        const prev = pool.get(rec.id);
        if (!prev) pool.set(rec.id, rec);
        else {
          // 同一 Apple id 跨区都存在时，保留分数更高的记录，但把区合并进 storefronts，
          // 否则 jp 先搜到就会把 cn/hk 覆盖掉，报告看起来「只有日区」。
          for (const s2 of rec.storefronts) if (!prev.storefronts.includes(s2)) prev.storefronts.push(s2);
          if (rec.score > prev.score) { rec.storefronts = prev.storefronts; pool.set(rec.id, rec); }
        }
        if (best && best.id === rec.id) {
          for (const s2 of rec.storefronts) if (!best.storefronts.includes(s2)) best.storefronts.push(s2);
        }
      }
      if (bestTier === 'A-name' && !best?.partialTitle) break outer;   // 已确认，省下后续请求
    }
  }
  const status = (!anyOk && anyFail) ? 'retry' : bestTier;
  const candidates = [...pool.values()].sort((a, b) => b.score - a.score).slice(0, 5)
    .map(c => ({ id: c.id, name: c.name, artistName: c.artistName, albumName: c.albumName,
      storefront: c.storefront, storefronts: c.storefronts,
      durDelta: c.durDelta, tScore: c.tScore, aScore: c.aScore, url: c.url }));
  return { idx: ne.idx, name: ne.name, artist: ne.artist, album: ne.album || '',
    duration: ne.duration || null, sid: ne.sid, verdict: status, best: bestTier === 'D-no' ? null : best, candidates };
}

// ---------- 输出 ----------
function esc(v) { return String(v == null ? '' : v).replace(/\|/g, '\\|'); }
const isAuto = r => S.AUTO_DOWNLOAD_TIERS.has(r.verdict) && r.best && !r.best.versionMismatch;
function writeOutputs() {
  fs.writeFileSync(REPORT, JSON.stringify(results, null, 1), 'utf8');
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['idx', 'ne_title', 'ne_artist', 'ne_album', 'ne_duration_s', 'ne_song_id', 'verdict', 'auto_download', 'apple_title', 'apple_artist', 'apple_album', 'storefront', 'duration_delta_s', 'title_sim', 'artist_sim', 'matched_form', 'partial_title', 'isrc', 'apple_url', 'alt_candidates'].join(',')];
  for (const r of results.slice().sort((a, b) => a.idx - b.idx)) {
    const b = r.best || {};
    rows.push([r.idx, r.name, r.artist, r.album, r.duration, r.sid, r.verdict, isAuto(r) ? 'YES' : 'NO', b.name || '', b.artistName || '',
      b.albumName || '', (b.storefronts || [b.storefront || '']).join(','), b.durDelta != null ? b.durDelta.toFixed(1) : '',
      b.tScore != null ? b.tScore.toFixed(3) : '', b.aScore != null ? b.aScore.toFixed(3) : '',
      b.titleForm || '', b.partialTitle ? 'yes' : '', b.isrc || '', (b.url || ''),
      (r.candidates || []).slice(0, 3).map(c => `${c.name} — ${c.artistName} [${(c.storefronts || [c.storefront]).join(',')}]${c.durDelta != null ? ' Δ' + c.durDelta.toFixed(1) + 's' : ''}`).join(' / ')].map(q).join(','));
  }
  fs.writeFileSync(OUT_PREFIX + '-report.csv', '\uFEFF' + rows.join('\r\n'), 'utf8');

  const auto = results.filter(isAuto);
  const review = results.filter(r => !S.AUTO_DOWNLOAD_TIERS.has(r.verdict) && r.best);
  const none = results.filter(r => !r.best);

  const L = [];
  L.push('# 网易云 → Apple Music 匹配报告');
  L.push('');
  L.push(`歌单：${playlist.meta?.name || ''}（${results.length} 首）  检索区：${STOREFRONTS.join(', ')}`);
  if (playlist.meta?.owner) L.push(`归属：${playlist.meta.owner}（userId ${playlist.meta.ownerId || '?'}）  曲目来源：${playlist.meta.via || '?'}`);
  L.push(`生成时间：${new Date().toISOString()}`);
  L.push('');
  L.push('| 判定 | 数量 | 含义 |');
  L.push('|---|---|---|');
  const cnt = {};
  for (const r of results) cnt[r.verdict] = (cnt[r.verdict] || 0) + 1;
  const DESC = {
    'A-name': '曲名+歌手双吻合，可直接下载',
    'B-duration+album': '曲名吻合 + 时长≤1.5s + 专辑吻合，可下载',
    'C-duration-only': '曲名吻合、时长接近，但专辑/歌手存疑 —— 需人工过目',
    'C-album-only': '曲名吻合、专辑吻合，但时长对不上 —— 需人工过目',
    'D-no': '没找到',
    'retry': '查询失败，未判定',
  };
  for (const k of ['A-name', 'B-duration+album', 'C-duration-only', 'C-album-only', 'D-no', 'retry']) {
    if (cnt[k]) L.push(`| ${k} | ${cnt[k]} | ${DESC[k]} |`);
  }
  L.push('');
  L.push(`**建议直接下载：${auto.length} / ${results.length} = ${results.length ? (100 * auto.length / results.length).toFixed(1) : '0'}%**`);
  const bySf = {};
  for (const r of auto) bySf[r.best.storefront] = (bySf[r.best.storefront] || 0) + 1;
  L.push('');
  L.push('命中所属区（主区）：' + (Object.entries(bySf).map(([k, v]) => `${k} ${v}`).join('、') || '(无)'));
  const partial = auto.filter(r => r.best.partialTitle);
  if (partial.length) {
    L.push('');
    L.push(`> 注意：其中 ${partial.length} 首是靠网易云曲名里**拆出来的某一段**命中的（下表标「拆段」），大概率是同一首，但值得扫一眼。`);
  }
  const bigDelta = auto.filter(r => r.best.durDelta != null && r.best.durDelta > 3);
  if (bigDelta.length) {
    L.push('');
    L.push(`> 警示：其中 ${bigDelta.length} 首曲名+歌手都对上了、但**时长差 > 3s**（下表标 ⚠），可能是另一个剪辑/版本（短版、Extended、Live），下载前值得点开确认。`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push(`## 可直接下载（${auto.length}）`);
  L.push('');
  L.push('| # | 网易云曲名 | 网易云歌手 | Apple 曲名 | Apple 歌手 | 专辑 | 区 | 时长Δ | 拆段 | 链接 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of auto.slice().sort((a, b) => a.idx - b.idx)) {
    const b = r.best;
    const warn = b.durDelta != null && b.durDelta > 3 ? ' ⚠' : '';
    L.push(`| ${r.idx} | ${esc(r.name)} | ${esc(r.artist)} | ${esc(b.name)} | ${esc(b.artistName)} | ${esc(b.albumName)} | ${(b.storefronts || [b.storefront]).join(',')} | ${b.durDelta != null ? b.durDelta.toFixed(1) + warn : ''} | ${b.partialTitle ? '拆段' : ''} | ${(b.url || '')} |`);
  }
  L.push('');
  L.push(`## 需人工过目（${review.length}）`);
  L.push('');
  L.push('| # | 网易云曲名 | 网易云歌手 | 候选曲名 | 候选歌手 | 候选专辑 | 判定 | 时长Δ | 曲名 | 歌手 | 区 | 链接 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of review.slice().sort((a, b) => a.idx - b.idx)) {
    const b = r.best;
    L.push(`| ${r.idx} | ${esc(r.name)} | ${esc(r.artist)} | ${esc(b.name)} | ${esc(b.artistName)} | ${esc(b.albumName)} | ${r.verdict}${b.versionMismatch ? '(版本:' + b.versionMismatch + ')' : ''} | ${b.durDelta != null ? b.durDelta.toFixed(1) : ''} | ${b.tScore.toFixed(2)} | ${b.aScore.toFixed(2)} | ${(b.storefronts || [b.storefront]).join(',')} | ${(b.url || '')} |`);
  }
  L.push('');
  L.push(`## 未找到（${none.length}）`);
  L.push('');
  L.push('最后一列是**最接近的候选**（未达自动门槛，仅供人工判断），带 Δ 的是时长差。');
  L.push('');
  L.push('| # | 曲名 | 歌手 | 专辑 | 最接近的候选（曲名 — 歌手 [区] 时长Δ） |');
  L.push('|---|---|---|---|---|');
  for (const r of none.slice().sort((a, b) => a.idx - b.idx)) {
    const alt = (r.candidates || []).slice(0, 3)
      .map(c => `${esc(c.name)} — ${esc(c.artistName)} [${(c.storefronts || [c.storefront]).join(',')}]${c.durDelta != null ? ' Δ' + c.durDelta.toFixed(1) + 's' : ''}`).join('<br>');
    L.push(`| ${r.idx} | ${esc(r.name)} | ${esc(r.artist)} | ${esc(r.album)} | ${alt || '(无任何候选)'} |`);
  }
  L.push('');
  fs.writeFileSync(OUT_PREFIX + '-report.md', L.join('\n'), 'utf8');
  // 给下载器用的自动清单：按区聚拢，方便分区喂给 apple-music-alac
  const lines = [];
  for (const sf of STOREFRONTS) {
    const group = auto.filter(r => r.best.storefront === sf);
    if (!group.length) continue;
    lines.push(`# storefront=${sf}  (${group.length})`);
    for (const r of group) lines.push(r.best.url);
  }
  fs.writeFileSync(OUT_PREFIX + '-download.txt', lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

  return { auto: auto.length, review: review.length, none: none.length, bySf };
}

// ---------- 主循环 ----------
(async () => {
  const todo = tracks.filter(t => !done.has(t.idx));
  console.log(`待处理 ${todo.length} / ${tracks.length}`);
  let cursor = 0, finished = 0;
  const t0 = Date.now();
  async function worker() {
    while (cursor < todo.length) {
      const ne = todo[cursor++];
      let rec;
      try { rec = await processTrack(ne); }
      catch (e) { rec = { idx: ne.idx, name: ne.name, artist: ne.artist, album: ne.album, duration: ne.duration, sid: ne.sid, verdict: 'retry', best: null, error: String(e.message) }; }
      results.push(rec); finished++;
      if (finished % 10 === 0 || finished === todo.length) {
        const s = writeOutputs();
        console.log(`  ${finished}/${todo.length} reqs=${reqCount} rl=${rlCount} 可下载=${s.auto} 待确认=${s.review} 未找到=${s.none}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const s = writeOutputs();
  console.log('=== 完成 ===');
  console.log(`可下载 ${s.auto} | 待人工过目 ${s.review} | 未找到 ${s.none} | 请求 ${reqCount} | 限流 ${rlCount}`);
  console.log('命中区：' + JSON.stringify(s.bySf));
  console.log(`产出：${OUT_PREFIX}-report.md / -report.csv / -report.json / -download.txt`);
})();
