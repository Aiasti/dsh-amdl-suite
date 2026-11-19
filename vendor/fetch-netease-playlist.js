#!/usr/bin/env node
// 抓取网易云音乐歌单的完整曲目表（曲名 / 歌手 / 专辑 / 时长）。
//
// 用法:
//   node fetch-netease-playlist.js <歌单ID或URL> [输出json]
//   node fetch-netease-playlist.js --songs <歌曲ID,歌曲ID,...> [输出json]
//
// 输出格式与 qq-to-apple-match 的曲目表一致：
//   { meta: {id,name,owner,ownerId,total,via,fetchedAt}, tracks: [{idx,name,artist,album,duration,sid}] }
//   duration 是**秒**（网易云接口给的是毫秒 dt，这里已换算）。
//
// 踩过的坑（与 QQ 侧同源）：
//   * 数字 ID 在不同平台含义不同。网易云歌单 ID 走 Meting 类接口时**必须显式 server=netease**，
//     不带 server 参数时它恰好默认走网易云——但这属于「碰巧」，不能依赖，一律显式写死。
//   * 拿到结果必须核对数量：trackCount / trackIds.length / tracks.length 三者要一致，
//     不一致说明被截断或分页了，要先补齐再匹配，否则报告会静默少歌。
//   * 分享链接带 creatorId 时要和接口返回的 playlist.userId 对齐，
//     对不上说明解析到了另一张歌单（QQ 侧真出过这个事故）。
const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
  'Content-Type': 'application/x-www-form-urlencoded',
  Cookie: 'appver=8.9.70; os=pc; channel=netease;',
  'Accept-Encoding': 'identity',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(url, { method = 'GET', body = null, headers = {} } = {}, depth = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method,
      headers: { ...HEADERS, ...headers }, timeout: 40000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth > 0) {
        res.resume();
        const nx = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return resolve(request(nx, { method, body, headers }, depth - 1));
      }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const post = (url, body, headers) => request(url, { method: 'POST', body, headers });
const get = (url, headers) => request(url, { headers });

// 从 URL 或裸 ID 里取歌单 ID；顺带把分享链接里的 creatorId 抠出来做一致性校验
function parseTarget(input) {
  const s = String(input);
  const idm = s.match(/(?:playlist\?|playlist\/|disstid=|id=)?(\d{5,})/);
  if (!idm) throw new Error('无法从 "' + input + '" 解析出歌单 ID');
  const cm = s.match(/creatorId=(\d+)/i);
  return { id: idm[1], creatorId: cm ? cm[1] : null };
}

function songToTrack(s, i) {
  return {
    idx: i + 1,
    name: (s.name || '').trim(),
    artist: (s.ar || s.artists || []).map(a => a.name).join('/'),
    album: s.al?.name || s.album?.name || '',
    duration: s.dt != null ? Math.round(s.dt / 1000) : (s.duration != null ? Math.round(s.duration / 1000) : null),
    sid: String(s.id),
    fee: s.fee,
    mv: s.mv || 0,
  };
}

// 官方 v6 详情：信息最全（含专辑名与毫秒时长），且公开歌单无需登录
async function viaV6(id) {
  const r = await post('https://music.163.com/api/v6/playlist/detail', `id=${id}&n=1000&s=8`);
  if (r.status !== 200) throw new Error('v6 HTTP ' + r.status);
  const j = JSON.parse(r.body);
  if (j.code !== 200 || !j.playlist) throw new Error('v6 code=' + j.code + (j.message ? ' ' + j.message : ''));
  const pl = j.playlist;
  return {
    meta: {
      id: String(pl.id), name: pl.name, owner: pl.creator?.nickname || '', ownerId: String(pl.userId),
      total: pl.trackCount, trackIds: (pl.trackIds || []).map(t => String(t.id ?? t)),
      playCount: pl.playCount, subscribedCount: pl.subscribedCount,
      createTime: pl.createTime, updateTime: pl.updateTime, description: pl.description || '',
    },
    tracks: (pl.tracks || []).filter(Boolean).map(songToTrack),
  };
}

// Meting 回落：**必须显式 server=netease**
async function viaMeting(id) {
  const r = await get(`https://api.injahow.cn/meting/?server=netease&type=playlist&id=${id}`);
  if (r.status !== 200) throw new Error('meting HTTP ' + r.status);
  const arr = JSON.parse(r.body);
  if (!Array.isArray(arr)) throw new Error('meting 返回不是数组');
  return {
    meta: { id: String(id), name: '', owner: '', ownerId: '', total: arr.length, trackIds: [], via: 'meting-netease' },
    tracks: arr.map((t, i) => ({
      idx: i + 1, name: (t.name || '').trim(), artist: (t.artist || '').trim(), album: '',
      duration: null, sid: String(t.url || '').replace(/.*id=/, ''),
    })),
  };
}

// v6 只给前若干首时（大歌单/未登录），按 trackIds 把缺的补回来
async function fillMissing(data) {
  const have = new Set(data.tracks.map(t => t.sid));
  const missing = (data.meta.trackIds || []).filter(id => !have.has(String(id)));
  if (!missing.length) return data;
  console.error(`[info] v6 只给了 ${data.tracks.length} 首，按 trackIds 补 ${missing.length} 首`);
  const got = new Map();
  for (let i = 0; i < missing.length; i += 200) {
    const batch = missing.slice(i, i + 200);
    const r = await post('https://music.163.com/api/v3/song/detail', 'c=' + encodeURIComponent(JSON.stringify(batch.map(id => ({ id: Number(id) })))));
    if (r.status === 200) {
      try { for (const s of (JSON.parse(r.body).songs || [])) got.set(String(s.id), s); } catch (e) { /* ignore */ }
    }
    await sleep(600);
  }
  const full = [];
  for (const id of data.meta.trackIds) {
    const s = got.get(String(id));
    const old = data.tracks.find(t => t.sid === String(id));
    if (old) full.push(old); else if (s) full.push(songToTrack(s, full.length));
    else console.error(`[warn] 歌曲 ${id} 详情缺失，跳过`);
  }
  data.tracks = full.map((t, i) => ({ ...t, idx: i + 1 }));
  return data;
}

async function viaSongIds(ids) {
  const tracks = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const r = await post('https://music.163.com/api/v3/song/detail', 'c=' + encodeURIComponent(JSON.stringify(batch.map(id => ({ id: Number(id) })))));
    if (r.status !== 200) throw new Error('song/detail HTTP ' + r.status);
    const j = JSON.parse(r.body);
    for (const s of (j.songs || [])) if (s && s.name) tracks.push(songToTrack(s, tracks.length));
    await sleep(600);
  }
  return { meta: { id: '', name: `(单曲清单 ${ids.length} 首)`, owner: '', ownerId: '', total: tracks.length, trackIds: ids, via: 'netease-song-detail' }, tracks };
}

(async () => {
  const argv = process.argv.slice(2);
  const outArg = argv.find(a => a.endsWith('.json'));
  const songsIdx = argv.indexOf('--songs');
  let data, via;

  if (songsIdx !== -1) {
    const ids = String(argv[songsIdx + 1] || '').split(/[,\s]+/).filter(Boolean);
    if (!ids.length) { console.error('--songs 后面要跟歌曲 ID 列表'); process.exit(2); }
    data = await viaSongIds(ids);
    via = 'netease-song-detail';
  } else {
    const input = argv.find(a => !a.startsWith('--') && !a.endsWith('.json'));
    if (!input) { console.error('用法: node fetch-netease-playlist.js <歌单ID或URL> [输出json]'); process.exit(2); }
    const { id, creatorId } = parseTarget(input);
    try {
      data = await viaV6(id);
      via = 'netease-v6';
    } catch (e) {
      console.error('[warn] v6 失败：' + e.message + '，回落到 Meting(server=netease)');
      data = await viaMeting(id);
      via = 'meting-netease';
    }
    if (data.meta.total && data.tracks.length < data.meta.total) data = await fillMissing(data);
    // 一致性三连：接口自报 / trackIds / 实际曲目
    const n = data.tracks.length;
    if (data.meta.total && n !== data.meta.total) console.error(`[warn] 数量对不上：拿到 ${n} 首，接口自报 ${data.meta.total} 首——匹配前先确认`);
    if (data.meta.trackIds?.length && n !== data.meta.trackIds.length) console.error(`[warn] trackIds ${data.meta.trackIds.length} 个，实际解析 ${n} 首`);
    if (creatorId && data.meta.ownerId && creatorId !== data.meta.ownerId) {
      console.error(`[warn] ⚠ 链接里的 creatorId=${creatorId} 与歌单归属人 userId=${data.meta.ownerId} 不一致——可能解析到了另一张歌单，先人工核对！`);
    }
  }

  const id = data.meta.id || 'songs';
  const outFile = outArg || path.join(process.cwd(), `netease-playlist-${id}.json`);
  data.meta.via = data.meta.via || via;
  data.meta.fetchedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(data, null, 1), 'utf8');

  console.log(`歌单：${data.meta.name || '(未命名)'}  主人：${data.meta.owner || '?'}${data.meta.ownerId ? ' (' + data.meta.ownerId + ')' : ''}`);
  console.log(`曲目：${data.tracks.length} 首（接口自报 ${data.meta.total ?? '?'}）  来源：${data.meta.via}`);
  const noDur = data.tracks.filter(t => !t.duration).length;
  if (noDur) console.log(`[warn] ${noDur} 首没有时长——「时长复核」对这些曲子无效，它们只能靠曲名+歌手判定`);
  console.log('已写入 ' + outFile);
  console.log('前 5 首：');
  for (const t of data.tracks.slice(0, 5)) console.log(`  ${t.idx}. ${t.name} — ${t.artist} [${t.album}] ${t.duration || '?'}s`);
})();
