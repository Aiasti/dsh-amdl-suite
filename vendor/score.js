// 网易云 → Apple Music 曲目比对内核（无外部依赖）
// 与 qq-to-apple-match/scripts/score.js 同源，额外处理网易云特有的两件事：
//   * 曲名/歌手名里藏着不可见字符（例：「初音ミク￴」结尾的 U+FFFC），不剥掉永远比不上
//   * 曲名常是「中文本名 + 外文名」拼在一起（例：「献向镜水的月光 Song to the Mirrored Moon」），
//     而 Apple Music 往往只挂其中一种 → 拆文种分段后各自比对
//
// 这个模块是整个匹配流程里最值钱的部分，浓缩了这些坑：
//   * 繁简差异（牛尾憲輔 vs 牛尾宪辅）——不做折叠就永远匹配不上
//   * 日文新字体/异体字（恵 vs 惠）、々 叠字（佐々木 vs 佐佐木）
//   * 片假名 vs 罗马音（ダズビー vs Dazbee）
//   * 歌手串里混着多位歌手（IA/TeddyLoid），只取第一个会判错
//   * ⚠ 千万不要生成「只留拉丁字母」的变体：那会把「電波中毒ガール」和
//     「穴熊ガール」都压成 "garu" 从而假报满分。这是真实踩过的 bug。
//
// OpenCC 繁简表是可选的：缺失时 foldChars 退化为恒等，其余功能照常。
// 安装：node scripts/fetch-opencc.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.NEAM_DATA || process.env.QQAM_DATA || path.join(__dirname, '..', 'data');

// ---------- 不可见字符 ----------
// 网易云会把零宽字符/对象替换字符混进曲名与歌手名，肉眼看不见，却能让相似度掉档。
// 实测本歌单第 12 首的歌手就是「初音ミク」+ U+FFF4（Specials 区的半宽黑方块）。
// 所有入口统一先过 clean()。
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uFFF0-\uFFF8\uFFFC\uFFFD]/g;
const clean = s => (s || '').normalize('NFKC').replace(INVISIBLE, '');

// ---------- 片假名 → 罗马音 ----------
const KANA = {
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o','カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
  'ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go','サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so',
  'ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo','タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do','ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no',
  'ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho','バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
  'パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po','マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
  'ヤ':'ya','ユ':'yu','ヨ':'yo','ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro','ワ':'wa','ヲ':'o',
  'ン':'n','ヴ':'vu','ァ':'a','ィ':'i','ゥ':'u','ェ':'e','ォ':'o','ャ':'ya','ュ':'yu','ョ':'yo','ヮ':'wa',
};
const COMBO = {
  'キャ':'kya','キュ':'kyu','キョ':'kyo','シャ':'sha','シュ':'shu','ショ':'sho','チャ':'cha','チュ':'chu','チョ':'cho',
  'ニャ':'nya','ニュ':'nyu','ニョ':'nyo','ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo','ジャ':'ja','ジュ':'ju','ジョ':'jo',
  'ビャ':'bya','ビュ':'byu','ビョ':'byo','ピャ':'pya','ピュ':'pyu','ピョ':'pyo','ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo',
  'ティ':'ti','ディ':'di','デュ':'dyu','ウィ':'wi','ウェ':'we','ウォ':'wo','ツィ':'tsi','シェ':'she','ジェ':'je','チェ':'che',
};
function romaji(s) {
  const t = clean(s);
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const two = t.slice(i, i + 2);
    if (COMBO[two]) { out += COMBO[two]; i++; continue; }
    const c = t[i];
    if (c === 'ッ') { const r = KANA[t[i + 1]] || ''; out += r ? r[0] : ''; continue; }
    if (c === 'ー' || c === '・' || c === '＝') continue;
    if (KANA[c]) { out += KANA[c]; continue; }
    out += c;
  }
  return out;
}

// ---------- 繁简折叠（OpenCC，可选） ----------
let TS_MAP = null;
function tsMap() {
  if (TS_MAP) return TS_MAP;
  TS_MAP = new Map();
  TS_MAP.__phrases = [];
  try {
    for (const line of fs.readFileSync(path.join(DATA_DIR, 'TSCharacters.txt'), 'utf8').split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 2 && p[0].length === 1) TS_MAP.set(p[0], p[1]);
    }
    TS_MAP.__phrases = fs.readFileSync(path.join(DATA_DIR, 'TSPhrases.txt'), 'utf8').split('\n')
      .map(l => l.trim().split(/\s+/)).filter(p => p.length >= 2);
  } catch (e) { /* 表缺失：退化 */ }
  return TS_MAP;
}
function foldChars(s) {
  const m = tsMap();
  if (!m.size && !m.__phrases.length) return s;
  let t = s;
  for (const [a, b] of m.__phrases) if (t.includes(a)) t = t.split(a).join(b);
  let o = '';
  for (const c of t) o += (m.get(c) || c);
  return o;
}

// 日文新字体/异体字 → 中文也用字形
const JA_VARIANTS = {
  '恵':'惠','遥':'遙','沢':'澤','浜':'濱','辺':'邊','圏':'圈','売':'賣','発':'發','経':'經','対':'對',
  '実':'實','学':'學','国':'國','会':'會','体':'體','気':'氣','広':'廣','応':'應','医':'醫','剣':'劍',
  '検':'檢','険':'險','験':'驗','権':'權','歓':'歡','歯':'齒','歳':'歲','残':'殘','渉':'涉','焼':'燒',
  '状':'狀','総':'總','増':'增','蔵':'藏','臓':'臟','争':'爭','単':'單','団':'團','徳':'德','稲':'稻',
  '薬':'藥','蛍':'螢','齢':'齡','亀':'龜','竜':'龍','縁':'緣','恋':'戀','湾':'灣','変':'變','顕':'顯',
  '県':'縣','芸':'藝','壌':'壤','嬢':'孃','条':'條','穏':'穩','摂':'攝','斎':'齋','粛':'肅','渋':'澀',
  '獣':'獸','塁':'壘','頬':'頰','拠':'據','挙':'舉','叙':'敘','従':'從','豊':'豐','醸':'釀','譲':'讓',
  '弐':'貳','隠':'隱','寛':'寬','覧':'覽','囲':'圍',
};
function foldJa(s) {
  let t = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '々') { t += (t[t.length - 1] || ''); continue; }   // 佐々木 → 佐佐木
    t += (JA_VARIANTS[s[i]] || s[i]);
  }
  return t;
}

const kataToHira = s => s.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const stripParen = s => s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ');

function base(s, o = {}) {
  let t = foldJa(foldChars(clean(s).toLowerCase()));
  if (o.stripParen !== false) t = stripParen(t);
  t = t.replace(/[\s\u3000]+/g, '').replace(/[!-\/:-@\[-`{-~]/g, '').replace(/[、。・，．！？「」『』【】…～~_]/g, '');
  if (o.foldKana) t = kataToHira(t);
  if (o.dropLong) t = t.replace(/[ー\u30FC]/g, '');
  return t;
}

function variants(s) {
  const raw = foldJa(foldChars(clean(s).toLowerCase()));
  const out = new Set([base(s), base(s, { stripParen: false }), base(s, { foldKana: true }),
    base(s, { dropLong: true }), base(s, { foldKana: true, dropLong: true })]);
  const r = romaji(raw);
  if (r !== raw) {
    out.add(base(r));
    out.add(base(r, { stripParen: false }));
    out.add(base(r, { foldKana: true }));
  }
  out.delete('');
  // 守卫：变体至少要保留一半信息量，否则会产生 "garu" 这种假命中
  const full = base(s).length || 1;
  return [...out].filter(v => v.length >= Math.min(3, full));
}

function bigrams(s) { const g = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); if (!g.length && s.length) g.push(s); return g; }
function dice(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b), m = new Map();
  for (const g of A) m.set(g, (m.get(g) || 0) + 1);
  let hit = 0;
  for (const g of B) { const c = m.get(g) || 0; if (c > 0) { hit++; m.set(g, c - 1); } }
  return (2 * hit) / (A.length + B.length);
}
const sim = (a, b) => { let best = 0; for (const x of variants(a)) for (const y of variants(b)) best = Math.max(best, dice(x, y)); return best; };

// 歌手串拆成所有可能的名字：括号里的、被 / & × feat 分开的
function tokens(s) {
  const out = new Set();
  const raw = foldJa(foldChars(clean(s)));
  const push = v => { v = v.trim(); if (v) out.add(v); };
  for (const m of raw.matchAll(/[（(【\[]([^）)】\]]+)[）)】\]]/g))
    for (const p of m[1].split(/[\/&,，、×]/)) push(p);
  const head = stripParen(raw);
  for (const p of head.split(/[\/&,，、×]|\s+feat\.?\s+|\s+ft\.?\s+|\s+vs\.?\s+/i)) push(p);
  out.delete('');
  return [...out];
}
// 只要任意一侧的任意名字对得上就算歌手吻合
function artistSim(qqArtist, appleArtist) {
  let best = 0;
  for (const a of tokens(qqArtist)) for (const b of tokens(appleArtist)) best = Math.max(best, sim(a, b));
  return best;
}
const stripTitle = s => stripParen(clean(s)).trim() || clean(s);

// ---------- 文种分段（网易云特有） ----------
// 网易云的曲名经常把中文本名和外文名拼在一起，Apple Music 上往往只有其中一种。
// 「献向镜水的月光 Song to the Mirrored Moon」整串去跟「Song to the Mirrored Moon」比
// 相似度只有 0.4 左右，必然判 D-no —— 拆开就满分。
const SCRIPT_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[A-Za-z0-9]+(?:['’.\-][A-Za-z0-9]+)*/g;
function segments(s) {
  const parts = clean(s).match(SCRIPT_RE) || [];
  const out = [];
  let cur = '', curScript = null;
  for (const p of parts) {
    const sc = /^[A-Za-z0-9]/.test(p) ? 'latin' : 'cjk';
    if (cur && sc === curScript) cur += (sc === 'latin' ? ' ' : '') + p;
    else { if (cur) out.push(cur); cur = p; curScript = sc; }
  }
  if (cur) out.push(cur);
  const seen = new Set();
  return out.filter(v => v && !seen.has(v) && seen.add(v));
}
// 括号里的名字也是有效曲名形态。
// 网易云常把外文名塞进括号：`연애의 조건 (Love Options)`、`胡广生(电影《无名之辈》推广曲)`。
// Apple 侧往往只挂括号里那一个名字（或反过来），不取括号内容就永远比不上。
// 实测：`연애의 조건 (Love Options) / BESTie` 整串去比只有 0.79，取括号后 1.00。
// 安全阀：`(Instrumental)`/`(Live)` 这类版本标记由 versionMismatch() 拦截，不靠这里过滤。
function parenParts(s) {
  const out = [];
  for (const m of clean(s).matchAll(/[（(【\[]([^）)】\]]+)[）)】\]]/g)) {
    const v = m[1].trim();
    if (v.length >= 3) out.push(v);
  }
  return out;
}
// 只有「中英混排」才拆文种：单一文种的曲名保持原逻辑，避免把「捉迷藏」这类短串拆坏。
// 但归一化段必须**总是**输出：`翦玉令·燕辞归` 与 `翦玉令燕辞归` 只差一个间隔符，
// 旧实现只在 segs.length > 1 时输出，导致 Apple 侧单段 CJK 名永远比不上（2026-11-19）。
function titleForms(s) {
  const full = clean(s);
  const out = [full, stripTitle(full)];
  const segs = segments(stripTitle(full));   // 括号里多是翻译/备注，拆文种前先去掉，避免拼出怪串
  for (const g of segs) if (g.length >= 2) out.push(stripTitle(g));
  for (const p of parenParts(full)) { out.push(p); out.push(stripTitle(p)); }
  return [...new Set(out.filter(Boolean))];
}

// 搜索词：整串 + 去括号串 + 拆出来的各文种串
function titleCandidates(s) {
  return titleForms(s).filter(v => v.length >= 2);
}

// 曲名相似度：对所有形态两两取最大
function titleSimDetail(qqName, apName) {
  let best = 0, form = '';
  const qf = titleForms(qqName), af = titleForms(apName);
  for (const a of qf) for (const b of af) { const v = sim(a, b); if (v > best) { best = v; form = a; } }
  return { tScore: best, form };
}
const titleSim = (qqName, apName) => titleSimDetail(qqName, apName).tScore;

// 版本标记：候选带了这些、而 QQ 曲名没有 → 是另一个版本，不是同一录音
const VERSION_MARKERS = ['instrumental', 'off vocal', 'offvocal', 'off-vocal', '(inst', 'inst.',
  'karaoke', 'カラオケ', '歌っちゃ王', 'piano', 'acoustic', 'tv size', 'tv-size', 'short ver',
  'アコースティック', '弾き語り', 'cover'];
function versionMismatch(qqName, candName) {
  const q = (qqName || '').toLowerCase(), c = (candName || '').toLowerCase();
  for (const m of VERSION_MARKERS) if (c.includes(m) && !q.includes(m)) return m;
  return null;
}

// 判定：曲名+歌手都吻合才算 exact；只有曲名吻合是 ambiguous，不能自动下载
function classify(t, a) {
  if (t >= 0.92 && a >= 0.6) return 'exact';
  if (t >= 0.92 && a >= 0.4) return 'likely';
  if (t >= 0.85 && a >= 0.5) return 'likely';
  if (t >= 0.7 || a >= 0.6) return 'ambiguous';
  return 'none';
}
const RANK = { exact: 3, likely: 2, ambiguous: 1, none: 0 };

// 单条候选打分。耗时/durationInMillis/albumName 用于「时长/专辑」二次确认
function scorePair(qqName, qqArtist, apName, apArtist) {
  const t = titleSim(qqName, apName);
  const a = artistSim(qqArtist, apArtist);
  return { tScore: t, aScore: a, score: 0.65 * t + 0.35 * a };
}

// 综合「名称 + 时长 + 专辑」给出分档。
// 记住：时长单独不可信（钢琴翻奏版、同长不同曲都能撞上），必须配合曲名。
function tierOf({ tScore, aScore, durDelta, albumSim, versionMismatch }) {
  if (tScore >= 0.92 && aScore >= 0.6) return 'A-name';          // 可直接下载
  if (tScore >= 0.9 && durDelta != null && durDelta <= 1.5 && albumSim != null && albumSim >= 0.7) return 'B-duration+album';
  if (tScore >= 0.9 && durDelta != null && durDelta <= 3) return 'C-duration-only';  // 需人工过目
  if (tScore >= 0.9 && albumSim != null && albumSim >= 0.7) return 'C-album-only';
  // 弱匹配兜底：歌手满分 + 时长接近 + 曲名过 0.7，只进复核，不自动下载。
  // 必须排除版本标记（伴奏/翻唱），且时长必须已知。
  if (aScore >= 0.9 && tScore >= 0.7 && durDelta != null && durDelta <= 1.5
      && (versionMismatch === null || versionMismatch === undefined)) return 'C-artist-duration';
  return 'D-no';
}
const AUTO_DOWNLOAD_TIERS = new Set(['A-name', 'B-duration+album']);

module.exports = {
  sim, variants, base, romaji, foldChars, foldJa, tokens, artistSim, stripTitle,
  clean, segments, titleForms, titleCandidates, titleSim, titleSimDetail, parenParts,
  classify, scorePair, tierOf, versionMismatch, RANK, AUTO_DOWNLOAD_TIERS,
  DATA_DIR, VERSION_MARKERS, dice,
};
