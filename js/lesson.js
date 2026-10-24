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
      toks.push({ text: t, b: 0 });
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
  const segs = [];
  let s = 0;
  while (s < words.length) {
    let cut = -1;
    for (let e = s; e < words.length; e++) {
      const len = e - s + 1;
      if ((words[e].b >= bound && len >= min) || (words[e].b === 3 && len >= 2)) { cut = e; break; }
      // 後面隔了一段很長的空白（例如只有音效的片段），一定要斷開，不然會播很久
      if (words[e + 1] && words[e + 1].start - words[e].end > 2) { cut = e; break; }
      if (len >= max) {
        // 太長了：在範圍內找最強、最後面的斷點
        let best = e, bestB = 0;
        for (let k = e; k >= s + min - 1; k--) if (words[k].b > bestB) { bestB = words[k].b; best = k; }
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

// ---------- 存取 ----------
// state：每個字一個字元，0 未完成、1 聽寫正確、2 揭曉、3 Easy 提示
export function newLesson({ videoId, title, words, enhanced, source }) {
  return { videoId, title: title || '', words, state: '0'.repeat(words.length).split(''), level: 'natural', cursor: 0, enhanced: !!enhanced, source };
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
    words: L.words.map(w => [w.text, Math.round(w.start * 100), Math.round(w.end * 100), w.b]),
  };
  const st = lessonStats(L);
  return saveLessonData(L.videoId, data, { title: L.title, total: st.total, done: st.done });
}

export function loadLesson(id) {
  const d = loadLessonData(id);
  if (!d?.words) return null;
  const words = d.words.map(([text, s, e, b]) => ({ text, start: s / 100, end: e / 100, b }));
  const state = (d.state || '').padEnd(words.length, '0').slice(0, words.length).split('');
  return { videoId: d.videoId, title: d.title || '', words, state, level: d.level || 'natural', cursor: d.cursor || 0, enhanced: !!d.enhanced, source: d.source };
}
