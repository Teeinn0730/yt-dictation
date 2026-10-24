// Google Gemini API（免費方案）。金鑰只從瀏覽器直接送到 Google，不經過任何其他伺服器。
import { getSettings, saveSettings } from './storage.js';
import { toSeconds, fillEnds } from './transcript.js';
import { applyEnhanced } from './lesson.js';

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
async function callModel(model, body, { onText, signal } = {}) {
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
export async function generate(parts, { schema, temperature = 0.3, mediaResolution, retries = 2, onText, onStatus, signal } = {}) {
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
      data = await callModel(model, body, { onText, signal });
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
export async function transcribeVideo(videoId, startSec, endSec, { onProgress, onStatus, signal } = {}) {
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
