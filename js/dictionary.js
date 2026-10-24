// 免費、免金鑰的英英字典：
// - Datamuse（https://www.datamuse.com/api/）：IPA 和英文解釋，變化形也查得到
// - Free Dictionary API（https://dictionaryapi.dev）：真人發音音檔（服務不穩，查不到就用瀏覽器語音）
import { normWord } from './dictation.js';

const cache = new Map();
const POS = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: '' };

async function fetchJson(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function datamuse(word) {
  const data = await fetchJson(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=dr&ipa=1&max=1`);
  const e = data?.[0];
  if (!e || normWord(e.word) !== normWord(word)) return null;
  const ipaTag = (e.tags || []).find(t => t.startsWith('ipa_pron:'));
  const groups = new Map();
  for (const d of e.defs || []) {
    const [pos, def] = d.split('\t');
    const key = POS[pos] ?? pos;
    if (!groups.has(key)) groups.set(key, []);
    if (groups.get(key).length < 2) groups.get(key).push(def.trim());
  }
  return {
    headword: e.defHeadword || '',
    ipa: ipaTag ? `/${ipaTag.slice(9)}/` : '',
    meanings: [...groups].slice(0, 3).map(([pos, defs]) => ({ pos, defs })),
  };
}

async function audioUrls(word) {
  const data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, 4000);
  const phonetics = (Array.isArray(data) ? data : []).flatMap(e => e.phonetics || []);
  const find = kind => phonetics.find(p => p.audio && new RegExp(`-${kind}\\.mp3$`).test(p.audio))?.audio || '';
  return { audioUS: find('us'), audioUK: find('uk') };
}

export async function lookup(word) {
  const key = normWord(word);
  if (cache.has(key)) return cache.get(key);
  const [dm, audio] = await Promise.all([datamuse(word), audioUrls(word.toLowerCase())]);
  const result = dm || audio.audioUS || audio.audioUK ? { ipa: '', meanings: [], headword: '', ...dm, ...audio } : null;
  cache.set(key, result);
  return result;
}

export function speak(text, lang = 'en-US', rate = 0.9) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = rate;
  const voice = speechSynthesis.getVoices().find(v => v.lang === lang);
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

export function pronounce(word, info, accent = 'us') {
  const url = accent === 'uk' ? info?.audioUK : info?.audioUS;
  const fallback = () => speak(word, accent === 'uk' ? 'en-GB' : 'en-US');
  if (url) new Audio(url).play().catch(fallback);
  else fallback();
}
