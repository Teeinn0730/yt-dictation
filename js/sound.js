// 練習音效：用 Web Audio 即時合成，不需要任何音檔。
// 打字是清脆的青軸鍵盤聲；提示音走柔和路線，避免刺耳。
let ctx = null;
let master = null;   // 提示音：最後過一道低通，削掉刺耳的高頻
let keyBus = null;   // 打字聲：不過低通，保留青軸的清脆感
let noise = null;
let volume = 0.6;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 5000;
    master.connect(soften).connect(ctx.destination);
    keyBus = ctx.createGain();
    keyBus.connect(ctx.destination);
    master.gain.value = keyBus.gain.value = volume;
  }
  if (ctx.state === 'suspended') ctx.resume();
  if (!noise) {
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return ctx;
}

// v：0 ~ 1
export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = keyBus.gain.value = volume;
}

// 包絡：先很快淡入（避免爆音），再指數衰減
function envelope(gain, t, peak, attack, decay) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

const jitter = amount => 1 + (Math.random() * 2 - 1) * amount;

// 一小段經過帶通濾波的雜訊：用來做「喀」「噠」這種敲擊聲
function burst(t, { freq, q, peak, decay, rate = 1 }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = rate;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = ctx.createGain();
  envelope(g, t, peak, 0.0008, decay);
  src.connect(bp).connect(g).connect(keyBus);
  src.start(t, Math.random() * 0.02);
  src.stop(t + decay + 0.02);
}

// 短促的共鳴音：鍵帽、外殼被敲到時的「音色」
function ping(t, { freq, type = 'triangle', peak, decay }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.8, t + decay);
  const g = ctx.createGain();
  envelope(g, t, peak, 0.0008, decay);
  osc.connect(g).connect(keyBus);
  osc.start(t);
  osc.stop(t + decay + 0.02);
}

// 青軸：先是清脆的「喀」（咔噠片彈開），十幾毫秒後鍵帽觸底「噠」，放開時再一聲小小的回彈
// kind：key 一般按鍵、space 空白鍵（比較厚、有衛星軸的聲音）、back 刪除
export function keyClick(kind = 'key') {
  const ac = audio();
  if (!ac || volume === 0) return;
  if (style === 'builtin' && banks.builtin.length) return playSample(banks.builtin, kind);
  if (style === 'custom' && banks.custom.length) return playSample(banks.custom, kind);
  if (style === 'office') return officeClick(kind);
  const t = ac.currentTime + 0.002;
  const j = jitter(0.07);
  const spec = {
    key: { click: 4200, clickPeak: 0.55, bottom: 1900, bottomPeak: 0.4, body: 520, bodyPeak: 0.12, gap: 0.016 },
    back: { click: 3800, clickPeak: 0.5, bottom: 1700, bottomPeak: 0.38, body: 470, bodyPeak: 0.12, gap: 0.018 },
    space: { click: 3300, clickPeak: 0.42, bottom: 1100, bottomPeak: 0.55, body: 260, bodyPeak: 0.22, gap: 0.022 },
  }[kind] || {};

  // 1. 喀：高頻、極短
  burst(t, { freq: spec.click * j, q: 2.5, peak: spec.clickPeak, decay: 0.012 });
  ping(t, { freq: spec.click * 0.75 * j, type: 'square', peak: 0.05, decay: 0.008 });
  // 2. 噠：鍵帽觸底，中頻 + 一點塑膠共鳴
  const tb = t + spec.gap * j;
  burst(tb, { freq: spec.bottom * j, q: 1.2, peak: spec.bottomPeak, decay: kind === 'space' ? 0.045 : 0.03 });
  ping(tb, { freq: spec.body * j, peak: spec.bodyPeak, decay: kind === 'space' ? 0.05 : 0.03 });
  // 3. 回彈：很小聲的第二下「喀」
  burst(t + 0.075 * j, { freq: spec.click * 1.1 * j, q: 3, peak: spec.clickPeak * 0.25, decay: 0.008 });
}

// ---------- 其他打字音色 ----------
// style：builtin 網站內建的錄音、blue 青軸（合成）、office 一般鍵盤（合成）、custom 使用者上傳的音檔
// 錄音類的音色還沒載入完成時，先用青軸合成音代替
let style = 'builtin';
const banks = { builtin: [], custom: [] };
let lastSample = -1;

export const setStyle = s => { style = s; };
export const sampleCount = () => banks.custom.length;

// 一般鍵盤：一聲清脆的「喀噠」，沒有青軸的兩段聲
function officeClick(kind) {
  const t = ctx.currentTime + 0.002;
  const j = jitter(0.06);
  const space = kind === 'space';
  burst(t, { freq: (space ? 2400 : 3200) * j, q: 1, peak: space ? 0.4 : 0.5, decay: 0.007 });
  burst(t + 0.003, { freq: (space ? 900 : 1350) * j, q: 1.4, peak: space ? 0.45 : 0.35, decay: space ? 0.04 : 0.026 });
  ping(t + 0.003, { freq: (space ? 220 : 380) * j, peak: space ? 0.16 : 0.09, decay: space ? 0.04 : 0.022 });
}

function playSample(samples, kind) {
  // 隨機挑一個切好的按鍵聲，避免連續兩次一樣
  let i = Math.floor(Math.random() * samples.length);
  if (samples.length > 1 && i === lastSample) i = (i + 1) % samples.length;
  lastSample = i;
  const src = ctx.createBufferSource();
  src.buffer = samples[i];
  src.playbackRate.value = (kind === 'space' ? 0.86 : kind === 'back' ? 1.05 : 1) * jitter(0.03);
  src.connect(keyBus);
  src.start();
}

// 讀入一段打字錄音，自動切成一下一下的按鍵聲
async function decodeAndSlice(arrayBuffer) {
  const ac = audio();
  if (!ac) throw new Error('這個瀏覽器不支援音效。');
  let buf;
  try {
    buf = await ac.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error('讀不懂這個音檔，請換成 mp3、wav 或 m4a。');
  }
  lastSample = -1;
  return sliceKeystrokes(buf);
}

// 使用者上傳的音檔；回傳切出幾個按鍵聲
export async function loadCustomSound(arrayBuffer) {
  banks.custom = await decodeAndSlice(arrayBuffer);
  return banks.custom.length;
}

export function clearCustomSound() {
  banks.custom = [];
}

// 網站內建的鍵盤錄音（assets/sound/），部署到 github.io 後每台裝置都聽得到
export async function loadBuiltinSound(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`找不到內建音檔（${res.status}）`);
  banks.builtin = await decodeAndSlice(await res.arrayBuffer());
  return banks.builtin.length;
}

// 用音量的「突然變大」找出每一下按鍵的起點
function sliceKeystrokes(buf) {
  const sr = buf.sampleRate;
  const data = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) data[i] += ch[i] / buf.numberOfChannels;
  }
  const win = Math.max(1, Math.floor(sr * 0.004));
  const energy = [];
  for (let i = 0; i + win <= data.length; i += win) {
    let sum = 0;
    for (let k = i; k < i + win; k++) sum += data[k] * data[k];
    energy.push(Math.sqrt(sum / win));
  }
  const sorted = [...energy].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const peak = sorted[sorted.length - 1] || 0;
  const threshold = Math.max(floor * 4, peak * 0.18);
  const minGap = Math.ceil(0.07 / 0.004);

  const onsets = [];
  for (let w = 1; w < energy.length; w++) {
    if (energy[w] >= threshold && energy[w - 1] < threshold && (!onsets.length || w - onsets[onsets.length - 1] >= minGap)) onsets.push(w);
  }

  const maxLen = Math.floor(sr * 0.13);
  const cuts = onsets.length
    ? onsets.map((w, i) => {
        const start = Math.max(0, (w - 1) * win);
        const next = i + 1 < onsets.length ? (onsets[i + 1] - 1) * win : data.length;
        return [start, Math.min(next, start + maxLen)];
      })
    : [[0, Math.min(data.length, Math.floor(sr * 0.3))]]; // 找不到起點：整段當成一個聲音

  return cuts.slice(0, 60).map(([s, e]) => {
    const len = Math.max(1, e - s);
    const out = ctx.createBuffer(1, len, sr);
    const o = out.getChannelData(0);
    let max = 0;
    for (let i = 0; i < len; i++) { o[i] = data[s + i]; max = Math.max(max, Math.abs(o[i])); }
    const gain = max > 0 ? 0.9 / max : 1;          // 每一下的音量拉到差不多
    const fade = Math.min(len, Math.floor(sr * 0.012)); // 結尾淡出，避免「啪」的雜音
    for (let i = 0; i < len; i++) o[i] *= gain * (i >= len - fade ? (len - i) / fade : 1);
    return out;
  });
}

// 類似木琴的音：基音 + 很快消失的高泛音
function mallet(freq, start, { peak = 0.12, decay = 0.35, type = 'sine' } = {}) {
  const ac = audio();
  if (!ac || volume === 0) return;
  const t = ac.currentTime + start;
  for (const [mult, amp, dec] of [[1, 1, decay], [4, 0.18, decay * 0.25]]) {
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.value = freq * mult;
    const g = ac.createGain();
    envelope(g, t, peak * amp, 0.005, dec);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.01 + dec + 0.05);
  }
}

// 聽對一個字：輕輕的「叮」
export const wordOk = () => mallet(784, 0, { peak: 0.07, decay: 0.18 });

// 完成一整句：上行的三個音（Do Mi Sol）
export function sentenceDone() {
  mallet(523.25, 0, { peak: 0.1, decay: 0.4 });
  mallet(659.25, 0.08, { peak: 0.1, decay: 0.4 });
  mallet(783.99, 0.16, { peak: 0.11, decay: 0.6 });
}

// 答案還不對：低沉、往下走的兩個音，不刺耳
export function wrong() {
  const ac = audio();
  if (!ac || volume === 0) return;
  const t = ac.currentTime;
  [[311, 0], [233, 0.11]].forEach(([freq, start]) => {
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ac.createGain();
    envelope(g, t + start, 0.12, 0.008, 0.16);
    osc.connect(lp).connect(g).connect(master);
    osc.start(t + start);
    osc.stop(t + start + 0.25);
  });
}
