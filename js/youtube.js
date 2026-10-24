// YouTube IFrame Player：只播放指定時間區段，播完自動暫停，可重複播放
let apiPromise = null;

function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiPromise = null; reject(new Error('無法載入 YouTube 播放器，請檢查網路。')); };
      document.head.appendChild(s);
    });
  }
  return apiPromise;
}

export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 11);
    const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

// 讀取影片長度（秒）：在畫面外放一個看不到的播放器，讀完就移除；讀不到回傳 0
export async function getVideoDuration(videoId, timeoutMs = 8000) {
  await loadApi();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;';
  const el = document.createElement('div');
  host.appendChild(el);
  document.body.appendChild(host);
  let p = null;
  try {
    return await new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const d = p?.getDuration?.() || 0;
        if (d > 0) return resolve(d);
        if (Date.now() > deadline) return resolve(0);
        setTimeout(poll, 200);
      };
      p = new YT.Player(el, {
        videoId,
        playerVars: { autoplay: 0, mute: 1 },
        events: { onReady: poll, onError: () => resolve(0) },
      });
      setTimeout(() => resolve(0), timeoutMs + 500);
    });
  } finally {
    try { p?.destroy(); } catch { /* ignore */ }
    host.remove();
  }
}

const ERRORS = {
  2: '影片網址有誤。',
  5: '播放器發生錯誤，請重新整理頁面。',
  100: '找不到這部影片（可能已刪除或設為私人）。',
  101: '這部影片的作者不允許在其他網站播放，請換一部影片。',
  150: '這部影片的作者不允許在其他網站播放，請換一部影片。',
};

export class SegmentPlayer {
  constructor(elId) {
    this.elId = elId;
    this.player = null;
    this.videoId = null;
    this.timer = null;
    this.gapTimer = null;
    this.rate = 1;
    this.showCC = false;
    this.onStateChange = null;
    this.onError = null;
  }

  async load(videoId) {
    await loadApi();
    if (this.player) {
      if (this.videoId !== videoId) {
        this.stop();
        this.player.cueVideoById(videoId);
        this.videoId = videoId;
      }
      return;
    }
    this.videoId = videoId;
    await new Promise(resolve => {
      this.player = new YT.Player(this.elId, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, cc_load_policy: 0, iv_load_policy: 3, modestbranding: 1, disablekb: 1 },
        events: {
          onReady: () => resolve(),
          onStateChange: e => {
            if (e.data === YT.PlayerState.PLAYING) {
              if (this.player.getPlaybackRate() !== this.rate) this.player.setPlaybackRate(this.rate);
              this.applyCaptions();
            }
            this.onStateChange?.(e.data);
          },
          onError: e => this.onError?.(ERRORS[e.data] || `播放器錯誤（${e.data}）`),
        },
      });
    });
  }

  // repeat：連續播幾次；gap：每次之間停幾秒
  playSegment(start, end, repeat = 1, gap = 0.7) {
    if (!this.player) return;
    this.stop(false);
    let left = repeat;
    const go = () => {
      this.player.setPlaybackRate(this.rate);
      this.player.seekTo(Math.max(0, start), true);
      this.player.playVideo();
      this.timer = setInterval(() => {
        const t = this.player.getCurrentTime?.() ?? 0;
        if (t >= end) {
          this.player.pauseVideo();
          clearInterval(this.timer);
          if (--left > 0) this.gapTimer = setTimeout(go, gap * 1000);
        }
      }, 50);
    };
    go();
  }

  stop(pause = true) {
    clearInterval(this.timer);
    clearTimeout(this.gapTimer);
    if (pause) {
      try { this.player?.pauseVideo(); } catch { /* ignore */ }
    }
  }

  // v：0 ~ 100
  setVolume(v, muted = false) {
    this.volume = v;
    this.muted = muted;
    try {
      this.player?.setVolume(v);
      if (muted || v === 0) this.player?.mute();
      else this.player?.unMute();
    } catch { /* ignore */ }
  }

  setRate(r) {
    this.rate = r;
    try { this.player?.setPlaybackRate(r); } catch { /* ignore */ }
  }

  // YouTube 沒有正式的開關字幕 API，這是常見的非官方作法
  setCaptions(on) {
    this.showCC = on;
    this.applyCaptions();
  }

  applyCaptions() {
    try {
      if (this.showCC) this.player?.loadModule('captions');
      else this.player?.unloadModule('captions');
    } catch { /* ignore */ }
  }

  title() {
    try { return this.player?.getVideoData?.().title || ''; } catch { return ''; }
  }
}
