// index.js for SillyTavern Extension

(async function () {
    const EXTENSION_NAME = "SillyTavern-CocoSnap"; // 設定在 ST 裡的儲存鍵名
    // 取得當前 script 的完整路徑，並移除 index.js 檔名，只保留目錄
    const scriptPath = document.currentScript ? document.currentScript.src : null;
    // 如果無法偵測 (極少見)，則回退到預設名稱
    const EXTENSION_PATH = scriptPath 
        ? scriptPath.substring(0, scriptPath.lastIndexOf('/') + 1) 
        : `/scripts/extensions/third-party/SillyTavern-CocoSnap/`;

    // 移除 console.log 的硬編碼名稱，改用通用名稱
    const LOG_PREFIX = '[CocoSnap]';

    // 之後的 loadLib 函式改成這樣使用 EXTENSION_PATH：
    const loadLib = (filename) => {
        return new Promise((resolve, reject) => {
            // 檢查是否已載入
            if (document.querySelector(`script[src*="${filename}"]`)) { resolve(); return; }
            
            const script = document.createElement('script');
            script.src = EXTENSION_PATH + 'lib/' + filename; // 直接使用偵測到的路徑
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    };

    // 依序載入庫 (注意順序，如果彼此有依賴)
    try {
        await loadLib('turndown.umd.js');
        await loadLib('marked.umd.js');
        await loadLib('html2canvas.min.js');
        await loadLib('jszip.min.js');
        console.log('[可可快存] 依賴庫載入完成');
    } catch (e) {
        console.error('[可可快存] 載入庫失敗:', e);
        return; // 庫沒載入成功就停止執行
    }

    // 確保庫載入後再初始化 Turndown
    const td = new TurndownService({ headingStyle: "atx" });

    // ===== 1. 基本設定與 ST Context =====
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const SCALE = 2;
    const defaultCfg = {
        userBg: "#313131", aiBg: "#202020",
        quoteColor: "#e18a24", bracketColor: "#e18a24",
        italicColor: "#888888",
        bg: "#000000", txt: "#ffffff",
        width: 800, fSize: 16, lineR: 1.6, fFamily: "Noto Sans TC, sans-serif", // ST 常見預設字體
        avatarW: 100, showAvatar: true,
        MAX: 4096
    };

    // 初始化設定物件
    function getCfg() {
        const savedSettings = extensionSettings[EXTENSION_NAME] || {};
        const merged = { ...defaultCfg, ...savedSettings };
        extensionSettings[EXTENSION_NAME] = merged;
        return extensionSettings[EXTENSION_NAME];
    }
    
    let cfg = getCfg();

    /* ===== 1.1 儲存設定 (改用 ST API) ===== */
    function saveCfg() {
        extensionSettings[EXTENSION_NAME] = cfg;
        saveSettingsDebounced(); // ST 的防抖動儲存
    }

    /* ===== 2. 工具列 (整合進 ST) ===== */
    // 為了美觀，我們稍微調整一下按鈕的 Z-Index 和位置，避免擋到 ST 的 Topbar
    const bar = document.createElement("div");
    bar.id = "coco-snap-bar";

    const mkBtn = t => { 
        const b = document.createElement("button"); 
        b.textContent = t; 
        // 使用 ST 的通用按鈕樣式 class (menu_button) 讓它長得像原生介面
        b.className = "menu_button"; 
        b.style.cssText = "padding:4px 10px; font-size:14px;"; 
        return b; 
    };

    const shotBtn = mkBtn("📷 ");
    const setBtn = mkBtn("⚙️"); 
    bar.append(shotBtn, setBtn); 
    document.body.appendChild(bar);

    /* ===== 3. 公用小函式 (維持原樣) ===== */
    const row = (l, id, v, type = "text") =>
        `<div style="margin-bottom:12px"><label style="display:block;margin-bottom:4px">${l}</label><input type="${type}" id="${id}" value="${v ?? ""}" style="width:100%;height:30px;background:#444;color:#fff;border:none;border-radius:4px;padding:0 8px"></div>`;
    const chk = (l, id, c) =>
        `<div style="margin-bottom:12px"><label><input type="checkbox" id="${id}" ${c ? "checked" : ""}> ${l}</label></div>`;
    
    // Modal 改進：加入 backdrop-filter 讓背景模糊，更有質感
    /* ===== 終極修正版 modal 函式 ===== */
    /* ===== modal 函式：自動注入右上角關閉鈕 ===== */
    const modal = html => { 
        const o = document.createElement("div"); 
        o.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.7);
            z-index: 2147483647;
            display: flex;
            padding: 20px 10px; /* 這裡的 padding 確保視窗不會貼齊螢幕邊緣 */
            overflow-y: auto;
            backdrop-filter: blur(2px);
        `;
        o.innerHTML = html; 
        
        // 點擊背景關閉
        o.onclick = (e) => {
            if (e.target === o) o.remove();
        };

        // ★自動加入右上角 X 按鈕★
        const box = o.querySelector('.coco-dialog-box');
        if (box) {
            const xBtn = document.createElement('button');
            xBtn.className = 'coco-close-x';
            xBtn.innerHTML = '&times;';
            xBtn.onclick = () => {
                // 如果視窗內有定義特殊的關閉邏輯 (例如 revokeObjectURL)，這裡可以觸發它
                // 但通常直接 remove 視窗是最簡單的
                
                // 如果是預覽視窗，可能需要釋放 URL，這裡簡單處理：
                const img = box.querySelector('img');
                if (img && img.src.startsWith('blob:')) {
                    URL.revokeObjectURL(img.src);
                }
                o.remove(); 
            };
            box.prepend(xBtn); // 插入到視窗最開頭
        }
        
        document.documentElement.appendChild(o); 
        return o; 
    };

    /* ===== 4. 設定面板 (邏輯微調：儲存時呼叫 saveCfg) ===== */
    setBtn.onclick = () => {
        cfg = getCfg();
        const html = `
        <div class="coco-dialog-box" style="font-family:${cfg.fFamily}">
            <h3 style="margin:0 0 15px;font-size:18px;">截圖設定</h3>
            
            <div class="coco-dialog-content"> 
                ${row("使用者背景","userBg",cfg.userBg,"color")}
                ${row("角色背景","aiBg",cfg.aiBg,"color")}
                ${row("一般文字色","txt",cfg.txt,"color")}
                ${row("引號文字色","quoteColor",cfg.quoteColor,"color")}
                ${row("斜體文字色","italicColor",cfg.italicColor,"color")}
                ${row("字體大小(px)","fSize",cfg.fSize,"number")}
                ${row("字體名稱","fFamily",cfg.fFamily)}
                ${row("截圖寬度(px)","width",cfg.width,"number")}
                ${row("截圖背景色","bg",cfg.bg,"color")}
                ${row("頭像寬度(px)","avatarW",cfg.avatarW,"number")}
                ${chk("顯示頭像","showAvatar",cfg.showAvatar)}
            </div>

            <div class="coco-actions">
                <button class="coco-btn" id="ok">確定</button>
                <button class="coco-btn" id="x">取消</button>
                <button class="coco-btn danger" id="re">還原</button>
            </div>
        </div>`;
        
        const ov = modal(html);
        const v = id => { const el = ov.querySelector(`#${id}`); return el.type === "checkbox" ? el.checked : el.value; };
        
        ov.querySelector("#ok").onclick = () => {
            cfg.userBg = v("userBg"); cfg.aiBg = v("aiBg");
            cfg.quoteColor = cfg.bracketColor = v("quoteColor");
            cfg.italicColor = v("italicColor");
            cfg.fSize = +v("fSize"); cfg.fFamily = v("fFamily");
            cfg.width = +v("width"); cfg.bg = v("bg"); cfg.txt = v("txt");
            cfg.avatarW = +v("avatarW"); cfg.showAvatar = v("showAvatar");
            
            saveCfg(); // 使用 ST 的儲存方式
            ov.remove();
        };
        ov.querySelector("#x").onclick = () => ov.remove();
        ov.querySelector("#re").onclick = () => {
            if (!confirm("確定要還原成預設值？")) return;
            Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
            saveCfg();
            ov.remove();
        };
    };

    /* ===== 5. 截圖流程 (大部分維持原樣) ===== */
    shotBtn.onclick = () => {
        cfg = getCfg();
        const ask = modal(`
        <div class="coco-dialog-box" style="font-family:${cfg.fFamily}">
            <h3 style="margin-top:0;font-size:18px">截圖範圍</h3>
            
            <div class="coco-dialog-content">
                ${row("起始訊息ID (選填)","sid","","number")}
                ${row("結束訊息ID (選填)","eid","","number")}
                <div style="margin-bottom:12px;background:#333;padding:10px;border-radius:5px;">
                    <label><input type="radio" name="rangeMode" value="last" checked> 最後一則</label><br>
                    <label><input type="radio" name="rangeMode" value="last2"> 最後兩則</label><br>
                    <label><input type="radio" name="rangeMode" value="all"> 全部訊息</label>
                </div>
            </div>

            <div class="coco-actions">
                <button class="coco-btn" id="go">截圖</button>
                <button class="coco-btn" id="no">取消</button>
            </div>
        </div>`);
        ask.querySelector("#no").onclick = () => ask.remove();
        ask.querySelector("#go").onclick = () => {
            const sid = ask.querySelector("#sid").value ? +ask.querySelector("#sid").value : null;
            const eid = ask.querySelector("#eid").value ? +ask.querySelector("#eid").value : null;
            const mode = ask.querySelector("input[name=rangeMode]:checked").value;
            ask.remove(); 
            capture(sid, eid, mode);
        };
    };

    async function capture(start, end, mode = "last") {
        const wait = modal(`
            <div class="coco-wait-box" style="font-family:${cfg.fFamily}">
                <div style="font-size:20px;">截圖中，請稍候…</div>
                <div style="width: 30px; height: 30px; border: 3px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                <button class="coco-btn danger" id="cancelCap" style="margin-top: 10px;">取消</button>
            </div>
        `);
        
        let cancelFlag = false;
        wait.querySelector("#cancelCap").onclick = () => { cancelFlag = true; };
        
        try {
            // 取得當前聊天名稱，用作檔名
            const chatName = SillyTavern.getContext().chat[0]?.name || "chat"; 
            
            // 抓取訊息 DOM
            let msgs = [...document.querySelectorAll("#chat .mes")];
            
            if (start === null && end === null) {
                if (mode === "last")       msgs = msgs.slice(-1);
                else if (mode === "last2") msgs = msgs.slice(-2);
            } else {
                msgs = msgs.filter(m => {
                    const id = +m.getAttribute("mesid");
                    if (start !== null && end !== null) return id >= start && id <= end;
                    if (start !== null) return id >= start;
                    return id <= end;
                });
            }
            if (!msgs.length) { alert("找不到訊息！"); wait.remove(); return; }
        
            const meas = container(); document.body.appendChild(meas);
            const blocks = [];
            for (const m of msgs) {
                if (cancelFlag) { meas.remove(); wait.remove(); return; }
                const b = await buildBlock(m); meas.appendChild(b);
                blocks.push({ dom: b.cloneNode(true), h: b.offsetHeight + 20 });
            }
            document.body.removeChild(meas);
        
            // 分段邏輯 (略，與原版相同)
            const segs = []; let cur = [], h = 0;
            for (const o of blocks) {
                if (h + o.h > cfg.MAX && cur.length) { segs.push(cur); cur = []; h = 0; }
                cur.push(o.dom); h += o.h;
            }
            if (cur.length) segs.push(cur);
        
            let zip = null;
            if (segs.length > 1) {
                if (!confirm(`內容超過 ${cfg.MAX}px，將分成 ${segs.length} 張並壓縮下載，確定嗎？`)) { wait.remove(); return; }
                zip = new JSZip(); // 這裡使用全域的 JSZip (因為我們手動載入了)
            }
        
            for (let i = 0; i < segs.length; i++) {
                if (cancelFlag) { wait.remove(); return; }
                const c = container(); segs[i].forEach(n => c.appendChild(n));
                document.body.appendChild(c);
                
                // 稍微增加一點延遲，讓手機有時間渲染 DOM
                await new Promise(r => setTimeout(r, 100)); 
                
                if (cancelFlag) { document.body.removeChild(c); wait.remove(); return; }
                
                // ★★★ 關鍵修正開始 ★★★
                const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 800;
                
                // 如果是手機，強制 DPR 為 1 (這樣總縮放就是 SCALE 的 2倍，夠清晰了且不會爆記憶體)
                // 如果是電腦，維持使用原本的高畫質設定
                const safeDPR = isMobile ? 1 : (window.devicePixelRatio || 1);
                
                const cvs = await window.html2canvas(c, { 
                    scale: SCALE * safeDPR, 
                    backgroundColor: cfg.bg,
                    // 針對 iOS 的額外優化：停用 logging 節省效能
                    logging: false,
                });
                // ★★★ 關鍵修正結束 ★★★

                const blob = await new Promise(r => cvs.toBlob(r));
                
                if (zip) zip.file(`${chatName}-${i + 1}.png`, blob); 
                else save(blob, `${chatName}.png`);
                
                document.body.removeChild(c);
            }
            if (zip) save(await zip.generateAsync({ type: "blob" }), `${chatName}.zip`);

        } catch(e){ 
            console.error("截圖錯誤：",e); 
            alert("截圖失敗：" + e.message); 
        } finally { 
            wait.remove(); 
        }
    }

    /* ===== 終極版 save 函式：支援圖片預覽與 ZIP 下載 ===== */
    function save(blob, name) { 
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 800;

        // 簡單判斷是否為 ZIP 檔
        const isZip = name.endsWith('.zip');

        if (isMobile) {
            const url = URL.createObjectURL(blob);
            
            // 根據檔案類型決定視窗內容
            let contentHtml = '';
            
            if (isZip) {
                // === ZIP 檔的介面 ===
                contentHtml = `
                    <div style="text-align:center; padding: 20px 10px;">
                        <div style="font-size: 40px; margin-bottom: 10px;">📦</div>
                        <h3 style="margin:0 0 10px 0; font-size:16px; color:#fff;">圖片過長，已打包分割</h3>
                        <p style="color:#aaa; font-size:13px; margin-bottom: 20px;">請點擊下方按鈕下載至「檔案」。</p>
                        
                        <a href="${url}" download="${name}" class="coco-btn" style="text-decoration:none; display:inline-block; background:#28a745; border-color:#28a745; color:#fff; padding: 10px 20px;">
                            下載壓縮檔 (.zip)
                        </a>
                    </div>
                `;
            } else {
                // === 圖片檔的介面 (原本的邏輯) ===
                contentHtml = `
                    <div style="text-align:center; padding: 15px;">
                        <h3 style="margin:0 0 10px 0; font-size:16px; color:#aaa;">儲存圖片</h3>
                        <div style="overflow:auto; max-height: 60vh; border:1px solid #444; margin-bottom:10px; border-radius:4px;">
                            <img src="${url}" id="previewImg" style="max-width:100%; display:block; margin:0 auto; -webkit-touch-callout: default; user-select: auto;">
                        </div>
                        <div style="margin-top:10px;">
                            <button class="coco-btn" id="shareBtn" style="display:none; background:#28a745; border-color:#28a745;">分享/儲存</button>
                        </div>
                    </div>
                `;
            }

            // 包裝外框
            const html = `
            <div class="coco-dialog-box">
                ${contentHtml}
                <div class="coco-actions" style="justify-content: center !important; margin-top: 15px;">
                    <button class="coco-btn" id="closePrev">關閉</button>
                </div>
            </div>`;
            
            const p = modal(html);
            
            // 如果是圖片，才需要綁定長按/分享事件
            if (!isZip) {
                const imgDom = p.querySelector('#previewImg');
                const shareBtn = p.querySelector('#shareBtn');

                imgDom.addEventListener('contextmenu', (e) => { e.stopPropagation(); }, true);

                if (navigator.share && navigator.canShare) {
                    const file = new File([blob], name, { type: blob.type });
                    if (navigator.canShare({ files: [file] })) {
                        shareBtn.style.display = 'inline-block';
                        shareBtn.onclick = async () => {
                            try {
                                await navigator.share({
                                    files: [file],
                                    title: '聊天截圖'
                                });
                            } catch (err) { console.log('分享取消', err); }
                        };
                    }
                }
            }

            p.querySelector('#closePrev').onclick = () => {
                p.remove();
                URL.revokeObjectURL(url);
            };

        } else {
            // 電腦版直接下載
            const a = document.createElement("a"); 
            a.href = URL.createObjectURL(blob); 
            a.download = name; 
            a.click(); 
        }
    }

    /* ===== 6. 容器 / style (手機版終極修正 V2) ===== */
    const styleEl = document.createElement('style');
    styleEl.innerHTML = `
        /* 截圖生成用的隱藏容器 */
        .__snap * { font-family: var(--ff)!important; font-size: var(--fs)!important; line-height: var(--lh)!important; }
        .__snap em, .__snap i { color: var(--it)!important; }
        .__snap strong, .__snap b { font-weight: bold!important; color: inherit; }

        /* === 工具列按鈕 (右下角垂直排列) === */
        #coco-snap-bar {
            position: fixed;
            z-index: 2000;
            display: flex;
            gap: 10px;
            opacity: 0.5;
            transition: 0.2s;
            /* 預設(電腦)位置 */
            top: 20px;
            right: 20px;
        }
        #coco-snap-bar:hover { opacity: 1; }

        /* === 手機版工具列：強制固定在右上角 === */
        @media (max-width: 800px) {
            #coco-snap-bar {
                /* 手機版往下移，避免擋到 ST 的漢堡選單或頂部按鈕 */
                top: 80px !important; 
                right: 10px !important;
                opacity: 0.8 !important; /* 手機不容易 hover，保持可見 */
            }
        }

        /* === 彈出視窗核心樣式 === */
        .coco-dialog-box {
            background: #2b2b2b;
            padding: 20px;
            /* ★關鍵修正：加入底部安全區域，防止被 iPhone 黑條或瀏覽器工具列擋住 */
            padding-bottom: calc(20px + env(safe-area-inset-bottom)); 
            border-radius: 12px;
            color: #ddd;
            border: 1px solid #555;
            box-shadow: 0 10px 40px rgba(0,0,0,0.8);
            margin: auto; 
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
            position: relative; /* 為了讓右上角的 X 能夠定位 */
            
            width: 450px;
            max-width: 90vw; 
            max-height: 80vh; /* 稍微縮小高度，留空間給鍵盤或工具列 */
        }

        .coco-dialog-content {
            flex: 1;
            overflow-y: auto;
            max-height: 60vh;
            padding-right: 5px;
        }

        /* === 右上角 X 關閉鈕樣式 === */
        .coco-close-x {
            position: absolute;
            top: 10px;
            right: 15px;
            background: transparent;
            border: none;
            color: #888;
            font-size: 28px;
            line-height: 1;
            cursor: pointer;
            padding: 5px;
            z-index: 10;
        }
        .coco-close-x:hover { color: #fff; }

        /* 按鈕與操作區 */
        .coco-btn {
            padding: 8px 16px !important;
            font-size: 14px !important;
            background: #444 !important;
            color: #fff !important;
            border: 1px solid #666 !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            min-width: 70px !important;
            height: auto !important;
            display: inline-block !important;
            margin-left: 10px !important;
            transition: background 0.2s;
        }
        .coco-btn:hover { background: #666 !important; }
        .coco-btn.danger { background: #822 !important; border-color: #a44 !important; }
        
        .coco-actions {
            display: flex !important;
            justify-content: flex-end !important;
            align-items: center !important;
            margin-top: 20px !important;
            border-top: 1px solid #444;
            padding-top: 15px;
            flex-shrink: 0;
        }
        .coco-wait-box {
            background: rgba(0, 0, 0, 0.85); /* 深色半透明背景 */
            color: #fff;
            padding: 40px 60px;
            border-radius: 12px;
            text-align: center;
            
            /* ★關鍵修正：讓它在新的 Modal 系統中自動置中★ */
            margin: auto; 
            
            /* 尺寸限制 */
            width: auto;
            min-width: 200px;
            max-width: 90vw;
            
            /* 內部排版 */
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
    `;
    document.head.appendChild(styleEl);

    function container() {
        const wDom = cfg.width / SCALE, fsDom = (cfg.fSize / SCALE) + "px", lhDom = (cfg.fSize * cfg.lineR / SCALE) + "px";
        const d = document.createElement("div");
        d.className = "__snap";
        d.style.cssText = `position:fixed;top:-9999px;left:0;width:${wDom}px;background:${cfg.bg};padding:20px;display:flex;flex-direction:column;gap:20px;color:${cfg.txt}`;
        d.style.setProperty("--ff", cfg.fFamily); 
        d.style.setProperty("--fs", fsDom); 
        d.style.setProperty("--lh", lhDom); 
        d.style.setProperty("--it", cfg.italicColor);
        return d;
    }

    /* ===== 7. 單則訊息處理 ===== */
    async function buildBlock(m) {
        const user = m.getAttribute("is_user") === "true";
        // 嘗試從 DOM 抓取頭像，如果失敗則從 Context 抓取
        let av = m.querySelector(".avatar img")?.src || "";
        
        let html = m.querySelector(".mes_text")?.innerHTML || "";
        
        // 預處理：將 span 展開，避免樣式干擾
        const tmp = document.createElement("div"); tmp.innerHTML = html; 
        tmp.querySelectorAll("span").forEach(s => s.replaceWith(...s.childNodes)); 
        html = tmp.innerHTML;

        // HTML -> Markdown -> HTML (清洗格式)
        const clean = marked.parse(td.turndown(html));
        
        const h = document.createElement("div"); 
        h.innerHTML = clean; 
        colorQuotes(h); 
        h.querySelectorAll("em,i").forEach(e => e.style.color = cfg.italicColor);

        const wrap = document.createElement("div");
        wrap.style.cssText = `background:${user ? cfg.userBg : cfg.aiBg};padding:12px;border-radius:10px;display:flex;align-items:flex-start;gap:12px`;

        if (cfg.showAvatar && av) {
            const side = cfg.avatarW / SCALE;
            const holder = document.createElement("div");
            holder.style.cssText = `width:${side}px;height:${side}px;border-radius:8px;overflow:hidden;flex:0 0 ${side}px;background:#666;`;
            const img = document.createElement("img");
            img.src = av;
            img.style.cssText = `
                width: 100%;
                height: auto;
                display: block;
                image-rendering: -webkit-optimize-contrast; /* Chrome/Edge 常用 */
                image-rendering: high-quality;              /* 現代標準 */
            `;
            holder.appendChild(img);
            wrap.appendChild(holder);
        }

        const txt = document.createElement("div"); 
        txt.innerHTML = h.innerHTML; 
        // 修正 marked 解析出來的 p 標籤 margin
        txt.querySelectorAll('p').forEach(p => p.style.margin = '0 0 8px 0');
        
        wrap.appendChild(txt);
        return wrap;
    }

    /* ===== 8. quote 上色 ===== */
    function colorQuotes(root) {
        const reg = /「[^」]*」|“[^”]*”|"[^"]*"/g;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        const list = []; let n; while (n = walker.nextNode()) list.push(n);
        list.forEach(t => {
            const s = t.nodeValue; let idx = 0, m; const frag = document.createDocumentFragment();
            while (m = reg.exec(s)) {
                if (m.index > idx) frag.appendChild(document.createTextNode(s.slice(idx, m.index)));
                const sp = document.createElement("span"); 
                sp.textContent = m[0]; 
                sp.style.color = m[0].startsWith("「") ? cfg.bracketColor : cfg.quoteColor; 
                frag.appendChild(sp);
                idx = m.index + m[0].length;
            }
            if (idx < s.length) frag.appendChild(document.createTextNode(s.slice(idx)));
            if (frag.childNodes.length) t.parentNode.replaceChild(frag, t);
        });
    }

})();