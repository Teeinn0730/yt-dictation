// Google Gemini API（免費方案）。金鑰只從瀏覽器直接送到 Google，不經過任何其他伺服器。
import { getSettings, saveSettings } from './storage.js';
import { toSeconds, fillEnds } from './transcript.js';
import { applyEnhanced } from './lesson.js';
import { normWord } from './dictation.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const hasKey = () => !!getSettings().apiKey;

function friendly(status, msg) {
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'API 金鑰無效，請到「設定」頁確認是否貼錯。';
  if (status === 429) return '已達免費額度上限，請稍候一分鐘再試，或到設定頁換一個模型。';
  if (status === 404) return '找不到這個模型，請到「設定」頁按「取得可用模型」換一個。';
  if (status === 403) return `金鑰沒有權限：${msg}`;
  if (status >= 500) return `Gemini 伺服器忙碌中，請稍後再試。（${msg}）`;
  return msg;
}

async function request(path, init = {}) {
  const { apiKey } = getSettings();
  if (!apiKey) throw new GeminiError('尚未設定 Gemini API 金鑰，請先到「設定」頁面貼上。');
  let res;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    });
  } catch {
    throw new GeminiError('無法連線到 Gemini，請檢查網路。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GeminiError(friendly(res.status, data?.error?.message || `HTTP ${res.status}`), res.status);
  return data;
}

const isAbort = e => e?.name === 'AbortError';
const abortError = () => new GeminiError('已取消。', 'abort');

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

const partsText = cand => (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');

// 呼叫一次模型。有 onText 時用串流（SSE），每收到一小段就回報目前累積的文字
// onActivity：只要有收到任何資料（包含模型的思考過程）就呼叫，用來判斷「還活著」
async function callModel(model, body, { onText, onActivity, signal } = {}) {
  const { apiKey } = getSettings();
  if (!apiKey) throw new GeminiError('尚未設定 Gemini API 金鑰，請先到「設定」頁面貼上。');
  const action = onText ? 'streamGenerateContent?alt=sse' : 'generateContent';
  let res;
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal,
    });
  } catch (e) {
    throw isAbort(e) || signal?.aborted ? abortError() : new GeminiError('無法連線到 Gemini，請檢查網路。');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new GeminiError(friendly(res.status, data?.error?.message || `HTTP ${res.status}`), res.status);
  }
  if (!onText) {
    const cand = (await res.json()).candidates?.[0];
    return { text: partsText(cand), finishReason: cand?.finishReason };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', finishReason = '';
  signal?.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        onActivity?.();
        try {
          const cand = JSON.parse(line.slice(5)).candidates?.[0];
          text += partsText(cand);
          if (cand?.finishReason) finishReason = cand.finishReason;
          onText(text);
        } catch { /* 不完整的一行，略過 */ }
      }
    }
  } catch (e) {
    throw isAbort(e) || signal?.aborted ? abortError() : new GeminiError('連線中斷，請再試一次。');
  }
  if (signal?.aborted) throw abortError();
  return { text, finishReason };
}

// onText：串流時回報目前文字；onStatus：重試、換模型等狀態訊息；signal：用來取消
export async function generate(parts, { schema, temperature = 0.3, mediaResolution, retries = 2, onText, onActivity, onStatus, signal } = {}) {
  let { model } = getSettings();
  let healed = false;
  const generationConfig = { temperature };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }
  if (mediaResolution) generationConfig.mediaResolution = mediaResolution;
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig });

  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      data = await callModel(model, body, { onText, onActivity, signal });
      break;
    } catch (e) {
      // 每分鐘次數用完時，等一下再重試
      if (attempt < retries && (e.status === 429 || e.status >= 500)) {
        onStatus?.(e.status === 429 ? '免費額度暫時用完，20 秒後自動重試…' : 'Gemini 伺服器忙碌，20 秒後自動重試…');
        await sleep(20000, signal);
        continue;
      }
      // 模型被 Google 淘汰了：自動換成目前可用的推薦模型再試一次
      if (e.status === 404 && !healed) {
        healed = true;
        const next = recommendModel(await listModels().catch(() => []));
        if (next && next !== model) {
          model = next;
          saveSettings({ ...getSettings(), model });
          window.dispatchEvent(new CustomEvent('gemini-model-changed', { detail: model }));
          continue;
        }
      }
      throw e;
    }
  }
  const { text, finishReason } = data;
  if (!text) throw new GeminiError(`Gemini 沒有回傳內容${finishReason ? `（${finishReason}）` : ''}，請再試一次。`);
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    throw new GeminiError('Gemini 回傳的格式有誤，請再試一次。');
  }
}

export async function listModels() {
  const data = await request('/models?pageSize=200');
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
    .map(m => m.name.replace(/^models\//, ''));
}

// 從可用清單挑一個適合的模型：優先「最新的 flash」別名，其次版本最新的正式版 flash
export function recommendModel(models) {
  if (models.includes('gemini-flash-latest')) return 'gemini-flash-latest';
  const version = m => parseFloat((m.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const special = /image|tts|live|audio|embed|robotics|computer|native/i;
  const byVersion = (a, b) => version(b) - version(a) || a.length - b.length;
  const flash = models.filter(m => /flash/i.test(m) && !special.test(m));
  const stable = flash.filter(m => !/lite|exp|preview|thinking/i.test(m)).sort(byVersion);
  return stable[0] || flash.sort(byVersion)[0] || models[0] || null;
}

export const testConnection = () => generate([{ text: 'Reply with exactly: OK' }], { temperature: 0, retries: 0 });

const MARKER_RULES = `- Insert " / " between short phrases (about 2–5 words) and " | " between thought groups (sense groups of about 4–10 words that a listener naturally processes together).
- Sentence-final punctuation (. ? !) already marks a boundary; do not add a marker right after it.`;

// ---------- 沒有字幕時：讓 Gemini 直接看 YouTube 影片產生字幕 ----------
const TRANSCRIBE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    language: { type: 'STRING' },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, text: { type: 'STRING' } },
        required: ['start', 'end', 'text'],
      },
    },
  },
  required: ['language', 'segments'],
};

// onProgress({ count, at, pct })：目前產生了幾句、寫到影片第幾秒、完成比例（0~1）
export async function transcribeVideo(videoId, startSec, endSec, { onProgress, onActivity, onStatus, signal } = {}) {
  const prompt = `You are a professional caption transcriber.
Transcribe ALL spoken English in this video clip verbatim. Do not summarize, paraphrase or correct the speaker's grammar.
- Use normal English capitalization and punctuation.
${MARKER_RULES}
- Split into caption segments of one short sentence each (roughly 2–7 seconds). Timestamps must be as precise as possible.
- Timestamps use MM:SS.s or H:MM:SS.s, measured from the beginning of the FULL video (not from the clip start).
- Skip music, sound effects and silence.
- "language": the ISO code of the main spoken language (e.g. "en").`;
  const videoPart = {
    fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
    videoMetadata: { startOffset: `${Math.floor(startSec)}s`, endOffset: `${Math.floor(endSec)}s` },
  };
  const span = Math.max(1, endSec - startSec);
  // 從串流中途的 JSON 文字抓出最後一個 start 時間，換算成進度
  const onText = text => {
    const starts = [...text.matchAll(/"start"\s*:\s*"([^"]+)"/g)].map(m => toSeconds(m[1])).filter(Number.isFinite);
    if (!starts.length) return;
    const at = starts[starts.length - 1];
    const rel = at >= startSec ? at - startSec : at; // 模型偶爾用片段內的時間
    onProgress?.({ count: starts.length, at: startSec + rel, pct: Math.min(1, rel / span) });
  };
  const out = await generate([videoPart, { text: prompt }], {
    schema: TRANSCRIBE_SCHEMA,
    temperature: 0.1,
    mediaResolution: 'MEDIA_RESOLUTION_LOW',
    onText,
    onActivity,
    onStatus,
    signal,
  });
  let cues = (out.segments || [])
    .map(s => ({ start: toSeconds(s.start), end: toSeconds(s.end), text: String(s.text || '').trim() }))
    .filter(c => c.text && Number.isFinite(c.start));
  // 有時模型會用「片段內」的時間，這時補上起始偏移
  if (startSec > 0 && cues.length && Math.max(...cues.map(c => c.start)) < startSec) {
    cues = cues.map(c => ({ ...c, start: c.start + startSec, end: c.end + startSec }));
  }
  cues.sort((a, b) => a.start - b.start);
  return { language: String(out.language || '').toLowerCase(), cues: fillEnds(cues) };
}

// ---------- 長影片：拆成 5 分鐘一段依序處理，再合併成一份 ----------
const CHUNK_SEC = 300;
const OVERLAP_SEC = 8;

// 兩句幾乎同時開始、而且字大部分一樣：視為交界處重複產生的同一句
function isDuplicate(merged, cue) {
  const words = new Set(cue.text.split(/\s+/).map(normWord).filter(Boolean));
  if (!words.size) return true;
  return merged.slice(-4).some(m => {
    if (Math.abs(m.start - cue.start) > 3) return false;
    const other = m.text.split(/\s+/).map(normWord).filter(Boolean);
    const same = other.filter(w => words.has(w)).length;
    return same / Math.max(1, Math.min(words.size, other.length)) >= 0.6;
  });
}

// 每段前後多看 8 秒，句子不會在交界處被切斷；合併時每段只留「開始時間在自己範圍內」的句子，再去掉重複
// 某一段失敗時，錯誤物件的 partial 會帶著已完成的部分，讓呼叫端可以先建立練習
export async function transcribeRange(videoId, startSec, endSec, { onChunk, onProgress, onActivity, onStatus, signal } = {}) {
  const n = Math.max(1, Math.ceil((endSec - startSec) / CHUNK_SEC));
  const merged = [];
  let language = '';
  for (let i = 0; i < n; i++) {
    const cs = startSec + i * CHUNK_SEC;
    const ce = Math.min(endSec, cs + CHUNK_SEC);
    onChunk?.(i, n, cs, ce);
    let res;
    try {
      res = await transcribeVideo(videoId, Math.max(0, i ? cs - OVERLAP_SEC : cs), i < n - 1 ? ce + OVERLAP_SEC : ce, {
        onActivity,
        onStatus,
        signal,
        onProgress: p => onProgress?.({
          chunk: i,
          chunks: n,
          count: merged.length + p.count,
          at: p.at,
          pct: (i + Math.min(1, Math.max(0, (p.at - cs) / Math.max(1, ce - cs)))) / n,
        }),
      });
    } catch (e) {
      e.partial = { cues: fillEnds(merged.slice()), language, doneUntil: cs, chunk: i, chunks: n };
      throw e;
    }
    if (!language) language = res.language;
    for (const c of res.cues) {
      if (i > 0 && c.start < cs) continue;      // 屬於上一段
      if (i < n - 1 && c.start >= ce) continue; // 屬於下一段
      if (isDuplicate(merged, c)) continue;
      merged.push(c);
    }
  }
  merged.sort((a, b) => a.start - b.start);
  return { language, cues: fillEnds(merged) };
}

// ---------- 有字幕時：只請 Gemini 補標點、標出切句位置（純文字，很省額度） ----------
const ENHANCE_SCHEMA = { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] };
const CHUNK = 400;

export async function enhanceWords(words, { onProgress, onStatus, signal } = {}) {
  const n = Math.ceil(words.length / CHUNK);
  for (let c = 0; c < n; c++) {
    const chunk = words.slice(c * CHUNK, (c + 1) * CHUNK);
    const prompt = `Below is a fragment of a raw English video transcript (often auto-generated, may lack punctuation).
Return EXACTLY the same words in the same order. Do not add, remove, reorder, or correct any word.
Only:
- add proper punctuation and capitalization;
${MARKER_RULES}

Transcript:
"""
${chunk.map(w => w.text).join(' ')}
"""`;
    const out = await generate([{ text: prompt }], { schema: ENHANCE_SCHEMA, temperature: 0.1, onStatus, signal });
    applyEnhanced(chunk, out.text || '');
    onProgress?.(c + 1, n);
  }
}

// ---------- 標出片語 ----------
const PHRASE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    phrases: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING' }, phrase: { type: 'STRING' }, zh: { type: 'STRING' }, note: { type: 'STRING' } },
        required: ['text', 'phrase', 'zh'],
      },
    },
  },
  required: ['phrases'],
};

// 找出字幕裡的片語、慣用語、動詞片語、固定搭配。回傳 [{ from, to, phrase, zh, note }]，from/to 是字的索引（to 不含）
export async function findPhrases(words, { onProgress, onStatus, signal } = {}) {
  const norms = words.map(w => normWord(w.text));
  const found = [];
  const n = Math.ceil(words.length / CHUNK);
  for (let c = 0; c < n; c++) {
    const from = c * CHUNK, to = Math.min(words.length, (c + 1) * CHUNK);
    const prompt = `You are helping a Taiwanese intermediate English learner study an English video transcript.
Find the idioms, phrasal verbs, fixed expressions and useful collocations (2 words or more) in the transcript below.
- Skip trivial word combinations (e.g. "of the", "I am", "it is"), names and titles.
- text: the words EXACTLY as they appear in the transcript (a contiguous run of words, copied verbatim).
- phrase: the dictionary form, using "someone"/"something" for variable parts (e.g. "in the middle of nowhere", "make someone look bad", "give up").
- zh: a concise meaning in Traditional Chinese (Taiwan usage) that fits this context.
- note: optional, one very short usage note in Traditional Chinese (or empty).

Transcript:
<<<
${words.slice(from, to).map(w => w.text).join(' ')}
>>>`;
    const res = await generate([{ text: prompt }], { schema: PHRASE_SCHEMA, temperature: 0.2, onStatus, signal });
    for (const p of res.phrases || []) {
      const toks = String(p.text || '').split(/\s+/).map(normWord).filter(Boolean);
      if (toks.length < 2) continue;
      // 在這一段裡找出所有出現的位置（模型給的是原文，用比對的方式定位，比要它給索引可靠）
      for (let i = from; i + toks.length <= to; i++) {
        if (toks.every((t, k) => norms[i + k] === t)) {
          found.push({ from: i, to: i + toks.length, phrase: String(p.phrase || p.text).trim(), zh: String(p.zh || '').trim(), note: String(p.note || '').trim() });
        }
      }
    }
    onProgress?.(c + 1, n);
  }
  // 互相重疊時，保留比較長的片語
  found.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  const used = new Uint8Array(words.length);
  const kept = [];
  for (const p of found) {
    let free = true;
    for (let i = p.from; i < p.to; i++) if (used[i]) { free = false; break; }
    if (!free) continue;
    for (let i = p.from; i < p.to; i++) used[i] = 1;
    kept.push(p);
  }
  return kept.sort((a, b) => a.from - b.from);
}

// ---------- 單字中文解釋 ----------
const EXPLAIN_SCHEMA = {
  type: 'OBJECT',
  properties: { zh: { type: 'STRING' }, pos: { type: 'STRING' }, note: { type: 'STRING' } },
  required: ['zh', 'pos', 'note'],
};

export function explainWord(word, sentence) {
  const prompt = `Explain the English word "${word}" as it is used in this sentence:
"${sentence}"
- zh: its meaning in THIS context, in concise Traditional Chinese (Taiwan usage).
- pos: part of speech, in Traditional Chinese (e.g. 動詞, 名詞).
- note: one short, useful note in Traditional Chinese — a common collocation, a phrasal verb it belongs to, or a pronunciation trap (e.g. it gets linked or reduced in fast speech). Keep English examples in English.`;
  return generate([{ text: prompt }], { schema: EXPLAIN_SCHEMA, temperature: 0.2 });
}
