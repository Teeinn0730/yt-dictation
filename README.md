# 🎧 YT Dictation

用 YouTube 影片練習英文聽寫的網頁，玩法參考 EasyDictation：

- **遮罩句子**：每個字用圓點遮住，看得出字數和長度
- **逐字即時批改**：一邊打字一邊比對，打對變綠色、打錯變紅色、拼到一半是黃色
- **三種切句粒度**：Steady（短詞組）／Natural（意群）／Fluent（整句），三種共用同一份進度
- **自動停在句尾**，可以設定每句重複播放 1～5 次、調整速度、隱藏畫面和字幕
- **Easy 提示**：只留下比較難的字讓你聽
- **揭曉單字＋查字典**：音標、英文解釋、美式／英式發音；有 Gemini 金鑰時還能看中文解釋
- **單字本**：用「聽發音 → 拼字」的方式做間隔重複複習

完全免費、不需要註冊，也不需要後端伺服器。所有資料都存在你自己的瀏覽器裡。

👉 線上版：<https://teeinn0730.github.io/yt-dictation/>

## 使用方式

1. 首頁貼上 YouTube 網址 →「下一步」
2. 取得字幕（二選一）
   - **貼上轉錄稿**（電腦）：在 YouTube 影片下方點「…更多」→「顯示轉錄稿」，全選後複製貼上
   - **✨ Gemini 自動產生**（手機也可以）：需要 Gemini 金鑰
3. 按「建立練習」開始聽寫

### 快捷鍵

| 動作 | 按鍵 |
|---|---|
| 重播 | `Tab` |
| 上一句 | `Shift` + `Tab` |
| 檢查／下一句 | `Enter` |
| 跳過 | `Shift` + `Enter` |
| Easy 提示 | `Ctrl` + `E` |
| 揭曉第 N 個字 | `Alt` + `1~9` |
| 變慢／變快／回到 1x | `[`　`]`　`\` |

## Gemini 金鑰（選用、免費）

不需要訂閱 Gemini，也不用綁信用卡：

1. 用 Google 帳號打開 <https://aistudio.google.com/apikey>
2. 按「Create API key」
3. 把金鑰貼到網頁的「設定」頁並儲存

金鑰只存在那台裝置的瀏覽器，只會直接傳給 Google。免費方案有每分鐘和每天的次數上限，而且內容可能被 Google 拿來改善模型。

## 在自己電腦上執行

網頁使用 ES modules，不能直接雙擊 `index.html` 開啟，要用一個簡單的本機伺服器：

```bash
python serve.py 8765
```

（`serve.py` 會要求瀏覽器不要快取，改完程式重新整理就會生效。）

然後打開 <http://localhost:8765>。

## 部署到 GitHub Pages

1. 在 GitHub 建立一個 repository，把這個資料夾的檔案推上去
2. Settings → Pages → Source 選 `main` branch、`/ (root)`
3. 幾分鐘後就能用 `https://<你的帳號>.github.io/<repo 名稱>/` 打開

注意：每台裝置的瀏覽器資料是分開的，練習進度和單字本不會自動同步。

## 使用的免費服務

- [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)：播放影片片段
- [Datamuse API](https://www.datamuse.com/api/)：音標和英文解釋
- [Free Dictionary API](https://dictionaryapi.dev/)：真人發音音檔（服務不穩時改用瀏覽器內建語音）
- [Gemini API](https://ai.google.dev/)：自動產生字幕、補標點和切句、單字中文解釋

## 已知限制

- 有些影片的作者不允許在其他網站嵌入播放，這類影片無法使用
- 短詞組（Steady）的起訖時間是依字數估算的，偶爾會切到一點前後的聲音
- Gemini 自動產生的字幕，時間軸大約只準到 1 秒左右
- 隱藏 YouTube 字幕用的是非官方作法，少數情況可能失效，可以改用「隱藏畫面」
