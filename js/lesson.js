// 課程資料：把字幕拆成「單字」，每個字有時間與斷點強度，三種切句粒度共用同一份進度
import { normWord, lcsPairs } from './dictation.js';
import { loadLessonData, saveLessonData } from './storage.js';

// 斷點強度 b：0 無、1 短詞組、2 意群、3 句尾
export const LEVELS = {
  steady: { label: 'Steady', zh: '短詞組', bound: 1, min: 2, max: 6 },
  natural: { label: 'Natural', zh: '意群', bound: 2, min: 3, max: 12 },
  fluent: { label: 'Fluent', zh: '整句', bound: 3, min: 4, max: 22 },
};

// 這些字前面通常可以斷開成短詞組
const BREAK_BEFORE = new Set(['and', 'but', 'or', 'so', 'because', 'that', 'which', 'who', 'when', 'where', 'while',
  'if', 'then', 'to', 'in', 'on', 'at', 'for', 'with', 'about', 'from', 'like', 'after', 'before', 'until', 'than']);
const ABBR = /^(mr|mrs|ms|dr|st|vs|etc|jr|sr)\.$/i;
const SENTENCE_END = /[.?!…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

export function cuesToWords(cues) {
  const words = [];
  for (const cue of cues) {
    const toks = [];
    for (const t of cue.text.split(/\s+/).filter(Boolean)) {
      if (t === '/' || t === '|') {
        const prev = toks[toks.length - 1] || words[words.length - 1];
        if (prev) prev.b = Math.max(prev.b, t === '|' ? 2 : 1);
        continue;
      }
      if (!normWord(t)) continue;
      toks.push({ text: t, b: 0, cueEnd: false });
    }
    if (!toks.length) continue;
    // 一行字幕裡的每個字，依字元長度估算時間
    const total = toks.reduce((s, t) => s + t.text.length + 1, 0);
    const dur = Math.max(0.3, cue.end - cue.start);
    let off = 0;
    for (const t of toks) {
      const len = t.text.length + 1;
      t.start = cue.start + (dur * off) / total;
      t.end = cue.start + (dur * (off + len)) / total;
      off += len;
      words.push(t);
    }
    toks[toks.length - 1].cueEnd = true;
  }
  applyHeuristics(words);
  return words;
}

function applyHeuristics(words) {
  // 自動字幕常常沒有標點，這時字幕換行處就是最好的意群斷點
  const sentenceEnds = words.filter(w => SENTENCE_END.test(w.text)).length;
  const cueBound = sentenceEnds < words.length / 40 ? 2 : 1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], next = words[i + 1];
    if (SENTENCE_END.test(w.text) && !ABBR.test(w.text)) w.b = 3;
    else if (CLAUSE_END.test(w.text)) w.b = Math.max(w.b, 2);
    if (w.cueEnd) w.b = Math.max(w.b, cueBound);
    if (!next) { w.b = 3; continue; }
    const gap = next.start - w.end;
    if (gap > 1.5) w.b = 3;
    else if (gap > 0.7) w.b = Math.max(w.b, 2);
    if (BREAK_BEFORE.has(normWord(next.text))) w.b = Math.max(w.b, 1);
  }
}

// 套用 Gemini 加好標點與斷點標記（/ 與 |）的文字；用 LCS 對齊，模型改字也不會壞掉
export function applyEnhanced(chunk, text) {
  const toks = [];
  for (const raw of String(text).split(/\s+/).filter(Boolean)) {
    const m = raw.match(/^(.*?)([/|]*)$/);
    const word = m[1], marks = m[2];
    if (word && normWord(word)) toks.push({ text: word, norm: normWord(word), mark: 0 });
    const prev = toks[toks.length - 1];
    if (prev && marks) prev.mark = Math.max(prev.mark, marks.includes('|') ? 2 : 1);
  }
  const pairs = lcsPairs(chunk.map(w => normWord(w.text)), toks.map(t => t.norm));
  for (const [i, j] of pairs) {
    const w = chunk[i], t = toks[j];
    w.text = t.text;
    let b = t.mark;
    if (SENTENCE_END.test(t.text) && !ABBR.test(t.text)) b = 3;
    else if (CLAUSE_END.test(t.text)) b = Math.max(b, 1);
    w.b = Math.max(b, w.cueEnd ? 1 : 0);
  }
  return pairs.length;
}

export function buildSegments(words, level) {
  const { bound, min, max } = LEVELS[level];
  // Natural／Fluent 只在字幕換行處斷句：一行字幕的開始、結束時間是 YouTube 給的，最準；
  // 同一行裡面的字只有估算時間，在行內硬切容易切到聲音。只有 Steady 會切進行內。
  // （舊的課程沒有存換行位置，維持原本的切法）
  const cueAware = level !== 'steady' && words.some(w => w.cueEnd !== undefined);
  const strength = w => {
    if (!cueAware) return w.b;
    if (!w.cueEnd) return 0;
    return level === 'natural' ? Math.max(w.b, 2) : w.b;
  };
  const segs = [];
  let s = 0;
  while (s < words.length) {
    let cut = -1;
    for (let e = s; e < words.length; e++) {
      const len = e - s + 1;
      const b = strength(words[e]);
      if ((b >= bound && len >= min) || (b === 3 && len >= 2)) { cut = e; break; }
      // 後面隔了一段很長的空白（例如只有音效的片段），一定要斷開，不然會播很久
      if (words[e + 1] && words[e + 1].start - words[e].end > 2) { cut = e; break; }
      if (len >= max) {
        // 太長了：在範圍內找最強、最後面的斷點
        // 優先選字幕換行處，其次才是行內的斷點
        let best = e, bestB = 0;
        for (let k = e; k >= s + min - 1; k--) {
          const kb = words[k].b + (words[k].cueEnd ? 10 : 0);
          if (kb > bestB) { bestB = kb; best = k; }
        }
        cut = best;
        break;
      }
    }
    if (cut < 0) cut = words.length - 1;
    segs.push({ from: s, to: cut + 1, start: words[s].start, end: words[cut].end });
    s = cut + 1;
  }
  return segs;
}

// 接續處理：把新產生的字幕接到現有課程裡，原本的進度不變。
// 新字幕以「一行字幕」為單位加入；和現有字幕時間重疊的行會略過，避免重複。回傳加入幾個字
// newPhrases：新字幕裡的片語（索引指向 newWords），會一起換算成合併後的位置
export function appendWords(L, newWords, newPhrases = []) {
  const existing = L.words.slice().sort((a, b) => a.start - b.start);
  const starts = existing.map(w => w.start);
  const covered = (a, b) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < b) lo = mid + 1; else hi = mid; }
    for (let k = lo - 1; k >= 0 && k >= lo - 3; k--) if (existing[k].end > a) return true;
    return false;
  };

  const added = [];
  let group = [];
  for (const w of newWords) {
    group.push(w);
    if (!w.cueEnd && w !== newWords[newWords.length - 1]) continue;
    const a = group[0].start + 0.3, b = Math.max(a + 0.01, group[group.length - 1].end - 0.3);
    if (!covered(a, b)) added.push(...group);
    group = [];
  }
  if (!added.length) return 0;

  const cursorWord = L.words[L.cursor];
  // 片語記住頭尾兩個字本身，合併重新排序後再換算回索引
  const refs = [
    ...(L.phrases || []).map(p => ({ ...p, fw: L.words[p.from], lw: L.words[p.to - 1] })),
    ...newPhrases.map(p => ({ ...p, fw: newWords[p.from], lw: newWords[p.to - 1] })),
  ];
  const all = [
    ...L.words.map((w, i) => ({ w, s: L.state[i] })),
    ...added.map(w => ({ w, s: '0' })),
  ].sort((x, y) => x.w.start - y.w.start);
  L.words = all.map(x => x.w);
  L.state = all.map(x => x.s);
  L.cursor = Math.max(0, L.words.indexOf(cursorWord));
  const pos = new Map(L.words.map((w, i) => [w, i]));
  L.phrases = refs
    .filter(r => pos.has(r.fw) && pos.has(r.lw))
    .map(({ fw, lw, ...p }) => ({ ...p, from: pos.get(fw), to: pos.get(lw) + 1 }))
    .sort((a, b) => a.from - b.from);
  return added.length;
}

// 課程目前涵蓋到影片的第幾秒（接續處理時從這裡開始）
export const lessonEndSec = L => L.words.reduce((m, w) => Math.max(m, w.end), 0);

// ---------- 存取 ----------
// state：每個字一個字元，0 未完成、1 聽寫正確、2 揭曉、3 Easy 提示
// phrases：[{ from, to, phrase, zh, note }]，from/to 是字的索引（to 不含）
export function newLesson({ videoId, title, words, enhanced, source, phrases = [] }) {
  return { videoId, title: title || '', words, state: '0'.repeat(words.length).split(''), level: 'natural', cursor: 0, enhanced: !!enhanced, source, phrases };
}

export function lessonStats(L) {
  const c = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const s of L.state) c[s]++;
  const total = L.state.length;
  return { total, solved: c[1], revealed: c[2], hinted: c[3], done: total - c[0] };
}

export function saveLesson(L) {
  const data = {
    v: 1,
    videoId: L.videoId,
    title: L.title,
    level: L.level,
    cursor: L.cursor,
    enhanced: L.enhanced,
    source: L.source,
    state: L.state.join(''),
    words: L.words.map(w => [w.text, Math.round(w.start * 100), Math.round(w.end * 100), w.b, w.cueEnd ? 1 : 0]),
    phrases: (L.phrases || []).map(p => [p.from, p.to, p.phrase, p.zh, p.note || '']),
  };
  const st = lessonStats(L);
  return saveLessonData(L.videoId, data, { title: L.title, total: st.total, done: st.done });
}

export function loadLesson(id) {
  const d = loadLessonData(id);
  if (!d?.words) return null;
  const words = d.words.map(([text, s, e, b, ce]) => ({ text, start: s / 100, end: e / 100, b, cueEnd: ce === undefined ? undefined : !!ce }));
  const state = (d.state || '').padEnd(words.length, '0').slice(0, words.length).split('');
  const phrases = (d.phrases || []).map(([from, to, phrase, zh, note]) => ({ from, to, phrase, zh, note }));
  return { videoId: d.videoId, title: d.title || '', words, state, level: d.level || 'natural', cursor: d.cursor || 0, enhanced: !!d.enhanced, source: d.source, phrases };
}
