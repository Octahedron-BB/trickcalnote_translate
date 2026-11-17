# 트릭컬 노트 (Trickcal Note) 韓文轉繁體中文

為 `https://note.trickcal.com/` 設計的 Tampermonkey（油猴）自動翻譯腳本，將網頁中的韓文內容翻譯為台灣繁體中文。

## 功能特色
- **SPA 動態監聽**：登入後動態載入的介面、按鈕與屬性（`placeholder` / `title` / `aria-label`）皆可自動翻譯。
- **雙引擎支援**：
  - 內建免費 **Google 翻譯**（免設定即用）。
  - 支援自訂 **AI / LLM 翻譯**（相容 OpenAI `/chat/completions` 格式，支援 OpenAI、Gemini、DeepSeek 等端點，並可一鍵查詢可用模型）。
- **側邊欄術語表編輯器**：支援即時搜尋、新增、修改、刪除、匯出/匯入 JSON，並會自動注入 LLM 提示詞中確保譯名一致。
- **本機快取與一鍵開關**：翻譯結果自動快取，並可隨時透過右下角懸浮列切換原文/譯文或重新翻譯。

## GreasyFork 同步用 Raw 網址
```
https://raw.githubusercontent.com/Octahedron-BB/trickcalnote_translate/main/trickcal-note-zh-tw.user.js
```
