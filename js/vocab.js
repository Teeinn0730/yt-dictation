// 單字本 + 簡易間隔重複（忘記 → 10 分鐘後、模糊 → 拉長一點、記得 → 1、3、7…天）
import { loadVocab, saveVocab } from './storage.js';

const DAY = 24 * 60 * 60 * 1000;
const key = w => String(w).toLowerCase();

export const getVocab = () => loadVocab();
export const hasWord = w => loadVocab().some(v => key(v.word) === key(w));

export function addWord(entry) {
  const list = loadVocab().filter(v => key(v.word) !== key(entry.word));
  list.unshift({ ...entry, added: Date.now(), due: Date.now(), interval: 0, reps: 0 });
  return saveVocab(list);
}

export function updateWord(word, patch) {
  saveVocab(loadVocab().map(v => (key(v.word) === key(word) ? { ...v, ...patch } : v)));
}

export const removeWord = word => saveVocab(loadVocab().filter(v => key(v.word) !== key(word)));

export const dueWords = () => loadVocab().filter(v => (v.due || 0) <= Date.now());

// grade：0 忘記、1 模糊、2 記得
export function review(word, grade) {
  const v = loadVocab().find(x => key(x.word) === key(word));
  if (!v) return;
  let { interval = 0, reps = 0 } = v;
  let due;
  if (grade === 0) {
    interval = 0;
    reps = 0;
    due = Date.now() + 10 * 60 * 1000;
  } else if (grade === 1) {
    interval = Math.max(1, Math.round(interval * 1.2));
    due = Date.now() + interval * DAY;
  } else {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(Math.max(interval, 1) * 2.5);
    reps++;
    due = Date.now() + interval * DAY;
  }
  updateWord(word, { interval, reps, due });
}
