// ==UserScript==
// @name         阿p全自动发布工具
// @namespace    http://tampermonkey.net/
// @version      2.9.58
// @description  小白番茄小说作者后台自动批量上传章节，支持解析章节、自动填写、自动发布（v2.9.1 停顿时间可调）
// @author       阿日
// @match        *://fanqienovel.com/main/writer/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';
    const SCRIPT_VER = '2.9.58';

    /*******************************
     * 核心配置
     *******************************/
    const CONFIG = {
        DELAY: {
            CLICK: 800,
            INPUT: 300,
            PAGE_LOAD: 1500,
            CHAPTER: 1200,
            RETRY: 1000,
            TYPING: 100
        },
        VALIDATION: {
            MIN_WORDS: 1000,
            MAX_WORDS: 20000
        },
        STORAGE: {
            UPLOAD_STATE: 'novel_upload_state',
            SETTINGS: 'novel_upload_settings'
        }
    };

    /*******************************
     * 全局状态
     *******************************/
    let parsedChapters = [];
    let isUploading = false;
    let currentIndex = 0;
    let uploadState = null;
    let currentBookName = '';
    let privacyMode = false;
    let panel = null;

    // 多账号任务上下文：由 shell 通过 __xbuRunTask 注入，日志上报时带上
    let activeTaskId = '';
    let activeTaskBook = '';

    /*******************************
     * 工具函数
     *******************************/
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    function log(message, type = 'info') {
        const prefix = '[小说上传助手]';
        const colors = {
            info: '#1890ff',
            success: '#52c41a',
            warning: '#faad14',
            error: '#ff4d4f'
        };
        
        console.log(`%c${prefix} ${message}`, `color: ${colors[type] || colors.info}; font-weight: bold;`);
        
        // 更新UI日志
        const logEl = document.getElementById('upload-log');
        if (logEl) {
            const time = new Date().toLocaleTimeString();
            const entry = document.createElement('div');
            entry.style.cssText = `
                padding: 4px 0;
                border-bottom: 1px solid #f0f0f0;
                font-size: 12px;
                color: ${colors[type] || colors.info};
            `;
            entry.textContent = `[${time}] ${message}`;
            logEl.insertBefore(entry, logEl.firstChild);
            
            // 限制日志数量
            if (logEl.children.length > 20) {
                logEl.removeChild(logEl.lastChild);
            }
        }

        // 多账号任务：把日志上报到主进程汇总（对所有日志生效，不只在任务中）
        try {
            if (typeof window.__xbuLog === 'function') {
                window.__xbuLog(type, message, activeTaskId, activeTaskBook || currentBookName);
            }
        } catch (e) { /* ignore */ }
    }

    async function waitForElement(selector, timeout = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null) {
                return el;
            }
            await delay(200);
        }
        return null;
    }

    function findButtonByText(text) {
        const buttons = document.querySelectorAll('button');
        // 优先返回可见按钮：页面上可能同时存在隐藏的引导层/弹窗里的同名按钮，
        // 旧代码返回第一个匹配（常常是隐藏的），点了没反应。
        let fallback = null;
        for (const btn of buttons) {
            if (btn.textContent.trim().includes(text)) {
                if (btn.offsetParent !== null) return btn;
                if (!fallback) fallback = btn;
            }
        }
        return fallback;
    }

    function getCurrentBookId() {
        const url = window.location.href;
        const match = url.match(/\/(\d{15,})/);
        return match ? match[1] : null;
    }

    function countWords(text) {
        if (!text) return 0;
        // 番茄后台的字数按"去掉空白后的字符数"算（含标点），
        // 之前只数中英文数字，会明显比番茄显示得少，容易让人误会。
        return String(text).replace(/\s+/g, '').length;
    }

    /*******************************
     * 样式注入
     *******************************/
    GM_addStyle(`
        #novel-upload-panel {
            position: fixed;
            top: 80px;
            right: 20px;
            width: 380px;
            max-height: 80vh;
            background: white;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
            z-index: 9999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            overflow: hidden;
            border: 1px solid #e8e8e8;
        }
        
        .panel-header {
            padding: 16px;
            background: linear-gradient(135deg, #1890ff, #40a9ff);
            color: white;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
            user-select: none;
        }
        
        .panel-title {
            font-weight: 600;
            font-size: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .panel-controls {
            display: flex;
            gap: 8px;
        }
        
        .panel-btn {
            width: 24px;
            height: 24px;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.2);
            border: none;
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }
        
        .panel-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        
        .panel-body {
            padding: 16px;
            max-height: calc(80vh - 60px);
            overflow-y: auto;
        }
        
        .section {
            margin-bottom: 20px;
        }
        
        .section-title {
            font-size: 14px;
            font-weight: 600;
            color: #262626;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .book-info {
            background: #f6ffed;
            border: 1px solid #b7eb8f;
            border-radius: 6px;
            padding: 12px;
            font-size: 13px;
            color: #52c41a;
            margin-bottom: 16px;
        }

        .bc-label { font-size: 11px; color: #8c8c8c; margin-bottom: 4px; }
        .bc-name { font-size: 14px; font-weight: 600; color: #1f2937; line-height: 1.5; word-break: break-all; }
        .bc-id { margin-top: 3px; font-size: 11px; color: #8c8c8c; font-family: Consolas, monospace; }
        .bc-tip { margin-top: 6px; font-size: 11px; line-height: 1.5; }
        .bc-tip.ok { color: #52c41a; }
        .bc-tip.warn { color: #fa8c16; }
        
        .file-upload-area {
            border: 2px dashed #1890ff;
            border-radius: 6px;
            padding: 24px;
            text-align: center;
            cursor: pointer;
            background: #f0f9ff;
            transition: all 0.3s;
        }
        
        .file-upload-area:hover {
            background: #e6f7ff;
            border-color: #40a9ff;
        }
        
        .file-name {
            margin-top: 8px;
            font-size: 12px;
            color: #595959;
            word-break: break-all;
        }
        
        .chapters-list {
            max-height: 300px;
            overflow-y: auto;
            border: 1px solid #e8e8e8;
            border-radius: 6px;
            margin-top: 12px;
        }
        
        .chapter-item {
            padding: 12px;
            border-bottom: 1px solid #f0f0f0;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .chapter-item:last-child {
            border-bottom: none;
        }
        
        .chapter-item:hover {
            background: #fafafa;
        }
        
        .chapter-info {
            flex: 1;
        }
        
        .chapter-title {
            font-weight: 500;
            font-size: 13px;
            color: #262626;
            margin-bottom: 4px;
        }
        
        .chapter-meta {
            font-size: 11px;
            color: #8c8c8c;
        }
        
        .chapter-status {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 10px;
            font-weight: 500;
        }
        
        .status-pending {
            background: #f5f5f5;
            color: #8c8c8c;
        }
        
        .status-uploading {
            background: #e6f7ff;
            color: #1890ff;
        }
        
        .status-success {
            background: #f6ffed;
            color: #52c41a;
        }
        
        .status-error {
            background: #fff2f0;
            color: #ff4d4f;
        }
        
        .progress-bar {
            height: 6px;
            background: #f5f5f5;
            border-radius: 3px;
            overflow: hidden;
            margin-top: 8px;
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #1890ff, #40a9ff);
            transition: width 0.3s ease;
        }
        
        .buttons-row {
            display: flex;
            gap: 12px;
            margin-top: 16px;
        }
        
        .btn {
            flex: 1;
            padding: 10px 16px;
            border-radius: 6px;
            border: none;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            text-align: center;
        }
        
        .btn-primary {
            background: #1890ff;
            color: white;
        }
        
        .btn-primary:hover {
            background: #40a9ff;
            transform: translateY(-1px);
        }
        
        .btn-secondary {
            background: #f5f5f5;
            color: #262626;
        }
        
        .btn-secondary:hover {
            background: #e8e8e8;
        }
        
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .btn:disabled:hover {
            transform: none;
        }
        
        .settings-group {
            background: #fafafa;
            border-radius: 6px;
            padding: 12px;
            margin-top: 16px;
        }
        
        .setting-item {
            margin-bottom: 12px;
        }
        
        .setting-item:last-child {
            margin-bottom: 0;
        }
        
        .setting-label {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: #262626;
            margin-bottom: 4px;
            cursor: pointer;
        }
        
        .upload-log {
            max-height: 150px;
            overflow-y: auto;
            border: 1px solid #e8e8e8;
            border-radius: 6px;
            padding: 8px;
            font-size: 11px;
            background: #fafafa;
            margin-top: 12px;
        }
        
        .hidden {
            display: none !important;
        }

        /* 粘贴区 */
        .paste-area {
            width: 100%;
            min-height: 84px;
            max-height: 200px;
            resize: vertical;
            padding: 10px;
            border: 1px dashed #d9d9d9;
            border-radius: 6px;
            font-size: 12px;
            line-height: 1.6;
            color: #262626;
            font-family: inherit;
            background: #fcfcfd;
            transition: border-color .2s, background .2s;
        }

        .paste-area:focus {
            outline: none;
            border-color: #1890ff;
            background: #fff;
            box-shadow: 0 0 0 2px rgba(24, 144, 255, .1);
        }

        .or-divider {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 12px 0 8px;
            font-size: 11px;
            color: #b0b7c3;
        }

        .or-divider::before,
        .or-divider::after {
            content: '';
            flex: 1;
            height: 1px;
            background: #eef1f5;
        }

        /* 拖放遮罩 */
        #drop-overlay {
            position: fixed;
            inset: 0;
            z-index: 100000;
            display: none;
            align-items: center;
            justify-content: center;
            background: rgba(24, 144, 255, .10);
            backdrop-filter: blur(1px);
            pointer-events: none;
        }

        #drop-overlay.show {
            display: flex;
        }

        #drop-overlay .box {
            padding: 32px 48px;
            border: 3px dashed #1890ff;
            border-radius: 14px;
            background: rgba(255, 255, 255, .95);
            color: #1890ff;
            font-size: 18px;
            font-weight: 600;
            box-shadow: 0 12px 40px rgba(24, 144, 255, .25);
        }

        #drop-overlay .box small {
            display: block;
            margin-top: 8px;
            font-size: 12px;
            font-weight: 400;
            color: #8c8c8c;
        }
        
        .drag-over {
            background: #e6f7ff !important;
            border-color: #1890ff !important;
        }
        
        .timed-options {
            background: #f0f9ff;
            border-radius: 6px;
            padding: 12px;
            margin-top: 8px;
            border: 1px solid #e6f7ff;
        }
        
        .input-row {
            margin-bottom: 10px;
        }
        
        .input-row:last-child {
            margin-bottom: 0;
        }
        
        .input-label {
            display: block;
            font-size: 12px;
            color: #595959;
            margin-bottom: 4px;
        }
        
        .input-field {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid #d9d9d9;
            border-radius: 4px;
            font-size: 12px;
        }
        
        .input-field:focus {
            outline: none;
            border-color: #1890ff;
            box-shadow: 0 0 0 2px rgba(24, 144, 255, 0.1);
        }
        
        /* 滚动条样式 */
        .panel-body::-webkit-scrollbar,
        .chapters-list::-webkit-scrollbar,
        .upload-log::-webkit-scrollbar {
            width: 4px;
        }
        
        .panel-body::-webkit-scrollbar-thumb,
        .chapters-list::-webkit-scrollbar-thumb,
        .upload-log::-webkit-scrollbar-thumb {
            background: #bfbfbf;
            border-radius: 2px;
        }
        
        .panel-body::-webkit-scrollbar-track,
        .chapters-list::-webkit-scrollbar-track,
        .upload-log::-webkit-scrollbar-track {
            background: #f5f5f5;
        }
    `);

    /*******************************
     * 创建控制面板
     *******************************/
    function createPanel() {
        if (document.getElementById('novel-upload-panel')) {
            return;
        }

        panel = document.createElement('div');
        panel.id = 'novel-upload-panel';
        
        panel.innerHTML = `
            <div class="panel-header">
                <div class="panel-title">
                    <span>🐋 阿p全自动发布工具</span>
                    <span style="font-size: 12px; opacity: 0.9;">v${SCRIPT_VER}</span>
                </div>
                <div class="panel-controls">
                    <button class="panel-btn" id="toggle-panel">−</button>
                    <button class="panel-btn" id="close-panel">×</button>
                </div>
            </div>
            <div class="panel-body">
                <div id="panel-tabs" style="display:flex;gap:6px;margin-bottom:14px;">
                    <button class="ptab active" data-mode="long" style="flex:1;height:32px;border:none;border-radius:8px;background:#1890ff;color:#fff;font-size:13px;cursor:pointer;">📖 长篇</button>
                    <button class="ptab" data-mode="short" style="flex:1;height:32px;border:none;border-radius:8px;background:#f0f2f5;color:#595959;font-size:13px;cursor:pointer;">📝 短篇</button>
                </div>

                <div id="long-panel">
                <!-- 书籍信息 -->
                <div class="section">
                    <div class="section-title">
                        <span>📕</span>
                        <span>当前书籍</span>
                    </div>
                    <div id="book-info" class="book-info">
                        正在检测书籍信息...
                    </div>
                    <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
                        <button class="btn btn-secondary" id="scan-schedule" style="flex:0 0 auto;padding:7px 12px;font-size:12px;">🔄 扫描本书定时</button>
                    <button class="btn btn-secondary" id="scan-income" title="在收益页点一下，把当前收益记进看板" style="flex:0 0 auto;padding:7px 12px;font-size:12px;">💰 记录收益</button>
                        <span id="scan-result" style="font-size:11px;color:#8c8c8c;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
                    </div>
                </div>

                <!-- 文件上传 -->
                <div class="section">
                    <div class="section-title">
                        <span>🗂</span>
                        <span>上传章节文件</span>
                    </div>
                    <div class="file-upload-area" id="file-upload-area">
                        <div style="font-size: 32px; margin-bottom: 8px;">📄</div>
                        <div style="font-weight: 500; margin-bottom: 4px;">点击选择 TXT 文件</div>
                        <div style="font-size: 12px; color: #8c8c8c;">
                            也可以把 TXT 直接拖到窗口任意位置
                        </div>
                        <input type="file" id="file-input" accept=".txt" style="display: none;">
                        <div id="file-name" class="file-name"></div>
                    </div>
                    <div class="or-divider">或者直接粘贴</div>
                    <textarea id="paste-input" class="paste-area" placeholder="把章节正文粘贴到这里（Ctrl+V），粘贴后会自动识别章节"></textarea>
                    <div style="display:flex;gap:8px;margin-top:8px;">
                        <button class="btn btn-secondary" id="paste-parse" style="flex:1;padding:8px;font-size:13px;">识别并解析</button>
                        <button class="btn btn-secondary" id="paste-clear" style="padding:8px 12px;font-size:13px;">清空</button>
                    </div>
                    <textarea id="content-input" style="display: none;"></textarea>
                </div>

                <!-- 章节预览 -->
                <div class="section hidden" id="preview-section">
                    <div class="section-title">
                        <span>🗒</span>
                        <span>章节预览 (<span id="chapter-count">0</span>)</span>
                    </div>
                    
                    <!-- 快捷操作 -->
                    <div style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
                        <button class="btn btn-secondary" id="select-all" style="padding: 6px 12px; font-size: 12px;">全选</button>
                        <button class="btn btn-secondary" id="select-none" style="padding: 6px 12px; font-size: 12px;">清空</button>
                        <button class="btn btn-secondary" id="select-valid" style="padding: 6px 12px; font-size: 12px;">有效章节</button>
                    </div>
                    <div style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
                        <button class="btn btn-secondary" id="select-last5" style="padding: 6px 12px; font-size: 12px;">后五章</button>
                        <button class="btn btn-secondary" id="select-last10" style="padding: 6px 12px; font-size: 12px;">后十章</button>
                    </div>

                    <div class="chapters-list" id="chapters-list"></div>

                    <!-- 设置 -->
                    <div class="settings-group">
                        <div class="setting-item">
                            <label class="setting-label">
                                <input type="radio" name="mode" value="auto" checked>
                                全自动模式
                            </label>
                        </div>
                        <div class="setting-item">
                            <label class="setting-label">
                                <input type="radio" name="mode" value="semi">
                                半自动模式（每章发布前等你点「继续」确认）
                            </label>
                        </div>
                        <div class="setting-item">
                            <label class="setting-label">
                                <input type="checkbox" id="check-sequence" checked>
                                检查章节连续性
                            </label>
                        </div>
                        <div class="setting-item">
                            <label class="setting-label">
                                <input type="checkbox" id="ignore-violation">
                                无视违规提示（自动继续提交）
                            </label>
                        </div>
                        <div class="setting-item" style="font-size:11px;color:#8c8c8c;line-height:1.5;margin-top:-6px;">
                            不勾选时：一旦番茄弹出违规/色情拦截，会自动暂停，等你改完点「继续发布」。
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" style="margin-bottom:6px;">定时发布停顿（秒）</label>
                            <input type="number" id="settle-seconds" class="input-field" value="2.5" min="0.5" max="15" step="0.5">
                            <div style="font-size:11px;color:#8c8c8c;margin-top:4px;line-height:1.5;">
                                设置日期后等多久再点发布。越大越稳、越慢；默认 2.5 秒。
                            </div>
                        </div>
                        <div class="setting-item">
                            <label class="setting-label">
                                <input type="checkbox" id="timed-publish">
                                启用定时发布
                            </label>
                        </div>
                        <div class="timed-options hidden" id="timed-options">
                            <div class="setting-item" style="margin-bottom:8px;">
                                <label class="setting-label">
                                    <input type="checkbox" id="continue-after-last">
                                    ⏭ 接着上次定时排（自动从后一天开始）
                                </label>
                            </div>
                            <div class="setting-item" style="font-size:11px;color:#8c8c8c;line-height:1.5;margin-top:-6px;margin-bottom:8px;">
                                勾上后，开始日期会自动变成「上次定时的下一天」，时间/每日章数/间隔照你下面的设置。
                            </div>
                            <div class="input-row">
                                <label class="input-label">开始日期</label>
                                <input type="date" id="start-date" class="input-field">
                            </div>
                            <div class="input-row">
                                <label class="input-label">开始时间</label>
                                <input type="time" id="start-time" value="12:00" class="input-field">
                            </div>
                            <div class="input-row">
                                <label class="input-label">每日章节数</label>
                                <input type="number" id="daily-count" value="3" min="1" max="10" class="input-field">
                            </div>
                            <div class="input-row">
                                <label class="input-label">发布间隔(分钟)</label>
                                <input type="number" id="interval-minutes" value="0" min="0" max="1440" class="input-field" placeholder="0表示同时发布">
                            </div>
                            <div class="input-row">
                                <label class="input-label">跳过周末</label>
                                <select id="skip-weekend" class="input-field">
                                    <option value="no">不跳过</option>
                                    <option value="yes">跳过周六周日</option>
                                </select>
                            </div>
                            <div id="schedule-preview" style="font-size: 11px; color: #52c41a; margin-top: 8px; padding: 6px; background: #f6ffed; border-radius: 4px;"></div>
                        </div>
                    </div>

                    <!-- 操作按钮 -->
                    <div class="buttons-row">
                        <button class="btn btn-secondary" id="back-btn">重新选择</button>
                        <button class="btn btn-primary" id="start-upload">
                            开始上传 (<span id="selected-count">0</span>)
                        </button>
                    </div>
                </div>

                <!-- 上传进度 -->
                <div class="section hidden" id="progress-section">
                    <div class="section-title">
                        <span>🚀</span>
                        <span>上传进度</span>
                    </div>
                    <div>
                        <div id="progress-text" style="font-size: 13px; margin-bottom: 8px;">准备中...</div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 11px; color: #8c8c8c; margin-top: 4px;">
                            <span id="current-progress">0/0</span>
                            <span id="percentage">0%</span>
                        </div>
                    </div>
                    <div class="buttons-row">
                        <button class="btn btn-secondary" id="pause-upload">暂停</button>
                        <button class="btn btn-secondary" id="stop-upload">停止上传</button>
                    </div>
                </div>

                <!-- 日志 -->
                <div class="section">
                    <div class="section-title">
                        <span>📝</span>
                        <span>操作日志</span>
                    </div>
                    <div class="upload-log" id="upload-log"></div>
                </div>
                </div><!-- /long-panel -->

                <div id="short-panel" style="display:none;">
                    <div class="section">
                        <div class="section-title">
                            <span>🗂</span>
                            <span>上传短篇文件</span>
                        </div>
                        <div class="file-upload-area" id="short-drop">
                            <div style="font-size: 32px; margin-bottom: 8px;">📄</div>
                            <div style="font-weight: 500; margin-bottom: 4px;">点击选择 TXT 文件</div>
                            <div style="font-size: 12px; color: #8c8c8c;">
                                也可以把 TXT 直接拖到这里
                            </div>
                            <input type="file" id="short-file" accept=".txt" style="display: none;">
                            <div id="short-file-name" class="file-name"></div>
                        </div>
                        <div class="or-divider">或者直接粘贴</div>
                        <textarea id="short-batch" class="paste-area" placeholder="把短篇正文粘贴到这里（Ctrl+V），每篇用一行 === 隔开，第一行是标题"></textarea>
                        <div style="display:flex;gap:8px;margin-top:8px;">
                            <button class="btn btn-secondary" id="short-parse" style="flex:1;padding:8px;font-size:13px;">识别并解析</button>
                            <button class="btn btn-secondary" id="short-clear" style="padding:8px 12px;font-size:13px;">清空</button>
                        </div>
                    </div>

                    <div class="section" id="short-preview-section">
                        <div class="section-title">
                            <span>🗒</span>
                            <span>短篇预览 (<span id="short-count">0</span>)</span>
                        </div>
                        <div style="display:flex;gap:8px;margin-bottom:10px;">
                            <button class="btn btn-secondary" id="short-all" style="padding:6px 12px;font-size:12px;">全选</button>
                            <button class="btn btn-secondary" id="short-none" style="padding:6px 12px;font-size:12px;">全不选</button>
                        </div>
                        <div class="chapters-list" id="short-list">
                            <div style="font-size:11px;color:#bbb;text-align:center;padding:12px;">载入或粘贴内容后，这里会列出识别到的每一篇</div>
                        </div>

                        <div class="settings-group">
                            <div class="setting-item">
                                <label class="setting-label" style="margin-bottom:6px;">试读比例</label>
                                <select id="short-trial" class="input-field">
                                    <option value="0">不设置（默认）</option>
                                    <option value="10">10%</option>
                                    <option value="20">20%</option>
                                    <option value="30">30%</option>
                                    <option value="50">50%</option>
                                </select>
                            </div>
                            <div class="setting-item" style="font-size:11px;color:#8c8c8c;line-height:1.5;margin-top:-6px;">
                                封面和作品分类番茄可能需要你手动选一次，其余全部自动填、自动发布。
                            </div>
                        </div>

                        <div class="buttons-row">
                            <button class="btn btn-secondary" id="short-stop">停止</button>
                            <button class="btn btn-primary" id="short-start">
                                开始发布 (<span id="short-total">0</span>)
                            </button>
                        </div>

                        <div id="short-log" style="font-size:11px;color:#595959;line-height:1.8;margin-top:10px;white-space:pre-wrap;max-height:150px;overflow:auto;"></div>
                    </div>
                </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);
        initDrag(panel);
        bindEvents();
        updateBookInfo();
        
        // 恢复上次的停顿设置
        try {
            const saved = parseFloat(GM_getValue('settle_seconds', '2.5'));
            const el = document.getElementById('settle-seconds');
            if (el && isFinite(saved) && saved > 0) el.value = saved;
        } catch (e) { /* ignore */ }

        log('上传助手已加载', 'success');
    }

    /*******************************
     * 面板显示 / 隐藏 / 唤回
     *******************************/
    function ensurePanel() {
        const exist = document.getElementById('novel-upload-panel');
        if (exist) {
            panel = exist;
            return panel;
        }
        panel = null;
        createPanel();
        return panel;
    }

    function showPanel() {
        const p = ensurePanel();
        if (!p) return false;
        p.style.display = 'flex';
        p.style.display = 'block';
        const bubble = document.getElementById('panel-restore');
        if (bubble) bubble.remove();
        log('面板已重新打开', 'success');
        return true;
    }

    const BUBBLE_POS_KEY = 'panel_bubble_pos';

    function hidePanel() {
        if (panel) panel.style.display = 'none';
        showRestoreBubble();
    }

    function showRestoreBubble() {
        if (document.getElementById('panel-restore')) return;
        const b = document.createElement('div');
        b.id = 'panel-restore';
        b.title = '重新打开上传助手面板';
        b.textContent = '☁';
        b.style.cssText = [
            'position:fixed', 'top:80px', 'right:20px',
            'width:42px', 'height:42px', 'border-radius:50%',
            'background:linear-gradient(135deg,#1890ff,#40a9ff)',
            'color:#fff', 'display:flex', 'align-items:center', 'justify-content:center',
            'font-size:22px', 'cursor:pointer', 'z-index:9999',
            'box-shadow:0 6px 16px rgba(24,144,255,.45)',
            'user-select:none', 'transition:transform .15s'
        ].join(';');
        b.innerHTML = '<span style="pointer-events:none;font-size:22px;line-height:1;">🐋</span>';

        // 位置可拖动并且记住
        try {
            const saved = JSON.parse(GM_getValue(BUBBLE_POS_KEY, 'null'));
            if (saved && typeof saved.x === 'number') {
                b.style.left = saved.x + 'px';
                b.style.top = saved.y + 'px';
                b.style.right = 'auto';
            }
        } catch (e) { /* ignore */ }

        let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

        const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - sx;
            const dy = e.clientY - sy;
            if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
            const x = Math.max(4, Math.min(window.innerWidth - 50, ox + dx));
            const y = Math.max(4, Math.min(window.innerHeight - 50, oy + dy));
            b.style.left = x + 'px';
            b.style.top = y + 'px';
            b.style.right = 'auto';
        };

        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            b.style.transition = 'transform .15s';
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            if (moved) {
                try {
                    GM_setValue(BUBBLE_POS_KEY, JSON.stringify({
                        x: parseInt(b.style.left, 10) || 0,
                        y: parseInt(b.style.top, 10) || 0
                    }));
                } catch (e) { /* ignore */ }
            }
        };

        b.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const r = b.getBoundingClientRect();
            dragging = true;
            moved = false;
            sx = e.clientX;
            sy = e.clientY;
            ox = r.left;
            oy = r.top;
            b.style.transition = 'none';
            e.preventDefault();
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        });

        b.onmouseenter = () => { if (!dragging) b.style.transform = 'scale(1.08)'; };
        b.onmouseleave = () => { if (!dragging) b.style.transform = 'scale(1)'; };
        b.title = '单击打开面板，拖动可移动位置';

        b.addEventListener('click', () => {
            if (moved) { moved = false; return; }   // 拖动结束的那一下不算点击
            b.remove();
            showPanel();
        });

        document.body.appendChild(b);
    }

    // 给桌面版外壳（左上角鲸鱼）调用
    /* ---------- 页面级隐私遮罩（用替换而非模糊，避免被 AI 还原） ---------- */
    const PRIVACY_GRAY = 'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#c9ced6"/><text x="60" y="86" font-size="12" fill="#8b93a1" text-anchor="middle">已隐藏</text></svg>');

    const privTexts = new Map();   // el -> 原文
    const privImages = new Map();  // img -> 原 src

    function isPrivacySafe(el) {
        return !!(el.closest && el.closest('#novel-upload-panel'));
    }

    // 文本节点级遮罩：不管嵌套多深，只要出现笔名/书名就换掉
    function walkTextNodes(root) {
        const out = [];
        const w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = w.nextNode())) out.push(n);
        return out;
    }

    let privName = '';

    function detectPenName() {
        if (privName) return privName;
        const re = /^(晚上好|早上好|上午好|下午好|你好|嗨)\s*[，,]\s*(\S{2,12})/;
        for (const node of walkTextNodes()) {
            const el = node.parentElement;
            if (!el || isPrivacySafe(el)) continue;
            const txt = (node.nodeValue || '').trim();
            if (!txt || txt.length > 40) continue;
            const m = re.exec(txt);
            if (m && m[2]) { privName = m[2].trim(); break; }
        }
        return privName;
    }

    function maskTexts() {
        const name = detectPenName();
        const words = [];
        if (name) words.push(name);
        if (typeof currentBookName === 'string' && currentBookName.trim().length >= 2) {
            words.push(currentBookName.trim());
        }
        if (!words.length) return;

        for (const node of walkTextNodes()) {
            const el = node.parentElement;
            if (!el || isPrivacySafe(el)) continue;
            if (/^(SCRIPT|STYLE|TEXTAREA|INPUT)$/.test(el.tagName || '')) continue;

            let txt = node.nodeValue || '';
            let changed = false;
            for (const w of words) {
                if (w && txt.indexOf(w) !== -1) {
                    txt = txt.split(w).join('★★★');
                    changed = true;
                }
            }
            if (changed) {
                privTexts.set(node, node.nodeValue);
                node.nodeValue = txt;
            }
        }
    }

    function maskImages() {
        document.querySelectorAll('img').forEach((img) => {
            if (isPrivacySafe(img)) return;
            const r = img.getBoundingClientRect();
            const w = r.width || img.width || 0;
            const h = r.height || img.height || 0;
            const srcHint = /avatar|head|cover|portrait|author/i.test(img.src || '') ||
                /avatar|head|cover/i.test(String(img.className || ''));
            // 封面/头像：小尺寸图，或 class/src 带 cover/avatar 的图
            const isSmall = (w > 0 && w <= 340) && (h > 0 && h <= 520) && h > 20;
            const inBookLink = !!(img.closest && img.closest('a[href*="/writer/"], a[href*="/book"], a[href*="/novel"]'));
            if (!(isSmall || srcHint || inBookLink)) return;
            if (privImages.has(img)) return;
            privImages.set(img, img.src);
            img.src = PRIVACY_GRAY;
            img.style.objectFit = 'cover';
        });
    }

    function unmaskPrivacy() {
        for (const [node, txt] of privTexts) {
            try {
                if (node.nodeType === 3) node.nodeValue = txt;
                else node.textContent = txt;
            } catch (e) { /* ignore */ }
        }
        privTexts.clear();
        for (const [img, src] of privImages) {
            try { img.src = src; } catch (e) { /* ignore */ }
        }
        privImages.clear();
        const st = document.getElementById('xbu-privacy-style');
        if (st) st.remove();
    }

    function applyPrivacyMasks() {
        if (!privacyMode) { unmaskPrivacy(); return; }
        try { maskImages(); } catch (e) { /* ignore */ }
        try { maskTexts(); } catch (e) { /* ignore */ }
    }

    // 页面异步加载的内容也要补


    window.__novelUploaderSetPrivacy = function (on) {
        privacyMode = !!on;
        try { unmaskPrivacy(); } catch (e) { /* ignore */ }
        updateBookInfo();
        maskPreviewIfNeeded();
        log(privacyMode ? '隐私模式已开启（书名/ID 已隐藏）' : '隐私模式已关闭', 'info');
    };

    // 章节预览里的标题也遮一下，避免截图带出内容
    function maskPreviewIfNeeded() {
        const list = document.getElementById('chapters-list');
        if (!list) return;
        if (privacyMode) {
            list.querySelectorAll('.chapter-title').forEach((el) => {
                if (!el.dataset.rawTitle) el.dataset.rawTitle = el.textContent;
                el.textContent = '第 ★ 章 ★★★';
            });
        } else {
            list.querySelectorAll('.chapter-title').forEach((el) => {
                if (el.dataset.rawTitle) el.textContent = el.dataset.rawTitle;
            });
        }
    }

    window.__novelUploaderShowPanel = showPanel;
    window.__novelUploaderHidePanel = hidePanel;
    window.__novelUploaderIsReady = true;

    /*******************************
     * 多账号任务系统对接口（供 shell 通过 executeJavaScript 调用）
     *******************************/

    // 诊断：把当前页面所有链接与可能含书号的文本 dump 出来，供排查番茄页面结构
    window.__xbuDumpLinks = function () {
        const links = Array.prototype.slice.call(document.querySelectorAll('a[href]')).map(a => ({
            href: (function () { try { return a.getAttribute('href') || ''; } catch (e) { return ''; } })(),
            text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        }));
        // 页面上出现的所有长数字串（书号候选）
        const bodyText = (document.body ? document.body.innerText : '') || '';
        const nums = (bodyText.match(/\d{10,}/g) || []).slice(0, 100);
        return JSON.stringify({ url: location.href, title: document.title, linkCount: links.length, links: links.slice(0, 200), nums: nums }, null, 2);
    };

    // 列出当前账号作品管理页里的书：[{id, name}]
    // 兼容多种番茄版本：优先从链接路径抠书号，其次从链接/卡片的 data 属性、点击处理里找
    window.__xbuListBooks = async function () {
        const out = [];
        const seen = {};
        const addBook = (id, name) => {
            if (!id || seen[id]) return;
            seen[id] = true;
            out.push({ id: String(id), name: String(name || ('书 ' + id)).replace(/\s+/g, ' ').trim().slice(0, 60) });
        };
        const links = document.querySelectorAll('a[href]');
        for (const a of links) {
            let href = '';
            try { href = a.getAttribute('href') || ''; } catch (e) { continue; }
            let id = '';
            // 各种可能的书号位置：路径段、查询参数 id/bookId/book_id
            const segs = href.match(/\d{10,}/g);
            if (segs && segs.length) id = segs[0];
            if (!id) {
                const q = /[?&](?:book_?id|id|novel_?id)=(\d{10,})/i.exec(href);
                if (q) id = q[1];
            }
            if (!id) continue;
            let name = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (!name && a.closest) {
                const card = a.closest('[class*="book"], [class*="item"], [class*="card"], li, tr');
                if (card) {
                    const t = card.querySelector('[class*="title"], [class*="name"], h3, h4, [class*="book-name"]');
                    if (t) name = (t.textContent || '').replace(/\s+/g, ' ').trim();
                }
            }
            // 排除明显不是书的（纯数字URL里混的时间戳等）
            if (!name || /^\d+$/.test(name)) name = '书 ' + id;
            addBook(id, name);
        }
        // 兜底：若到处都没有 <a>，尝试从带 data-id / onclick 的元素里找
        if (!out.length) {
            const cands = document.querySelectorAll('[data-book-id], [data-bookid], [data-id]');
            for (const el of cands) {
                let id = '';
                try { id = el.getAttribute('data-book-id') || el.getAttribute('data-bookid') || el.getAttribute('data-id') || ''; } catch (e) {}
                if (/\d{10,}/.test(String(id))) {
                    const name = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
                    addBook(String(id).match(/\d{10,}/)[0], name);
                }
            }
        }
        return out;
    };

    // 执行一个任务：接收章节与设置，构造上传状态后跳发布页，剩下的交给断点续传
    // config = { taskId, bookId, bookName, chapters:[{number,title,content,wordCount}], settings:{...} }
    window.__xbuRunTask = async function (config) {
        try {
            const cfg = typeof config === 'string' ? JSON.parse(config) : (config || {});
            const chapters = Array.isArray(cfg.chapters) ? cfg.chapters.filter(ch => ch && ch.content) : [];
            if (!chapters.length) {
                log('任务没有可发布的章节', 'error');
                if (window.__xbuTaskStatus) window.__xbuTaskStatus(cfg.taskId, 'failed');
                return { ok: false, reason: '没有章节' };
            }
            const bookId = String(cfg.bookId || '');
            if (!/^\d{8,}$/.test(bookId)) {
                log('任务书号无效：' + bookId, 'error');
                if (window.__xbuTaskStatus) window.__xbuTaskStatus(cfg.taskId, 'failed');
                return { ok: false, reason: '书号无效' };
            }

            // 任务上下文：存进 state，跳转后 init() 恢复时一并带回来
            activeTaskId = String(cfg.taskId || '');
            activeTaskBook = String(cfg.bookName || '');

            const s = cfg.settings || {};
            const settings = {
                mode: s.mode || 'timed',
                checkSequence: !!s.checkSequence,
                todayQuota: Number(s.todayQuota) || 0,
                timedPublish: s.timedPublish !== false,
                startDate: s.startDate || '',
                startTime: /^\d{2}:\d{2}$/.test(s.startTime || '') ? s.startTime : '08:00',
                dailyCount: Number(s.dailyCount) || 3,
                intervalMinutes: Number(s.intervalMinutes) || 0,
                skipWeekend: !!s.skipWeekend,
                ignoreViolation: !!s.ignoreViolation,
                settleSeconds: Number(s.settleSeconds) || 2.5
            };

            isPaused = false;
            stopRequested = false;  // 重新下发任务 = 新的一批，清掉上次的取消标志
            try { syncPauseBtn(); } catch (e) { /* ignore */ }

            uploadState = {
                isUploading: true,
                bookId: bookId,
                bookName: activeTaskBook,
                taskId: activeTaskId,
                chapters: chapters.map(ch => ({
                    number: Number(ch.number) || 0,
                    title: String(ch.title || ''),
                    content: String(ch.content || ''),
                    wordCount: Number(ch.wordCount) || 0,
                    status: 'pending'
                })),
                currentIndex: 0,
                settings: settings,
                results: [],
                startTime: Date.now()
            };
            saveUploadState(uploadState);

            if (window.__xbuTaskStatus) window.__xbuTaskStatus(cfg.taskId, 'running');
            // 本批进度归零（重新开启任务时从头计）
            try {
                if (window.__xbuTaskProgress && cfg.taskId) {
                    window.__xbuTaskProgress(cfg.taskId, 0, chapters.length, 0);
                }
            } catch (e) { /* ignore */ }
            log('任务已下发：' + activeTaskBook + '，共 ' + chapters.length + ' 章，即将跳转发布页', 'success');

            await delay(800);
            window.location.href = 'https://fanqienovel.com/main/writer/' + bookId + '/publish/?enter_from=newchapter_1';
            return { ok: true };
        } catch (e) {
            log('执行任务出错：' + (e && e.message), 'error');
            try { if (cfg && cfg.taskId && window.__xbuTaskStatus) window.__xbuTaskStatus(cfg.taskId, 'failed'); } catch (e2) {}
            return { ok: false, reason: (e && e.message) || '未知错误' };
        }
    };

    /*******************************
     * 初始化拖拽功能
     *******************************/
    function initDrag(panel) {
        const header = panel.querySelector('.panel-header');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('panel-btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.left = (startLeft + dx) + 'px';
            panel.style.top = (startTop + dy) + 'px';
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    /*******************************
     * 绑定事件
     *******************************/
    function bindEvents() {
        // 切换面板
        document.getElementById('toggle-panel').addEventListener('click', () => {
            const body = panel.querySelector('.panel-body');
            body.style.display = body.style.display === 'none' ? 'block' : 'none';
        });

        // 关闭面板（隐藏并留一个唤回入口）
        document.getElementById('close-panel').addEventListener('click', () => {
            hidePanel();
        });

        // 短篇批量
    (function bindShortPanel() {
        const box = document.getElementById('short-batch');
        const drop = document.getElementById('short-drop');
        const fileInput = document.getElementById('short-file');
        const fileNameEl = document.getElementById('short-file-name');
        const listBox = document.getElementById('short-list');

        const startBtn = document.getElementById('short-start');
        const stopBtn = document.getElementById('short-stop');

        const refresh = () => {
            if (box) shortItems = parseShortBatch(box.value);
            renderShortList();
        };

        const loadFile = async (file) => {
            if (!file) return;
            try {
                const text = await readFile(file);
                if (box) box.value = text;
                if (fileNameEl) fileNameEl.textContent = file.name;
                refresh();
                shortLog('已载入「' + file.name + '」，识别到 ' + shortItems.length + ' 篇', 'success');
            } catch (e) {
                shortLog('读取文件失败：' + e.message, 'error');
            }
        };

        if (drop && fileInput) {
            drop.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', (ev) => {
                const f = ev.target.files && ev.target.files[0];
                loadFile(f);
                ev.target.value = '';
            });
            drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('dragover'); });
            drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
            drop.addEventListener('drop', (ev) => {
                ev.preventDefault();
                drop.classList.remove('dragover');
                const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
                if (f) loadFile(f);
            });
        }

        // 整个窗口拖进来也能接
        document.addEventListener('dragover', (ev) => { ev.preventDefault(); });
        document.addEventListener('drop', (ev) => {
            const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
            if (!f) return;
            const panelEl = document.getElementById('novel-upload-panel');
            const shortVisible = panelEl && document.getElementById('short-panel') &&
                document.getElementById('short-panel').style.display !== 'none';
            if (shortVisible) {
                ev.preventDefault();
                loadFile(f);
            }
        });

        const parseBtn = document.getElementById('short-parse');
        const clearBtn = document.getElementById('short-clear');
        if (parseBtn) parseBtn.addEventListener('click', () => { refresh(); shortLog('已解析：' + shortItems.length + ' 篇'); });
        if (clearBtn) clearBtn.addEventListener('click', () => {
            if (box) box.value = '';
            if (fileNameEl) fileNameEl.textContent = '';
            shortItems = [];
            renderShortList();
        });

        if (box) {
            box.addEventListener('input', refresh);
        }

        const allBtn = document.getElementById('short-all');
        const noneBtn = document.getElementById('short-none');
        if (allBtn) allBtn.addEventListener('click', () => { shortItems.forEach(x => { x.selected = true; }); renderShortList(); });
        if (noneBtn) noneBtn.addEventListener('click', () => { shortItems.forEach(x => { x.selected = false; }); renderShortList(); });

        if (startBtn) startBtn.addEventListener('click', () => runShortBatch());
        if (stopBtn) stopBtn.addEventListener('click', () => {
            shortStop = true;
            shortLog('已请求停止，当前这一篇做完就停', 'warning');
        });

        refresh();
    })();

    // 长篇 / 短篇 切换
        document.querySelectorAll('.ptab').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                document.querySelectorAll('.ptab').forEach(b => {
                    const on = b === btn;
                    b.classList.toggle('active', on);
                    b.style.background = on ? '#1890ff' : '#f0f2f5';
                    b.style.color = on ? '#fff' : '#595959';
                });
                document.getElementById('long-panel').style.display = mode === 'long' ? '' : 'none';
                document.getElementById('short-panel').style.display = mode === 'short' ? '' : 'none';
            });
        });

        // 文件上传
        const fileUploadArea = document.getElementById('file-upload-area');
        const fileInput = document.getElementById('file-input');

        installDropZone();
        bindPasteArea();

        fileUploadArea.addEventListener('click', () => fileInput.click());
        fileUploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileUploadArea.classList.add('drag-over');
        });
        fileUploadArea.addEventListener('dragleave', () => {
            fileUploadArea.classList.remove('drag-over');
        });
        fileUploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            fileUploadArea.classList.remove('drag-over');
            if (e.dataTransfer.files[0]) {
                fileInput.files = e.dataTransfer.files;
                handleFileSelect({ target: fileInput });
            }
        });

        fileInput.addEventListener('change', handleFileSelect);

        // 手动扫描定时时间
        const scanBtn = document.getElementById('scan-schedule');
        if (scanBtn) {
            scanBtn.addEventListener('click', async () => {
                scanBtn.disabled = true;
                scanBtn.textContent = '扫描中…';
                const res = await scanScheduledLastTime(true, true);
                scanBtn.disabled = false;
                scanBtn.textContent = '🔄 扫描本书定时';
                if (!res) {
                    const el = document.getElementById('scan-result');
                    if (el) { el.textContent = '未找到，请打开章节管理页'; el.style.color = '#ff4d4f'; }
                }
            });
        }

        // 章节选择
        document.getElementById('select-all').addEventListener('click', () => {
            parsedChapters.forEach(ch => {
                if (ch.wordCount >= CONFIG.VALIDATION.MIN_WORDS) {
                    ch.selected = true;
                }
            });
            renderChapters();
        });

        document.getElementById('select-none').addEventListener('click', () => {
            parsedChapters.forEach(ch => ch.selected = false);
            renderChapters();
        });

        // 选最后 N 章
    function selectLastN(n) {
        parsedChapters.forEach(c => { c.selected = false; });
        const start = Math.max(0, parsedChapters.length - n);
        for (let i = start; i < parsedChapters.length; i++) parsedChapters[i].selected = true;
        renderChapters();
        log(`已选中最后 ${parsedChapters.length - start} 章`, 'info');
    }
    const last5 = document.getElementById('select-last5');
    const last10 = document.getElementById('select-last10');
    if (last5) last5.addEventListener('click', () => selectLastN(5));
    if (last10) last10.addEventListener('click', () => selectLastN(10));

    document.getElementById('select-valid').addEventListener('click', () => {
            parsedChapters.forEach(ch => {
                ch.selected = ch.wordCount >= CONFIG.VALIDATION.MIN_WORDS;
            });
            renderChapters();
        });

        // 返回按钮
        document.getElementById('back-btn').addEventListener('click', () => {
            document.getElementById('preview-section').classList.add('hidden');
            parsedChapters = [];
            fileInput.value = '';
            document.getElementById('file-name').textContent = '';
        });

        // 开始上传
        document.getElementById('start-upload').addEventListener('click', startUpload);

        // 停止上传
        document.getElementById('stop-upload').addEventListener('click', stopUpload);

        // 暂停 / 继续
        document.getElementById('pause-upload').addEventListener('click', () => {
            if (isPaused) {
                resumeAutomation();
            } else {
                pauseAutomation('手动暂停');
            }
        });

        // 手动扫描收益
    (function bindScanIncome() {
        const btn = document.getElementById('scan-income');
        if (!btn) return;
        btn.addEventListener('click', () => {
            try {
                const before = lastIncomeValue;
                scanIncomePage(true);
                if (lastIncomeValue === before) {
                    log('没找到收益数字，已把页面内容存下来供排查', 'warning');
                    try {
                        const txt = (document.body && document.body.innerText) || '';
                        const nums = [];
                        const re = /(\d+(?:\.\d+)?)/g;
                        let m;
                        while ((m = re.exec(txt)) !== null && nums.length < 200) nums.push(m[1]);
                        const dump = {
                            url: location.href,
                            title: document.title,
                            textHead: txt.slice(0, 6000),
                            numbers: nums.slice(0, 60)
                        };
                        if (window.__saveDump) window.__saveDump(JSON.stringify(dump));
                        log('已保存收益页结构，请把这句话告诉作者', 'success');
                    } catch (e) { /* ignore */ }
                }
            } catch (e) {
                log('扫描收益失败: ' + e.message, 'error');
            }
        });
    })();

    // 接着上次定时排
    (function bindContinueAfterLast() {
        const cb = document.getElementById('continue-after-last');
        if (!cb) return;
        cb.addEventListener('change', () => {
            if (cb.checked) {
                applyContinueAfterLast(false);
            } else {
                log('已取消「接着上次排」，日期按你手动选的来', 'info');
            }
        });
    })();

    // 定时发布开关
        document.getElementById('timed-publish').addEventListener('change', (e) => {
            const timedOptions = document.getElementById('timed-options');
            timedOptions.classList.toggle('hidden', !e.target.checked);
            if (e.target.checked) {
                // 设置默认日期为明天
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const dateStr = tomorrow.toISOString().split('T')[0];
                document.getElementById('start-date').value = dateStr;
                updateSchedulePreview();
            }
        });

        // 定时设置变化时更新预览
        ['start-date', 'start-time', 'daily-count', 'interval-minutes', 'skip-weekend'].forEach(id => {
            document.getElementById(id).addEventListener('change', updateSchedulePreview);
        });
    }

    /*******************************
     * 更新书籍信息
     *******************************/
    /* ---------- 收益页扫描：自动记录今日收益 ---------- */
    let lastIncomeScan = 0;
    let lastIncomeValue = -1;

    function scanIncomePage(force) {
        if (!force && Date.now() - lastIncomeScan < 3000) return;
        lastIncomeScan = Date.now();

        const href = location.href;
        const bodyTxt = (document.body && document.body.innerText) || '';
        const looksIncome = /收益|收入|income|revenue/i.test(href) ||
            /收益/.test(bodyTxt);
        if (!looksIncome) return;

        let value = null;

        // 优先按 DOM 结构找：标签「昨日番茄收益」旁边紧跟的那个数字
        const labels = ['昨日番茄收益', '今日番茄收益', '今日收益', '昨日收益', '预估收益', '番茄收益'];
        const leaves = Array.from(document.querySelectorAll('div,span,p,h3,h4,label,strong'));

        for (const lab of labels) {
            const hits = leaves.filter((el) => {
                if (el.children && el.children.length) return false;
                const txt = (el.textContent || '').replace(/\s+/g, '');
                return txt === lab || txt === lab + 'ⓘ' || txt.indexOf(lab) === 0 && txt.length <= lab.length + 2;
            });

            for (const el of hits) {
                let node = el.parentElement;
                for (let d = 0; d < 3 && node; d++) {
                    const raw = (node.innerText || '').replace(lab, ' ');
                    const m = /(\d+(?:\.\d+)?)/.exec(raw);
                    if (m) {
                        const num = parseFloat(m[1]);
                        // 排除"5.25%"这种百分比
                        const idx = raw.indexOf(m[1]);
                        const after = raw.slice(idx + m[1].length, idx + m[1].length + 2);
                        if (!isNaN(num) && after.indexOf('%') === -1) { value = num; break; }
                    }
                    node = node.parentElement;
                }
                if (value !== null) break;
            }
            if (value !== null) break;
        }

        // 兜底：整页文本按写法匹配
        if (value === null) {
            const m1 = /(昨日番茄收益|今日番茄收益|番茄收益|昨日收益|今日收益|预估收益)[^\d]{0,20}(\d+(?:\.\d+)?)/.exec(bodyTxt);
            if (m1) value = parseFloat(m1[2]);
        }

        if (value === null || isNaN(value)) return;
        if (Math.abs(value - lastIncomeValue) < 0.005) return;
        lastIncomeValue = value;

        if (window.__xbuIncome) {
            const nm = (typeof currentBookName === 'string' ? currentBookName.trim() : '');
            const key = nm ? ('nm:' + nm) : ('t:' + Date.now());
            window.__xbuIncome(key, value);
            log('已记录今日收益：¥' + value.toFixed(2), 'success');
        }
    }

    setInterval(() => { try { scanIncomePage(true); } catch (e) { /* ignore */ } }, 3000);

    // 供外壳调用：立刻扫描一次（打开收益窗口时自动触发）
    window.__xbuScanIncome = function () {
        try { scanIncomePage(true); } catch (e) { /* ignore */ }
    };

    function updateBookInfo() {
        const bookId = getCurrentBookId();
        const infoEl = document.getElementById('book-info');
        if (!infoEl) return;

        // 尽量把书名找出来（不同页面结构都试一遍）
        let bookName = '';
        const selectors = [
            '.book-title', '.novel-title', 'h1', '.title',
            '.arco-breadcrumb-item:last-child',
            '.serial-header-title', '[class*="book-name"]', '[class*="bookName"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            const txt = el && (el.textContent || '').trim();
            if (txt && txt.length >= 2 && txt.length <= 40 &&
                !/^(番茄|作家专区|章节管理|作品管理|工作台)$/.test(txt)) {
                bookName = txt;
                break;
            }
        }

        if (bookName) currentBookName = bookName;

        if (privacyMode) {
            infoEl.innerHTML =
                '<div class="bc-label">请确认要上传的书是这本</div>' +
                '<div class="bc-name">📕 ★★★（隐私模式）</div>' +
                '<div class="bc-id">书籍ID：****</div>' +
                '<div class="bc-tip ok">隐私模式已开启，可以放心截图</div>';
            infoEl.style.color = '#262626';
            return;
        }

        if (bookId || bookName) {
            infoEl.innerHTML =
                '<div class="bc-label">请确认要上传的书是这本</div>' +
                '<div class="bc-name">' + (bookName ? '📖 ' + bookName : '⚠️ 未识别到书名') + '</div>' +
                '<div class="bc-id">书籍ID：' + (bookId || '未知') + '</div>' +
                (bookName
                    ? '<div class="bc-tip ok">书名已自动识别，核对无误再上传</div>'
                    : '<div class="bc-tip warn">没读到书名，请手动确认当前页是不是目标书籍</div>');
            infoEl.style.color = '#262626';
            log(bookName ? '当前书籍：《' + bookName + '》' : '未能识别书名，请确认页面', bookName ? 'success' : 'warning');
        } else {
            infoEl.innerHTML =
                '<div class="bc-name">⚠️ 未检测到书籍</div>' +
                '<div class="bc-tip warn">请进入「作品管理 → 小说 → 章节管理」再使用</div>';
            infoEl.style.color = '#faad14';
            log('未检测到书籍，请进入正确页面', 'warning');
        }
    }

    /*******************************
     * 载入文本（文件 / 粘贴 / 拖拽 共用）
     *******************************/
    async function applyContent(content, displayName) {
        const fileName = document.getElementById('file-name');

        if (!content || !content.trim()) {
            log('内容是空的，没东西可解析', 'error');
            return;
        }

        document.getElementById('content-input').value = content;
        parseChapters(content);

        if (parsedChapters.length === 0) {
            fileName.textContent = '未识别到章节，请检查格式';
            fileName.style.color = '#ff4d4f';
            log('未识别到章节：需要「第N章 / 第N节 / Chapter N / N.」这样的标题行', 'error');
            return;
        }

        fileName.textContent = `${displayName} - ${parsedChapters.length}章`;
        fileName.style.color = '#52c41a';

        document.getElementById('preview-section').classList.remove('hidden');
        updateSchedulePreview();
        log(`成功解析 ${parsedChapters.length} 个章节（${displayName}）`, 'success');

        // 滚动到预览区
        const sec = document.getElementById('preview-section');
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function isTxtFile(file) {
        if (!file) return false;
        return /\.txt$/i.test(file.name) || file.type === 'text/plain';
    }

    async function handleFileObject(file) {
        if (!file) return;
        const fileName = document.getElementById('file-name');
        fileName.textContent = `${file.name} - 读取中...`;
        fileName.style.color = '#1890ff';

        if (!isTxtFile(file)) {
            log(`不是 TXT 文件：${file.name}`, 'warning');
        }

        try {
            const content = await readFile(file);
            await applyContent(content, file.name);
        } catch (error) {
            fileName.textContent = '文件读取失败';
            fileName.style.color = '#ff4d4f';
            log(`文件读取失败: ${error.message}`, 'error');
        }
    }

    async function handleFileSelect(event) {
        const file = event.target.files && event.target.files[0];
        if (file) await handleFileObject(file);
    }

    /*******************************
     * 全窗口拖拽载入
     *******************************/
    function installDropZone() {
        if (window.__novelUploaderDropReady) return;
        window.__novelUploaderDropReady = true;

        let overlay = document.getElementById('drop-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'drop-overlay';
            overlay.innerHTML = '<div class="box">松开鼠标，载入 TXT<small>支持拖到窗口任意位置</small></div>';
            document.body.appendChild(overlay);
        }

        let dragDepth = 0;

        window.addEventListener('dragenter', (e) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            e.preventDefault();
            dragDepth++;
            overlay.classList.add('show');
        }, true);

        window.addEventListener('dragover', (e) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            overlay.classList.add('show');
        }, true);

        window.addEventListener('dragleave', (e) => {
            if (!e.dataTransfer) return;
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) overlay.classList.remove('show');
        }, true);

        window.addEventListener('drop', async (e) => {
            if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
            // 关键：阻止 Electron/浏览器把文件当页面打开
            e.preventDefault();
            e.stopPropagation();
            dragDepth = 0;
            overlay.classList.remove('show');

            const files = Array.from(e.dataTransfer.files);
            const txt = files.find(isTxtFile) || files[0];
            log(`拖入文件：${txt.name}`, 'info');
            await handleFileObject(txt);
        }, true);
    }

    /*******************************
     * 粘贴文本解析
     *******************************/
    async function parsePastedText() {
        const box = document.getElementById('paste-input');
        const content = (box && box.value) || '';
        if (!content.trim()) {
            log('粘贴框是空的', 'warning');
            return;
        }
        await applyContent(content, '粘贴文本');
    }

    function bindPasteArea() {
        const box = document.getElementById('paste-input');
        if (!box) return;

        const parseBtn = document.getElementById('paste-parse');
        const clearBtn = document.getElementById('paste-clear');

        if (parseBtn) parseBtn.addEventListener('click', parsePastedText);
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                box.value = '';
                box.focus();
            });
        }

        // 粘贴后自动识别（内容够长才自动触发，避免误判）
        box.addEventListener('paste', () => {
            setTimeout(() => {
                if (box.value.trim().length > 200) {
                    parsePastedText();
                }
            }, 120);
        });
    }

    function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(file, 'UTF-8');
        });
    }

    /*******************************
     * 解析章节
     *******************************/
    function parseChapters(content) {
        parsedChapters = [];
        
        // 多种章节格式的正则表达式
        const patterns = [
            /^第(\d+)章[\s:：]*(.*)$/gm,          // 第1章 标题
            /^第(\d+)节[\s:：]*(.*)$/gm,          // 第1节 标题
            /^Chapter\s+(\d+)[\s:：]*(.*)$/gmi,   // Chapter 1 标题
            /^(\d+)\.[\s]*(.*)$/gm                 // 1. 标题
        ];

        let matches = [];
        
        for (const pattern of patterns) {
            pattern.lastIndex = 0; // 重置正则状态
            let match;
            while ((match = pattern.exec(content)) !== null) {
                matches.push({
                    index: match.index,
                    number: parseInt(match[1]),
                    title: (match[2] || `第${match[1]}章`).trim(),
                    fullMatch: match[0]
                });
            }
            if (matches.length > 0) break; // 使用第一个匹配到的模式
        }

        if (matches.length === 0) {
            log('未找到有效章节格式', 'error');
            return;
        }

        // 提取章节内容
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const start = m.index + m.fullMatch.length;
            const end = i < matches.length - 1 ? matches[i + 1].index : content.length;
            const chapterContent = content.substring(start, end).trim();
            const wordCount = countWords(chapterContent);

            parsedChapters.push({
                number: m.number,
                title: m.title,
                content: chapterContent,
                wordCount: wordCount,
                selected: wordCount >= CONFIG.VALIDATION.MIN_WORDS,
                status: 'pending'
            });
        }

        renderChapters();
    }

    /*******************************
     * 渲染章节列表
     *******************************/
    function renderChapters() {
        const list = document.getElementById('chapters-list');
        const count = document.getElementById('chapter-count');
        const selectedCount = document.getElementById('selected-count');
        
        count.textContent = parsedChapters.length;
        
        const selected = parsedChapters.filter(ch => ch.selected).length;
        selectedCount.textContent = selected;

        list.innerHTML = parsedChapters.map((chapter, index) => {
            const isValid = chapter.wordCount >= CONFIG.VALIDATION.MIN_WORDS;
            const statusClass = `status-${chapter.status}`;
            
            return `
                <div class="chapter-item" data-index="${index}">
                    <input type="checkbox" 
                           class="chapter-checkbox" 
                           ${chapter.selected ? 'checked' : ''}
                           ${!isValid ? 'disabled' : ''}
                           style="width: 16px; height: 16px; cursor: pointer;">
                    <div class="chapter-info">
                        <div class="chapter-title">
                            第${chapter.number}章 ${chapter.title}
                        </div>
                        <div class="chapter-meta">
                            ${chapter.wordCount} 字
                            ${!isValid ? '<span style="color:#ff4d4f;">(字数不足)</span>' : ''}
                        </div>
                    </div>
                    <div class="chapter-status ${statusClass}">
                        ${getStatusText(chapter.status)}
                    </div>
                </div>
            `;
        }).join('');

        // 绑定复选框事件
        list.querySelectorAll('.chapter-checkbox').forEach((checkbox, index) => {
            checkbox.addEventListener('change', () => {
                parsedChapters[index].selected = checkbox.checked;
                renderChapters();
                updateSchedulePreview();
            });
        });
    }

    function getStatusText(status) {
        const texts = {
            pending: '待上传',
            uploading: '上传中',
            success: '成功',
            error: '失败'
        };
        return texts[status] || status;
    }

    /*******************************
     * 更新进度
     *******************************/
    function updateProgress(current, total, message) {
        const percent = Math.round((current / total) * 100);
        
        document.getElementById('progress-text').textContent = message;
        document.getElementById('progress-fill').style.width = `${percent}%`;
        document.getElementById('current-progress').textContent = `${current}/${total}`;
        document.getElementById('percentage').textContent = `${percent}%`;
    }

    /*******************************
     * 更新定时发布预览
     *******************************/
    // 把开始日期设成"上次定时的下一天"
    async function applyContinueAfterLast(silent) {
        const cb = document.getElementById('continue-after-last');
        const dateEl = document.getElementById('start-date');
        if (!cb || !dateEl) return false;

        if (!cb.checked) return false;
        if (!window.__xbuScheduleGet) {
            if (!silent) log('读取定时记录不可用，请重启程序', 'warning');
            return false;
        }

        let rec = null;
        try { rec = await window.__xbuScheduleGet(bookRef()); } catch (e) { rec = null; }

        if (!rec || !rec.last) {
            if (!silent) log('这本书还没有定时记录，先按你选的日期排', 'warning');
            return false;
        }

        const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(rec.last));
        if (!m) return false;

        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        d.setDate(d.getDate() + 1);
        const pad = (n) => String(n).padStart(2, '0');
        const next = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

        if (dateEl.value !== next) {
            dateEl.value = next;
            if (!silent) log(`已把开始日期设为上次定时的下一天：${next}（上次 ${rec.last}）`, 'success');
            updateSchedulePreview();
        }
        return true;
    }

    function updateSchedulePreview() {
        const selectedChapters = parsedChapters.filter(ch => ch.selected);
        if (selectedChapters.length === 0) return;

        const startDate = document.getElementById('start-date').value;
        const startTime = document.getElementById('start-time').value;
        const dailyCount = parseInt(document.getElementById('daily-count').value) || 3;
        const intervalMinutes = parseInt(document.getElementById('interval-minutes').value) || 0;
        const skipWeekend = document.getElementById('skip-weekend').value === 'yes';
        
        // 计算发布计划
        let currentDayIndex = 0;
        let currentChapterIndex = 0;
        let publishDates = [];
        let currentDate = new Date(`${startDate}T${startTime}`);
        
        while (currentChapterIndex < selectedChapters.length) {
            const dayOfWeek = currentDate.getDay();
            
            // 检查是否跳过周末
            if (skipWeekend && (dayOfWeek === 0 || dayOfWeek === 6)) {
                currentDate.setDate(currentDate.getDate() + 1);
                continue;
            }
            
            // 计算当天发布的时间
            for (let i = 0; i < dailyCount && currentChapterIndex < selectedChapters.length; i++) {
                const publishTime = new Date(currentDate.getTime() + i * intervalMinutes * 60000);
                publishDates.push({
                    date: publishTime,
                    chapter: selectedChapters[currentChapterIndex].number
                });
                currentChapterIndex++;
            }
            
            // 移动到下一天
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(parseInt(startTime.split(':')[0]));
            currentDate.setMinutes(parseInt(startTime.split(':')[1]));
            currentDayIndex++;
        }
        
        const totalDays = Math.ceil(currentDayIndex);
        const lastDate = publishDates[publishDates.length - 1]?.date;
        
        let previewText = `计划发布 ${selectedChapters.length} 章，预计 ${totalDays} 天完成`;
        if (lastDate) {
            previewText += `，最后发布日期: ${lastDate.toLocaleDateString()}`;
        }
        
        document.getElementById('schedule-preview').textContent = previewText;
    }

    /*******************************
     * 开始上传
     *******************************/
    async function startUpload() {
        const selectedChapters = parsedChapters.filter(ch => ch.selected);
        if (selectedChapters.length === 0) {
            log('请选择要上传的章节', 'error');
            alert('请选择要上传的章节');
            return;
        }

        const bookId = getCurrentBookId();
        if (!bookId) {
            log('未检测到书籍ID，请进入书籍页面', 'error');
            alert('未检测到书籍ID，请进入书籍页面');
            return;
        }

        isPaused = false; // 新批次开始，清掉上一次的暂停状态
        try { syncPauseBtn(); } catch (e) { /* ignore */ }
        parsedChapters.forEach(c => { c.retryCount = 0; });

        // 勾了"接着上次排"就先校准开始日期
        try { await applyContinueAfterLast(true); } catch (e) { /* ignore */ }
        await delay(120);

        // 今天已排几章？据此补足「每日章数」
        let todayQuota = 0;
        try {
            const cb = document.getElementById('continue-after-last');
            const dailyCount = parseInt(document.getElementById('daily-count').value, 10) || 0;
            if (cb && cb.checked && dailyCount > 0) {
                const already = countTodayScheduled();
                todayQuota = Math.max(0, dailyCount - already);
                if (todayQuota > 0) {
                    log(`今天已排 ${already} 章，本次先补 ${todayQuota} 章到今天的定时里`, 'info');
                }
            }
        } catch (e) { /* ignore */ }

        // 获取设置
        const settings = {
            mode: document.querySelector('input[name="mode"]:checked').value,
            checkSequence: document.getElementById('check-sequence').checked,
            todayQuota: todayQuota,
            timedPublish: document.getElementById('timed-publish').checked,
            startDate: document.getElementById('start-date').value,
            // 统一成 HH:mm，防止 "0:00" 这类写法在面板里点不中小时
            startTime: (function () {
                const raw = String(document.getElementById('start-time').value || '00:00');
                const p = raw.split(':');
                const hh = String(Math.min(23, Math.max(0, parseInt(p[0], 10) || 0))).padStart(2, '0');
                const mm = String(Math.min(59, Math.max(0, parseInt(p[1], 10) || 0))).padStart(2, '0');
                return hh + ':' + mm;
            })(),
            dailyCount: parseInt(document.getElementById('daily-count').value) || 3,
            intervalMinutes: parseInt(document.getElementById('interval-minutes').value) || 0,
            skipWeekend: document.getElementById('skip-weekend').value === 'yes',
            ignoreViolation: document.getElementById('ignore-violation').checked,
            settleSeconds: (function () {
                const v = parseFloat((document.getElementById('settle-seconds') || {}).value);
                const s = isFinite(v) && v > 0 ? Math.max(0.5, Math.min(15, v)) : 2.5;
                try { GM_setValue('settle_seconds', String(s)); } catch (e) { /* ignore */ }
                return s;
            })()
        };

        // 定时发布：先登记计划（供提醒窗口）
        if (settings.timedPublish) {
            recordSchedulePlan(settings, selectedChapters.length);
        }

        // 保存上传状态
        uploadState = {
            isUploading: true,
            bookId: bookId,
            chapters: selectedChapters.map(ch => ({
                number: ch.number,
                title: ch.title,
                content: ch.content,
                wordCount: ch.wordCount,
                status: 'pending'
            })),
            currentIndex: 0,
            settings: settings,
            results: [],
            startTime: Date.now()
        };
        
        saveUploadState(uploadState);

        // 切换到进度界面
        document.getElementById('preview-section').classList.add('hidden');
        document.getElementById('progress-section').classList.remove('hidden');
        
        log(`开始上传 ${selectedChapters.length} 个章节`, 'success');
        log('即将跳转到发布页面...', 'info');
        updateProgress(0, selectedChapters.length, '准备开始上传...');

        // 跳转到发布页面
        await delay(1000);
        window.location.href = `https://fanqienovel.com/main/writer/${bookId}/publish/?enter_from=newchapter_1`;
    }

    /*******************************
     * 停止上传
     *******************************/
    function stopUpload() {
        if (confirm('确定要停止上传吗？')) {
            isUploading = false;
            clearUploadState();
            document.getElementById('progress-section').classList.add('hidden');
        hideUploadNotice();
            document.getElementById('preview-section').classList.remove('hidden');
            log('上传已停止', 'warning');
        }
    }

    /*******************************
     * 状态管理
     *******************************/
    function saveUploadState(state) {
        GM_setValue(CONFIG.STORAGE.UPLOAD_STATE, JSON.stringify(state));
    }

    function loadUploadState() {
        try {
            const data = GM_getValue(CONFIG.STORAGE.UPLOAD_STATE, null);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            return null;
        }
    }

    function clearUploadState() {
        GM_deleteValue(CONFIG.STORAGE.UPLOAD_STATE);
    }

    /*******************************
     * 继续上传流程
     *******************************/
    let continueRunning = false;

    async function continueUpload() {
        if (continueRunning) return;
        continueRunning = true;
        try {
            await continueUploadInner();
        } finally {
            continueRunning = false;
        }
    }

    async function continueUploadInner() {
        if (stopRequested) return;  // 本次已被取消，别再自己续上
        const state = loadUploadState();
        if (!state || !state.isUploading) return;

        uploadState = state;
        const { bookId, chapters, currentIndex } = state;
        
        log(`继续上传流程，当前索引: ${currentIndex}`);
        
        // 判断当前页面
        if (window.location.href.includes('chapter-manage')) {
            // 章节管理页面，说明上一章发布成功
            if (currentIndex > 0 && chapters[currentIndex - 1]) {
                chapters[currentIndex - 1].status = 'success';
                state.results[currentIndex - 1] = { 
                    chapter: chapters[currentIndex - 1].number, 
                    success: true 
                };
                saveUploadState(state);
            }
            
            // 检查是否完成
            if (currentIndex >= chapters.length) {
                clearUploadState();
                showCompletionNotice(state.results);
                return;
            }
            
            // 继续下一章
            await delay(CONFIG.DELAY.CHAPTER);
            window.location.href = `https://fanqienovel.com/main/writer/${bookId}/publish/?enter_from=newchapter_1`;
            return;
        }
        
        // 发布页面，执行上传
        if (window.location.href.includes('/publish/')) {
            await delay(CONFIG.DELAY.PAGE_LOAD);
            await fillAndSubmitChapter(state);
        }
    }

    /*******************************
     * 填写并提交章节
     *******************************/
    // 根据页面上的「上次提交：第N章」校正当前进度（手动发过一章也不会错位）
    function syncIndexWithPage(state) {
        try {
            const el = document.querySelector('.publish-maintain-info-lasttitle');
            if (!el || !state || !Array.isArray(state.chapters)) return false;

            const m = /第\s*(\d+)\s*章/.exec(el.textContent || '');
            if (!m) return false;
            const lastNum = parseInt(m[1], 10) || 0;
            if (!lastNum) return false;

            const idx = state.chapters.findIndex(c => Number(c.number) === lastNum + 1);
            if (idx < 0) return false;

            if (idx !== state.currentIndex) {
                log('页面已提交到第' + lastNum + '章，进度校正为第' + (lastNum + 1) + '章', 'warning');
                state.currentIndex = idx;
                saveUploadState(state);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async function fillAndSubmitChapter(state) {
        const { chapters, settings } = state;
        // 先按页面真实进度校正索引，再取当前章；校正后必须同步局部变量，
        // 否则后面仍用旧 currentIndex 标记结果/推进进度，会错章或跳章。
        syncIndexWithPage(state);
        let currentIndex = state.currentIndex;
        const chapter = chapters[currentIndex];

        // 新的一章：重置"本能章无视违规"标志
        chapterViolationBypass = false;
        
        if (!chapter) {
            clearUploadState();
            return;
        }

        // 已被「取消本次」→ 直接退出，不再填表/点发布
        if (stopRequested) {
            hideUploadNotice();
            return;
        }

        // 显示上传通知
        showUploadNotice(currentIndex + 1, chapters.length, chapter.number);

        // 每章开始重置「确认发布」弹窗计数，别让上一章的计数影响本章
        window.__pubConfirmHits = 0;
        
        try {
            // 等待页面加载
            await delay(1500);
            
            // 处理所有弹窗（包括风险提示）
            await handleAllDialogs();
            
            // 重复上传防护：这本书发过的章号再发一次会给目录制造重复
            if (window.__xbuProgressGet) {
                try {
                    const rec = await window.__xbuProgressGet(bookRef());
                    const nums = (rec && rec.nums) || [];
                    const maxN = (rec && rec.max) || 0;
                    if (nums.includes(chapter.number) || (maxN && chapter.number <= maxN && nums.includes(chapter.number))) {
                        log(`第${chapter.number}章 之前已经发过（记录里最高第${maxN}章）`, 'warning');
                        const again = confirm(
                            '重复上传提醒！\n\n' +
                            `「第${chapter.number}章」之前已经成功发布过一次（这本书记录到第${maxN}章）。\n\n` +
                            '点「确定」仍然再发一次，点「取消」跳过这一章。'
                        );
                        if (!again) {
                            log(`已跳过重复的第${chapter.number}章`, 'warning');
                            return;
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // 检查章节连续性（不确定就停下来问用户）
            if (settings.checkSequence) {
                const seqOk = await checkChapterSequence(chapter.number);
                if (!seqOk) {
                    clearUploadState();
                    hideUploadNotice();
                    const sec = document.getElementById('progress-section');
                    if (sec) sec.classList.add('hidden');
                    log('因章节不连续，已停止本次上传', 'error');
                    return;
                }
            }
            
            // 填写章节信息
            await fillChapterInfo(chapter);
            
            // 点击下一步
            await clickNextButton();

            // 点完下一步可能立刻弹违规/色情拦截
            await delay(800);
            const vDlg = findViolationDialog();
            if (vDlg) {
                await handleViolationDialog(vDlg, settings);
                await delay(800);
            }

            // 风险提示会拦住「下一步」，没弹出发布框就再点一次
            await waitPublishDialogOrRetry(3);

            // 处理发布对话框
            const published = await handlePublishDialog(state);
            
            if (published) {
                try {
                    if (window.__xbuStats) {
                        window.__xbuStats(bookRef(), 1, chapter.content ? chapter.content.length : 0);
                    }
                } catch (e) { /* ignore */ }
                // 记下"这本书记得发过第几章"，用于下次防重复
                try {
                    if (window.__xbuProgressSet) window.__xbuProgressSet(bookRef(), chapter.number);
                } catch (e) { /* ignore */ }

                // 更新状态
                chapters[currentIndex].status = 'success';
                chapter.retryCount = 0;
                state.results[currentIndex] = { 
                    chapter: chapter.number, 
                    success: true 
                };
                state.currentIndex = currentIndex + 1;
                saveUploadState(state);

                // 单独打一条成功记录：日志面板里整行绿字，一眼能看出发到第几章了
                log(`第${chapter.number}章 发布成功（本批 ${state.currentIndex}/${state.chapters.length} 章）`, 'success');

                // 回报本批进度：已发 k 章 / 共 N 章，刚发完第 X 章
                try {
                    const tid = String(state.taskId || activeTaskId || '');
                    if (window.__xbuTaskProgress && tid) {
                        // 用"成功条数"算已完成，避免索引未推进时报成 0
                        const doneCount = (state.results || []).filter(r => r && r.success).length;
                        const done = Math.max(doneCount, Number(state.currentIndex) || 0);
                        window.__xbuTaskProgress(tid, done, state.chapters.length, chapter.number);
                    }
                } catch (e) { /* ignore */ }
                
                // 等待跳转
                for (let i = 0; i < 10; i++) {
                    await delay(500);
                    if (window.location.href.includes('chapter-manage')) {
                        break;
                    }
                }
            }
            
        } catch (error) {
            log(`上传出错: ${error.message}`, 'error');

            // 是被「取消本次」打断的：不要重试、更不要跳下一章
            if (stopRequested) {
                hideUploadNotice();
                return;
            }

            // 断点续传配套：本章还没成功，先重试，不急着往后跳
            const tries = (chapter.retryCount || 0);
            if (tries < 3) {
                chapter.retryCount = tries + 1;
                state.chapterRetry = chapter.retryCount;
                saveUploadState(state);
                const wait = 3000 * (tries + 1);
                log(`第${chapter.number}章 失败，${Math.round(wait / 1000)} 秒后自动重试（第 ${chapter.retryCount}/3 次）`, 'warning');
                showUploadNotice(currentIndex + 1, state.chapters.length, chapter.number);
                await delay(wait);
                window.location.href = `https://fanqienovel.com/main/writer/${state.bookId}/publish/?enter_from=newchapter_1`;
                return;
            }

            log(`第${chapter.number}章 已重试 3 次仍失败，先跳过`, 'error');

            // 标记失败，继续下一章
            chapters[currentIndex].status = 'error';
            state.results[currentIndex] = {
                chapter: chapter.number,
                success: false,
                error: error.message
            };
            state.currentIndex = currentIndex + 1;
            chapter.retryCount = 0;
            saveUploadState(state);

            // 尝试继续
            await delay(2000);
            window.location.href = `https://fanqienovel.com/main/writer/${state.bookId}/publish/?enter_from=newchapter_1`;
        }
    }

    /*******************************
     * 填写章节信息
     * v2.4.4：按番茄真实 DOM 识别「章节序号」「章节标题」两个受控输入框，
     *         并用 React 状态写入（单纯改 DOM 会被重渲染冲掉）。
     *******************************/
    function isUsableInput(el) {
        return el && el.offsetParent !== null && !el.disabled;
    }

    function reactPropsOf(node) {
        if (!node) return null;
        for (const k of Object.keys(node)) {
            if (k.indexOf('reactProps') !== -1) return node[k];
        }
        return null;
    }

    // 序号框：番茄是 input.serial-input（标题框额外带 serial-editor-input-hint-area）
    function findSequenceInput(inputs) {
        const serial = inputs.find(el =>
            /serial-input/.test(el.className || '') &&
            !/hint-area/.test(el.className || ''));
        if (serial) return serial;

        for (const el of inputs) {
            if (/序号|章节号|数字/.test(el.placeholder || '')) return el;
        }
        for (const el of inputs) {
            const sig = ((el.className || '') + ' ' + (el.id || '') + ' ' + (el.name || ''));
            if (/number|num|seq/i.test(sig)) return el;
        }
        return null;
    }

    function findTitleInput(inputs, seqInput) {
        const hint = inputs.find(el => el !== seqInput && /hint-area/.test(el.className || ''));
        if (hint) return hint;
        const byPh = inputs.find(el => el !== seqInput && /标题|章名/.test(el.placeholder || ''));
        if (byPh) return byPh;
        return inputs.find(el => el !== seqInput && el.tagName === 'INPUT') || null;
    }

    // 受控输入框写入：多方法尝试 + 回读校验
    async function setControlledValue(el, value) {
        const text = String(value);
        if (!el) return false;

        const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

        // 方法一：原生 setter + input/change 事件
        try {
            el.focus();
            if (setNative) setNative.call(el, text); else el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { /* ignore */ }
        await delay(180);
        if (el.value === text) return true;

        // 方法二：直接调用 React 的 props.onChange
        const p = reactPropsOf(el);
        if (p && typeof p.onChange === 'function') {
            const calls = [
                () => p.onChange(text),
                () => p.onChange(text, { target: { value: text }, currentTarget: { value: text } }),
                () => p.onChange({ target: { value: text }, currentTarget: { value: text } })
            ];
            for (const fn of calls) {
                try { fn(); } catch (e) { /* 换签名 */ }
                await delay(180);
                if (el.value === text) return true;
            }
        }

        // 方法三：模拟输入
        try {
            el.focus();
            if (el.select) el.select();
            document.execCommand('insertText', false, text);
        } catch (e) { /* ignore */ }
        await delay(180);
        if (el.value === text) return true;

        log(`写入失败：期望 "${text}"，实际 "${el.value}"`, 'warning');
        return false;
    }

    function normalizeChapterTitle(chapter) {
        let t = (chapter.title || '').trim();
        t = t.replace(/^第\s*\d+\s*[章节回]\s*[:：]?\s*/, '').trim();
        if (!t) t = `第${chapter.number}章`;
        return t;
    }

    async function fillChapterInfo(chapter) {
        log(`填写章节信息: 第${chapter.number}章 ${chapter.title}`, 'info');

        await delay(1500);

        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea'))
            .filter(isUsableInput);

        const seqInput = findSequenceInput(inputs);
        const titleInput = findTitleInput(inputs, seqInput);

        // 1) 章节序号：只写数字
        if (seqInput) {
            log('检测到「章节序号」输入框，只写入数字', 'info');
            let ok = await setControlledValue(seqInput, String(chapter.number));
            if (!ok) {
                log('序号首次写入失败，重试', 'warning');
                ok = await setControlledValue(seqInput, String(chapter.number));
            }
            const val = (seqInput.value || '').trim();
            if (/^\d+$/.test(val)) {
                log(`章节序号填写成功: ${val}`, 'success');
            } else {
                log(`章节序号不是纯数字: "${val}"`, 'error');
            }
        } else {
            log('未检测到独立的章节序号输入框（旧版页面）', 'info');
        }

        // 2) 章节标题
        const titleText = seqInput
            ? normalizeChapterTitle(chapter)
            : `第${chapter.number}章 ${chapter.title}`;

        if (titleInput) {
            log(`填写章节标题: ${titleText}`, 'info');
            let ok = await setControlledValue(titleInput, titleText);
            if (!ok) {
                log('标题首次写入失败，重试', 'warning');
                ok = await setControlledValue(titleInput, titleText);
            }
            const actual = (titleInput.value || '').trim();
            if (actual) log(`章节标题当前值: ${actual.slice(0, 30)}`, 'success');
        } else {
            log('未找到章节标题输入框', 'error');
        }

        // 3) 番茄的校验提示
        await delay(300);
        const errEl = document.querySelector('.arco-message-error, .arco-message, .byte-message, .arco-notification');
        if (errEl && /序号|阿拉伯数字|标题/.test(errEl.textContent || '')) {
            log(`页面校验提示: ${(errEl.textContent || '').trim().slice(0, 40)}`, 'error');
        }

        // 4) 正文
        await fillChapterContent(chapter.content);
    }

    /*******************************
     * 设置输入框值并触发所有事件（对标代码方法）
     *******************************/
    async function setInputValueWithEvents(input, value) {
        if (!input) return false;
        
        try {
            // 聚焦元素
            input.focus();
            await delay(200);
            
            // 清空现有内容
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await delay(50);
            
            // 使用 nativeInputValueSetter 设置值（对标代码的方法）
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 
                'value'
            ).set;
            
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(input, value);
            } else {
                input.value = value;
            }
            
            // 触发完整的事件链（对标代码的方法）
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            // 失焦触发验证
            await delay(100);
            input.blur();
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            await delay(100);
            
            // 再次聚焦确保值被接受
            input.focus();
            
            log(`输入完成: ${value}`, 'success');
            return true;
            
        } catch (error) {
            log(`设置输入值失败: ${error.message}`, 'error');
            return false;
        }
    }

    /*******************************
     * 备用填写方法
     *******************************/
    async function fallbackFillTitle(input, text) {
        log('使用备用方法填写标题', 'info');
        
        try {
            // 方法1：使用execCommand（如果可用）
            if (document.execCommand && input.contentEditable !== 'true') {
                input.select();
                document.execCommand('insertText', false, text);
                await delay(300);
                return;
            }
            
            // 方法2：使用dispatchEvent的详细配置
            const inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                data: text,
                inputType: 'insertText',
                isComposing: false
            });
            
            input.value = text;
            input.dispatchEvent(inputEvent);
            await delay(300);
            
            // 方法3：触发所有可能的事件
            const events = ['keydown', 'keypress', 'keyup', 'input', 'change'];
            for (const eventType of events) {
                input.dispatchEvent(new Event(eventType, { bubbles: true }));
                await delay(50);
            }
            
        } catch (error) {
            log(`备用方法失败: ${error.message}`, 'error');
            
            // 最后尝试：直接设置值
            input.value = text;
            await delay(300);
        }
    }

    /*******************************
     * 填写章节标题（备用方法）
     *******************************/
    async function fillChapterTitleFallback(fullChapterTitle) {
        // 尝试通过页面结构查找输入框
        const containers = document.querySelectorAll('.publish-title-input, .chapter-title-input, .title-input, [class*="title"], [class*="chapter"]');
        
        for (const container of containers) {
            const inputs = container.querySelectorAll('input, textarea');
            if (inputs.length > 0) {
                const input = inputs[0];
                log(`通过容器类名找到章节标题输入框: ${container.className}`, 'info');
                
                input.value = fullChapterTitle;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                
                log(`章节标题已填写: ${fullChapterTitle}`, 'success');
                await delay(CONFIG.DELAY.INPUT);
                return;
            }
        }
        
        log('所有方法都无法找到章节标题输入框', 'error');
        throw new Error('无法找到章节标题输入框');
    }

    /*******************************
     * 填写章节内容
     *******************************/
    async function fillChapterContent(content) {
        // 查找编辑器
        let editor = document.querySelector('[contenteditable="true"]');
        
        if (!editor) {
            // 尝试查找文本区域
            editor = document.querySelector('textarea');
        }
        
        if (!editor) {
            // 尝试通过类名查找
            const editorClasses = ['.editor', '.content-editor', '.chapter-editor', '.publish-editor', '.arco-editor'];
            for (const className of editorClasses) {
                editor = document.querySelector(className);
                if (editor) break;
            }
        }
        
        if (editor) {
            log('找到编辑器，填写章节内容', 'info');
            
            // 清除现有内容（仅对内容编辑器进行清除）
            if (editor.contentEditable === 'true') {
                editor.innerHTML = '';
            } else {
                editor.value = '';
            }
            
            // 触发事件
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            await delay(500);
            
            // 填写内容
            if (editor.contentEditable === 'true') {
                // 富文本编辑器
                const paragraphs = content.split('\n')
                    .filter(p => p.trim())
                    .map(p => `<p>${p}</p>`)
                    .join('');
                editor.innerHTML = paragraphs;
            } else {
                // 普通文本区域
                editor.value = content;
            }
            
            // 触发事件
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            editor.dispatchEvent(new Event('blur', { bubbles: true }));
            
            log(`已填写内容，字数: ${countWords(content)}`, 'success');
            await delay(1500);
        } else {
            log('未找到编辑器，尝试备用方法', 'warning');
            
            // 备用方法：查找所有textarea和contenteditable元素
            const allEditors = document.querySelectorAll('textarea, [contenteditable="true"]');
            if (allEditors.length > 0) {
                const firstEditor = allEditors[0];
                log(`找到备用编辑器: ${firstEditor.tagName}`, 'info');
                
                if (firstEditor.tagName === 'TEXTAREA') {
                    firstEditor.value = content;
                } else {
                    firstEditor.innerHTML = content.split('\n')
                        .filter(p => p.trim())
                        .map(p => `<p>${p}</p>`)
                        .join('');
                }
                
                firstEditor.dispatchEvent(new Event('input', { bubbles: true }));
                firstEditor.dispatchEvent(new Event('change', { bubbles: true }));
                await delay(1500);
            } else {
                log('未找到任何编辑器', 'error');
            }
        }
    }

    /*******************************
     * 点击下一步按钮
     *******************************/
    async function clickNextButton() {
        // 查找下一步按钮
        let nextBtn = findButtonByText('下一步');
        
        if (!nextBtn) {
            // 尝试通过类名查找
            nextBtn = document.querySelector('.publish-next-btn, .next-btn, [class*="next"], .arco-btn-primary');
        }
        
        if (!nextBtn) {
            // 查找所有按钮
            const allBtns = document.querySelectorAll('button');
            for (const btn of allBtns) {
                if (btn.textContent.includes('下一步') && btn.offsetParent !== null) {
                    nextBtn = btn;
                    break;
                }
            }
        }
        
        if (nextBtn) {
            log('点击下一步按钮', 'info');
            nextBtn.click();
            await delay(CONFIG.DELAY.CLICK);
        } else {
            throw new Error('找不到下一步按钮');
        }
    }

    /*******************************
     * 检查章节连续性
     *******************************/
    async function checkChapterSequence(currentChapterNum) {
        const lastTitleEl = document.querySelector('.publish-maintain-info-lasttitle');
        if (!lastTitleEl) return true;

        const text = (lastTitleEl.textContent || '').trim();
        const match = text.match(/第(\d+)章/);
        if (!match) return true;

        const lastChapterNum = parseInt(match[1], 10);
        const expectedNum = lastChapterNum + 1;
        if (currentChapterNum === expectedNum) return true;

        log(`章节不连续：上一章是第${lastChapterNum}章，当前要发第${currentChapterNum}章（中间缺第${expectedNum}章）`, 'warning');

        const goOn = confirm(
            '章节不连续！\n\n' +
            `这本书上一章是「第${lastChapterNum}章」，\n` +
            `你现在要发「第${currentChapterNum}章」，中间缺了「第${expectedNum}章」。\n\n` +
            '点「确定」继续上传本章，点「取消」停止这一章。'
        );

        if (!goOn) {
            log('你选择了停止：章节不连续，本章不上传', 'error');
            return false;
        }
        log('你选择了继续上传不连续的章节', 'warning');
        return true;
    }

    /*******************************
     * 短故事：批量全自动
     *******************************/
    let shortStop = false;
    let shortRunning = false;

    function shortLog(msg, level) {
        const box = document.getElementById('short-log');
        if (box) {
            const time = new Date().toLocaleTimeString();
            box.textContent += '[' + time + '] ' + msg + '\n';
            box.scrollTop = box.scrollHeight;
        }
        log('[短篇] ' + msg, level || 'info');
    }

    // 解析批量文本： 标题行 + 正文，篇与篇之间用 === 分隔
    function parseShortBatch(text) {
        const raw = String(text || '');
        let blocks;

        // 有 === 就按 === 切；没有的话，按「标题：」开头切成多条
        if (/^\s*={3,}\s*$/m.test(raw)) {
            blocks = raw.split(/^\s*={3,}\s*$/m);
        } else {
            const lines = raw.split(/\r?\n/);
            const idxs = [];
            lines.forEach((l, i) => { if (/^\s*标题[:：]/.test(l)) idxs.push(i); });
            if (idxs.length <= 1) {
                blocks = [raw];
            } else {
                blocks = idxs.map((start, k) => lines.slice(start, idxs[k + 1] === undefined ? lines.length : idxs[k + 1]).join('\n'));
            }
        }

        const out = [];
        for (const block of blocks) {
            const lines = block.split(/\r?\n/);
            while (lines.length && !lines[0].trim()) lines.shift();
            if (!lines.length) continue;

            const title = lines[0].trim().replace(/^标题[:：]\s*/, '').slice(0, 60);
            const body = lines.slice(1).join('\n').trim();
            if (!title) continue;
            out.push({ title, body, selected: true });
        }
        return out;
    }

    function shortEsc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    let shortItems = [];

    function renderShortList() {
        const box = document.getElementById('short-list');
        const cnt = document.getElementById('short-count');
        const picked = document.getElementById('short-picked');
        const totalEl = document.getElementById('short-total');
        if (cnt) cnt.textContent = shortItems.length;
        const sel = shortItems.filter(x => x.selected).length;
        if (picked) picked.textContent = sel;
        if (totalEl) totalEl.textContent = sel;
        if (!box) return;

        if (!shortItems.length) {
            box.innerHTML = '<div style="font-size:11px;color:#bbb;text-align:center;padding:10px;">粘贴内容后这里会列出识别到的每一篇</div>';
            return;
        }

        box.innerHTML = shortItems.map((it, i) => {
            const len = it.body.replace(/\s+/g, '').length;
            return '<div class="short-row" style="display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px solid #f2f5f9;">' +
                '<input type="checkbox" data-i="' + i + '" ' + (it.selected ? 'checked' : '') + ' style="margin-top:3px;flex:0 0 auto;">' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:12.5px;font-weight:600;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + shortEsc(it.title) + '</div>' +
                '<div style="font-size:11px;color:#8c8c8c;margin-top:2px;">' + len + ' 字</div>' +
                '</div></div>';
        }).join('');

        box.querySelectorAll('input[type="checkbox"]').forEach((el) => {
            el.addEventListener('change', () => {
                const i = Number(el.dataset.i);
                if (shortItems[i]) shortItems[i].selected = el.checked;
                renderShortList();
            });
        });
    }

    function inputByLabel(keyword) {
        const labels = Array.from(document.querySelectorAll('label, div, span'))
            .filter(el => {
                const txt = (el.textContent || '').trim();
                return txt.length > 0 && txt.length <= 12 && txt.includes(keyword);
            });
        for (const lab of labels) {
            let node = lab.parentElement;
            let depth = 0;
            while (node && depth < 4) {
                const inp = node.querySelector('input[type="text"], input:not([type]), textarea');
                if (inp && inp.offsetParent !== null) return inp;
                node = node.parentElement;
                depth++;
            }
        }
        return null;
    }

    function visibleEditors() {
        return Array.from(document.querySelectorAll('.ProseMirror, .ql-editor, [contenteditable="true"], textarea'))
            .filter(el => el.offsetParent !== null);
    }

    // 找「创建短故事 / 新建短故事 / 创建作品」入口
    function findCreateEntry() {
        const words = ['创建短故事', '新建短故事', '发布短故事', '创作短篇', '新建作品', '创建作品'];
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
        for (const w of words) {
            const hit = nodes.find(el =>
                el.offsetParent !== null &&
                (el.textContent || '').trim().replace(/\s+/g, '') === w
            );
            if (hit) return hit;
        }
        return null;
    }

    async function fillOneShort(item, doPublish) {
        // 标题
        const titleEl = inputByLabel('标题') ||
            document.querySelector('input[placeholder*="标题"], input[maxlength="60"]');
        if (!titleEl) { shortLog('没找到标题输入框（可能不在创建页）', 'error'); return false; }
        await setControlledValue(titleEl, item.title);
        shortLog('标题：' + item.title);
        await delay(400);

        // 正文
        const editors = visibleEditors();
        const bodyEl = editors.find(el => /ProseMirror|ql-editor/.test(el.className || '')) || editors[0];
        if (!bodyEl) { shortLog('没找到正文编辑器', 'error'); return false; }

        if (bodyEl.tagName === 'TEXTAREA') {
            await setControlledValue(bodyEl, item.body);
        } else {
            bodyEl.focus();
            bodyEl.innerHTML = '';
            item.body.split(/\n+/).forEach((para) => {
                const pEl = document.createElement('p');
                pEl.textContent = para;
                bodyEl.appendChild(pEl);
            });
            bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        shortLog('正文：' + item.body.replace(/\s+/g, '').length + ' 字');
        await delay(600);

        // AI → 否
        const noLab = Array.from(document.querySelectorAll('label, span, div'))
            .find(el => (el.textContent || '').trim() === '否' && el.offsetParent !== null);
        if (noLab) { noLab.click(); await delay(300); shortLog('AI：否'); }

        // 试读比例
        const trial = ((document.getElementById('short-trial') || {}).value || '0');
        if (trial !== '0') {
            const goBtn = Array.from(document.querySelectorAll('button, span, div'))
                .find(el => (el.textContent || '').trim() === '去设置' && el.offsetParent !== null);
            if (goBtn) {
                goBtn.click();
                await delay(800);
                const opt = Array.from(document.querySelectorAll('button, li, .arco-radio, .arco-select-option, span'))
                    .find(el => (el.textContent || '').trim() === trial + '%');
                if (opt) {
                    opt.click();
                    await delay(300);
                    const ok = findButtonByText('确定') || findButtonByText('保存');
                    if (ok) { ok.click(); await delay(400); }
                    shortLog('试读比例：' + trial + '%');
                } else {
                    shortLog('试读比例没找到 ' + trial + '% 档位，跳过', 'warning');
                }
            }
        }

        // 发布协议：自动勾（不再让用户点）
        const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(el => el.offsetParent !== null);
        const agree = boxes[boxes.length - 1];
        if (agree && !agree.checked) {
            agree.click();
            await delay(250);
            shortLog('已自动勾选发布协议');
        }

        // 下一步
        const next = findButtonByText('下一步') || findButtonByText('提交');
        if (!next) { shortLog('没找到「下一步」', 'error'); return false; }
        next.click();
        shortLog('下一步');
        await delay(1800);

        const pub = findButtonByText('继续发布') || findButtonByText('发布') || findButtonByText('确认发布');
        if (!pub) { shortLog('没找到「发布」按钮', 'error'); return false; }

        if (!doPublish) { shortLog('只填写模式，停在发布前', 'success'); return true; }

        pub.click();
        shortLog('已点发布');
        await delay(1500);

        const sure = findButtonByText('确认') || findButtonByText('确定');
        if (sure) { sure.click(); shortLog('已确认'); }
        await delay(1500);
        return true;
    }

    async function runShortBatch() {
        if (shortRunning) { shortLog('已经在跑了', 'warning'); return; }
        const box = document.getElementById('short-batch');
        if (box) shortItems = parseShortBatch(box.value);

        const items = shortItems.filter(x => x.selected);
        if (!items.length) {
            shortLog('没有勾选要发布的篇目（勾上左边的小方框）', 'error');
            return;
        }

        if (!confirm('将连续发布 ' + items.length + ' 篇短故事，确定开始？')) return;

        shortRunning = true;
        shortStop = false;
        let okCount = 0;
        const failed = [];

        for (let i = 0; i < items.length; i++) {
            if (shortStop) { shortLog('已停止，剩余 ' + (items.length - i) + ' 篇未发', 'warning'); break; }
            const item = items[i];
            shortLog(`—— 第 ${i + 1}/${items.length} 篇：${item.title}`);

            // 不在创建页就先点「创建短故事」
            if (!inputByLabel('标题')) {
                const entry = findCreateEntry();
                if (entry) {
                    entry.click();
                    shortLog('点了「创建短故事」，等待页面…');
                    await delay(2500);
                } else {
                    shortLog('找不到「创建短故事」入口，请先手动打开创建页再点开始', 'error');
                    break;
                }
            }

            const ok = await fillOneShort(item, true);
            if (ok) { okCount++; } else { failed.push(item.title); }

            // 回列表，准备下一篇
            await delay(1200);
        }

        shortRunning = false;
        shortLog(`完成：成功 ${okCount} 篇` + (failed.length ? `，失败 ${failed.length} 篇（${failed.join('、')}）` : ''), failed.length ? 'warning' : 'success');
    }

    /*******************************
     * 处理所有弹窗
     *******************************/
    async function handleAllDialogs() {
        for (let i = 0; i < 10; i++) {
            await delay(500);
            
            let dialogHandled = false;
            
            // 1. 处理"我知道了"弹窗
            const knowBtn = findButtonByText('我知道了');
            if (knowBtn && knowBtn.offsetParent !== null) {
                log('关闭"我知道了"弹窗', 'info');
                knowBtn.click();
                dialogHandled = true;
                await delay(300);
            }
            
            // 2. 处理风险提示弹窗
            const riskDialog = findRiskDialog();
            if (riskDialog) {
                log('找到风险提示弹窗', 'info');
                await handleRiskDialog(riskDialog);
                dialogHandled = true;
                await delay(500);
            }
            
            // 3. 处理新手引导
            const guideBtn = document.querySelector('[id*="reactour"] button');
            if (guideBtn && guideBtn.textContent.includes('下一步')) {
                log('处理新手引导', 'info');
                guideBtn.click();
                dialogHandled = true;
                await delay(300);
            }
            
            // 4. 处理错别字相关弹窗（提交确认框 / 检测结果框，两类都要处理，避免卡死）
            if (await handleTypoDialogs()) {
                dialogHandled = true;
            }
            
            if (!dialogHandled) {
                break;
            }
        }
    }

    /*******************************
     * 暂停 / 继续
     *******************************/
    let isPaused = false;
    // 「取消本次」用的中止标志：置位后各检查点直接退出，不再继续下一章
    let stopRequested = false;
    let resumeWaiters = [];
    // 用户点了「继续发布」→ 本章后续违规提示全部无视，不再暂停
    let chapterViolationBypass = false;

    function updatePauseButton() {
        const btn = document.getElementById('pause-upload');
        if (!btn) return;
        btn.textContent = isPaused ? '继续' : '暂停';
        btn.style.background = isPaused ? '#faad14' : '';
        btn.style.color = isPaused ? '#fff' : '';
    }

    // 把"暂停/继续"回报给任务面板，卡片上的按钮才能跟着变
    function reportTaskPauseState() {
        try {
            const tid = String((uploadState && uploadState.taskId) || activeTaskId || '');
            if (tid && window.__xbuTaskStatus) {
                window.__xbuTaskStatus(tid, isPaused ? 'paused' : 'running');
            }
        } catch (e) { /* ignore */ }
    }

    function pauseAutomation(reason) {
        if (isPaused) return;
        isPaused = true;
        // 面板按钮和悬浮条按钮都要同步，避免两处状态显示不一致
        try { updatePauseButton(); } catch (e) { /* ignore */ }
        try { syncPauseBtn(); } catch (e) { /* ignore */ }
        log(`已暂停${reason ? '：' + reason : ''}，点「继续」恢复`, 'warning');
        reportTaskPauseState();
    }

    function resumeAutomation() {
        if (!isPaused) return;
        isPaused = false;
        try { updatePauseButton(); } catch (e) { /* ignore */ }
        try { syncPauseBtn(); } catch (e) { /* ignore */ }
        // 关键：必须唤醒 waitWhilePaused() 里等待的 Promise，否则半自动 /
        // 违规暂停后流程会永久卡住（旧代码只在面板按钮里调本函数，悬浮条
        // 的「继续」直接改 isPaused，等待者永远收不到通知）。
        const waiters = resumeWaiters;
        resumeWaiters = [];
        waiters.forEach(fn => fn());
        log('已继续执行', 'success');
        reportTaskPauseState();
    }

    // 给任务面板用的外部开关（跨页面跳转也有效：init 会按任务状态重新暂停）
    window.__xbuSetPaused = function (paused) {
        try {
            // active：页面上还有没有正在跑的发布流程（程序重启过就会没有）
            const st = uploadState || null;
            const active = !!(st && st.isUploading);
            if (!paused && !active) {
                // 没有活跃流程时别把状态改成"发布中"误导用户
                return { ok: true, paused: false, active: false };
            }
            if (paused) pauseAutomation('任务面板暂停');
            else resumeAutomation();
            return { ok: true, paused: isPaused, active: active };
        } catch (e) {
            return { ok: false, reason: String((e && e.message) || e) };
        }
    };
    window.__xbuIsPaused = function () { return isPaused; };

    // 取消本次发布：立刻中止这一批（已发出去的章节不受影响），
    // 并清掉断点续传状态——否则下次打开页面还会"接着发旧的那批"，
    // 用户换上新章节也发不了新内容。
    window.__xbuCancelTask = function () {
        try {
            const tid = String((uploadState && uploadState.taskId) || activeTaskId || '');
            stopRequested = true;
            isUploading = false;
            isPaused = false;
            uploadState = null;
            clearUploadState();
            // 暂停中取消：必须唤醒 waitWhilePaused 的等待者，否则流程永远卡在那
            const waiters = resumeWaiters;
            resumeWaiters = [];
            waiters.forEach(fn => fn());
            try { updatePauseButton(); } catch (e) { /* ignore */ }
            try { syncPauseBtn(); } catch (e) { /* ignore */ }
            try { hideUploadNotice(); } catch (e) { /* ignore */ }
            try { hideViolationBanner(); } catch (e) { /* ignore */ }
            const sec = document.getElementById('progress-section');
            if (sec) sec.classList.add('hidden');
            const pv = document.getElementById('preview-section');
            if (pv) pv.classList.remove('hidden');
            log('已取消本次发布（已发出的章节不受影响）', 'warning');
            if (tid && window.__xbuTaskStatus) window.__xbuTaskStatus(tid, 'idle');
            return { ok: true, taskId: tid };
        } catch (e) {
            return { ok: false, reason: String((e && e.message) || e) };
        }
    };

    async function waitWhilePaused() {
        // 暂停期间也继续处理错别字/确认提交弹窗，避免弹窗堆着没人点
        while (isPaused) {
            try { await handleTypoDialogs(); } catch (e) { /* ignore */ }
            await Promise.race([
                new Promise(resolve => resumeWaiters.push(resolve)),
                new Promise(resolve => setTimeout(resolve, 1500))
            ]);
        }
    }

    /*******************************
     * 违规 / 色情拦截处理
     *******************************/
    // 只认真正的违规拦截措辞；错别字、校验提醒等一律不算
    const VIOLATION_RE = /(色情|低俗|涉黄|涉政|违规内容|内容违规|不符合.{0,6}规范|不良信息|敏感内容|含有违规)/;
    // 明确排除：错别字提示、字数提示、保存提示等普通弹窗
    const NOT_VIOLATION_RE = /(错别字|错字|字数|保存|自动保存|请选择|确认删除|网络|超时)/;

    function findViolationDialog() {
        const nodes = document.querySelectorAll('.arco-modal, .arco-modal-wrapper, .ant-modal, .modal, [role="dialog"]');
        for (const el of nodes) {
            if (el.offsetParent === null) continue;
            const txt = el.textContent || '';
            if (txt.length > 600) continue;
            if (!VIOLATION_RE.test(txt)) continue;
            // 错别字 / 字数 / 保存 这类提示不是违规拦截，直接跳过
            if (NOT_VIOLATION_RE.test(txt)) continue;
            // 排除我们自己画的面板 / 横幅
            if (el.closest('#novel-upload-panel') || el.closest('#violation-banner')) continue;
            // 排除发布确认框（里面也可能提到“违规风险”等字样）
            if (el.classList.contains('publish-confirm-container-new')) continue;
            if (el.querySelector('.publish-confirm-container-new')) continue;
            if (/发布设置|定时发布|确认发布/.test(txt)) continue;
            return el;
        }
        return null;
    }

    function findButtonIn(root, texts) {
        const btns = Array.from(root.querySelectorAll('button, .arco-btn, a[role="button"]'));
        for (const want of texts) {
            const hit = btns.find(b => (b.textContent || '').trim() === want && b.offsetParent !== null);
            if (hit) return hit;
        }
        for (const want of texts) {
            const hit = btns.find(b => (b.textContent || '').includes(want) && b.offsetParent !== null);
            if (hit) return hit;
        }
        return null;
    }

    // 取当前可见的弹窗节点（番茄用 arco 的 .arco-modal，也可能包在 wrapper 里）
    function visibleModals() {
        const nodes = Array.from(document.querySelectorAll('.arco-modal, .ant-modal, [role="dialog"]'));
        return nodes.filter(n => n.offsetParent !== null);
    }

    // 关闭弹窗的兜底手段：右上角 ×（arco 的关闭图标）
    function closeModalByIcon(root) {
        const icon = root.querySelector('.arco-modal-close-icon, .arco-modal-close, [aria-label="Close"], .ant-modal-close');
        if (icon && icon.offsetParent !== null) {
            icon.click();
            return true;
        }
        // 有些弹窗把关闭图标放在 wrapper 上
        const wrap = root.closest('.arco-modal-wrapper') || root.parentElement;
        if (wrap) {
            const icon2 = wrap.querySelector('.arco-modal-close-icon, [aria-label="Close"]');
            if (icon2 && icon2.offsetParent !== null) { icon2.click(); return true; }
        }
        return false;
    }

    /*******************************
     * 处理番茄的"错别字"相关弹窗（这是发布卡死的常见原因）
     *
     * 番茄其实会弹两类错别字框，必须分开处理：
     *   A) 确认提交框："检测到你还有错别字未修改，是否确定提交" → 按钮【提交】
     *   B) 检测结果框：列出错别字 + 【重新检测】，或提示有错别字要看详情 → 需要【取消/知道了/关闭】或点 × 关掉
     *
     * 旧代码只认 A 且只会全局 findButtonByText('提交')，遇到 B（没有"提交"按钮）
     * 时什么都不点，弹窗一直开着，整条流程卡死。本函数两类都处理。
     * 返回 true 表示处理过至少一个弹窗。
     *******************************/
    async function handleTypoDialogs() {
        let handled = false;
        // 已经点过的弹窗节点不再重复处理：番茄关框常有动画延迟，
        // 节点短时间内还在 DOM 里，不记录会导致同一按钮被连点多次。
        const seen = new WeakSet();
        // 弹窗可能连弹，最多处理 4 轮
        for (let round = 0; round < 4; round++) {
            let didSomething = false;

            for (const modal of visibleModals()) {
                if (seen.has(modal)) continue;
                const text = (modal.textContent || '').replace(/\s+/g, '');
                const isTypoRelated = /错别字|错字|纠错|校对/.test(text);
                if (!isTypoRelated) continue;

                // 排除发布确认框/定时框：那些也含"发布"字样，不能当错别字框关掉
                if (/发布设置|定时发布|确认发布信息/.test(text) && !/错别字/.test(text)) continue;

                const isSubmitConfirm = /是否确定提交|是否确认提交|仍要提交|错别字未修改/.test(text);

                if (isSubmitConfirm) {
                    // A 类：确认提交框 → 先点"提交"继续发
                    const submitBtn = findButtonIn(modal, ['提交', '确认提交', '继续提交', '仍然提交', '确定']);
                    if (submitBtn) {
                        log('错别字确认框：点"提交"继续发布', 'info');
                        seen.add(modal);
                        submitBtn.click();
                        didSomething = handled = true;
                        await delay(900);
                        break;
                    }
                    // 找不到"提交"就点"取消"退回，别卡住
                    const backBtn = findButtonIn(modal, ['取消', '返回修改', '返回']);
                    if (backBtn) {
                        log('错别字确认框：没找到提交，点"取消"退回', 'warning');
                        seen.add(modal);
                        backBtn.click();
                        didSomething = handled = true;
                        await delay(800);
                        break;
                    }
                }

                // B 类：检测结果/提示框 → 点"取消/知道了/关闭"或右上角 × 关掉它
                const dismissBtn = findButtonIn(modal, ['取消', '知道了', '我知道了', '关闭', '返回修改', '稍后再说']);
                if (dismissBtn) {
                    log('错别字检测框：点"' + dismissBtn.textContent.trim() + '"关闭', 'info');
                    seen.add(modal);
                    dismissBtn.click();
                    didSomething = handled = true;
                    await delay(700);
                    break;
                }
                if (closeModalByIcon(modal)) {
                    log('错别字检测框：点右上角×关闭', 'info');
                    seen.add(modal);
                    didSomething = handled = true;
                    await delay(700);
                    break;
                }
            }

            if (!didSomething) break;
        }
        return handled;
    }

    function showViolationBanner(text) {
        let el = document.getElementById('violation-banner');
        if (el) el.remove();

        el = document.createElement('div');
        el.id = 'violation-banner';
        el.style.cssText = [
            'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
            'z-index:10002', 'background:#fffbe6', 'border:1px solid #ffe58f', 'color:#874d00',
            'padding:12px 18px', 'border-radius:8px', 'box-shadow:0 4px 16px rgba(0,0,0,.18)',
            'font-size:13px', 'line-height:1.7', 'max-width:82vw'
        ].join(';');

        el.innerHTML = '<b>⚠ 检测到违规/色情拦截，已暂停</b><br>' +
            '请在该章节里修改内容，改完点下面的「继续发布」。<br>' +
            (text ? `<span style="color:#8c8c8c;font-size:12px;">${text}</span><br>` : '');

        const row = document.createElement('div');
        row.style.cssText = 'margin-top:8px;display:flex;gap:8px;';

        const go = document.createElement('button');
        go.textContent = '继续发布';
        go.style.cssText = 'padding:6px 14px;border:none;border-radius:6px;background:#1890ff;color:#fff;cursor:pointer;font-size:13px;';
        go.onclick = () => {
            chapterViolationBypass = true;
            log('已选择继续：本章后续违规提示将全部无视', 'warning');
            hideViolationBanner();
            resumeAutomation();
        };
        row.appendChild(go);

        const stop = document.createElement('button');
        stop.textContent = '停止本批';
        stop.style.cssText = 'padding:6px 14px;border:1px solid #ffccc7;border-radius:6px;background:#fff2f0;color:#cf1322;cursor:pointer;font-size:13px;';
        stop.onclick = () => {
            hideViolationBanner();
            clearUploadState();
            isPaused = false;
            updatePauseButton();
            log('用户选择停止本批上传', 'warning');
        };
        row.appendChild(stop);

        el.appendChild(row);
        document.body.appendChild(el);
    }

    function hideViolationBanner() {
        const el = document.getElementById('violation-banner');
        if (el) el.remove();
    }

    // 返回 true 表示可以继续；false 表示用户中止
    async function handleViolationDialog(dialog, settings) {
        const ignore = !!(settings && settings.ignoreViolation) || chapterViolationBypass;
        const snippet = (dialog ? (dialog.textContent || '') : '').replace(/\s+/g, ' ').trim().slice(0, 80);
        log(`检测到违规拦截${snippet ? '：' + snippet : ''}`, 'warning');

        if (ignore) {
            log(chapterViolationBypass && !(settings && settings.ignoreViolation)
                ? '本章已选择「继续发布」，自动无视违规提示'
                : '已勾选「无视违规提示」，自动继续提交', 'info');
            const btn = dialog ? findButtonIn(dialog, ['继续提交', '仍然提交', '继续发布', '继续', '确认', '确定', '我知道了', '下一步']) : null;
            if (btn) {
                btn.click();
                await delay(800);
            }
            try {
                await clickNextButton();
                log('已重新点击「下一步」', 'success');
            } catch (e) {
                log(`重新点击「下一步」失败: ${e.message}`, 'error');
            }
            return true;
        }

        log('自动流程已暂停，请修改章节内容后点「继续发布」', 'warning');
        showViolationBanner(snippet);
        if (settings.mode !== 'semi') {
            log('违规拦截：全自动模式不暂停，尝试继续提交', 'warning');
        } else {
            pauseAutomation('违规拦截');
        }
        await waitWhilePaused();
        hideViolationBanner();
        // 用户是直接取消掉这一批的，别再去点「下一步」
        if (stopRequested) return true;

        // 用户点「继续发布」后，重新走一次「下一步」
        try {
            await clickNextButton();
            log('已按用户操作重新点击「下一步」', 'success');
        } catch (e) {
            log(`重新点击「下一步」失败: ${e.message}`, 'error');
        }
        return true;
    }

    /*******************************
     * 查找风险提示弹窗
     *******************************/
    let riskTries = 0;

    /*******************************
     * 番茄的「确认发布当前内容?」确认层
     *   文案：格式异常、风险提示内容未完全修改，请确认是否发布当前内容?
     *   按钮：【取消】/【确认发布】
     *
     * 这既不是发布设置框，也不是风险拦截框，纯粹是个确认层：
     *   点「确认发布」才会继续发，点「取消」等于放弃本章。
     * 旧逻辑把它当成风险弹窗，找按钮失败后就一直转圈——整批卡死在这里。
     *******************************/
    function findPublishConfirmDialog() {
        // 番茄不同版本用的容器类名不一样，别只认 arco-modal
        const nodes = document.querySelectorAll('.arco-modal, .ant-modal, [role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"]');
        for (const el of nodes) {
            if (el.offsetParent === null) continue;
            if (el.closest('#novel-upload-panel') || el.closest('#violation-banner')) continue;
            const t = (el.textContent || '').replace(/\s+/g, '');
            if (t.length > 400) continue;
            if (!/确认发布当前内容|格式异常|风险提示内容未完全修改/.test(t)) continue;
            // 排除小碎片（按钮/标签之类），真正的确认层有卡片那么大
            const r = el.getBoundingClientRect();
            if (r.width < 200 || r.height < 80) continue;
            return el;
        }
        return null;
    }

    // 真实的点击序列（React 的按钮有时不认单纯的 el.click()）
    function fullClick(el) {
        try {
            const r = el.getBoundingClientRect();
            const opt = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                let ev;
                if (type.indexOf('pointer') === 0 && window.PointerEvent) ev = new PointerEvent(type, opt);
                else ev = new MouseEvent(type, opt);
                el.dispatchEvent(ev);
            }
            return true;
        } catch (e) {
            try { el.click(); return true; } catch (e2) { return false; }
        }
    }

    // 在确认框里找「确认发布」并点掉；返回点到的按钮文字（找不到返回 null）
    function clickPublishConfirm(modal) {
        const norm = (s) => String(s || '').replace(/[\s\u00a0]+/g, '');
        const nodes = Array.from(modal.querySelectorAll('button, [role="button"], .arco-btn, a, span, div'))
            .filter(el => el.offsetParent !== null && el.childElementCount === 0 && norm(el.textContent).length <= 6);

        const want = ['确认发布', '仍然发布', '继续发布', '确定发布', '发布', '确认', '确定'];
        for (const w of want) {
            const hit = nodes.find(el => norm(el.textContent) === w);
            if (hit) { fullClick(hit); return { text: norm(hit.textContent), tag: hit.tagName }; }
        }
        // 主按钮兜底（番茄的橙色按钮就是 arco-btn-primary）
        const primary = modal.querySelector('.arco-btn-primary, .ant-btn-primary, .confirm-btn, button[type="submit"]');
        if (primary) { fullClick(primary); return { text: norm(primary.textContent).slice(0, 8) || '(主按钮)', tag: primary.tagName }; }

        // 最后一招：番茄的确认按钮一般是最右边那个（取消在左、确认在右）
        const btns = Array.from(modal.querySelectorAll('button')).filter(b => b.offsetParent !== null);
        if (btns.length) {
            const last = btns[btns.length - 1];
            if (!/取消|关闭|返回/.test(norm(last.textContent))) {
                fullClick(last);
                return { text: norm(last.textContent).slice(0, 8) || '(最右按钮)', tag: last.tagName };
            }
        }
        return null;
    }

    function findRiskDialog() {
        // 查找包含风险提示的弹窗
        const modals = document.querySelectorAll('.arco-modal, .ant-modal, .modal');
        
        for (const modal of modals) {
            const text = modal.textContent || '';
            // 「确认发布当前内容?」不是风险拦截框，交给 findPublishConfirmDialog 处理
            if (/确认发布当前内容|格式异常/.test(text)) continue;
            if (text.includes('风险') || text.includes('违规') || text.includes('违反') || text.includes('警告')) {
                return modal;
            }
        }
        
        return null;
    }

    /*******************************
     * 处理风险提示弹窗
     *******************************/
    async function handleRiskDialog(modal) {
        try {
            // 查找确定/同意/继续按钮
            let confirmBtn = null;
            
            // 尝试不同可能的按钮文本
            const possibleTexts = ['确定', '同意', '继续', '我知道了', '确认', '好的', '了解'];
            
            for (const text of possibleTexts) {
                const btn = findButtonByText(text);
                if (btn && modal.contains(btn)) {
                    confirmBtn = btn;
                    break;
                }
            }
            
            // 如果没找到，尝试查找主要按钮
            if (!confirmBtn) {
                const primaryBtn = modal.querySelector('.arco-btn-primary, .ant-btn-primary, .btn-primary, .confirm-btn');
                if (primaryBtn) {
                    confirmBtn = primaryBtn;
                }
            }
            
            if (confirmBtn) {
                log('点击风险提示弹窗确认按钮', 'info');
                confirmBtn.click();
                await delay(1000);
                
                // 检查是否还有风险提示
                const newRiskDialog = findRiskDialog();
                if (newRiskDialog) {
                    log('仍有风险提示，再次处理', 'info');
                    await handleRiskDialog(newRiskDialog);
                }
                return true;
            } else {
                log('未找到风险提示弹窗的确认按钮', 'warning');
                return false;
            }
        } catch (error) {
            log(`处理风险提示弹窗失败: ${error.message}`, 'error');
            return false;
        }
    }

    /*******************************
     * 处理发布对话框（修复定时上传问题）
     *******************************/
    /* 点完「下一步」后等发布框；如果没出来（常见于风险提示拦着），就再点一次 */
    async function waitPublishDialogOrRetry(maxRetry) {
        const tries = Number(maxRetry) || 3;
        for (let i = 0; i < tries; i++) {
            for (let w = 0; w < 8; w++) {
                await delay(500);
                if (document.querySelector('.arco-modal.publish-confirm-container-new, .arco-modal')) {
                    return true;
                }
            }
            log('发布框没出现，重新点一次「下一步」（第 ' + (i + 1) + ' 次）', 'warning');
            try { await clickNextButton(); } catch (e) { /* ignore */ }
            await delay(1200);
        }
        return false;
    }

    async function handlePublishDialog(state) {
        const { settings, chapters, currentIndex } = state;
        const maxAttempts = 30;
        
        for (let i = 0; i < maxAttempts; i++) {
            await delay(500);

            // 暂停闸
            await waitWhilePaused();
            // 暂停期间被「取消本次」：立刻退出，绝不能再点发布
            if (stopRequested) return false;
            if (i === 0) riskTries = 0;

            // 「确认发布当前内容?」确认层：先点掉它，否则整批卡在这里
            // （它里面有"风险"字样，会被 findRiskDialog 误认，所以必须排在前面处理）
            const pubConfirm = findPublishConfirmDialog();
            if (pubConfirm) {
                const hit = clickPublishConfirm(pubConfirm);
                window.__pubConfirmHits = (window.__pubConfirmHits || 0) + 1;
                if (hit) {
                    log('「确认发布当前内容」弹窗：点了「' + hit.text + '」继续发布（第 ' + window.__pubConfirmHits + ' 次）', 'warning');
                } else {
                    log('「确认发布当前内容」弹窗里没找到确认按钮，按钮文字=' + JSON.stringify(Array.from(pubConfirm.querySelectorAll('button')).map(b => (b.textContent || '').trim())), 'error');
                }
                if (window.__pubConfirmHits > 6) {
                    window.__pubConfirmHits = 0;
                    log('确认框连续出现 6 次仍发不出去，跳过本章', 'error');
                    return false;
                }
                await delay(1500);
                continue;
            }

            // 违规/色情拦截：统一走横幅暂停流程，不再用 alert + continue。
            // 旧代码不勾「无视」时只弹 alert 就 continue，违规框仍开着，
            // 下一轮又会 alert，形成无限弹窗；而且和说明里「弹横幅、点继续发布」
            // 的行为对不上。handleViolationDialog 会关框/等待/重试下一步。
            const violation = findViolationDialog();
            if (violation) {
                await handleViolationDialog(violation, settings);
                await delay(800);
                continue;
            }
            
            // 检查是否已跳转
            if (window.location.href.includes('chapter-manage')) {
                log('已跳转到章节管理页面', 'success');
                return true;
            }
            
            // 再次检查风险提示
            const riskDialog = findRiskDialog();
            if (riskDialog) {
                riskTries++;

                // 全自动模式：不暂停，继续点确认并往下走（最多 8 次，之后跳过本章）
                if (settings.mode !== 'semi') {
                    if (riskTries > 8) {
                        log('风险提示重复出现 8 次，跳过本章', 'error');
                        riskTries = 0;
                        return false;
                    }
                    log('风险提示第 ' + riskTries + ' 次，继续点确认（全自动不暂停）', 'warning');
                } else if (riskTries > 3) {
                    log('风险提示连续出现，已暂停等你处理', 'error');
                    isPaused = true;
                    try { syncPauseBtn(); } catch (e) { /* ignore */ }
                    alert('这一章多次被判定有风险。\n\n请手动修改或删除敏感段落，\n然后点悬浮条「继续」。');
                    riskTries = 0;
                    await waitWhilePaused();
                    continue;
                }
                log('发布前发现风险提示弹窗（第 ' + riskTries + ' 次）', 'info');
                await handleRiskDialog(riskDialog);

                // 勾了「无视违规提示」：关掉提示后直接点下一步继续提交
                if (settings.ignoreViolation) {
                    await delay(600);
                    // 更稳地找「下一步」：按钮文字包含即可，优先可见的
                    const allBtns = Array.from(document.querySelectorAll('button, [role="button"], a'));
                    const nextBtn = allBtns.find(b => {
                        const t2 = (b.textContent || '').replace(/\s+/g, '');
                        return b.offsetParent !== null && /下一步|继续提交/.test(t2);
                    });
                    if (nextBtn) {
                        log('无视提示，已点右上角「下一步」', 'warning');
                        nextBtn.click();
                        await delay(1800);
                    } else {
                        log('没找到右上角「下一步」按钮，请手动点一下', 'error');
                    }
                }
                continue;
            }
            
            // 处理错别字相关弹窗（提交确认框点提交；检测结果框点取消/×关闭，避免卡死）
            if (await handleTypoDialogs()) {
                await delay(500);
                continue;
            }
            
            // 查找发布对话框
            const dialog = document.querySelector('.arco-modal.publish-confirm-container-new, .arco-modal, .ant-modal');
            // 同一个发布框反复出现说明点不出去，计数兜底，避免无限刷日志
            if (dialog) {
                window.__dlgHits = (window.__dlgHits || 0) + 1;
                if (window.__dlgHits > 25) {
                    window.__dlgHits = 0;
                    log('发布框反复出现 25 次仍未发出，已停止本批', 'error');
                    return false;
                }
            }
            if (dialog && (dialog.textContent.includes('发布') || dialog.textContent.includes('定时') || dialog.querySelector('.publish-confirm-container-new'))) {
                log('找到发布对话框', 'info');
                
                // 设置AI选项（如果存在）
                const aiRadios = dialog.querySelectorAll('input[type="radio"][value="1"], input[type="radio"][value="2"]');
                if (aiRadios.length > 0) {
                    // 默认选择不开启AI
                    for (const radio of aiRadios) {
                        if (radio.value === '2' && !radio.checked) {
                            log('设置AI选项: 关闭', 'info');
                            radio.click();
                            await delay(300);
                            break;
                        }
                    }
                }
                
                // 设置定时发布（v2.4.1：写 React 状态 + 回读校验）
                if (settings.timedPublish && settings.startDate && settings.startTime) {
                    log('设置定时发布', 'info');

                    const switchBtn = dialog.querySelector('.arco-switch, .ant-switch, [role="switch"]');
                    if (switchBtn) {
                        const isChecked = switchBtn.classList.contains('arco-switch-checked') ||
                                         switchBtn.classList.contains('ant-switch-checked') ||
                                         switchBtn.getAttribute('aria-checked') === 'true';
                        if (!isChecked) {
                            log('开启定时发布开关', 'info');
                            switchBtn.click();
                            await delay(1500);
                        }
                        await delay(1000);
                    } else {
                        log('未找到定时发布开关，直接尝试写入时间', 'warning');
                    }

                    const publishTime = calculatePublishTimeFixed(settings, chapters.length, currentIndex);
                    log(`目标定时时间: ${publishTime.date} ${publishTime.time}`, 'info');

                    const settle = settleMs(settings);
                    log(`停顿 ${(settle / 1000).toFixed(1)} 秒后再继续`, 'info');

                    window.__lastPublishCtx = { dialog: dialog, date: publishTime.date, time: publishTime.time };
                    try {
                        const lastInfo = document.querySelector('.publish-maintain-info-lasttitle');
                        if (lastInfo) log('上次提交：' + (lastInfo.textContent || '').trim(), 'info');
                    } catch (e) { /* ignore */ }

                    let applied = await applyTimedPublish(dialog, publishTime.date, publishTime.time);
                    // 点完日期后页面要缓一下才把值写实
                    await delay(settle);

                    if (!applied) {
                        log('第一次写入没成功，重试一次', 'warning');
                        applied = await applyTimedPublish(dialog, publishTime.date, publishTime.time);
                        await delay(settle);
                    }
                    if (!applied) {
                        log('定时时间仍未写入，发布前会被拦截', 'warning');
                    }
                }

                // 点发布前，先把可能残留的时间弹层关掉（否则按钮被挡住点不到）
                await closePickerPopup();

                // 查找并点击发布按钮
                let confirmBtn = null;
                const possibleConfirmTexts = ['发布', '确认发布', '提交', '确定'];
                
                for (const text of possibleConfirmTexts) {
                    const btn = findButtonByText(text);
                    if (btn && dialog.contains(btn)) {
                        confirmBtn = btn;
                        break;
                    }
                }
                
                if (!confirmBtn) {
                    // 尝试通过类名查找
                    confirmBtn = dialog.querySelector('.arco-btn-primary, .ant-btn-primary, .btn-primary, .confirm-btn, .publish-btn');
                }
                
                // 任务模式传进来的是 'timed'，不能只认 'auto'，否则永远不点发布
                if (confirmBtn) {
                    if (settings.mode === 'semi') {
                        log('半自动模式：确认无误后点「继续」发布本章', 'warning');
                        isPaused = true;
                        try { syncPauseBtn(); } catch (e) { /* ignore */ }
                        await waitWhilePaused();
                        if (stopRequested) return false;
                    }

                    log('点击确认发布按钮', 'info');
                    
                    // 注意：这里不能推进 currentIndex！
                    // 发布成功后外面会统一 +1，这里再 +1 会跳章（真实 bug）
                    
                    // [安全闸] 发布前回读定时时间，不一致就不点发布
                    if (settings.timedPublish) {
                        const expect = calculatePublishTimeFixed(settings, chapters.length, currentIndex);
                        // 再给页面一点时间把状态刷实，然后连续校验两次
                        const settle = settleMs(settings);
                        await delay(settle);
                        let timeOk = await verifyTimedPublish(dialog, expect);
                        if (!timeOk) {
                            log(`首次校验未过，再等 ${(settle / 1000).toFixed(1)} 秒校验一次`, 'warning');
                            await delay(settle);
                            timeOk = await verifyTimedPublish(dialog, expect);
                        }
                        if (!timeOk) {
                            const copied = dumpTimedPicker(expect);
                            clearUploadState();
                            // 把可能残留的 Invalid Date 清掉，别让页面卡在无效状态
                            try { clearPickerInputs(findTimedPickerInputs(dialog)); } catch (e) { /* ignore */ }
                            hideUploadNotice();
                            showBlockedNotice(expect, copied);
                            log('定时时间与期望不符，已中止整批上传', 'error');
                            return false;
                        }
                    }

                    confirmBtn.click();

                    // 等待发布完成（对标代码的方法）
                    for (let j = 0; j < 30; j++) {
                        await delay(500);
                        // 刚点完发布就被取消：别再跳到下一章
                        if (stopRequested) return true;
                        if (window.location.href.includes('chapter-manage')) {
                            console.log('[小说上传助手] 已跳转到章节管理页面');
                            
                            // 检查是否还有待上传的章节
                            const nextState = loadUploadState();
                            if (nextState && nextState.currentIndex < nextState.chapters.length) {
                                console.log('[小说上传助手] 继续上传下一章...');
                                showUploadNotice(nextState.currentIndex + 1, nextState.chapters.length, nextState.chapters[nextState.currentIndex].number);
                                await delay(CONFIG.DELAY.CHAPTER);
                                // 直接跳转到发布页面继续
                                window.location.href = `https://fanqienovel.com/main/writer/${nextState.bookId}/publish/?enter_from=newchapter_1`;
                            } else if (nextState) {
                                // 所有章节上传完成
                                // 多账号任务：回报完成状态（任务标识从状态里恢复）
                                try {
                                    const doneTaskId = String(nextState.taskId || activeTaskId || '');
                                    if (doneTaskId && window.__xbuTaskStatus) {
                                        window.__xbuTaskStatus(doneTaskId, 'done');
                                    }
                                } catch (e) { /* ignore */ }
                                clearUploadState();
                                showCompletionNotice(nextState.results);
                            }
                            return true;
                        }
                        
                        // 检查是否有风险提示弹窗出现
                        const newRiskDialog = findRiskDialog();
                        if (newRiskDialog) {
                            log('发布后出现风险提示弹窗', 'info');
                            await handleRiskDialog(newRiskDialog);
                        }
                    }
                    return true;
                } else if (!confirmBtn) {
                    log('未找到发布按钮', 'warning');
                }
            }
        }
        
        log('发布对话框处理超时', 'warning');
        return false;
    }

    /*******************************
     * 定时发布：真实写入组件状态 + 发布前回读校验
     * v2.4.1 修复：原实现只改 input.value，Arco DatePicker 是受控组件，
     * 内部状态没变，于是界面显示 11-04 却按默认 11-02 提交。
     *******************************/
    const TIMED = {
        // 校验不通过时是否仍然发布。默认 false：宁可停下，也不发错日期。
        FORCE_ON_MISMATCH: false
    };

    // 定时发布停顿（毫秒），来自用户设置
    function settleMs(settings) {
        let s = Number(settings && settings.settleSeconds);
        if (!isFinite(s) || s <= 0) s = 2.5;
        s = Math.max(0.5, Math.min(15, s));
        return Math.round(s * 1000);
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function reactFiberOf(node) {
        if (!node) return null;
        for (const k of Object.keys(node)) {
            if (k.indexOf('reactFiber') !== -1) return node[k];
        }
        return null;
    }

    function parseDateTimeText(text) {
        if (!text) return null;
        const m = String(text).match(/(\d{4})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})(?:\D{0,3}(\d{1,2})\D{0,3}(\d{1,2}))?/);
        if (!m) return null;
        return {
            date: `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`,
            time: (m[4] !== undefined && m[4] !== '' && m[4] !== null)
                ? `${pad2(+m[4])}:${pad2(+(m[5] || 0))}`
                : null
        };
    }

    function findTimedPickerInputs(dialog) {
        const scopes = [];
        if (dialog) scopes.push(dialog);
        scopes.push(document);

        for (const scope of scopes) {
            let list = Array.from(scope.querySelectorAll(
                'input.arco-picker-input, .arco-picker input, input[placeholder*="日期"], input[placeholder*="时间"], input[placeholder*="date"], input[placeholder*="time"]'
            )).filter(el => el.offsetParent !== null && !el.disabled);

            if (list.length === 0) {
                list = Array.from(scope.querySelectorAll('input')).filter(el => {
                    if (el.offsetParent === null || el.disabled) return false;
                    const ph = el.placeholder || '';
                    const hint = ph + ' ' + (el.value || '');
                    return /\d{4}[-/年]\d{1,2}/.test(hint) || /日期|时间|date|time/i.test(ph);
                });
            }
            if (list.length > 0) {
                const seen = new Set();
                return list.filter(el => {
                    if (seen.has(el)) return false;
                    seen.add(el);
                    return true;
                });
            }
        }
        return [];
    }

    // 读「已提交」的值：来自 React props，而不是 input.value（后者只是显示）
    function readPickerCommittedValue(input) {
        let f = reactFiberOf(input);
        let depth = 0;
        while (f && depth < 60) {
            const p = f.memoizedProps;
            if (p && p.value !== undefined && p.value !== null) {
                if (typeof p.value === 'object' && typeof p.value.format === 'function') {
                    try {
                        if (typeof p.value.isValid !== 'function' || p.value.isValid()) {
                            return p.value.format('YYYY-MM-DD HH:mm');
                        }
                    } catch (e) { /* ignore */ }
                } else if (typeof p.value === 'string' && parseDateTimeText(p.value)) {
                    return p.value;
                }
            }
            f = f.return;
            depth++;
        }
        return null;
    }

    // 首选：直接调用选择器的 onChange，真正写进 React 状态（多种签名都试）
    async function setPickerValueViaReact(input, dateStr, timeStr) {
        const target = `${dateStr} ${timeStr}:00`;
        let f = reactFiberOf(input);
        let depth = 0;
        while (f && depth < 80) {
            const p = f.memoizedProps;
            if (p && typeof p.onChange === 'function' &&
                p.value && typeof p.value === 'object' && typeof p.value.format === 'function') {
                let next = null;
                try { next = p.value.constructor(target); } catch (e) { /* ignore */ }
                // 构造失败或非法时，用带格式的构造方式
                if (!next || (typeof next.isValid === 'function' && !next.isValid())) {
                    try { next = p.value.constructor(target, 'YYYY-MM-DD HH:mm:ss'); } catch (e) { /* ignore */ }
                }
                if (!next || (typeof next.isValid === 'function' && !next.isValid())) {
                    f = f.return; depth++; continue;
                }

                // 当前值若是 Invalid Date，先清空，否则写进去还是非法
                try {
                    if (typeof p.value.isValid === 'function' && !p.value.isValid()) {
                        p.onChange(null);
                        await delay(250);
                    }
                } catch (e) { /* ignore */ }

                const str = (typeof next.format === 'function')
                    ? next.format('YYYY-MM-DD HH:mm:ss')
                    : `${dateStr} ${timeStr}:00`;

                const calls = [
                    () => p.onChange(next, str),
                    () => p.onChange(next),
                    () => p.onChange(str, next)
                ];
                for (const fn of calls) {
                    try { fn(); } catch (e) { /* 换签名 */ }
                    await delay(250);
                    const got = readPickerCommittedValue(input);
                    // 必须日期和时间同时对上，否则只是日期对了、小时还是默认值
                    if (got && got.indexOf(dateStr) === 0 && got.indexOf(timeStr) >= 0) {
                        log(`已写入定时时间（React 状态）: ${got}`, 'success');
                        return true;
                    }
                    if (got) log(`写入后读回 ${got}，与目标 ${dateStr} ${timeStr} 不符，换方式重试`, 'warning');
                }
            }
            f = f.return;
            depth++;
        }
        return false;
    }

    // 兜底：模拟真实输入 + Enter + 点面板「确定」
    async function setPickerViaTyping(input, dateStr, timeStr) {
        try {
            input.focus();
            input.click();
            await delay(300);

            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            const text = `${dateStr} ${timeStr}`;
            if (nativeSetter) nativeSetter.call(input, text); else input.value = text;

            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await delay(200);

            for (const type of ['keydown', 'keypress', 'keyup']) {
                input.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                }));
            }
            await delay(300);

            const okBtn = document.querySelector(
                '.arco-picker-footer-btn-wrapper button.arco-btn-primary, .arco-picker-footer button.arco-btn-primary, .arco-trigger-popup .arco-btn-primary'
            );
            if (okBtn) {
                okBtn.click();
                await delay(300);
            }
            return true;
        } catch (e) {
            log(`模拟输入失败: ${e.message}`, 'warning');
            return false;
        }
    }

    /* ---------- 路径四：键盘逐字输入 ---------- */
    async function typeByKeyboard(input, dateStr, timeStr) {
        try {
            input.focus();
            input.click();
            await delay(500);

            const text = dateStr + ' ' + timeStr;

            // 先清空
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
            await delay(150);

            for (const ch of text) {
                const ie = new InputEvent('beforeinput', {
                    inputType: 'insertText', data: ch, bubbles: true, cancelable: true
                });
                input.dispatchEvent(ie);

                const ev = new InputEvent('input', {
                    inputType: 'insertText', data: ch, bubbles: true
                });
                input.dispatchEvent(ev);
                await delay(40);
            }

            input.dispatchEvent(new Event('change', { bubbles: true }));
            await delay(200);

            for (const type of ['keydown', 'keypress', 'keyup']) {
                input.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                }));
            }
            await delay(400);

            const okBtn = document.querySelector(
                '.arco-picker-footer-btn-wrapper button.arco-btn-primary, .arco-trigger-popup .arco-btn-primary'
            );
            if (okBtn) { okBtn.click(); await delay(300); }
            return true;
        } catch (e) {
            log('键盘输入失败: ' + e.message, 'warning');
            return false;
        }
    }

    /* ---------- 路径二：日历面板真实点选（不依赖 React 内部） ---------- */
    let lastSetTrusted = false;

    function findVisiblePickerPopup() {
        const sels = ['.arco-picker-container', '.arco-trigger-popup .arco-picker', '.arco-picker-popup', '.arco-picker-dropdown'];
        for (const s of sels) {
            const els = Array.from(document.querySelectorAll(s)).filter(e => e.offsetParent !== null);
            if (els.length) return els[els.length - 1];
        }
        const any = Array.from(document.querySelectorAll('.arco-picker'))
            .filter(e => e.offsetParent !== null && !e.closest('.arco-modal'));
        return any.length ? any[any.length - 1] : null;
    }

    function readPanelMonth(panel) {
        const head = panel.querySelector('.arco-picker-header') || panel;
        const t = (head.textContent || '').replace(/\s+/g, '');
        const m = t.match(/(\d{4})年?(\d{1,2})月?/);
        return m ? { year: +m[1], month: +m[2] } : null;
    }

    async function gotoPanelMonth(panel, year, month) {
        const headSel = '.arco-picker-header';
        const headText = () => {
            const h = panel.querySelector(headSel) || panel;
            return (h.textContent || '').replace(/\s+/g, '');
        };

        let lastDiff = 0;
        let sameTimes = 0;

        for (let i = 0; i < 24; i++) {
            const cur = readPanelMonth(panel);
            if (!cur) { log('读不到面板年月', 'warning'); return false; }

            const diff = (year - cur.year) * 12 + (month - cur.month);
            if (diff === 0) return true;

            // 同方向连续多次且面板没变化 → 判定卡死，直接放弃
            if (diff === lastDiff) sameTimes++; else { sameTimes = 0; lastDiff = diff; }
            if (sameTimes >= 6) {
                log('翻月卡住了（一直 ' + cur.year + '年' + cur.month + '月）', 'warning');
                return false;
            }

            const icons = Array.from(panel.querySelectorAll('.arco-picker-header-icon'));
            if (icons.length < 2) { log('找不到翻月按钮', 'warning'); return false; }

            // 面板可能有 4 个箭头：上一年/上一月/下一月/下一年。
            // 只挑"翻月"的那两个，绝对不能用翻年的，否则会在 2026/2027 之间横跳
            const isSuper = (el) => /super|year|double/.test(String(el.className || ''));
            const norm = icons.filter(el => !isSuper(el));
            let prevBtn, nextBtn;
            if (norm.length >= 2) {
                prevBtn = norm.find(el => /prev/.test(String(el.className || ''))) || norm[0];
                nextBtn = norm.slice().reverse().find(el => /next/.test(String(el.className || ''))) || norm[norm.length - 1];
            } else if (icons.length >= 4) {
                prevBtn = icons[1];
                nextBtn = icons[icons.length - 2];
            } else {
                prevBtn = icons[0];
                nextBtn = icons[icons.length - 1];
            }

            if (sameTimes === 5) {
                log('翻月按钮类名: ' + icons.map(el => el.className).join(' | '), 'warning');
            }

            const btn = diff > 0 ? nextBtn : prevBtn;

            const before = headText();
            btn.click();

            // 等面板真的变化再读，避免"读到的还是上一个月"导致反复横跳
            for (let w = 0; w < 12; w++) {
                await delay(120);
                if (headText() !== before) break;
            }
        }
        return false;
    }

    async function clickPanelDay(panel, day) {
        const cells = Array.from(panel.querySelectorAll('td.arco-picker-cell'));
        const target = cells.find(td => {
            const txt = (td.textContent || '').trim();
            if (txt !== String(day)) return false;
            const cn = td.className || '';
            if (/disabled/.test(cn)) return false;
            if (/arco-picker-cell-prev|arco-picker-cell-next|arco-picker-cell-new/.test(cn)) return false;
            return true;
        });
        if (!target) { log(`面板里找不到 ${day} 号单元格`, 'warning'); return false; }
        (target.querySelector('.arco-picker-date-value') || target).click();
        await delay(350);
        return true;
    }

    /* ---------- 关闭残留的时间选择弹层 ---------- */
    async function closePickerPopup() {
        try {
            const popups = Array.from(document.querySelectorAll('.arco-picker-container, .arco-trigger-popup, .ant-picker-dropdown'))
                .filter(el => el.offsetParent !== null);
            if (!popups.length) return false;

            const p = popups[0];
            const okBtn = Array.from(p.querySelectorAll('button'))
                .find(b => /确定|确认|此刻/.test((b.textContent || '').trim()));
            if (okBtn) {
                okBtn.click();
                log('已关闭时间弹层（点确定）', 'info');
                await delay(500);
                return true;
            }

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            await delay(300);
            log('已关闭时间弹层（Esc）', 'info');
            return true;
        } catch (e) {
            return false;
        }
    }

    async function clickPanelTime(panel, timeStr) {
        // 面板里的格子是 "00" "01"…，而传入的可能是 "0" —— 必须按数值比较，
        // 否则小时点不中，面板就保留默认小时（比如 2:00），只剩分钟被改掉。
        const parts = String(timeStr || '').split(':');
        const want = [parts[0], parts[1] || '0'].map(v => String(parseInt(v, 10) || 0));

        const lists = Array.from(panel.querySelectorAll('.arco-timepicker-list'));
        if (lists.length === 0) return false;

        const pick = (list, val) => {
            const cells = Array.from(list.querySelectorAll('.arco-timepicker-cell'));
            const n = parseInt(val, 10) || 0;
            return cells.find(c => {
                const txt = (c.textContent || '').trim();
                return txt === val || String(parseInt(txt, 10)) === String(n);
            }) || null;
        };

        for (let i = 0; i < Math.min(lists.length, want.length); i++) {
            const cell = pick(lists[i], want[i]);
            if (!cell) {
                log(`时间面板里没找到 ${want[i]} 这个格子`, 'warning');
                continue;
            }
            if (!/selected/.test(cell.className)) {
                cell.click();
                await delay(220);
            }
        }
        return true;
    }

    async function pickFromPanel(input, dateStr, timeStr) {
        try {
            if (input.scrollIntoView) input.scrollIntoView({ block: 'center' });
            input.click();
            await delay(600);

            let panel = findVisiblePickerPopup();
            if (!panel) { log('定时面板没有弹出', 'warning'); return false; }

            const parts = dateStr.split('-').map(Number);
            if (!await gotoPanelMonth(panel, parts[0], parts[1])) return false;
            if (!await clickPanelDay(panel, parts[2])) return false;

            panel = findVisiblePickerPopup() || panel;
            await clickPanelTime(panel, timeStr);

            const okBtn = document.querySelector('.arco-picker-footer-btn-wrapper button.arco-btn-primary') ||
                          document.querySelector('.arco-trigger-popup .arco-picker-footer button.arco-btn-primary');
            if (okBtn) { okBtn.click(); await delay(400); }
            log(`日历面板已点选 ${dateStr} ${timeStr}`, 'success');
            return true;
        } catch (e) {
            log(`面板点选失败: ${e.message}`, 'warning');
            return false;
        }
    }

    /* ---------- 诊断：失败时把页面结构塞进剪贴板 ---------- */
    function copyToClipboard(text) {
        try {
            if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; }
        } catch (e) { /* fallthrough */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            return true;
        } catch (e) { return false; }
    }

    function dumpTimedPicker(expect) {
        const inputs = findTimedPickerInputs(document);
        const info = inputs.map((el, i) => {
            const chain = [];
            let cur = reactFiberOf(el);
            let d = 0;
            while (cur && d < 20) {
                const nm = (cur.type && (cur.type.displayName || cur.type.name)) || '?';
                const p = cur.memoizedProps || {};
                if (p.value !== undefined || typeof p.onChange === 'function') {
                    let preview = 'n/a';
                    try {
                        preview = (typeof p.value === 'object' && p.value && typeof p.value.format === 'function')
                            ? p.value.format('YYYY-MM-DD HH:mm')
                            : String(p.value).slice(0, 40);
                    } catch (e) { /* ignore */ }
                    chain.push({
                        component: nm,
                        valueType: typeof p.value,
                        valuePreview: preview,
                        propsKeys: Object.keys(p).slice(0, 20)
                    });
                }
                cur = cur.return;
                d++;
            }
            return {
                index: i,
                placeholder: el.placeholder,
                value: el.value,
                className: el.className,
                readOnly: el.readOnly,
                type: el.type,
                committed: readPickerCommittedValue(el),
                fiberChain: chain
            };
        });

        const popup = findVisiblePickerPopup();
        const dlg = document.querySelector('.arco-modal.publish-confirm-container-new, .arco-modal');
        const payload = {
            ts: new Date().toISOString(),
            url: location.href,
            expect: expect,
            inputs: info,
            popupHtml: popup ? popup.outerHTML.slice(0, 8000) : null,
            dialogHtml: dlg ? dlg.outerHTML.slice(0, 8000) : null,
            ua: navigator.userAgent
        };
        const txt = JSON.stringify(payload, null, 2);
        try {
            if (typeof window.__saveDump === 'function') window.__saveDump(txt);
        } catch (e) { /* ignore */ }
        const ok = copyToClipboard(txt);
        console.log('[小说上传助手] 诊断信息（剪贴板=' + ok + '）:\n' + txt);
        return ok;
    }

    // 定时选择器是开关打开后才渲染的，需要等
    async function waitForTimedInputs(dialog, timeoutMs) {
        const started = Date.now();
        const limit = timeoutMs || 10000;
        while (Date.now() - started < limit) {
            const inputs = findTimedPickerInputs(dialog);
            if (inputs.length > 0) return inputs;
            await delay(400);
        }
        return [];
    }

    /* ---------- 番茄的「日期」「时间」是分开的两个框 ---------- */
    // 通过输入框所在行的文字判断它到底是日期框还是时间框
    function rowLabelOf(el) {
        let p = el.parentElement;
        let depth = 0;
        while (p && depth < 6) {
            const txt = (p.textContent || '').replace(/\s+/g, '');
            if (txt.length > 0 && txt.length <= 24) return txt;
            p = p.parentElement;
            depth++;
        }
        return '';
    }

    function classifyPickerInput(el) {
        const label = rowLabelOf(el);
        const ph = el.placeholder || '';
        const cls = el.className || '';
        const all = label + ' ' + ph + ' ' + cls;

        const looksTime = /时间|time|clock/i.test(all) && !/日期|date/i.test(all);
        const looksDate = /日期|date/i.test(all) && !/时间|time/i.test(all);
        if (looksTime) return 'time';
        if (looksDate) return 'date';
        return 'datetime';
    }

    // 只把一个字段写对（分栏模式下用）
    async function setOneField(input, val) {
        const clean = (s) => String(s || '').replace(/\s+/g, '').trim();
        const ok = () => {
            const shown = clean(input.value);
            const committed = clean(readPickerCommittedValue(input));
            return shown === clean(val) || committed.indexOf(clean(val)) >= 0;
        };

        // 1) React 上写
        let f = reactFiberOf(input);
        let depth = 0;
        while (f && depth < 80) {
            const p = f.memoizedProps;
            if (p && typeof p.onChange === 'function' &&
                p.value && typeof p.value === 'object' && typeof p.value.format === 'function') {
                let next = null;
                try { next = p.value.constructor(val); } catch (e) { /* ignore */ }
                for (const args of [[next, val], [val, next], [next]]) {
                    try { p.onChange.apply(null, args); } catch (e) { /* ignore */ }
                    await delay(200);
                    if (ok()) return true;
                }
            }
            f = f.return;
            depth++;
        }

        // 2) 键盘输入
        try {
            input.focus();
            input.click();
            await delay(300);
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (setter) setter.call(input, val); else input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await delay(150);
            for (const type of ['keydown', 'keypress', 'keyup']) {
                input.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                }));
            }
            await delay(400);
            return ok();
        } catch (e) {
            return false;
        }
    }

    // 把残留的 Invalid Date 清空，避免挡住后续操作
    function clearPickerInputs(inputs) {
        for (const el of inputs) {
            try {
                let f = reactFiberOf(el);
                let depth = 0;
                while (f && depth < 60) {
                    const p = f.memoizedProps;
                    if (p && typeof p.onChange === 'function') {
                        try { p.onChange(null, ''); } catch (e) { /* ignore */ }
                        break;
                    }
                    f = f.return;
                    depth++;
                }
            } catch (e) { /* ignore */ }
            try {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                if (setter) setter.call(el, ''); else el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (e) { /* ignore */ }
        }
    }

    async function fillSplitPickers(inputs, dateStr, timeStr) {
        let dateEls = [];
        let timeEls = [];
        const unknown = [];

        for (const el of inputs) {
            const k = classifyPickerInput(el);
            if (k === 'date') dateEls.push(el);
            else if (k === 'time') timeEls.push(el);
            else unknown.push(el);
        }

        // 番茄这里是「日期」「时间」两个框：只要框数 >= 2，就按分开写处理，
        // 名字认不出来就按 DOM 顺序：第一个当日期，第二个当时间。
        if (!dateEls.length && !timeEls.length && inputs.length >= 2) {
            dateEls = [inputs[0]];
            timeEls = [inputs[1]];
            log('没认出日期/时间标签，按顺序分别填写前两个框', 'warning');
        } else {
            if (!dateEls.length && unknown.length) dateEls = [unknown.shift()];
            if (!timeEls.length && unknown.length) timeEls = [unknown.shift()];
        }

        let dateOk = dateEls.length === 0;
        let timeOk = timeEls.length === 0;

        for (const el of dateEls) {
            if (await setOneField(el, dateStr)) dateOk = true;
        }
        for (const el of timeEls) {
            if (await setOneField(el, timeStr)) timeOk = true;
        }

        if (dateOk && timeOk) {
            log(`日期框/时间框分别写入成功：${dateStr} ${timeStr}`, 'success');
            return true;
        }
        log(`分栏写入结果：日期=${dateOk ? '成功' : '失败'}，时间=${timeOk ? '成功' : '失败'}`, 'warning');
        return false;
    }

    /* ---------- 纯点选：只用鼠标点日历+时间，不写任何值 ---------- */
    async function fillViaPanelOnly(inputs, dateStr, timeStr) {
        try {
            await closePickerPopup();
            const parts = String(dateStr).split('-').map(Number);
            if (parts.length !== 3) return false;

            // 打开第一个输入框（日期）
            inputs[0].click();
            await delay(700);
            let panel = findVisiblePickerPopup();
            if (!panel) { log('日历面板没有弹出', 'warning'); return false; }

            if (!await gotoPanelMonth(panel, parts[0], parts[1])) { log('切换月份失败', 'warning'); return false; }
            if (!await clickPanelDay(panel, parts[2])) { log('点不中日期 ' + parts[2], 'warning'); return false; }

            panel = findVisiblePickerPopup() || panel;
            await clickPanelTime(panel, timeStr);
            await delay(300);

            // 点弹层里的「确定」
            const okBtn = Array.from(panel.querySelectorAll('button'))
                .find(b => /确定/.test((b.textContent || '').trim()));
            if (okBtn) { okBtn.click(); await delay(600); }

            const shown = inputs.map(el => (el.value || '').trim()).join(' | ');
            const ok = shown.indexOf(dateStr) >= 0 && shown.indexOf(timeStr) >= 0;
            log('点选完成，输入框：' + shown, ok ? 'success' : 'warning');
            return ok;
        } catch (e) {
            log('点选失败: ' + e.message, 'warning');
            return false;
        }
    }

    async function applyTimedPublish(dialog, dateStr, timeStr) {
        // 入口统一补零："0:00" -> "00:00"
        {
            const p = String(timeStr || '').split(':');
            const hh = String(Math.min(23, Math.max(0, parseInt(p[0], 10) || 0))).padStart(2, '0');
            const mm = String(Math.min(59, Math.max(0, parseInt(p[1], 10) || 0))).padStart(2, '0');
            timeStr = `${hh}:${mm}`;
        }

        const inputs = await waitForTimedInputs(dialog, 10000);
        if (inputs.length === 0) {
            log('等待 10 秒仍未出现定时时间输入框', 'error');
            return false;
        }
        log(`找到 ${inputs.length} 个候选时间输入框`, 'info');
        lastSetTrusted = false;

        // 如果框里已是 Invalid Date，先用弹层里的「今天」重置
        try {
            const hasInvalid = inputs.some(el => /invalid/i.test(el.value || ''));
            if (hasInvalid) {
                for (const el of inputs) {
                    el.click();
                    await delay(500);
                    const todayBtn = Array.from(document.querySelectorAll('.arco-picker-today-btn, .arco-picker-footer a, span, button'))
                        .find(b => (b.textContent || '').trim() === '今天' && b.offsetParent !== null);
                    if (todayBtn) { todayBtn.click(); await delay(400); log('重置为今天', 'info'); break; }
                }
                await delay(300);
            }
        } catch (e) { /* ignore */ }

        // 先清空残留的 Invalid Date，否则面板打不开、点不中
        try {
            log('先清空时间框里的残留值', 'info');
            clearPickerInputs(inputs);
            await delay(400);
        } catch (e) { /* ignore */ }

        const timeOk = (input) => {
            const got = readPickerCommittedValue(input);
            return !!(got && got.indexOf(dateStr) === 0 && got.indexOf(timeStr) >= 0);
        };

        // 路径零：番茄是「日期」「时间」两个独立框时，分开写，绝对不能把
        // "2026-11-04 00:00" 塞进日期框（会变成 Invalid Date 卡死）
        if (inputs.length >= 2) {
            try { clearPickerInputs(inputs); await delay(300); } catch (e) { /* ignore */ }
            log('检测到多个时间输入框（日期/时间分开），分别填写', 'info');

            // 顺序调整：先"直接写值"（快、不翻月），不行再"点日历"（会翻月）
            // 这样避免两种方式各翻一次月份，出现"反复横跳"
            if (await fillSplitPickers(inputs, dateStr, timeStr)) {
                await delay(400);
                await closePickerPopup();
                const shown = inputs.map(el => (el.value || '').trim()).join(' | ');
                const okShown = shown.indexOf(dateStr) >= 0 && shown.indexOf(timeStr) >= 0;
                log('写入后输入框内容：' + shown, okShown ? 'success' : 'warning');
                if (okShown) return true;
            }

            // 写值不成，再走纯点选（只翻一次月）
            if (await fillViaPanelOnly(inputs, dateStr, timeStr)) {
                await delay(400);
                return true;
            }

            // 都失败就别用合并写法污染输入框
            clearPickerInputs(inputs);
            return false;
        }

        // 路径一：写 React 状态
        for (const input of inputs) {
            if (await setPickerValueViaReact(input, dateStr, timeStr) && timeOk(input)) {
                await delay(500);
                return true;
            }
        }

        // 路径二：真实点选日历面板
        for (const input of inputs) {
            log('改用日历面板点选', 'info');
            if (await pickFromPanel(input, dateStr, timeStr)) {
                await delay(400);
                if (timeOk(input)) {
                    lastSetTrusted = true;
                    await delay(300);
                    return true;
                }
                log('面板点选后时间仍不对，继续尝试', 'warning');
            }
        }

        // 路径三：模拟键入
        for (const input of inputs) {
            await setPickerViaTyping(input, dateStr, timeStr);
            await delay(400);
            if (timeOk(input)) return true;
        }

        // 路径四：点开面板后，用真实键盘事件逐字输入再回车
        for (const input of inputs) {
            log('改用键盘逐字输入', 'info');
            if (await typeByKeyboard(input, dateStr, timeStr)) {
                await delay(500);
                if (timeOk(input)) return true;
            }
        }
        // 失败时把候选框的真实状态打出来，并上报到 AppData 供作者排查
        try {
            const snap = inputs.map((el, i) => ({
                index: i,
                value: (el.value || '').trim(),
                placeholder: el.placeholder || '',
                className: (el.className || '').slice(0, 80),
                readback: readPickerCommittedValue(el)
            }));

            log('定时时间没能写成 ' + dateStr + ' ' + timeStr + '，发布前会被拦截。候选框：' +
                snap.map(s => `#${s.index}="${s.value}"`).join(' | '), 'error');

            let dump = null;
            try { dump = dumpTimedPicker({ date: dateStr, time: timeStr }); } catch (e) { /* ignore */ }
            let panelHtml = '';
            try {
                const pop = findVisiblePickerPopup();
                panelHtml = pop ? pop.outerHTML.slice(0, 6000) : '（没有可见面板）';
            } catch (e) { /* ignore */ }

            if (window.__xbuReport) {
                window.__xbuReport('timed-picker', {
                    expect: { date: dateStr, time: timeStr },
                    inputs: snap,
                    dump: dump,
                    panelHtml: panelHtml,
                    url: location.href,
                    ua: navigator.userAgent
                });
            }
        } catch (e) {
            log('定时时间没能写成 ' + dateStr + ' ' + timeStr + '，发布前会被拦截', 'error');
        }
        return false;
    }

    // 发布前校验：只认 React props 里已提交的值，不认 input.value 显示文本
    async function verifyTimedPublish(dialog, expect) {
        const want = `${expect.date} ${expect.time}`;
        const inputs = findTimedPickerInputs(dialog);

        const committed = [];
        for (const input of inputs) {
            const c = readPickerCommittedValue(input);
            if (c) committed.push(c);
        }

        let candidates = committed;
        if (candidates.length === 0 && lastSetTrusted) {
            log('读不到组件状态，但日期是面板真实点选的，按可信处理', 'warning');
            return true;
        }
        if (candidates.length === 0) {
            // 拿不到组件状态时才退回看显示值（风险更高，仅兜底）
            candidates = inputs.map(i => (i.value || '').trim()).filter(Boolean);
            document.querySelectorAll('.arco-picker-range-item, .arco-picker-start-time, .arco-picker-effective').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t) candidates.push(t);
            });
        }

        const parsed = candidates.map(parseDateTimeText).filter(Boolean);
        const exactOk = parsed.some(p => p.date === expect.date && p.time === expect.time);
        // 日期、时间分属两个选择器时：只要能凑出「日期对 + 时间对」就算通过
        const pairOk = parsed.some(p => p.date === expect.date) &&
                       parsed.some(p => p.time === expect.time);
        const ok = (expect.time === '00:00') ? parsed.some(p => p.date === expect.date) : (exactOk || pairOk);

        if (ok) {
            log(`定时时间校验通过: ${want}`, 'success');
            return true;
        }

        log(`定时时间校验失败，页面实际值: ${JSON.stringify(candidates.filter(Boolean).slice(0, 6))}，期望: ${want}`, 'error');
        if (TIMED.FORCE_ON_MISMATCH) {
            log('FORCE_ON_MISMATCH 已开启，仍然继续发布（时间可能不对）', 'warning');
            return true;
        }
        return false;
    }

    // 诊断：在控制台执行 __dumpTimedPicker() 可导出定时选择器结构，便于反馈排障
    window.__dumpTimedPicker = function () {
        const inputs = findTimedPickerInputs(document);
        const out = inputs.map((el, i) => {
            const chain = [];
            let cur = reactFiberOf(el);
            let d = 0;
            while (cur && d < 25) {
                const nm = (cur.type && (cur.type.displayName || cur.type.name)) || '?';
                const p = cur.memoizedProps || {};
                if (p.value !== undefined || typeof p.onChange === 'function') {
                    chain.push({
                        component: nm,
                        valueType: typeof p.value,
                        keys: Object.keys(p).slice(0, 14)
                    });
                }
                cur = cur.return;
                d++;
            }
            return {
                index: i,
                placeholder: el.placeholder,
                value: el.value,
                className: el.className,
                committed: readPickerCommittedValue(el),
                fiberChain: chain
            };
        });
        console.log('[小说上传助手] 定时选择器结构:', JSON.stringify(out, null, 2));
        return out;
    };

    function showBlockedNotice(expect, copied) {
        const el = document.createElement('div');
        el.style.cssText = [
            'position:fixed', 'top:20px', 'left:50%', 'transform:translateX(-50%)',
            'background:#fff2f0', 'border:1px solid #ffccc7', 'color:#cf1322',
            'padding:14px 22px', 'border-radius:8px', 'z-index:10001', 'font-size:14px',
            'box-shadow:0 4px 12px rgba(0,0,0,0.15)', 'max-width:80vw', 'line-height:1.6'
        ].join(';');
        el.innerHTML = `⚠️ 定时时间没能写进发布框<br>` +
            `期望 <b>${expect.date} ${expect.time}</b>，已中止本章发布（避免发到错误日期）。<br>` +
            (copied
                ? '诊断信息已<b>复制到剪贴板</b>，直接粘到对话里发我即可。'
                : '请在控制台执行 <b>__dumpTimedPicker()</b>，把输出发我。');
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 20000);
    }

    // 兼容旧调用点
    async function setTimedPublishTimeFixed(dialog, date, time) {
        const ok = await applyTimedPublish(dialog, date, time);
        const publishTime = { date: date, time: time };
        return ok && await verifyTimedPublish(dialog, publishTime);
    }

    async function setTimedPublishTimeFallbackFixed(dialog, date, time) {
        return await applyTimedPublish(dialog, date, time);
    }

    /*******************************
     * 计算发布时间（使用对标代码算法）
     *******************************/
    // 统计页面上"今天"已经排了定时发布多少章
    function countTodayScheduled() {
        try {
            const d = new Date();
            const p2 = (n) => String(n).padStart(2, '0');
            const keys = [
                d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
                d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()),
                d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
            ];
            const text = (document.body && document.body.innerText) || '';
            let n = 0;
            for (const k of keys) {
                n = Math.max(n, (text.split(k).length - 1));
            }
            return n;
        } catch (e) {
            return 0;
        }
    }

    const TODAY_QUOTA_ENABLED = false; // 暂时关闭：会算出小助手不接受的日期

    function calculatePublishTimeFixed(settings, totalChapters, currentIndex) {
        const { startDate, startTime, dailyCount, intervalMinutes } = settings;

        let actualDate = startDate;
        let actualTime = startTime || '12:00';

        // 统一成 HH:mm（补零），避免 "0:00" 这种写法导致面板点不中
        {
            const parts = String(actualTime).split(':');
            const hh = String(Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0))).padStart(2, '0');
            const mm = String(Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0))).padStart(2, '0');
            actualTime = `${hh}:${mm}`;
        }

        // 「接着上次排」时：今天已有 N 章，就把今天补到每日章数
        const quota = TODAY_QUOTA_ENABLED ? (Number(settings.todayQuota) || 0) : 0;
        if (quota > 0 && currentIndex < quota) {
            const hhmm = actualTime.split(':');
            const base = new Date();
            const parts2 = String(startDate).split('-');
            const todayBase = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10),
                parseInt(hhmm[0], 10), parseInt(hhmm[1], 10));
            todayBase.setMinutes(todayBase.getMinutes() + currentIndex * (intervalMinutes || 0));
            const p3 = (n) => String(n).padStart(2, '0');
            return {
                date: todayBase.getFullYear() + '-' + p3(todayBase.getMonth() + 1) + '-' + p3(todayBase.getDate()),
                time: p3(todayBase.getHours()) + ':' + p3(todayBase.getMinutes())
            };
        }
        if (dailyCount && dailyCount > 0) {
            const effIndex = quota > 0 ? (currentIndex - quota) : currentIndex;
            const daysToAdd = Math.floor(effIndex / dailyCount);
            const chapterInDay = effIndex % dailyCount;

            const dateParts = actualDate.split('-');
            const timeParts = actualTime.split(':');
            const baseDate = new Date(
                parseInt(dateParts[0]),
                parseInt(dateParts[1]) - 1,
                parseInt(dateParts[2]),
                parseInt(timeParts[0]),
                parseInt(timeParts[1])
            );

            // 「跳过周末」：把每一个发布日往后推到工作日，和面板预览保持一致。
            // 旧代码从没读过 skipWeekend，导致勾了也照样发到周六周日。
            if (settings.skipWeekend && daysToAdd > 0) {
                let pushed = 0;
                while (pushed < daysToAdd) {
                    baseDate.setDate(baseDate.getDate() + 1);
                    const wd = baseDate.getDay();
                    if (wd === 0 || wd === 6) continue;
                    pushed++;
                }
            } else {
                baseDate.setDate(baseDate.getDate() + daysToAdd);
            }
            baseDate.setMinutes(baseDate.getMinutes() + chapterInDay * (intervalMinutes || 0));

            const year = baseDate.getFullYear();
            const month = String(baseDate.getMonth() + 1).padStart(2, '0');
            const day = String(baseDate.getDate()).padStart(2, '0');
            actualDate = `${year}-${month}-${day}`;

            const hours = String(baseDate.getHours()).padStart(2, '0');
            const minutes = String(baseDate.getMinutes()).padStart(2, '0');
            actualTime = `${hours}:${minutes}`;
        }

        return { date: actualDate, time: actualTime };
    }


    /*******************************
     * 记录定时计划（供桌面版「定时提醒」窗口使用）
     *******************************/
    function recordSchedulePlan(settings, total) {
        try {
            if (!settings || !settings.timedPublish) return;
            const bookId = getCurrentBookId();
            if (!bookId) return;

            const last = calculatePublishTimeFixed(settings, total, total - 1);
            const rec = {
                slot: window.__novelUploaderSlot || 0,
                bookHash: bookRef(),
                bookName: currentBookName || '',
                last: `${last.date} ${last.time}`,
                count: total,
                lastChapter: 0,
                source: 'upload',
                updated: Date.now()
            };
            // 本批最后一章的章号（用于提醒窗口显示"最后一章 第X章"）
            try {
                const sel = parsedChapters.filter(ch => ch.selected);
                if (sel.length) {
                    const lastNum = Number(sel[sel.length - 1].number) || 0;
                    rec.lastChapter = lastNum;
                }
                // 章号解析失败时，用页面上能看到的"第N章"最大值兜底
                if (!rec.lastChapter) rec.lastChapter = scanMaxChapterNumber();
            } catch (e) { /* ignore */ }

            if (typeof window.__saveSchedule === 'function') {
                window.__saveSchedule(JSON.stringify(rec));
                log(`定时计划已登记：最后一章 ${rec.last}`, 'info');
            }
        } catch (e) {
            log(`登记定时计划失败: ${e.message}`, 'warning');
        }
    }


    /*******************************
     * 书籍标识（哈希，不落书名）
     *******************************/
    function bookRef() {
        const id = getCurrentBookId() || '';
        let h = 5381;
        for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
        return '#' + h.toString(16).padStart(8, '0').slice(0, 8);
    }

    function saveScheduleRecord(rec) {
        if (typeof window.__saveSchedule !== 'function') {
            log('登记通道不可用（__saveSchedule 缺失），请重启程序', 'error');
            return false;
        }
        try {
            window.__saveSchedule(JSON.stringify(rec));
            log(`定时记录已登记：${rec.last}`, 'success');
            return true;
        } catch (e) {
            log(`登记失败: ${e.message}`, 'error');
            return false;
        }
    }

    /*******************************
     * 打开章节管理页时自动扫描"最后的定时时间"
     *******************************/
    let lastScanAt = 0;

    // 从当前页面文字里找最大的「第N章」，用作"最后一章"
    function scanMaxChapterNumber() {
        try {
            const text = (document.body && document.body.innerText) || '';
            const re = /第\s*(\d+)\s*章/g;
            let m;
            let max = 0;
            while ((m = re.exec(text)) !== null) {
                const n = parseInt(m[1], 10) || 0;
                if (n > max) max = n;
            }
            return max;
        } catch (e) {
            return 0;
        }
    }

    function scanScheduledLastTime(force, manual) {
        if (!force && Date.now() - lastScanAt < 5000) return null;
        lastScanAt = Date.now();

        try {
            const text = (document.body && document.body.innerText) || '';
            const now = Date.now();
            const year = new Date().getFullYear();
            let best = null;

            // 支持 2026-11-03 12:00 / 2026/11/03 12:00 / 11-03 12:00 / 2026-11-03
            const res = [
                /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/g,
                /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g,
                /(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/g
            ];

            for (let ri = 0; ri < res.length; ri++) {
                const re = res[ri];
                let m;
                while ((m = re.exec(text)) !== null) {
                    let dt;
                    if (ri === 0) dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
                    else if (ri === 1) dt = new Date(+m[1], +m[2] - 1, +m[3], 0, 0);
                    else dt = new Date(year, +m[1] - 1, +m[2], +m[3], +m[4]);
                    if (isNaN(dt.getTime())) continue;
                    // 只关心未来（忽略历史时间）
                    if (dt.getTime() < now - 12 * 3600 * 1000) continue;
                    if (!best || dt > best) best = dt;
                }
            }

            if (!best) {
                log(manual
                    ? '没扫描到未来的定时时间：请先进入这本书的「章节管理」页再点扫描'
                    : '当前页面没有发现未来的定时时间', manual ? 'warning' : 'info');
                const el0 = document.getElementById('scan-result');
                if (el0) { el0.textContent = '未找到定时时间'; el0.style.color = '#ff4d4f'; }
                return null;
            }

            const pad = (n) => String(n).padStart(2, '0');
            const last = `${best.getFullYear()}-${pad(best.getMonth() + 1)}-${pad(best.getDate())} ${pad(best.getHours())}:${pad(best.getMinutes())}`;

            const scannedNum = scanMaxChapterNumber();

            const ok = saveScheduleRecord({
                slot: window.__novelUploaderSlot || 0,
                bookHash: bookRef(),
                bookName: currentBookName || '',
                last: last,
                lastChapter: scannedNum,
                source: 'scan',
                updated: Date.now()
            });
            if (!ok) {
                log('登记通道不可用：请重启程序后再扫描', 'error');
            }
            log(`已读取到最后定时时间：${last}`, 'success');
            const el = document.getElementById('scan-result');
            if (el) { el.textContent = `最后定时 ${last}`; el.style.color = '#52c41a'; }
            return last;
        } catch (e) {
            log(`扫描定时时间失败: ${e.message}`, 'warning');
            return null;
        }
    }

    /*******************************
     * 显示上传通知
     *******************************/
    // 关掉悬浮的"上传中"提示（正常结束、失败、取消、刷新都要调）
    // 让悬浮条上的按钮跟 isPaused 保持一致
    function syncPauseBtn() {
        const pf = document.getElementById('pause-float');
        if (!pf) return;
        pf.textContent = isPaused ? '继续' : '暂停';
        pf.style.background = isPaused ? '#52c41a' : '#fffbe6';
        pf.style.borderColor = isPaused ? '#b7eb8f' : '#ffe58f';
        pf.style.color = isPaused ? '#fff' : '#d48806';
    }

    function hideUploadNotice() {
        const el = document.getElementById('upload-notice');
        if (el) el.remove();
    }

    // 看门狗：只要任务已经不在进行中，悬浮提示就不该继续挂着
    (function watchUploadNotice() {
        setInterval(() => {
            const el = document.getElementById('upload-notice');
            if (!el) return;
            const busy = uploadState && uploadState.isUploading;
            if (!busy) hideUploadNotice();
        }, 1000);
    })();

    function showUploadNotice(current, total, chapterNum) {
        let notice = document.getElementById('upload-notice');
        if (notice) notice.remove();
        
        notice = document.createElement('div');
        notice.id = 'upload-notice';
        notice.style.cssText = `
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: white;
            padding: 12px 24px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 9999;
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 14px;
            border: 1px solid #e8e8e8;
        `;
        
        notice.innerHTML = `
            <div style="width: 8px; height: 8px; background: #1890ff; border-radius: 50%; animation: pulse 1.5s infinite;"></div>
            <div>
                <div style="font-weight: 500;">上传中: ${current}/${total}</div>
                <div style="font-size: 12px; color: #595959;">第${chapterNum}章</div>
            </div>
            <button id="retry-timed" style="margin-left:8px;padding:4px 12px;background:#e6f4ff;border:1px solid #91caff;color:#0958d9;border-radius:4px;cursor:pointer;font-size:12px;">重试定时</button>
            <button id="skip-chapter" style="margin-left:8px;padding:4px 12px;background:#f5f5f5;border:1px solid #d9d9d9;color:#595959;border-radius:4px;cursor:pointer;font-size:12px;">跳过本章</button>
            <button id="pause-float" style="margin-left:8px;padding:4px 12px;background:#fffbe6;border:1px solid #ffe58f;color:#d48806;border-radius:4px;cursor:pointer;font-size:12px;">暂停</button>
            <button id="cancel-upload" style="
                margin-left: 16px;
                padding: 4px 12px;
                background: #fff2f0;
                border: 1px solid #ffccc7;
                color: #ff4d4f;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            ">取消</button>
        `;
        
        document.body.appendChild(notice);
        try { syncPauseBtn(); } catch (e) { /* ignore */ }
        
        // 添加动画样式
        if (!document.querySelector('#upload-animation')) {
            const style = document.createElement('style');
            style.id = 'upload-animation';
            style.textContent = `
                @keyframes pulse {
                    0% { opacity: 1; }
                    50% { opacity: 0.5; }
                    100% { opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }
        
        // 取消按钮
        const rt = document.getElementById("retry-timed");
        if (rt) {
            rt.addEventListener("click", async () => {
                if (window.__retrying) { log("正在重试中，稍等", "warning"); return; }
                const ctx = window.__lastPublishCtx;
                if (!ctx || !ctx.dialog || !document.contains(ctx.dialog)) {
                    log("发布框已关闭，无法重试（请等下一页的发布框出现）", "warning");
                    return;
                }
                window.__retrying = true;
                log("只重试写入定时时间，不会重新生成章节", "info");
                try {
                    const ok = await applyTimedPublish(ctx.dialog, ctx.date, ctx.time);
                    log(ok ? "定时时间重试成功" : "定时时间重试仍失败，可再点一次或手动选", ok ? "success" : "warning");
                } catch (e) {
                    log("重试出错: " + e.message, "error");
                } finally {
                    window.__retrying = false;
                }
            });
        }

        const sk = document.getElementById("skip-chapter");
        if (sk) {
            sk.addEventListener("click", () => {
                if (!confirm("跳过这一章，继续发下一章？")) return;
                const st = loadUploadState();
                if (st) { st.currentIndex = (st.currentIndex || 0) + 1; saveUploadState(st); }
                log("已跳过当前章", "warning");
                window.location.href = location.href;
            });
        }

        const pf = document.getElementById("pause-float");
        if (pf) {
            pf.addEventListener("click", () => {
                // 复用统一的暂停/继续逻辑：它会唤醒 waitWhilePaused() 的等待者，
                // 并同步面板按钮状态。旧代码只改了 isPaused 和样式，导致
                // 半自动模式点「继续」后流程永久卡住。
                if (isPaused) resumeAutomation();
                else pauseAutomation('手动暂停');
            });
        }

        document.getElementById('cancel-upload').addEventListener('click', () => {
            if (confirm('确定取消上传吗？')) {
                clearUploadState();
                notice.remove();
                window.location.reload();
            }
        });
    }

    /*******************************
     * 显示完成通知
     *******************************/
    function showCompletionNotice(results) {
        hideUploadNotice();
        isPaused = false;
        try { syncPauseBtn(); } catch (e) { /* ignore */ }

        try {
            const okList = [];
            const failList = [];
            (results || []).forEach((r) => {
                if (!r) return;
                if (r.success) okList.push('第' + r.chapter + '章');
                else failList.push('第' + r.chapter + '章');
            });
            log(`本批完成：成功 ${okList.length} 章` + (failList.length ? `，失败 ${failList.length} 章（${failList.join('、')}）` : '，全部成功'), failList.length ? 'warning' : 'success');
        } catch (e) { /* ignore */ }


        const success = results.filter(r => r && r.success).length;
        const failed = results.filter(r => r && !r.success).length;
        
        const message = failed === 0 ?
            `✅ 上传完成! 成功 ${success} 章` :
            `⚠️ 上传完成! 成功 ${success} 章, 失败 ${failed} 章`;
        
        log(message);
        
        // 显示通知
        const notice = document.createElement('div');
        notice.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${failed === 0 ? '#f6ffed' : '#fffbe6'};
            border: 1px solid ${failed === 0 ? '#b7eb8f' : '#ffe58f'};
            color: ${failed === 0 ? '#52c41a' : '#faad14'};
            padding: 12px 24px;
            border-radius: 6px;
            z-index: 10000;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            display: flex;
            align-items: center;
            gap: 8px;
        `;
        
        notice.innerHTML = failed === 0 ? 
            `✅ 上传完成! 成功 ${success} 章` :
            `⚠️ 上传完成! 成功 ${success} 章, 失败 ${failed} 章`;
        
        document.body.appendChild(notice);
        
        setTimeout(() => notice.remove(), 5000);
    }

    /*******************************
     * 初始化
     *******************************/
    async function init() {
        log('小说上传助手正在初始化...');
        
        // 等待页面加载
        await delay(2000);
        
        // 创建控制面板
        createPanel();
        
        // 章节管理页：自动读取最后一次定时时间
        if (/chapter-manage/i.test(location.href)) {
            setTimeout(() => scanScheduledLastTime(true), 3000);
        }

        // 检查是否有未完成的上传任务（断点续传）
        const state = loadUploadState();
        if (state && state.isUploading) {
            // 恢复任务上下文，让跳转后的日志仍带上正确的任务标识
            if (state.taskId) activeTaskId = String(state.taskId);
            if (state.bookName) activeTaskBook = String(state.bookName);

            // 任务在面板上被暂停过：跳章后也要保持暂停，否则暂停等于没按
            if (activeTaskId) {
                try {
                    const info = await window.__xbuTaskGet(activeTaskId);
                    if (info && info.status === 'paused') {
                        isPaused = true;
                        try { updatePauseButton(); } catch (e) { /* ignore */ }
                        try { syncPauseBtn(); } catch (e) { /* ignore */ }
                        log('任务处于「已暂停」状态，等你在面板点「继续」', 'warning');
                    }
                } catch (e) { /* ignore */ }
            }
            const done = state.currentIndex || 0;
            const total = (state.chapters || []).length;
            const nextCh = (state.chapters || [])[done];
            const inPublishFlow = /\/publish\//i.test(location.href);

            if (inPublishFlow) {
                // 本来就在流程中间（上传会自动跳页面），直接继续，不要弹窗打断
                log('流程进行中，继续处理当前章节...', 'info');
                await continueUpload();
            } else if (done <= 0) {
                if (activeTaskId) {
                    // 任务模式：进度 0 也要跑，绝不能当垃圾清掉
                    log('任务刚下发，开始处理第 1 章…', 'info');
                    await continueUpload();
                } else {
                    clearUploadState();
                    log('清理了未开始的任务（进度 0）', 'info');
                }
            } else {
                const goOn = confirm(
                    '上次有一批章节没传完\n\n' +
                    `进度：${done}/${total}` + (nextCh ? `，下一章是第${nextCh.number}章` : '') + '\n\n' +
                    '点「确定」接着传，点「取消」放弃这批（已发布的不受影响）。'
                );
                if (goOn) {
                    log('继续上次未完成的上传任务...', 'info');
                    await continueUpload();
                } else {
                    clearUploadState();
                    log('已放弃上次未完成的任务', 'warning');
                }
            }
        }
        
        log('初始化完成，可以开始使用', 'success');
    }

    /*******************************
     * 启动脚本
     *******************************/
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 监听页面变化（SPA应用）
    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(() => {
                updateBookInfo();

                // 章节管理页：路由变化后重新扫描
                if (/chapter-manage/i.test(location.href)) {
                    setTimeout(() => scanScheduledLastTime(true), 2500);
                }

                // 检查是否有上传任务
                const state = loadUploadState();
                if (state && state.isUploading) {
                    continueUpload();
                }
            }, 1000);
        }
    }).observe(document, { subtree: true, childList: true });

})();