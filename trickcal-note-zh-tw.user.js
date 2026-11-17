// ==UserScript==
// @name         트릭컬 노트 (Trickcal Note) 韓文轉繁體中文 (支援 AI/LLM + 術語表編輯)
// @namespace    https://note.trickcal.com/
// @version      2.2.0
// @description  將 트릭컬 노트 (note.trickcal.com) 韓文翻譯為繁體中文，支援 AI/LLM、側邊欄術語表、選詞加入術語表與排除不翻譯規則
// @author       Antigravity
// @match        https://note.trickcal.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @connect      translate.googleapis.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const HANGUL_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
    const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE']);
    const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'];

    const STORAGE_KEYS = {
        CACHE: 'trickcal_note_zh_tw_cache_v2',
        ENABLED: 'trickcal_note_zh_tw_enabled',
        GLOSSARY: 'trickcal_note_zh_tw_glossary_v1',
        SETTINGS: 'trickcal_note_zh_tw_ai_settings_v1',
        EXCLUDES: 'trickcal_note_zh_tw_excludes_v1',
    };

    const DEFAULT_GLOSSARY = {
        '트릭컬 노트': 'Trickcal 筆記',
        '트릭컬 리바이브': '嘟嘟臉惡作劇',
        '이용약관': '使用條款',
        '개인정보처리방침': '隱私權政策',
        '로그인': '登入',
        '로그아웃': '登出',
        '저장': '儲存',
        '취소': '取消',
        '확인': '確認',
        '삭제': '刪除',
        '수정': '編輯',
        '검색': '搜尋',
        '설정': '設定',
        '공지사항': '公告事項',
        '닫기': '關閉',
        '사도': '使徒',
        '성격': '性格',
        '광기': '狂氣',
        '순수': '純真',
        '냉정': '冷靜',
        '우울': '憂鬱',
        '활발': '活潑',
        '아티팩트': '神器',
        '스펠': '魔法',
        '전열': '前排',
        '중열': '中排',
        '후열': '後排',
        '스킬': '技能',
        '저학년 스킬': '低年級技能',
        '고학년 스킬': '高年級技能',
        '평타': '普攻',
        '엘다인': '艾爾達因',
    };

    const DEFAULT_SYSTEM_PROMPT =
        '你是一位精通《嘟嘟臉惡作劇》(Trickcal / 트릭컬) 的韓文翻譯專家。請將提供的韓文遊戲網頁內容翻譯為自然、道地的台灣繁體中文。保留數字、符號、變數或專有名詞格式，不要添加多餘解釋。';

    const DEFAULT_SETTINGS = {
        engine: 'google', // 'google' | 'llm'
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: '',
        model: 'gpt-4o-mini',
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };

    // --- 狀態初始化 ---
    let isEnabled = GM_getValue(STORAGE_KEYS.ENABLED, true);
    let settings = Object.assign({}, DEFAULT_SETTINGS, GM_getValue(STORAGE_KEYS.SETTINGS, {}));
    let glossary = Object.assign({}, DEFAULT_GLOSSARY, GM_getValue(STORAGE_KEYS.GLOSSARY, {}));
    let excludes = Object.assign({ paths: [], selectors: [] }, GM_getValue(STORAGE_KEYS.EXCLUDES, {}));
    const cache = new Map(Object.entries(GM_getValue(STORAGE_KEYS.CACHE, {})));

    const pendingTranslations = new Map(); // trimmedText -> Promise<string>
    const nodeOriginalText = new WeakMap();
    const trackedNodes = new Set();

    let saveCacheTimer = null;
    let scanTimer = null;
    let isApplying = false;

    // --- 快取與設定儲存 ---
    function scheduleSaveCache() {
        if (saveCacheTimer) return;
        saveCacheTimer = setTimeout(() => {
            saveCacheTimer = null;
            try {
                if (cache.size > 5000) {
                    const entries = Array.from(cache.entries()).slice(-4000);
                    GM_setValue(STORAGE_KEYS.CACHE, Object.fromEntries(entries));
                } else {
                    GM_setValue(STORAGE_KEYS.CACHE, Object.fromEntries(cache));
                }
            } catch (e) {
                console.warn('[Trickcal 繁中翻譯] 儲存快取失敗:', e);
            }
        }, 1500);
    }

    function saveGlossary() {
        GM_setValue(STORAGE_KEYS.GLOSSARY, glossary);
    }

    function saveSettings() {
        GM_setValue(STORAGE_KEYS.SETTINGS, settings);
    }

    function saveExcludes() {
        GM_setValue(STORAGE_KEYS.EXCLUDES, excludes);
    }

    function isPathExcluded() {
        const currentPath = location.pathname;
        return (excludes.paths || []).some((p) => {
            const rule = p.trim();
            return rule && (currentPath === rule || currentPath.startsWith(rule));
        });
    }

    // --- Google 翻譯佇列 ---
    const MAX_GOOGLE_CONCURRENT = 5;
    let activeGoogleRequests = 0;
    const googleQueue = [];

    function enqueueGoogle(text) {
        return new Promise((resolve, reject) => {
            googleQueue.push({ text, resolve, reject });
            processGoogleQueue();
        });
    }

    function processGoogleQueue() {
        while (activeGoogleRequests < MAX_GOOGLE_CONCURRENT && googleQueue.length > 0) {
            const { text, resolve, reject } = googleQueue.shift();
            activeGoogleRequests++;
            fetchGoogleTranslate(text)
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    activeGoogleRequests--;
                    processGoogleQueue();
                });
        }
    }

    function fetchGoogleTranslate(text) {
        return new Promise((resolve, reject) => {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 10000,
                onload(res) {
                    if (res.status !== 200) {
                        reject(new Error(`Google HTTP ${res.status}`));
                        return;
                    }
                    try {
                        const data = JSON.parse(res.responseText);
                        if (Array.isArray(data) && Array.isArray(data[0])) {
                            const translated = data[0].map((part) => (part && part[0]) || '').join('');
                            resolve(translated || text);
                        } else {
                            resolve(text);
                        }
                    } catch (err) {
                        reject(err);
                    }
                },
                onerror: reject,
                ontimeout: () => reject(new Error('Google Translate timeout')),
            });
        });
    }

    // --- AI / LLM 批次翻譯 ---
    const LLM_BATCH_WAIT_MS = 120;
    const LLM_MAX_BATCH_ITEMS = 15;
    const LLM_MAX_BATCH_CHARS = 2000;
    let llmBatchBuffer = []; // { text, resolve }
    let llmBatchTimer = null;

    function enqueueLLM(text) {
        return new Promise((resolve) => {
            llmBatchBuffer.push({ text, resolve });
            if (llmBatchBuffer.length >= LLM_MAX_BATCH_ITEMS) {
                flushLLMBatch();
            } else if (!llmBatchTimer) {
                llmBatchTimer = setTimeout(flushLLMBatch, LLM_BATCH_WAIT_MS);
            }
        });
    }

    function flushLLMBatch() {
        if (llmBatchTimer) {
            clearTimeout(llmBatchTimer);
            llmBatchTimer = null;
        }
        if (llmBatchBuffer.length === 0) return;

        // 依字數切分批次
        const currentBatch = [];
        let charCount = 0;
        while (llmBatchBuffer.length > 0 && currentBatch.length < LLM_MAX_BATCH_ITEMS) {
            const next = llmBatchBuffer[0];
            if (currentBatch.length > 0 && charCount + next.text.length > LLM_MAX_BATCH_CHARS) {
                break;
            }
            llmBatchBuffer.shift();
            currentBatch.push(next);
            charCount += next.text.length;
        }

        if (llmBatchBuffer.length > 0) {
            llmBatchTimer = setTimeout(flushLLMBatch, 50);
        }

        runLLMBatch(currentBatch);
    }

    function collectRelevantGlossary(texts) {
        const matched = [];
        const combined = texts.join('\n');
        for (const [ko, zh] of Object.entries(glossary)) {
            if (ko && zh && combined.includes(ko)) {
                matched.push(`- ${ko} => ${zh}`);
            }
        }
        return matched;
    }

    function callLLMAPI(messages) {
        return new Promise((resolve, reject) => {
            if (!settings.apiUrl || !settings.apiKey) {
                reject(new Error('尚未設定 API URL 或 API Key'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'POST',
                url: settings.apiUrl.trim(),
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${settings.apiKey.trim()}`,
                },
                data: JSON.stringify({
                    model: settings.model.trim() || 'gpt-4o-mini',
                    temperature: 0.2,
                    messages,
                }),
                timeout: 30000,
                onload(res) {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`LLM HTTP ${res.status}: ${res.responseText.slice(0, 200)}`));
                        return;
                    }
                    try {
                        const data = JSON.parse(res.responseText);
                        const content = data?.choices?.[0]?.message?.content;
                        if (!content) {
                            reject(new Error('LLM 回應格式無效'));
                            return;
                        }
                        resolve(content.trim());
                    } catch (err) {
                        reject(err);
                    }
                },
                onerror: () => reject(new Error('LLM 網路連線失敗')),
                ontimeout: () => reject(new Error('LLM 請求逾時')),
            });
        });
    }

    async function runLLMBatch(batch) {
        const payloadObj = {};
        batch.forEach((item, idx) => {
            payloadObj[String(idx)] = item.text;
        });

        const relevantTerms = collectRelevantGlossary(batch.map((b) => b.text));
        const glossaryInstruction =
            relevantTerms.length > 0
                ? `\n\n請嚴格遵守以下專有名詞對照表：\n${relevantTerms.join('\n')}`
                : '';

        const systemContent =
            (settings.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
            glossaryInstruction +
            '\n\n請將使用者提供的 JSON 物件中每個 value 的韓文翻譯為繁體中文，並只回傳一個合法的 JSON 物件，保留完全相同的 key，不要包含任何 Markdown 標記或額外文字。';

        try {
            const rawReply = await callLLMAPI([
                { role: 'system', content: systemContent },
                { role: 'user', content: JSON.stringify(payloadObj) },
            ]);

            const cleaned = rawReply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(cleaned);

            batch.forEach((item, idx) => {
                const translated = parsed[String(idx)];
                if (typeof translated === 'string' && translated.trim()) {
                    item.resolve(translated.trim());
                } else {
                    // 單筆缺失時退回 Google 翻譯
                    enqueueGoogle(item.text).then(item.resolve).catch(() => item.resolve(item.text));
                }
            });
        } catch (err) {
            console.warn('[Trickcal 繁中翻譯] LLM 批次翻譯失敗，改用 Google 翻譯備援:', err);
            batch.forEach((item) => {
                enqueueGoogle(item.text).then(item.resolve).catch(() => item.resolve(item.text));
            });
        }
    }

    // --- 統一翻譯入口 ---
    async function translateText(rawText) {
        const trimmed = rawText.trim();
        if (!trimmed || !HANGUL_REGEX.test(trimmed)) {
            return rawText;
        }

        // 1. 術語表完全匹配
        if (Object.prototype.hasOwnProperty.call(glossary, trimmed)) {
            return rawText.replace(trimmed, glossary[trimmed]);
        }

        // 2. 快取命中
        if (cache.has(trimmed)) {
            return rawText.replace(trimmed, cache.get(trimmed));
        }

        // 3. 合併重複請求
        if (pendingTranslations.has(trimmed)) {
            const translated = await pendingTranslations.get(trimmed);
            return rawText.replace(trimmed, translated);
        }

        const useLLM = settings.engine === 'llm' && settings.apiKey && settings.apiUrl;
        const promise = (useLLM ? enqueueLLM(trimmed) : enqueueGoogle(trimmed))
            .then((translated) => {
                if (translated && translated !== trimmed) {
                    cache.set(trimmed, translated);
                    scheduleSaveCache();
                }
                return translated;
            })
            .catch((err) => {
                console.warn('[Trickcal 繁中翻譯] 翻譯失敗:', trimmed, err);
                return trimmed;
            })
            .finally(() => {
                pendingTranslations.delete(trimmed);
            });

        pendingTranslations.set(trimmed, promise);
        const translated = await promise;
        return rawText.replace(trimmed, translated);
    }

    // --- DOM 掃描與套用 ---
    function isIgnoredElement(el) {
        if (!el) return true;
        if (
            el.id === 'trickcal-tr-panel' ||
            el.id === 'trickcal-tr-drawer' ||
            el.id === 'trickcal-tr-selection-pop' ||
            el.closest('#trickcal-tr-panel') ||
            el.closest('#trickcal-tr-drawer') ||
            el.closest('#trickcal-tr-selection-pop')
        ) {
            return true;
        }
        if (IGNORE_TAGS.has(el.tagName)) return true;
        if (el.isContentEditable) return true;
        for (const sel of excludes.selectors || []) {
            const s = sel.trim();
            if (!s) continue;
            try {
                if (el.matches(s) || el.closest(s)) return true;
            } catch (_) {
                // 忽略無效的 CSS 選擇器
            }
        }
        return false;
    }

    async function processTextNode(node) {
        if (!node.isConnected) return;
        const parent = node.parentElement;
        if (!parent || isIgnoredElement(parent)) return;

        const currentVal = node.nodeValue;
        if (!currentVal || !HANGUL_REGEX.test(currentVal)) return;

        if (!nodeOriginalText.has(node)) {
            nodeOriginalText.set(node, currentVal);
            trackedNodes.add(node);
        }

        const original = nodeOriginalText.get(node);
        const translated = await translateText(original);

        if (!isEnabled || !node.isConnected || isPathExcluded()) return;
        if (node.nodeValue !== translated) {
            isApplying = true;
            node.nodeValue = translated;
            isApplying = false;
        }
    }

    async function processElementAttributes(el) {
        if (!el.isConnected || isIgnoredElement(el)) return;
        for (const attr of TRANSLATABLE_ATTRS) {
            const val = el.getAttribute(attr);
            if (!val || !HANGUL_REGEX.test(val)) continue;

            const origAttrKey = `data-tr-orig-${attr}`;
            if (!el.hasAttribute(origAttrKey)) {
                el.setAttribute(origAttrKey, val);
            }
            const original = el.getAttribute(origAttrKey);
            const translated = await translateText(original);
            if (!isEnabled || !el.isConnected || isPathExcluded()) return;
            if (el.getAttribute(attr) !== translated) {
                isApplying = true;
                el.setAttribute(attr, translated);
                isApplying = false;
            }
        }
    }

    function scanRoot(root) {
        if (!isEnabled || !root || isPathExcluded()) return;

        if (root.nodeType === Node.TEXT_NODE) {
            processTextNode(root);
            return;
        }

        if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body) return;
        if (root.nodeType === Node.ELEMENT_NODE && isIgnoredElement(root)) return;

        if (root.nodeType === Node.ELEMENT_NODE) {
            processElementAttributes(root);
            const elements = root.querySelectorAll('[placeholder], [title], [aria-label]');
            for (const el of elements) {
                processElementAttributes(el);
            }
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !HANGUL_REGEX.test(node.nodeValue)) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (isIgnoredElement(node.parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        let current;
        while ((current = walker.nextNode())) {
            processTextNode(current);
        }
    }

    function restoreOriginals() {
        isApplying = true;
        for (const node of trackedNodes) {
            if (!node.isConnected) {
                trackedNodes.delete(node);
                continue;
            }
            const orig = nodeOriginalText.get(node);
            if (orig !== undefined && node.nodeValue !== orig) {
                node.nodeValue = orig;
            }
        }
        for (const attr of TRANSLATABLE_ATTRS) {
            const origAttrKey = `data-tr-orig-${attr}`;
            document.querySelectorAll(`[${origAttrKey}]`).forEach((el) => {
                el.setAttribute(attr, el.getAttribute(origAttrKey));
            });
        }
        isApplying = false;
    }

    function retranslatePage() {
        restoreOriginals();
        if (isEnabled && document.body) {
            scanRoot(document.body);
        }
    }

    function scheduleFullScan() {
        if (!isEnabled || scanTimer) return;
        scanTimer = setTimeout(() => {
            scanTimer = null;
            if (document.body) scanRoot(document.body);
        }, 250);
    }

    const observer = new MutationObserver((mutations) => {
        if (!isEnabled || isApplying) return;
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                for (const added of mutation.addedNodes) {
                    scanRoot(added);
                }
            } else if (mutation.type === 'characterData') {
                const target = mutation.target;
                if (target.nodeType === Node.TEXT_NODE && HANGUL_REGEX.test(target.nodeValue || '')) {
                    nodeOriginalText.set(target, target.nodeValue);
                    processTextNode(target);
                }
            } else if (mutation.type === 'attributes') {
                processElementAttributes(mutation.target);
            }
        }
    });

    // --- UI 樣式與側邊欄 ---
    function injectStyles() {
        GM_addStyle(`
            #trickcal-tr-panel {
                position: fixed;
                right: 16px;
                bottom: 16px;
                z-index: 999990;
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(24, 24, 27, 0.9);
                color: #fff;
                padding: 6px 10px;
                border-radius: 9999px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
                backdrop-filter: blur(8px);
                user-select: none;
            }
            #trickcal-tr-panel button {
                border: none;
                border-radius: 9999px;
                padding: 5px 10px;
                font-size: 12px;
                cursor: pointer;
                transition: opacity 0.15s;
            }
            #trickcal-tr-panel button:hover { opacity: 0.85; }
            #trickcal-tr-toggle { background: #22c55e; color: #fff; font-weight: 600; }
            #trickcal-tr-toggle.off { background: #64748b; }
            #trickcal-tr-drawer-btn { background: #3b82f6; color: #fff; font-weight: 500; }
            #trickcal-tr-clear { background: rgba(255, 255, 255, 0.15); color: #e2e8f0; }

            #trickcal-tr-drawer {
                position: fixed;
                top: 0;
                right: -420px;
                width: 400px;
                max-width: 92vw;
                height: 100vh;
                z-index: 999999;
                background: #18181b;
                color: #f4f4f5;
                box-shadow: -6px 0 24px rgba(0, 0, 0, 0.45);
                display: flex;
                flex-direction: column;
                transition: right 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                border-left: 1px solid #27272a;
            }
            #trickcal-tr-drawer.open { right: 0; }

            .tr-drawer-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 16px;
                border-bottom: 1px solid #27272a;
                font-weight: 600;
                font-size: 15px;
            }
            .tr-close-btn {
                background: transparent;
                border: none;
                color: #a1a1aa;
                font-size: 20px;
                cursor: pointer;
                line-height: 1;
            }
            .tr-close-btn:hover { color: #fff; }

            .tr-tabs {
                display: flex;
                border-bottom: 1px solid #27272a;
                background: #1f1f23;
            }
            .tr-tab {
                flex: 1;
                padding: 10px;
                text-align: center;
                cursor: pointer;
                background: transparent;
                border: none;
                color: #a1a1aa;
                font-weight: 500;
                border-bottom: 2px solid transparent;
            }
            .tr-tab.active {
                color: #60a5fa;
                border-bottom-color: #3b82f6;
                background: #18181b;
            }

            .tr-drawer-body {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            .tr-tab-pane { display: none; flex-direction: column; gap: 12px; }
            .tr-tab-pane.active { display: flex; }

            .tr-field { display: flex; flex-direction: column; gap: 5px; }
            .tr-field label { font-size: 12px; color: #a1a1aa; font-weight: 500; }
            .tr-input, .tr-select, .tr-textarea {
                background: #27272a;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                color: #f4f4f5;
                padding: 8px 10px;
                font-size: 13px;
                outline: none;
                width: 100%;
                box-sizing: border-box;
            }
            .tr-input:focus, .tr-select:focus, .tr-textarea:focus {
                border-color: #3b82f6;
            }
            .tr-textarea { min-height: 76px; resize: vertical; font-family: inherit; }

            .tr-row { display: flex; gap: 8px; align-items: center; }
            .tr-btn {
                border: none;
                border-radius: 6px;
                padding: 7px 12px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                color: #fff;
                background: #3b82f6;
            }
            .tr-btn:hover { opacity: 0.9; }
            .tr-btn-secondary { background: #3f3f46; color: #e4e4e7; }
            .tr-btn-success { background: #22c55e; }
            .tr-btn-danger { background: #ef4444; }
            .tr-btn-sm { padding: 4px 8px; font-size: 11px; }

            .tr-presets { display: flex; flex-wrap: wrap; gap: 6px; }
            .tr-preset-chip {
                background: #27272a;
                border: 1px solid #3f3f46;
                color: #d4d4d8;
                border-radius: 9999px;
                padding: 3px 10px;
                font-size: 11px;
                cursor: pointer;
            }
            .tr-preset-chip:hover { border-color: #3b82f6; color: #fff; }

            .tr-glossary-list {
                display: flex;
                flex-direction: column;
                gap: 6px;
                max-height: 360px;
                overflow-y: auto;
                padding-right: 2px;
            }
            .tr-glossary-item {
                display: flex;
                gap: 6px;
                align-items: center;
                background: #27272a;
                padding: 6px 8px;
                border-radius: 6px;
            }
            .tr-glossary-item input {
                flex: 1;
                min-width: 0;
                background: #18181b;
                border: 1px solid #3f3f46;
                color: #f4f4f5;
                border-radius: 4px;
                padding: 4px 6px;
                font-size: 12px;
            }
            .tr-status-msg {
                font-size: 12px;
                padding: 6px 10px;
                border-radius: 6px;
                display: none;
            }
            .tr-status-msg.ok { display: block; background: rgba(34, 197, 94, 0.15); color: #4ade80; }
            .tr-status-msg.err { display: block; background: rgba(239, 68, 68, 0.15); color: #f87171; }

            #trickcal-tr-selection-pop {
                position: fixed;
                z-index: 999998;
                display: none;
                align-items: center;
                gap: 4px;
                background: rgba(24, 24, 27, 0.95);
                border: 1px solid #3f3f46;
                padding: 4px 6px;
                border-radius: 8px;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
                backdrop-filter: blur(6px);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }
            #trickcal-tr-selection-pop button {
                border: none;
                border-radius: 6px;
                padding: 4px 8px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                color: #fff;
                white-space: nowrap;
            }
            #trickcal-tr-selection-pop button:hover { opacity: 0.9; }
            #tr-sel-add-glossary { background: #3b82f6; }
            #tr-sel-exclude-el { background: #52525b; color: #f4f4f5; }
        `);
    }

    function createDrawer() {
        const drawer = document.createElement('div');
        drawer.id = 'trickcal-tr-drawer';
        drawer.innerHTML = `
            <div class="tr-drawer-header">
                <span>Trickcal 翻譯設定 & 術語表</span>
                <button class="tr-close-btn" id="tr-drawer-close" title="關閉">&times;</button>
            </div>
            <div class="tr-tabs">
                <button class="tr-tab active" data-tab="ai">AI / 翻譯引擎</button>
                <button class="tr-tab" data-tab="glossary">術語表 (<span id="tr-glossary-count">0</span>)</button>
                <button class="tr-tab" data-tab="exclude">排除規則</button>
            </div>
            <div class="tr-drawer-body">
                <!-- Tab 1: AI 設定 -->
                <div class="tr-tab-pane active" id="tr-pane-ai">
                    <div class="tr-field">
                        <label>翻譯引擎</label>
                        <select class="tr-select" id="tr-engine-select">
                            <option value="google">Google 翻譯（免費免設定）</option>
                            <option value="llm">AI / LLM 翻譯（OpenAI 相容 API，品質較佳）</option>
                        </select>
                    </div>

                    <div id="tr-llm-config" style="display:flex; flex-direction:column; gap:12px;">
                        <div class="tr-field">
                            <label>快速套用常見端點</label>
                            <div class="tr-presets">
                                <button type="button" class="tr-preset-chip" data-preset="openai">OpenAI</button>
                                <button type="button" class="tr-preset-chip" data-preset="gemini">Gemini (OpenAI相容)</button>
                                <button type="button" class="tr-preset-chip" data-preset="deepseek">DeepSeek</button>
                            </div>
                        </div>

                        <div class="tr-field">
                            <label>API Endpoint (Chat Completions URL)</label>
                            <input type="text" class="tr-input" id="tr-api-url" placeholder="https://api.openai.com/v1/chat/completions">
                        </div>

                        <div class="tr-field">
                            <label>API Key（僅儲存於本機瀏覽器）</label>
                            <div class="tr-row">
                                <input type="password" class="tr-input" id="tr-api-key" placeholder="sk-...">
                                <button type="button" class="tr-btn tr-btn-secondary" id="tr-toggle-key">顯示</button>
                            </div>
                        </div>

                        <div class="tr-field">
                            <label>模型名稱 (Model)</label>
                            <div class="tr-row">
                                <input type="text" class="tr-input" id="tr-api-model" placeholder="gpt-4o-mini">
                                <button type="button" class="tr-btn tr-btn-secondary" id="tr-fetch-models" style="white-space:nowrap;">查詢模型</button>
                            </div>
                            <select class="tr-select" id="tr-model-select" style="display:none; margin-top:4px;"></select>
                        </div>

                        <div class="tr-field">
                            <label>系統提示詞 (System Prompt)</label>
                            <textarea class="tr-textarea" id="tr-system-prompt"></textarea>
                        </div>
                    </div>

                    <div class="tr-row">
                        <button type="button" class="tr-btn tr-btn-success" id="tr-save-ai">儲存並套用</button>
                        <button type="button" class="tr-btn tr-btn-secondary" id="tr-test-ai">測試 AI 連線</button>
                    </div>
                    <div class="tr-status-msg" id="tr-ai-status"></div>
                </div>

                <!-- Tab 2: 術語表 -->
                <div class="tr-tab-pane" id="tr-pane-glossary">
                    <div class="tr-row">
                        <input type="text" class="tr-input" id="tr-glossary-search" placeholder="搜尋韓文或中文術語...">
                    </div>
                    <div class="tr-row">
                        <input type="text" class="tr-input" id="tr-new-ko" placeholder="韓文原文 (如: 사도)">
                        <input type="text" class="tr-input" id="tr-new-zh" placeholder="繁中譯名 (如: 使徒)">
                        <button type="button" class="tr-btn" id="tr-add-term">新增</button>
                    </div>
                    <div class="tr-glossary-list" id="tr-glossary-list"></div>
                    <div class="tr-row" style="justify-content: space-between; flex-wrap: wrap;">
                        <div class="tr-row">
                            <button type="button" class="tr-btn tr-btn-secondary tr-btn-sm" id="tr-export-glossary">匯出 JSON</button>
                            <button type="button" class="tr-btn tr-btn-secondary tr-btn-sm" id="tr-import-glossary">匯入 JSON</button>
                        </div>
                        <button type="button" class="tr-btn tr-btn-danger tr-btn-sm" id="tr-reset-glossary">重置預設</button>
                    </div>
                    <div class="tr-status-msg" id="tr-glossary-status"></div>
                </div>

                <!-- Tab 3: 排除規則 -->
                <div class="tr-tab-pane" id="tr-pane-exclude">
                    <div class="tr-field">
                        <label>不翻譯的網址路徑（每行一條，例如 /leaderboard）</label>
                        <textarea class="tr-textarea" id="tr-exclude-paths" placeholder="/leaderboard"></textarea>
                        <div class="tr-row">
                            <button type="button" class="tr-btn tr-btn-secondary tr-btn-sm" id="tr-add-current-path">+ 排除目前頁面</button>
                        </div>
                    </div>

                    <div class="tr-field">
                        <label>不翻譯的 CSS 選擇器（每行一條，可用選取文字「🚫 不翻譯此類」自動加入）</label>
                        <textarea class="tr-textarea" id="tr-exclude-selectors" style="min-height:110px;" placeholder="例如：&#10;table td:nth-child(2)&#10;.nickname"></textarea>
                    </div>

                    <div class="tr-row">
                        <button type="button" class="tr-btn tr-btn-success" id="tr-save-excludes">儲存排除規則並套用</button>
                    </div>
                    <div class="tr-status-msg" id="tr-exclude-status"></div>
                </div>
            </div>
        `;
        document.body.appendChild(drawer);

        // --- Drawer 切換與 Tab 邏輯 ---
        drawer.querySelector('#tr-drawer-close').addEventListener('click', () => {
            drawer.classList.remove('open');
        });

        drawer.querySelectorAll('.tr-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                drawer.querySelectorAll('.tr-tab').forEach((t) => t.classList.remove('active'));
                drawer.querySelectorAll('.tr-tab-pane').forEach((p) => p.classList.remove('active'));
                tab.classList.add('active');
                drawer.querySelector(`#tr-pane-${tab.dataset.tab}`).classList.add('active');
            });
        });

        // --- AI 設定邏輯 ---
        const engineSelect = drawer.querySelector('#tr-engine-select');
        const llmConfigDiv = drawer.querySelector('#tr-llm-config');
        const apiUrlInput = drawer.querySelector('#tr-api-url');
        const apiKeyInput = drawer.querySelector('#tr-api-key');
        const modelInput = drawer.querySelector('#tr-api-model');
        const promptInput = drawer.querySelector('#tr-system-prompt');
        const aiStatus = drawer.querySelector('#tr-ai-status');

        function syncAIInputs() {
            engineSelect.value = settings.engine;
            apiUrlInput.value = settings.apiUrl;
            apiKeyInput.value = settings.apiKey;
            modelInput.value = settings.model;
            promptInput.value = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
            llmConfigDiv.style.display = engineSelect.value === 'llm' ? 'flex' : 'none';
        }
        syncAIInputs();

        engineSelect.addEventListener('change', () => {
            llmConfigDiv.style.display = engineSelect.value === 'llm' ? 'flex' : 'none';
        });

        drawer.querySelector('#tr-toggle-key').addEventListener('click', (e) => {
            const isPwd = apiKeyInput.type === 'password';
            apiKeyInput.type = isPwd ? 'text' : 'password';
            e.target.textContent = isPwd ? '隱藏' : '顯示';
        });

        const PRESETS = {
            openai: {
                url: 'https://api.openai.com/v1/chat/completions',
                model: 'gpt-4o-mini',
            },
            gemini: {
                url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
                model: 'gemini-2.5-flash',
            },
            deepseek: {
                url: 'https://api.deepseek.com/chat/completions',
                model: 'deepseek-chat',
            },
        };

        drawer.querySelectorAll('.tr-preset-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                const p = PRESETS[chip.dataset.preset];
                if (p) {
                    apiUrlInput.value = p.url;
                    modelInput.value = p.model;
                }
            });
        });

        function showAIStatus(msg, ok) {
            aiStatus.textContent = msg;
            aiStatus.className = `tr-status-msg ${ok ? 'ok' : 'err'}`;
        }

        const modelSelect = drawer.querySelector('#tr-model-select');
        const fetchModelsBtn = drawer.querySelector('#tr-fetch-models');

        modelSelect.addEventListener('change', () => {
            if (modelSelect.value) {
                modelInput.value = modelSelect.value;
            }
        });

        fetchModelsBtn.addEventListener('click', () => {
            const url = apiUrlInput.value.trim();
            const key = apiKeyInput.value.trim();
            if (!url || !key) {
                showAIStatus('請先填寫 API Endpoint 與 API Key', false);
                return;
            }
            const modelsUrl = /\/chat\/completions\/?$/.test(url)
                ? url.replace(/\/chat\/completions\/?$/, '/models')
                : /\/models\/?$/.test(url)
                  ? url
                  : `${url.replace(/\/+$/, '')}/models`;

            fetchModelsBtn.disabled = true;
            fetchModelsBtn.textContent = '查詢中...';
            showAIStatus('正在查詢可用模型清單...', true);

            GM_xmlhttpRequest({
                method: 'GET',
                url: modelsUrl,
                headers: {
                    Authorization: `Bearer ${key}`,
                },
                timeout: 15000,
                onload(res) {
                    fetchModelsBtn.disabled = false;
                    fetchModelsBtn.textContent = '查詢模型';
                    if (res.status < 200 || res.status >= 300) {
                        showAIStatus(`查詢失敗 (HTTP ${res.status})：${res.responseText.slice(0, 150)}`, false);
                        return;
                    }
                    try {
                        const data = JSON.parse(res.responseText);
                        const rawList = Array.isArray(data?.data)
                            ? data.data
                            : Array.isArray(data?.models)
                              ? data.models
                              : [];
                        const ids = rawList
                            .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
                            .filter(Boolean)
                            .sort((a, b) => a.localeCompare(b));

                        if (ids.length === 0) {
                            showAIStatus('未回傳任何可用模型，請確認端點是否支援 /models', false);
                            return;
                        }

                        modelSelect.innerHTML = '<option value="">-- 請選擇可用模型 --</option>';
                        ids.forEach((id) => {
                            const opt = document.createElement('option');
                            opt.value = id;
                            opt.textContent = id;
                            if (id === modelInput.value.trim()) opt.selected = true;
                            modelSelect.appendChild(opt);
                        });
                        modelSelect.style.display = 'block';
                        showAIStatus(`成功取得 ${ids.length} 個可用模型，請從下方下拉選單選擇！`, true);
                    } catch (err) {
                        showAIStatus(`解析模型清單失敗：${err.message}`, false);
                    }
                },
                onerror() {
                    fetchModelsBtn.disabled = false;
                    fetchModelsBtn.textContent = '查詢模型';
                    showAIStatus('查詢模型連線失敗，請檢查端點網址或網路狀態', false);
                },
                ontimeout() {
                    fetchModelsBtn.disabled = false;
                    fetchModelsBtn.textContent = '查詢模型';
                    showAIStatus('查詢模型請求逾時', false);
                },
            });
        });

        drawer.querySelector('#tr-save-ai').addEventListener('click', () => {
            settings.engine = engineSelect.value;
            settings.apiUrl = apiUrlInput.value.trim();
            settings.apiKey = apiKeyInput.value.trim();
            settings.model = modelInput.value.trim();
            settings.systemPrompt = promptInput.value.trim() || DEFAULT_SYSTEM_PROMPT;
            saveSettings();
            cache.clear();
            GM_setValue(STORAGE_KEYS.CACHE, {});
            retranslatePage();
            showAIStatus('設定已儲存，並已重新翻譯頁面！', true);
        });

        drawer.querySelector('#tr-test-ai').addEventListener('click', async () => {
            const prev = Object.assign({}, settings);
            settings.apiUrl = apiUrlInput.value.trim();
            settings.apiKey = apiKeyInput.value.trim();
            settings.model = modelInput.value.trim();
            showAIStatus('連線測試中...', true);
            try {
                const res = await callLLMAPI([
                    { role: 'system', content: '請將韓文翻譯為繁體中文，只回傳譯文。' },
                    { role: 'user', content: '트릭컬 리바이브' },
                ]);
                showAIStatus(`測試成功！回應：${res}`, true);
            } catch (err) {
                showAIStatus(`測試失敗：${err.message}`, false);
            } finally {
                Object.assign(settings, prev);
            }
        });

        // --- 術語表編輯邏輯 ---
        const glossaryListEl = drawer.querySelector('#tr-glossary-list');
        const glossaryCountEl = drawer.querySelector('#tr-glossary-count');
        const searchInput = drawer.querySelector('#tr-glossary-search');
        const newKoInput = drawer.querySelector('#tr-new-ko');
        const newZhInput = drawer.querySelector('#tr-new-zh');
        const glossaryStatus = drawer.querySelector('#tr-glossary-status');

        function showGlossaryStatus(msg, ok = true) {
            glossaryStatus.textContent = msg;
            glossaryStatus.className = `tr-status-msg ${ok ? 'ok' : 'err'}`;
            setTimeout(() => {
                glossaryStatus.style.display = '';
                glossaryStatus.className = 'tr-status-msg';
            }, 3000);
        }

        function renderGlossary() {
            const filter = searchInput.value.trim().toLowerCase();
            const entries = Object.entries(glossary);
            glossaryCountEl.textContent = String(entries.length);
            glossaryListEl.innerHTML = '';

            for (const [ko, zh] of entries) {
                if (filter && !ko.toLowerCase().includes(filter) && !zh.toLowerCase().includes(filter)) {
                    continue;
                }
                const row = document.createElement('div');
                row.className = 'tr-glossary-item';

                const koInput = document.createElement('input');
                koInput.value = ko;
                koInput.title = '韓文原文';

                const zhInput = document.createElement('input');
                zhInput.value = zh;
                zhInput.title = '繁體中文譯名';

                const saveRow = () => {
                    const nextKo = koInput.value.trim();
                    const nextZh = zhInput.value.trim();
                    if (!nextKo || !nextZh) return;
                    if (nextKo !== ko) {
                        delete glossary[ko];
                    }
                    glossary[nextKo] = nextZh;
                    cache.delete(nextKo);
                    saveGlossary();
                    GM_setValue(STORAGE_KEYS.CACHE, Object.fromEntries(cache));
                    retranslatePage();
                };

                koInput.addEventListener('change', saveRow);
                zhInput.addEventListener('change', saveRow);

                const delBtn = document.createElement('button');
                delBtn.className = 'tr-btn tr-btn-danger tr-btn-sm';
                delBtn.textContent = '刪';
                delBtn.addEventListener('click', () => {
                    delete glossary[ko];
                    cache.delete(ko);
                    saveGlossary();
                    renderGlossary();
                    retranslatePage();
                });

                row.appendChild(koInput);
                row.appendChild(zhInput);
                row.appendChild(delBtn);
                glossaryListEl.appendChild(row);
            }
        }

        searchInput.addEventListener('input', renderGlossary);

        drawer.querySelector('#tr-add-term').addEventListener('click', () => {
            const ko = newKoInput.value.trim();
            const zh = newZhInput.value.trim();
            if (!ko || !zh) {
                showGlossaryStatus('請同時輸入韓文原文與繁中譯名', false);
                return;
            }
            glossary[ko] = zh;
            cache.delete(ko);
            saveGlossary();
            newKoInput.value = '';
            newZhInput.value = '';
            renderGlossary();
            retranslatePage();
            showGlossaryStatus(`已新增：${ko} → ${zh}`, true);
        });

        drawer.querySelector('#tr-export-glossary').addEventListener('click', () => {
            const json = JSON.stringify(glossary, null, 2);
            navigator.clipboard?.writeText(json).then(
                () => showGlossaryStatus('術語表 JSON 已複製到剪貼簿！', true),
                () => prompt('請手動複製以下 JSON：', json)
            );
        });

        drawer.querySelector('#tr-import-glossary').addEventListener('click', () => {
            const input = prompt('請貼上術語表 JSON（格式：{"韓文": "中文"}）：');
            if (!input) return;
            try {
                const parsed = JSON.parse(input);
                if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('格式錯誤');
                Object.assign(glossary, parsed);
                saveGlossary();
                cache.clear();
                GM_setValue(STORAGE_KEYS.CACHE, {});
                renderGlossary();
                retranslatePage();
                showGlossaryStatus('匯入成功並已重新翻譯！', true);
            } catch (e) {
                showGlossaryStatus('JSON 格式無效，匯入失敗', false);
            }
        });

        drawer.querySelector('#tr-reset-glossary').addEventListener('click', () => {
            if (!confirm('確定要將術語表重置為預設值嗎？')) return;
            glossary = Object.assign({}, DEFAULT_GLOSSARY);
            saveGlossary();
            cache.clear();
            GM_setValue(STORAGE_KEYS.CACHE, {});
            renderGlossary();
            retranslatePage();
            showGlossaryStatus('已重置為預設術語表', true);
        });

        // --- 排除規則邏輯 ---
        const excludePathsInput = drawer.querySelector('#tr-exclude-paths');
        const excludeSelectorsInput = drawer.querySelector('#tr-exclude-selectors');
        const excludeStatus = drawer.querySelector('#tr-exclude-status');

        function syncExcludeInputs() {
            excludePathsInput.value = (excludes.paths || []).join('\n');
            excludeSelectorsInput.value = (excludes.selectors || []).join('\n');
        }

        function showExcludeStatus(msg, ok = true) {
            excludeStatus.textContent = msg;
            excludeStatus.className = `tr-status-msg ${ok ? 'ok' : 'err'}`;
            setTimeout(() => {
                excludeStatus.style.display = '';
                excludeStatus.className = 'tr-status-msg';
            }, 3000);
        }

        drawer.querySelector('#tr-add-current-path').addEventListener('click', () => {
            const p = location.pathname;
            if (!excludes.paths.includes(p)) {
                excludes.paths.push(p);
                syncExcludeInputs();
            }
        });

        drawer.querySelector('#tr-save-excludes').addEventListener('click', () => {
            excludes.paths = excludePathsInput.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
            excludes.selectors = excludeSelectorsInput.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
            saveExcludes();
            retranslatePage();
            showExcludeStatus('排除規則已儲存並套用！', true);
        });

        drawer._openTab = (tabName) => {
            drawer.classList.add('open');
            drawer.querySelectorAll('.tr-tab').forEach((t) => {
                t.classList.toggle('active', t.dataset.tab === tabName);
            });
            drawer.querySelectorAll('.tr-tab-pane').forEach((p) => {
                p.classList.toggle('active', p.id === `tr-pane-${tabName}`);
            });
        };
        drawer._syncExcludeInputs = syncExcludeInputs;

        syncExcludeInputs();
        renderGlossary();
        return drawer;
    }

    // --- 選取文字懸浮按鈕（加入術語表 / 排除不翻譯） ---
    function deriveElementSelector(el) {
        if (!el || el === document.body) return '';
        const td = el.closest('td, th');
        if (td && td.parentElement) {
            const idx = Array.from(td.parentElement.children).indexOf(td) + 1;
            const table = td.closest('table');
            if (table && table.classList.length > 0) {
                const cls = Array.from(table.classList)
                    .filter((c) => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c))
                    .slice(0, 2)
                    .map((c) => `.${CSS.escape(c)}`)
                    .join('');
                if (cls) return `table${cls} ${td.tagName.toLowerCase()}:nth-child(${idx})`;
            }
            return `table ${td.tagName.toLowerCase()}:nth-child(${idx})`;
        }

        const classes = Array.from(el.classList || [])
            .filter((c) => /^[a-zA-Z_-][a-zA-Z0-9_-]{2,}$/.test(c))
            .slice(0, 2);
        if (classes.length > 0) {
            return `${el.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join('.')}`;
        }
        return el.tagName.toLowerCase();
    }

    function setupSelectionPopup(drawer) {
        const pop = document.createElement('div');
        pop.id = 'trickcal-tr-selection-pop';
        pop.innerHTML = `
            <button type="button" id="tr-sel-add-glossary">+ 加入術語表</button>
            <button type="button" id="tr-sel-exclude-el" title="將此類元素加入不翻譯清單">🚫 不翻譯此類</button>
        `;
        document.body.appendChild(pop);

        let lastSelectionInfo = null;

        function hidePop() {
            pop.style.display = 'none';
            lastSelectionInfo = null;
        }

        document.addEventListener('mouseup', (e) => {
            if (e.target.closest('#trickcal-tr-selection-pop') || e.target.closest('#trickcal-tr-drawer') || e.target.closest('#trickcal-tr-panel')) {
                return;
            }
            setTimeout(() => {
                const sel = window.getSelection();
                const text = sel ? sel.toString().trim() : '';
                if (!text || text.length > 80 || sel.rangeCount === 0) {
                    hidePop();
                    return;
                }
                const range = sel.getRangeAt(0);
                const container = range.commonAncestorContainer;
                const el = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
                if (!el || IGNORE_TAGS.has(el.tagName) || el.isContentEditable) {
                    hidePop();
                    return;
                }

                const anchorNode = sel.anchorNode;
                const origNodeText = anchorNode && nodeOriginalText.has(anchorNode) ? nodeOriginalText.get(anchorNode).trim() : '';

                lastSelectionInfo = {
                    selectedText: text,
                    origNodeText,
                    element: el,
                };

                const rect = range.getBoundingClientRect();
                const top = Math.max(8, rect.top - 38);
                const left = Math.min(window.innerWidth - 210, Math.max(8, rect.left));
                pop.style.top = `${top}px`;
                pop.style.left = `${left}px`;
                pop.style.display = 'flex';
            }, 10);
        });

        document.addEventListener('mousedown', (e) => {
            if (!e.target.closest('#trickcal-tr-selection-pop')) {
                hidePop();
            }
        });

        pop.querySelector('#tr-sel-add-glossary').addEventListener('click', () => {
            if (!lastSelectionInfo) return;
            const { selectedText, origNodeText } = lastSelectionInfo;
            const koInput = drawer.querySelector('#tr-new-ko');
            const zhInput = drawer.querySelector('#tr-new-zh');

            drawer._openTab('glossary');
            if (HANGUL_REGEX.test(selectedText)) {
                koInput.value = selectedText;
                zhInput.value = '';
                zhInput.focus();
            } else {
                koInput.value = origNodeText || '';
                zhInput.value = selectedText;
                (koInput.value ? zhInput : koInput).focus();
            }
            hidePop();
        });

        pop.querySelector('#tr-sel-exclude-el').addEventListener('click', () => {
            if (!lastSelectionInfo) return;
            const selector = deriveElementSelector(lastSelectionInfo.element);
            if (selector && !excludes.selectors.includes(selector)) {
                excludes.selectors.push(selector);
                saveExcludes();
                drawer._syncExcludeInputs();
                retranslatePage();
            }
            hidePop();
        });
    }

    function createControlPanel(drawer) {
        const panel = document.createElement('div');
        panel.id = 'trickcal-tr-panel';

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'trickcal-tr-toggle';

        const drawerBtn = document.createElement('button');
        drawerBtn.id = 'trickcal-tr-drawer-btn';
        drawerBtn.textContent = '設定 / 術語表';

        const clearBtn = document.createElement('button');
        clearBtn.id = 'trickcal-tr-clear';
        clearBtn.textContent = '重譯';
        clearBtn.title = '清除翻譯快取並重新翻譯';

        function updateToggleUI() {
            toggleBtn.textContent = isEnabled ? '繁中翻譯：開' : '繁中翻譯：關';
            toggleBtn.classList.toggle('off', !isEnabled);
        }

        toggleBtn.addEventListener('click', () => {
            isEnabled = !isEnabled;
            GM_setValue(STORAGE_KEYS.ENABLED, isEnabled);
            updateToggleUI();
            if (isEnabled) {
                scheduleFullScan();
            } else {
                restoreOriginals();
            }
        });

        drawerBtn.addEventListener('click', () => {
            drawer.classList.toggle('open');
        });

        clearBtn.addEventListener('click', () => {
            cache.clear();
            GM_setValue(STORAGE_KEYS.CACHE, {});
            retranslatePage();
        });

        updateToggleUI();
        panel.appendChild(toggleBtn);
        panel.appendChild(drawerBtn);
        panel.appendChild(clearBtn);
        document.body.appendChild(panel);
    }

    function init() {
        if (!document.body) return;
        injectStyles();
        const drawer = createDrawer();
        createControlPanel(drawer);
        setupSelectionPopup(drawer);

        // 監聽 SPA 路由切換
        let lastPath = location.pathname;
        const onRouteChange = () => {
            if (location.pathname !== lastPath) {
                lastPath = location.pathname;
                if (isPathExcluded()) {
                    restoreOriginals();
                } else if (isEnabled) {
                    scheduleFullScan();
                }
            }
        };
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function (...args) {
            origPush.apply(this, args);
            onRouteChange();
        };
        history.replaceState = function (...args) {
            origReplace.apply(this, args);
            onRouteChange();
        };
        window.addEventListener('popstate', onRouteChange);

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: TRANSLATABLE_ATTRS,
        });

        if (isEnabled && !isPathExcluded()) {
            scanRoot(document.body);
        }
    }

    init();
})();
