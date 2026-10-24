import { parseTranscript, detectLang, formatTime } from './transcript.js';
import { normWord, tokenize, lcsPairs, maskWord, cleanWord, isStopWord, shuffle } from './dictation.js';
import { cuesToWords, buildSegments, newLesson, loadLesson, saveLesson, lessonStats } from './lesson.js';
import { SegmentPlayer, parseVideoId } from './youtube.js';
import { lookup, pronounce } from './dictionary.js';
import * as gemini from './gemini.js';
import * as store from './storage.js';
import * as vocab from './vocab.js';
import { keyClick, wordOk, sentenceDone, wrong, setVolume as setSfxVolume, setStyle as setKeyStyle, loadCustomSound, clearCustomSound, sampleCount, loadBuiltinSound } from './sound.js';
import { putFile, getFile, deleteFile } from './filestore.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const thumb = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
const isTouch = matchMedia('(hover: none)').matches;

let settings = store.getSettings();
setSfxVolume(settings.sfxVolume / 100);
setKeyStyle(settings.keySound);
const BUILTIN_SOUND = 'assets/sound/keyboard.mp3';
// 內建鍵盤錄音：一開網頁就在背景載入，載入完成前先用青軸合成音
loadBuiltinSound(BUILTIN_SOUND).catch(() => {});
let customSoundName = '';
// 自訂打字音效存在 IndexedDB，開網頁時載回來
if (settings.keySound === 'custom') {
  getFile('keySound')
    .then(f => f && loadCustomSound(f.data).then(() => {
      customSoundName = f.name;
      if (document.body.dataset.view === 'settings') renderKeySound();
    }))
    .catch(() => {});
}
function setSetting(key, value) {
  settings[key] = value;
  store.saveSettings(settings);
}

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function setStatus(el, msg, type = '') {
  el.hidden = !msg;
  el.textContent = msg || '';
  el.className = `status ${type}`;
}

// =====================================================================
// 路由
// =====================================================================
const player = new SegmentPlayer('player');
player.onError = msg => toast(msg, 6000);
player.onStateChange = () => {
  if (L && !L.title) {
    const t = player.title();
    if (t) { L.title = t; $('#lesson-title').textContent = t; saveSoon(); }
  }
};

function showView(name) {
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${name}`; });
  $$('nav [data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === name || (name === 'lesson' && a.dataset.route === 'home')));
  document.body.dataset.view = name;
  updateDueBadge();
}

function route() {
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  closeSheet();
  if (page !== 'lesson' && L) { player.stop(); flushSave(); }
  if (page === 'lesson' && arg) return openLesson(decodeURIComponent(arg));
  if (page === 'vocab') { showView('vocab'); return renderVocab(); }
  if (page === 'settings') { showView('settings'); return renderSettings(); }
  showView('home');
  renderHome();
}
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => flushSave());

function updateDueBadge() {
  const n = vocab.dueWords().length;
  const b = $('#due-badge');
  b.hidden = !n;
  b.textContent = n;
}

// =====================================================================
// 首頁：新增影片、我的影片
// =====================================================================
let newVideoId = null;
let srcTab = 'paste';

function renderHome() {
  $('#key-banner').hidden = gemini.hasKey();
  $('#enhance-row').hidden = !gemini.hasKey();
  renderLibrary();
}

function renderLibrary() {
  const list = store.listLessons();
  $('#library-card').hidden = !list.length;
  $('#library').innerHTML = list.map(l => {
    const pct = l.total ? Math.round((l.done / l.total) * 100) : 0;
    return `<li class="lib-item">
      <a class="lib-link" href="#/lesson/${esc(l.videoId)}">
        <img src="${thumb(l.videoId)}" alt="" loading="lazy">
        <div class="lib-info">
          <div class="lib-title">${esc(l.title || l.videoId)}</div>
          <div class="bar"><span style="width:${pct}%"></span></div>
          <div class="muted small">完成 ${pct}%・共 ${l.total} 個字</div>
        </div>
      </a>
      <button class="icon-btn" data-del="${esc(l.videoId)}" title="刪除" aria-label="刪除">✕</button>
    </li>`;
  }).join('');
}

$('#library').addEventListener('click', e => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  if (confirm('確定要刪除這部影片和它的練習進度嗎？')) {
    store.deleteLesson(id);
    renderLibrary();
  }
});

function onLoadUrl() {
  const id = parseVideoId($('#url-input').value);
  if (!id) return toast('看不懂這個網址，請貼上 YouTube 影片網址。');
  newVideoId = id;
  $('#step-transcript').hidden = false;
  $('#new-thumb').src = thumb(id);
  const exists = store.listLessons().some(l => l.videoId === id);
  $('#new-exists').hidden = !exists;
  $('#new-exists-link').href = `#/lesson/${id}`;
  setStatus($('#create-status'), '');
  $('#step-transcript').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#btn-load').addEventListener('click', onLoadUrl);
$('#url-input').addEventListener('keydown', e => { if (e.key === 'Enter') onLoadUrl(); });

$$('.tab').forEach(tab => tab.addEventListener('click', () => {
  srcTab = tab.dataset.tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
  $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== srcTab; });
}));

async function fetchTitle(id) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
    if (res.ok) return (await res.json()).title || '';
  } catch { /* CORS 失敗時，之後從播放器取得標題 */ }
  return '';
}

// 進度條：pct 為 null 時顯示「還不知道進度」的動畫；超過 limit 秒自動取消
const progress = {
  ctrl: null,
  timer: null,
  t0: 0,
  limit: 0,
  start(text, hint = '', limitSec = 0) {
    this.ctrl = new AbortController();
    this.t0 = Date.now();
    this.limit = limitSec;
    $('#progress-box').hidden = false;
    this.set(null, text, hint);
    clearInterval(this.timer);
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    return this.ctrl.signal;
  },
  set(pct, text, hint) {
    const bar = $('#prog-bar');
    bar.parentElement.classList.toggle('indeterminate', pct == null);
    if (pct != null) bar.style.width = `${Math.round(pct * 100)}%`;
    if (text != null) $('#prog-text').textContent = text;
    if (hint != null) $('#prog-hint').textContent = hint;
  },
  tick() {
    const s = Math.floor((Date.now() - this.t0) / 1000);
    $('#prog-time').textContent = `已等待 ${formatTime(s)}`;
    if (this.limit && s >= this.limit) this.ctrl?.abort('timeout');
  },
  stop() {
    clearInterval(this.timer);
    $('#progress-box').hidden = true;
    this.ctrl = null;
  },
};
$('#btn-cancel').addEventListener('click', () => progress.ctrl?.abort('user'));

async function createLesson() {
  const id = newVideoId;
  const status = $('#create-status');
  const btn = $('#btn-create');
  if (!id) return;
  if (store.listLessons().some(l => l.videoId === id) && !confirm('這部影片已經有練習進度，要重新建立並清除舊進度嗎？')) return;

  btn.disabled = true;
  setStatus(status, '');
  let signal = null;
  const onStatus = msg => progress.set(null, null, msg);
  try {
    let words, enhanced = false;
    if (srcTab === 'paste') {
      const cues = parseTranscript($('#tr-paste').value);
      if (!cues.length) throw new Error('找不到有時間軸的字幕，請確認貼上的內容包含時間（例如 0:03）。');
      if (detectLang(cues) === 'zh') throw new Error('這看起來是中文字幕，請在 YouTube 轉錄稿面板把語言切換成英文後再複製。');
      words = cuesToWords(cues);
      if ($('#opt-enhance').checked && gemini.hasKey()) {
        const n = Math.ceil(words.length / 400);
        signal = progress.start(`✨ 補標點、調整切句…（0 / ${n} 段）`, '', 300);
        progress.set(0);
        try {
          await gemini.enhanceWords(words, {
            signal,
            onStatus,
            onProgress: (i, total) => progress.set(i / total, `✨ 補標點、調整切句…（${i} / ${total} 段）`, ''),
          });
          enhanced = true;
        } catch (e) {
          if (signal.reason === 'user') throw e;
          // 優化失敗不影響練習，重新用內建規則切句
          words = cuesToWords(cues);
          toast(`AI 優化失敗，改用內建切句：${e.message}`, 6000);
        }
      }
    } else {
      if (!gemini.hasKey()) throw new Error('自動產生字幕需要 Gemini 金鑰，請先到「設定」頁貼上。');
      const startMin = Math.max(0, +$('#tr-start').value || 0);
      const lenMin = Math.min(30, Math.max(1, +$('#tr-len').value || 10));
      const startSec = startMin * 60, endSec = (startMin + lenMin) * 60;
      signal = progress.start(
        '✨ Gemini 正在看影片…',
        'Gemini 會先把整段影片看完才開始寫字幕，這段時間沒有進度是正常的（通常 30 秒到 2 分鐘）。',
        360,
      );
      const { language, cues } = await gemini.transcribeVideo(id, startSec, endSec, {
        signal,
        onStatus,
        onProgress: ({ count, at, pct }) =>
          progress.set(pct, `✍️ 已產生 ${count} 句字幕・寫到 ${formatTime(at)} / ${formatTime(endSec)}`, ''),
      });
      if (!cues.length) throw new Error('Gemini 沒有辨識到任何英文語音。');
      if (language && !language.startsWith('en')) toast('這部影片的主要語言好像不是英文，聽寫效果可能不理想。', 6000);
      words = cuesToWords(cues);
      enhanced = true;
    }
    if (!words.length) throw new Error('字幕裡沒有可以練習的英文單字。');

    progress.stop();
    setStatus(status, '建立中…');
    const title = await fetchTitle(id);
    const lesson = newLesson({ videoId: id, title, words, enhanced, source: srcTab });
    if (!saveLesson(lesson)) throw new Error('瀏覽器儲存空間不足，請到首頁刪除一些舊影片。');
    L = null;
    setStatus(status, '');
    $('#url-input').value = '';
    $('#tr-paste').value = '';
    $('#step-transcript').hidden = true;
    location.hash = `#/lesson/${id}`;
  } catch (e) {
    let msg = e.message;
    if (signal?.reason === 'timeout') msg = '等太久了，已自動停止。可以把「處理幾分鐘」改小一點（例如 5 分鐘）再試一次。';
    else if (signal?.reason === 'user') msg = '已取消。';
    setStatus(status, msg, 'error');
  } finally {
    progress.stop();
    btn.disabled = false;
  }
}
$('#btn-create').addEventListener('click', createLesson);

// =====================================================================
// 練習頁
// =====================================================================
let L = null;            // 目前的課程
let segs = [];           // 目前粒度的句子
let segIdx = 0;
let hints = new Set();   // Easy 模式下直接顯示的字
let marks = new Map();   // 打字中的暫時標記 wordIndex → { type, text }
let letterHints = new Map(); // 字母提示：wordIndex → 已經給了幾個字母
let completed = false;
let saveTimer = null;
const answer = $('#answer');

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (L && !saveLesson(L)) toast('瀏覽器儲存空間不足，進度可能沒有存到。');
}

async function openLesson(id) {
  if (!L || L.videoId !== id) {
    const lesson = loadLesson(id);
    if (!lesson) {
      toast('找不到這部影片的練習資料。');
      location.hash = '#/';
      return;
    }
    L = lesson;
  }
  showView('lesson');
  $('#lesson-title').textContent = L.title;
  applyPlayerPrefs();
  setLevel(L.level, false);
  try {
    await player.load(L.videoId);
    player.setRate(settings.rate);
    player.setCaptions(settings.showCC);
    player.setVolume(settings.volume, settings.muted);
  } catch (e) {
    toast(e.message, 6000);
  }
}

function applyPlayerPrefs() {
  $('#rate-label').textContent = `${settings.rate}x`;
  $('#player-cover').hidden = !settings.hideVideo;
  $('#btn-video').classList.toggle('off', settings.hideVideo);
  $('#btn-cc').classList.toggle('off', !settings.showCC);
  $('#btn-easy').classList.toggle('on', settings.easy);
  $('#opt-repeat').value = String(settings.repeat);
  $('#opt-autoplay').checked = settings.autoplay;
  $('#opt-sound').checked = settings.typingSound;
  $('#vol-sfx').value = settings.sfxVolume;
  $('#vol-sfx').disabled = !settings.typingSound;
  $('#vol-video').value = settings.muted ? 0 : settings.volume;
  $('#btn-mute').textContent = settings.muted || settings.volume === 0 ? '🔇' : settings.volume < 50 ? '🔉' : '🔊';
  $('#btn-mute').classList.toggle('off', settings.muted);
}

function setLevel(level, keepFocus = true) {
  L.level = level;
  segs = buildSegments(L.words, level);
  const i = segs.findIndex(s => L.cursor >= s.from && L.cursor < s.to);
  $$('#level-switch button').forEach(b => b.classList.toggle('active', b.dataset.level === level));
  renderList();
  goSeg(Math.max(0, i), { autoplay: false, focus: keepFocus });
  saveSoon();
}
$('#level-switch').addEventListener('click', e => {
  const b = e.target.closest('[data-level]');
  if (b && L) setLevel(b.dataset.level);
});

const isOpen = wi => L.state[wi] === '0' && !hints.has(wi);
const segWords = s => Array.from({ length: s.to - s.from }, (_, k) => s.from + k);
const segDone = s => segWords(s).every(i => L.state[i] !== '0');

function segPreview(s) {
  return segWords(s).map(i => (L.state[i] === '0' ? `<span class="m">${esc(maskWord(L.words[i].text))}</span>` : esc(L.words[i].text))).join(' ');
}

function listItemHtml(s, i) {
  return `<li data-i="${i}" class="${segDone(s) ? 'done' : ''} ${i === segIdx ? 'current' : ''}">
    <span class="chk"></span>
    <div><div class="seg-text">${segPreview(s)}</div><div class="seg-meta">#${i + 1}・${formatTime(s.start)}</div></div>
  </li>`;
}

function renderList() {
  $('#seg-list').innerHTML = segs.map(listItemHtml).join('');
  updateListCount();
}

function updateListItem(i) {
  const li = $(`#seg-list li[data-i="${i}"]`);
  if (li && segs[i]) li.outerHTML = listItemHtml(segs[i], i);
}

function updateListCount() {
  $('#list-count').textContent = `(${segs.filter(segDone).length}/${segs.length})`;
}

function scrollToCurrent() {
  $(`#seg-list li[data-i="${segIdx}"]`)?.scrollIntoView({ block: 'nearest' });
}

$('#seg-list').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]');
  if (li) goSeg(+li.dataset.i);
});
$('#btn-locate').addEventListener('click', scrollToCurrent);

function goSeg(i, { autoplay = true, focus = true } = {}) {
  if (i >= segs.length) {
    toast('🎉 這部影片全部練完了！');
    return;
  }
  if (i < 0) return;
  const prev = segIdx;
  segIdx = i;
  L.cursor = segs[i].from;
  answer.value = '';
  marks = new Map();
  letterHints = new Map();
  completed = segDone(segs[i]);
  computeHints();
  updateListItem(prev);
  updateListItem(i);
  scrollToCurrent();
  $('#seg-pos').textContent = `第 ${i + 1} / ${segs.length} 句・${formatTime(segs[i].start)}`;
  setMsg(completed ? '這句已經完成了，按 Enter 前往下一句。' : '');
  renderSlots();
  updateStats();
  saveSoon();
  if (autoplay && settings.autoplay) playCurrent();
  if (focus && !isTouch) answer.focus();
}

function playCurrent() {
  const s = segs[segIdx];
  if (!s) return;
  // 短詞組的時間是估算的，前後多留一點
  const pad = L.level === 'steady' ? 0.35 : 0.2;
  player.playSegment(s.start - pad, s.end + pad + 0.1, settings.repeat);
}

// Easy：只挖掉約三成比較難的字，其它直接顯示
function computeHints() {
  hints = new Set();
  if (!settings.easy) return;
  const open = segWords(segs[segIdx]).filter(i => L.state[i] === '0');
  if (open.length <= 1) return;
  const difficulty = i => normWord(L.words[i].text).length - (isStopWord(L.words[i].text) ? 10 : 0);
  const keep = new Set([...open].sort((a, b) => difficulty(b) - difficulty(a)).slice(0, Math.max(1, Math.round(open.length * 0.3))));
  open.forEach(i => { if (!keep.has(i)) hints.add(i); });
}

function renderSlots() {
  const s = segs[segIdx];
  let n = 0;
  $('#slots').innerHTML = segWords(s).map(i => {
    const w = L.words[i], st = L.state[i], mk = marks.get(i);
    let cls, html, title = '點一下查字典';
    if (st === '1') { cls = 'ok'; html = esc(w.text); }
    else if (st === '2') { cls = 'revealed'; html = esc(w.text); }
    else if (st === '3' || hints.has(i)) { cls = 'hint'; html = esc(w.text); }
    else {
      n++;
      title = '點一下揭曉這個字';
      if (mk?.type === 'partial') {
        // 已經拼對開頭：接著顯示字母提示多給的部分，剩下的用圓點
        const target = normWord(w.text), typed = normWord(mk.text).length, given = letterHints.get(i) || 0;
        const extra = given > typed ? `<span class="given">${esc(target.slice(typed, given))}</span>` : '';
        cls = 'partial';
        html = `${esc(mk.text)}${extra}<span class="rest">${'•'.repeat(Math.max(0, target.length - Math.max(typed, given)))}</span>`;
      } else if (mk && !(mk.type === 'wrong' && letterHints.has(i))) {
        cls = mk.type;
        html = esc(mk.text);
      } else {
        cls = 'masked';
        html = (letterHints.has(i) ? maskWithPrefix(w.text, letterHints.get(i)) : esc(maskWord(w.text)))
          + (n <= 9 && !isTouch ? `<sup>${n}</sup>` : '');
      }
    }
    return `<button class="slot ${cls}" data-wi="${i}" title="${title}">${html}</button>`;
  }).join('');
  $('#slots').classList.toggle('complete', completed);
}

// 只露出前 n 個字母，其餘用圓點遮住
function maskWithPrefix(text, n) {
  let k = 0, out = '';
  for (const ch of String(text)) {
    if (/[A-Za-z0-9]/.test(ch)) out += k++ < n ? `<span class="given">${esc(ch)}</span>` : '•';
    else out += esc(ch);
  }
  return out;
}

// 💡 字母提示：對「第一個還沒聽出來的字」多給一個字母，給完整個字就算揭曉
function giveLetter() {
  if (completed) return;
  const wi = segWords(segs[segIdx]).find(i => isOpen(i) && marks.get(i)?.type !== 'tentative');
  if (wi == null) return;
  const total = normWord(L.words[wi].text).length;
  const mk = marks.get(wi);
  const typed = mk?.type === 'partial' ? normWord(mk.text).length : 0; // 已經拼對的開頭不用再提示
  const n = Math.max(letterHints.get(wi) || 0, typed) + 1;
  if (n >= total) {
    letterHints.delete(wi);
    reveal(wi);
    setMsg('字母都給完了，這個字算「揭曉」。');
  } else {
    letterHints.set(wi, n);
    renderSlots();
    setMsg(`💡 提示：這個字開頭是「${normWord(L.words[wi].text).slice(0, n)}…」，再按一次多給一個字母`);
  }
  if (!isTouch) answer.focus();
}

function setState(wi, v) {
  if (L.state[wi] === v) return;
  L.state[wi] = v;
}

// 每打一個字就比對：用 LCS 對齊，打錯或漏字也能繼續往後對
function evaluate(final = false) {
  const s = segs[segIdx];
  const idxs = segWords(s);
  const text = answer.value;
  const live = !final && !/\s$/.test(text);
  const toks = tokenize(text);
  const last = toks.length - 1;
  const target = idxs.map(i => normWord(L.words[i].text));
  const pairs = lcsPairs(target, toks.map(t => t.norm));

  marks = new Map();
  const matched = new Map();
  let changed = false;
  for (const [ti, tj] of pairs) {
    const wi = idxs[ti];
    matched.set(tj, ti);
    if (L.state[wi] !== '0') continue;
    if (live && tj === last) { marks.set(wi, { type: 'tentative', text: toks[tj].orig }); continue; }
    setState(wi, '1');
    changed = true;
  }

  // 沒對上的字：放進兩個已對上的字之間、第一個還沒完成的位置
  const nextAnchor = new Array(toks.length);
  let anchor = idxs.length;
  for (let j = toks.length - 1; j >= 0; j--) {
    if (matched.has(j)) anchor = matched.get(j);
    nextAnchor[j] = anchor;
  }
  let p = 0;
  for (let j = 0; j < toks.length; j++) {
    if (matched.has(j)) { p = matched.get(j) + 1; continue; }
    for (let k = p; k < nextAnchor[j]; k++) {
      const wi = idxs[k];
      if (!isOpen(wi) || marks.has(wi)) continue;
      marks.set(wi, { type: target[k].startsWith(toks[j].norm) ? 'partial' : 'wrong', text: toks[j].orig });
      p = k + 1;
      break;
    }
  }

  if (changed) afterProgress();
  if (!completed && idxs.every(i => L.state[i] !== '0' || hints.has(i))) {
    idxs.forEach(i => { if (hints.has(i) && L.state[i] === '0') setState(i, '3'); });
    hints = new Set();
    completed = true;
    afterProgress();
    setMsg('✓ 完成！按 Enter 前往下一句', 'ok');
    if (settings.typingSound) sentenceDone();
  } else if (changed && settings.typingSound) {
    wordOk();
  }
  renderSlots();
  return completed;
}

function afterProgress() {
  updateListItem(segIdx);
  updateListCount();
  updateStats();
  saveSoon();
}

answer.addEventListener('input', e => {
  if (settings.typingSound) {
    const type = e.inputType || '';
    if (type.startsWith('delete')) keyClick('back');
    else if (e.data === ' ') keyClick('space');
    else if (type.startsWith('insert')) keyClick('key');
  }
  if (!completed) evaluate(false);
});

function check() {
  if (completed) return goSeg(segIdx + 1);
  if (evaluate(true)) return;
  const left = segWords(segs[segIdx]).filter(isOpen).length;
  if (settings.typingSound) wrong();
  setMsg(`還有 ${left} 個字沒聽出來，再聽一次 🎧（點遮住的字可以直接揭曉）`, 'warn');
  playCurrent();
}

function reveal(wi) {
  if (!isOpen(wi)) return;
  setState(wi, '2');
  afterProgress();
  evaluate(false);
}

$('#slots').addEventListener('click', e => {
  const b = e.target.closest('[data-wi]');
  if (!b) return;
  const wi = +b.dataset.wi;
  if (isOpen(wi)) reveal(wi);
  openWordSheet(wi);
});

function setMsg(text, type = '') {
  const el = $('#practice-msg');
  el.textContent = text;
  el.className = `practice-msg ${type}`;
}

function updateStats() {
  if (!L) return;
  const st = lessonStats(L);
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  const acc = st.solved + st.revealed ? Math.round((st.solved / (st.solved + st.revealed)) * 100) : 0;
  $('#stat-bar').style.width = `${pct}%`;
  $('#stat-text').innerHTML = `
    <div>完成 <b>${pct}%</b>（${st.done} / ${st.total} 字）</div>
    <div><span class="dot" style="background:var(--ok)"></span>自己聽出來 <b>${st.solved}</b></div>
    <div><span class="dot" style="background:var(--info)"></span>揭曉 <b>${st.revealed}</b></div>
    <div><span class="dot" style="background:var(--hint)"></span>Easy 提示 <b>${st.hinted}</b></div>
    <div class="muted">聽寫正確率 ${acc}%</div>`;
}

function changeRate(r) {
  r = Math.min(2, Math.max(0.25, Math.round(r * 100) / 100));
  setSetting('rate', r);
  player.setRate(r);
  $('#rate-label').textContent = `${r}x`;
}

function toggleEasy() {
  setSetting('easy', !settings.easy);
  $('#btn-easy').classList.toggle('on', settings.easy);
  if (!completed) { computeHints(); evaluate(false); }
  setMsg(settings.easy ? 'Easy 提示開啟：只需要聽出比較難的字' : '');
}

$('#btn-check').addEventListener('click', check);
$('#btn-skip').addEventListener('click', () => goSeg(segIdx + 1));
$('#btn-prev').addEventListener('click', () => goSeg(segIdx - 1));
$('#btn-replay').addEventListener('click', () => { playCurrent(); if (!isTouch) answer.focus(); });
$('#btn-easy').addEventListener('click', toggleEasy);
$('#btn-letter').addEventListener('click', giveLetter);
$('#btn-slower').addEventListener('click', () => changeRate(settings.rate - 0.25));
$('#btn-faster').addEventListener('click', () => changeRate(settings.rate + 0.25));
$('#btn-video').addEventListener('click', () => { setSetting('hideVideo', !settings.hideVideo); applyPlayerPrefs(); });
$('#btn-cc').addEventListener('click', () => { setSetting('showCC', !settings.showCC); player.setCaptions(settings.showCC); applyPlayerPrefs(); });
$('#opt-repeat').addEventListener('change', e => setSetting('repeat', +e.target.value));
$('#opt-autoplay').addEventListener('change', e => setSetting('autoplay', e.target.checked));
$('#opt-sound').addEventListener('change', e => { setSetting('typingSound', e.target.checked); applyPlayerPrefs(); });
$('#vol-sfx').addEventListener('input', e => setSfxVolume(+e.target.value / 100));
$('#vol-sfx').addEventListener('change', e => {
  setSetting('sfxVolume', +e.target.value);
  keyClick('key'); // 放開滑桿時試聽一下
});
$('#vol-video').addEventListener('input', e => {
  const v = +e.target.value;
  setSetting('volume', v);
  setSetting('muted', v === 0);
  player.setVolume(v, v === 0);
  applyPlayerPrefs();
});
$('#btn-mute').addEventListener('click', () => {
  // 音量是 0 時按取消靜音，回到一個聽得到的音量
  if (settings.volume === 0) setSetting('volume', 60);
  setSetting('muted', !settings.muted);
  player.setVolume(settings.volume, settings.muted);
  applyPlayerPrefs();
});

document.addEventListener('keydown', e => {
  if (document.body.dataset.view !== 'lesson' || !$('#sheet').hidden) return;
  const inOtherField = e.target.matches('input, select, textarea') && e.target !== answer;
  if (inOtherField) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) goSeg(segIdx - 1);
    else playCurrent();
  } else if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (e.shiftKey) goSeg(segIdx + 1);
    else check();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    toggleEasy();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    giveLetter();
  } else if ((e.altKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const open = segWords(segs[segIdx]).filter(isOpen);
    const wi = open[+e.key - 1];
    if (wi != null) reveal(wi);
  } else if (e.key === '[' && !e.ctrlKey) {
    e.preventDefault();
    changeRate(settings.rate - 0.25);
  } else if (e.key === ']' && !e.ctrlKey) {
    e.preventDefault();
    changeRate(settings.rate + 0.25);
  } else if (e.key === '\\') {
    e.preventDefault();
    changeRate(1);
  }
});

// =====================================================================
// 單字卡（查字典、中文解釋、存單字本）
// =====================================================================
let sheetCtx = null;

function closeSheet() {
  $('#sheet').hidden = true;
  sheetCtx = null;
}
$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); if (!isTouch) answer.focus(); }
});

async function openWordSheet(wi) {
  const w = L.words[wi];
  const word = cleanWord(w.text);
  if (!word) return;
  const s = segs[segIdx];
  const ctx = {
    word,
    wi,
    sentence: segWords(s).map(i => L.words[i].text).join(' '),
    videoId: L.videoId,
    title: L.title,
    time: w.start,
    info: undefined,
    zh: null,
  };
  sheetCtx = ctx;
  $('#sheet').hidden = false;
  renderSheet();
  const info = await lookup(word);
  if (sheetCtx !== ctx) return;
  ctx.info = info;
  renderSheet();
}

function renderSheet() {
  const c = sheetCtx;
  if (!c) return;
  const saved = vocab.hasWord(c.word);
  const ctxHtml = esc(c.sentence).replace(new RegExp(`\\b(${c.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i'), '<mark>$1</mark>');
  let dict;
  if (c.info === undefined) dict = '<p class="muted small">查詢字典中…</p>';
  else if (!c.info) dict = '<p class="muted small">字典裡查不到這個字（可能是人名、縮寫或口語）。</p>';
  else dict = `<ul class="meanings">${c.info.meanings.map(m => `<li><span class="pos">${esc(m.pos)}</span>${m.defs.map(esc).join('<br>')}</li>`).join('')}</ul>`;
  let zh;
  if (c.zh?.loading) zh = '<div class="zh-box muted">Gemini 解釋中…</div>';
  else if (c.zh?.error) zh = `<div class="zh-box">${esc(c.zh.error)}</div>`;
  else if (c.zh) zh = `<div class="zh-box"><b>${esc(c.zh.pos)}</b>　${esc(c.zh.zh)}${c.zh.note ? `<div class="muted small" style="margin-top:4px">${esc(c.zh.note)}</div>` : ''}</div>`;
  else zh = gemini.hasKey() ? '<button id="sheet-zh">🇹🇼 中文解釋（Gemini）</button>' : '';

  $('#sheet-body').innerHTML = `
    <div class="word-head"><h3>${esc(c.word)}</h3><span class="ipa">${esc(c.info?.ipa || '')}</span>${c.info?.headword && normWord(c.info.headword) !== normWord(c.word) ? `<span class="muted small">原形：${esc(c.info.headword)}</span>` : ''}</div>
    <div class="row" style="margin-top:8px">
      <button data-say="us">🔊 美式</button>
      <button data-say="uk">🔊 英式</button>
    </div>
    ${dict}
    ${zh}
    <div class="context">${ctxHtml}</div>
    <button id="sheet-save" class="${saved ? '' : 'primary'}" ${saved ? 'disabled' : ''}>${saved ? '✓ 已在單字本' : '⭐ 存入單字本'}</button>`;
}

$('#sheet-body').addEventListener('click', async e => {
  const c = sheetCtx;
  if (!c) return;
  const say = e.target.closest('[data-say]')?.dataset.say;
  if (say) return pronounce(c.word, c.info, say);
  if (e.target.id === 'sheet-zh') {
    c.zh = { loading: true };
    renderSheet();
    try {
      c.zh = await gemini.explainWord(c.word, c.sentence);
    } catch (err) {
      c.zh = { error: err.message };
    }
    if (sheetCtx === c) renderSheet();
    return;
  }
  if (e.target.id === 'sheet-save') {
    vocab.addWord({
      word: c.word.toLowerCase(),
      ipa: c.info?.ipa || '',
      audioUS: c.info?.audioUS || '',
      audioUK: c.info?.audioUK || '',
      meaningEn: c.info?.meanings?.[0] ? `${c.info.meanings[0].pos}: ${c.info.meanings[0].defs[0] || ''}` : '',
      meaningZh: c.zh && !c.zh.loading && !c.zh.error ? `${c.zh.pos} ${c.zh.zh}` : '',
      sentence: c.sentence,
      videoId: c.videoId,
      title: c.title,
      time: Math.floor(c.time),
    });
    toast(`已把「${c.word}」存入單字本`);
    updateDueBadge();
    renderSheet();
  }
});

// =====================================================================
// 單字本 + 聽寫複習
// =====================================================================
let reviewQueue = [];

function dueLabel(v) {
  const diff = (v.due || 0) - Date.now();
  if (diff <= 0) return '今天要複習';
  const days = Math.ceil(diff / 86400000);
  return days <= 1 ? '明天複習' : `${days} 天後複習`;
}

function renderVocab() {
  const list = vocab.getVocab();
  const due = vocab.dueWords();
  $('#vocab-summary').textContent = list.length ? `共 ${list.length} 個單字，今天要複習 ${due.length} 個。` : '還沒有單字。練習時點一下單字，就能存進來。';
  $('#btn-review').disabled = !due.length;
  $('#vocab-list').innerHTML = list.map(v => `
    <li class="vocab-item">
      <div class="row">
        <span class="word">${esc(v.word)}</span>
        <span class="ipa">${esc(v.ipa)}</span>
        <button class="icon-btn" data-say="${esc(v.word)}" aria-label="發音">🔊</button>
        <span class="due">${dueLabel(v)}</span>
      </div>
      ${v.meaningZh ? `<div>${esc(v.meaningZh)}</div>` : ''}
      ${v.meaningEn ? `<div class="muted small">${esc(v.meaningEn)}</div>` : ''}
      <div class="context">${esc(v.sentence)}</div>
      <div class="row between small">
        <a href="https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}&t=${v.time || 0}s" target="_blank" rel="noopener">▶ ${esc(v.title || '原影片')} ${formatTime(v.time || 0)}</a>
        <button class="link" data-remove="${esc(v.word)}">刪除</button>
      </div>
    </li>`).join('');
  updateDueBadge();
}

$('#vocab-list').addEventListener('click', e => {
  const say = e.target.closest('[data-say]')?.dataset.say;
  if (say) {
    const v = vocab.getVocab().find(x => x.word === say);
    return pronounce(say, v && { audioUS: v.audioUS, audioUK: v.audioUK });
  }
  const rm = e.target.closest('[data-remove]')?.dataset.remove;
  if (rm && confirm(`要從單字本刪除「${rm}」嗎？`)) {
    vocab.removeWord(rm);
    renderVocab();
  }
});

function sayReviewWord() {
  const v = reviewQueue[0];
  if (v) pronounce(v.word, { audioUS: v.audioUS, audioUK: v.audioUK });
}

function startReview() {
  reviewQueue = shuffle(vocab.dueWords());
  if (!reviewQueue.length) return;
  $('#review-card').hidden = false;
  nextCard();
}

function nextCard() {
  const v = reviewQueue[0];
  if (!v) {
    $('#review-card').hidden = true;
    toast('🎉 今天的複習完成了！');
    renderVocab();
    return;
  }
  $('#review-left').textContent = `剩 ${reviewQueue.length} 個`;
  $('#review-input').value = '';
  $('#review-input').disabled = false;
  $('#btn-review-check').hidden = false;
  $('#review-answer').hidden = true;
  if (!isTouch) $('#review-input').focus();
  sayReviewWord();
}

function checkCard() {
  const v = reviewQueue[0];
  if (!v) return;
  const ok = normWord($('#review-input').value) === normWord(v.word);
  $('#review-input').disabled = true;
  $('#btn-review-check').hidden = true;
  const box = $('#review-answer');
  box.hidden = false;
  box.innerHTML = `
    <div class="review-result">
      <div class="verdict ${ok ? 'ok' : 'bad'}">${ok ? '✓ 拼對了！' : `✗ 正確答案是 ${esc(v.word)}`}</div>
      <div class="row center"><span class="ipa">${esc(v.ipa)}</span></div>
      ${v.meaningZh ? `<div style="text-align:center">${esc(v.meaningZh)}</div>` : ''}
      ${v.meaningEn ? `<div class="muted small" style="text-align:center">${esc(v.meaningEn)}</div>` : ''}
      <div class="context">${esc(v.sentence)}</div>
      <div class="grade-row">
        <button data-grade="0">😵 忘了</button>
        <button data-grade="1">🤔 模糊</button>
        <button data-grade="2" class="primary">😎 記得</button>
      </div>
    </div>`;
  box.querySelector(`[data-grade="${ok ? 2 : 0}"]`).focus();
}

$('#review-answer').addEventListener('click', e => {
  const g = e.target.closest('[data-grade]')?.dataset.grade;
  if (g == null) return;
  const v = reviewQueue.shift();
  vocab.review(v.word, +g);
  if (+g === 0) reviewQueue.push(v); // 忘了的字，這輪最後再考一次
  nextCard();
});
$('#btn-review').addEventListener('click', startReview);
$('#btn-review-say').addEventListener('click', sayReviewWord);
$('#btn-review-check').addEventListener('click', checkCard);
$('#review-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) checkCard(); });
$('#btn-review-stop').addEventListener('click', () => { $('#review-card').hidden = true; renderVocab(); });

// =====================================================================
// 設定
// =====================================================================
function renderModelOptions() {
  const models = settings.models?.length ? settings.models : [];
  const list = models.includes(settings.model) ? models : [settings.model, ...models];
  const rec = gemini.recommendModel(models);
  $('#set-model').innerHTML = list
    .map(m => `<option value="${esc(m)}"${m === settings.model ? ' selected' : ''}>${esc(m)}${m === rec ? '（推薦）' : ''}</option>`)
    .join('');
}

function renderSettings() {
  settings = store.getSettings();
  $('#set-key').value = settings.apiKey;
  renderModelOptions();
  setStatus($('#set-status'), '');
  renderKeySound();
}

function renderKeySound() {
  $('#set-keysound').value = settings.keySound;
  const custom = settings.keySound === 'custom';
  $('#custom-sound-box').hidden = !custom;
  const status = $('#keysound-status');
  if (!custom) setStatus(status, '');
  else if (sampleCount()) setStatus(status, `✓ 使用「${customSoundName || '自訂音檔'}」，切出 ${sampleCount()} 個按鍵聲。`, 'ok');
  else setStatus(status, '還沒有上傳音檔，目前會先用青軸音色。');
  if (settings.keySound === 'builtin') setStatus(status, '使用網站內建的鍵盤錄音，所有裝置都聽得到。', 'ok');
}

$('#set-keysound').addEventListener('change', e => {
  setSetting('keySound', e.target.value);
  setKeyStyle(e.target.value);
  renderKeySound();
});

$('#file-keysound').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#keysound-status');
  if (file.size > 15 * 1024 * 1024) return setStatus(status, '檔案太大了，請用 15MB 以內、短一點的錄音。', 'error');
  setStatus(status, '讀取中…');
  try {
    const data = await file.arrayBuffer();
    const n = await loadCustomSound(data);
    await putFile('keySound', { name: file.name, data });
    customSoundName = file.name;
    renderKeySound();
    playKeyDemo();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

// 試聽：模擬打一個短字和空白鍵
function playKeyDemo() {
  ['key', 'key', 'key', 'key', 'space', 'key', 'key', 'key', 'back', 'key'].forEach((kind, i) => {
    setTimeout(() => keyClick(kind), i * 110 + (kind === 'space' ? 60 : 0));
  });
}
$('#btn-keysound-test').addEventListener('click', playKeyDemo);

function saveSettingsForm() {
  setSetting('apiKey', $('#set-key').value.trim());
  setSetting('model', $('#set-model').value || store.DEFAULT_MODEL);
}

window.addEventListener('gemini-model-changed', e => {
  settings = store.getSettings();
  if (document.body.dataset.view === 'settings') renderModelOptions();
  toast(`原本的模型已無法使用，已自動換成 ${e.detail}`, 5000);
});

$('#btn-toggle-key').addEventListener('click', e => {
  const input = $('#set-key');
  input.type = input.type === 'password' ? 'text' : 'password';
  e.target.textContent = input.type === 'password' ? '顯示' : '隱藏';
});

$('#btn-save-settings').addEventListener('click', () => {
  saveSettingsForm();
  setStatus($('#set-status'), '已儲存。', 'ok');
});

$('#btn-test').addEventListener('click', async () => {
  saveSettingsForm();
  const status = $('#set-status');
  setStatus(status, '測試中…');
  try {
    await gemini.testConnection();
    setStatus(status, `✓ 連線成功！（模型：${settings.model}）`, 'ok');
  } catch (e) {
    setStatus(status, e.message, 'error');
  }
});

$('#btn-models').addEventListener('click', async () => {
  saveSettingsForm();
  const status = $('#set-status');
  setStatus(status, '讀取模型清單中…');
  try {
    const models = await gemini.listModels();
    const rec = gemini.recommendModel(models);
    setSetting('models', models);
    if (rec && !models.includes(settings.model)) setSetting('model', rec);
    renderModelOptions();
    setStatus(status, `找到 ${models.length} 個模型，目前使用 ${settings.model}。可以按「測試連線」確認。`, 'ok');
  } catch (e) {
    setStatus(status, e.message, 'error');
  }
});

$('#btn-clear').addEventListener('click', () => {
  if (!confirm('確定要清除所有練習進度、單字本和金鑰嗎？這個動作無法復原。')) return;
  store.clearAll();
  deleteFile('keySound').catch(() => {});
  clearCustomSound();
  settings = store.getSettings();
  setKeyStyle(settings.keySound);
  L = null;
  renderSettings();
  toast('已清除所有資料。');
});

// 部分瀏覽器要等語音清單載入後才有英式發音
if ('speechSynthesis' in window) speechSynthesis.getVoices();

route();
