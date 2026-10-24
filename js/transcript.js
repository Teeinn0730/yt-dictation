// 字幕解析：支援 YouTube「顯示轉錄稿」複製的文字、SRT、VTT、以及 "0:00 text" 單行格式
const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const TIME_RE = new RegExp(`^\\[?(${TS})\\]?$`);
const TIME_PREFIX_RE = new RegExp(`^\\[?(${TS})\\]?\\s+(.+)$`);
const ARROW_RE = new RegExp(`^(${TS})\\s*-->\\s*(${TS})`);
// YouTube 轉錄稿複製時常夾帶的無障礙標籤，例如「1 分鐘 5 秒」「5 seconds」
const UNIT = '(?:小時|分鐘|分|秒鐘|秒|hours?|minutes?|seconds?)';
const DURATION_LABEL_RE = new RegExp(`^(\\d+\\s*${UNIT}\\s*[,，、]?\\s*)+$`, 'i');
// 新版轉錄稿：時間和朗讀標籤黏在一起，例如「0:1515 秒BUT CREEPY…」「1:051 分鐘 5 秒Hello」
const LABELED_RE = new RegExp(`^\\[?(${TS})\\]?\\s*((?:\\d+\\s*${UNIT}[,，、\\s]*)+)(.*)$`, 'i');
// 只有 [Music]、(laughs) 這類標記的行
const NOISE_RE = /^[\[(（【♪][^\])）】]*[\])）】♪]?$/;
// 轉錄稿面板裡的章節標題，例如「第 1 章節：Intro」「Chapter 2: ...」
const CHAPTER_RE = /^(第\s*\d+\s*章節?\s*[:：]|chapter\s+\d+\s*[:：])/i;
// 字幕製作單位的說明，不適合拿來練習
const CREDIT_RE = /caption(ing|ed)\s+(made\s+possible|by)|subtitles?\s+by/i;

export function toSeconds(ts) {
  return String(ts).trim().replace(',', '.').split(':').map(Number).reduce((acc, p) => acc * 60 + p, 0);
}

export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function cleanText(t) {
  return t
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [Music] (laughs) 這類行內標記
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ')
    // 說話者名稱，例如「Eustace: OH, DOG!」「Le Quack: DIRTY DOG.」（全大寫字幕裡的人名是大小寫混合）
    .replace(/(^|[\s.!?])(?:[A-Z][a-z][A-Za-z.]*)(?: [A-Z][a-z][A-Za-z.]*)?:\s/g, '$1 ')
    .replace(/(^|\s)[-–—]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseTranscript(raw) {
  const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim());
  const cues = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line === 'WEBVTT' || /^(NOTE|STYLE|Kind:|Language:)/.test(line)) continue;
    if (CHAPTER_RE.test(line)) continue;
    let m;
    if ((m = line.match(ARROW_RE))) {
      cur = { start: toSeconds(m[1]), end: toSeconds(m[2]), text: '' };
      cues.push(cur);
      continue;
    }
    if (/^\d+$/.test(line) && ARROW_RE.test(lines[i + 1] || '')) continue; // SRT 序號
    if ((m = line.match(TIME_RE))) {
      cur = { start: toSeconds(m[1]), end: null, text: '' };
      cues.push(cur);
      continue;
    }
    if ((m = line.match(LABELED_RE))) {
      cur = { start: toSeconds(m[1]), end: null, text: cleanText(m[3]) };
      cues.push(cur);
      continue;
    }
    if ((m = line.match(TIME_PREFIX_RE))) {
      cur = { start: toSeconds(m[1]), end: null, text: cleanText(m[2]) };
      cues.push(cur);
      continue;
    }
    if (DURATION_LABEL_RE.test(line) || NOISE_RE.test(line)) continue;
    if (cur) {
      const t = cleanText(line);
      if (t) cur.text = cur.text ? `${cur.text} ${t}` : t;
    }
  }
  // 先用「全部」的行算出結束時間，再過濾掉 [Screaming]、製作單位這類行：
  // 被過濾的行雖然不練習，但它的開始時間代表前一句台詞已經說完了
  cues.sort((a, b) => a.start - b.start);
  fillEnds(cues);
  const out = cues.filter(c => /[A-Za-z0-9㐀-鿿]/.test(c.text) && !CREDIT_RE.test(c.text));
  if (isMostlyUpper(out)) {
    let start = true; // 上一行以句號結尾時，這一行開頭才大寫
    for (const c of out) {
      c.text = toSentenceCase(c.text, start);
      start = /[.!?]["')\]]*$/.test(c.text);
    }
  }
  return out;
}

function isMostlyUpper(cues) {
  const letters = cues.map(c => c.text).join('').replace(/[^A-Za-z]/g, '');
  return letters.length > 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8;
}

// 全大寫字幕轉成一般寫法：全部小寫，句首與 I 大寫（人名之後交給 Gemini 補）
function toSentenceCase(text, capitalizeFirst) {
  const s = text
    .toLowerCase()
    .replace(/\bi\b/g, 'I')
    .replace(/([.!?]\s+)([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
  return capitalizeFirst ? s.replace(/^([^A-Za-z]*)([a-z])/, (m, pre, ch) => pre + ch.toUpperCase()) : s;
}

// 大約要花幾秒說完：英文每字約 0.6 秒、中文每字約 0.3 秒，再加一點緩衝
function speechSeconds(text) {
  const words = (text.match(/[A-Za-z0-9'’]+/g) || []).length;
  const cjk = (text.match(/[㐀-鿿]/g) || []).length;
  return 1.5 + words * 0.6 + cjk * 0.3;
}

export function fillEnds(cues) {
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (cues[i].end == null || !(cues[i].end > cues[i].start)) {
      // 轉錄稿只有開始時間：到下一行開始為止，但不超過「說完這些字」需要的時間，
      // 避免把幾秒的台詞攤到後面一大段沒有人說話的空白
      const until = next ? next.start : cues[i].start + 5;
      cues[i].end = Math.min(until, cues[i].start + speechSeconds(cues[i].text));
    }
    cues[i].end = Math.min(cues[i].end, cues[i].start + 15);
  }
  return cues;
}

export function detectLang(cues) {
  const all = cues.map(c => c.text).join(' ');
  const cjk = (all.match(/[㐀-鿿]/g) || []).length;
  const latinWords = (all.match(/[A-Za-z]+/g) || []).length;
  return cjk >= latinWords ? 'zh' : 'en';
}
