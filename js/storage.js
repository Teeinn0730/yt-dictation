// 所有資料都只存在這台裝置的瀏覽器 localStorage
const PREFIX = 'ytel.';
const K = { settings: 'ytel.settings', lessons: 'ytel.lessons', vocab: 'ytel.vocab' };
const lessonKey = id => `ytel.lesson.${id}`;
export const DEFAULT_MODEL = 'gemini-flash-latest';

export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ---------- 設定 ----------
const DEFAULT_SETTINGS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  rate: 1,
  repeat: 1,
  autoplay: true,
  hideVideo: false,
  showCC: false,
  easy: false,
  typingSound: true,
  volume: 100,
  muted: false,
  sfxVolume: 60,
  keySound: 'builtin',
};

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...load(K.settings, {}) };
  if (!s.model) s.model = DEFAULT_MODEL;
  // 內建鍵盤錄音推出前存的預設（青軸）改成新的預設；自訂音檔的設定保留
  if (!s.keySoundV2) {
    if (s.keySound !== 'custom') s.keySound = 'builtin';
    s.keySoundV2 = true;
  }
  return s;
}
export const saveSettings = s => save(K.settings, s);

// ---------- 課程（每部影片一份） ----------
export const listLessons = () => load(K.lessons, []);
export const loadLessonData = id => load(lessonKey(id), null);

export function saveLessonData(id, data, summary) {
  let ok = save(lessonKey(id), data);
  // 空間不夠：從最久沒練的影片開始刪
  const others = listLessons().filter(l => l.videoId !== id).sort((a, b) => (a.updated || '').localeCompare(b.updated || ''));
  while (!ok && others.length) {
    const victim = others.shift();
    try { localStorage.removeItem(lessonKey(victim.videoId)); } catch { /* ignore */ }
    save(K.lessons, listLessons().filter(l => l.videoId !== victim.videoId));
    ok = save(lessonKey(id), data);
  }
  if (!ok) return false;
  const index = listLessons().filter(l => l.videoId !== id);
  index.unshift({ videoId: id, ...summary, updated: new Date().toISOString() });
  save(K.lessons, index);
  return true;
}

export function deleteLesson(id) {
  try { localStorage.removeItem(lessonKey(id)); } catch { /* ignore */ }
  save(K.lessons, listLessons().filter(l => l.videoId !== id));
}

// ---------- 單字本 ----------
export const loadVocab = () => load(K.vocab, []);
export const saveVocab = list => save(K.vocab, list);

export function clearAll() {
  try {
    Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
