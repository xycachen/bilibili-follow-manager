// ==UserScript==
// @name         哔哩哔哩关注管理助手（极速版）
// @namespace    http://tampermonkey.net/
// @version      11.0.0
// @description  并发3 | 间隔80ms | 每页40 | 修复HTML实体 | 极速加载
// @author       YourName
// @match        https://space.bilibili.com/*/follow*
// @match        https://www.bilibili.com/account/following*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_download
// @connect      api.bilibili.com
// @connect      space.bilibili.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';
    console.log('[B站关注助手] 脚本启动');

    const CONFIG = {
        PAGE_SIZE: 40,               // 每页40个关注
        CONCURRENT_LIMIT: 3,         // 同时处理3个UP主
        REQUEST_DELAY: 80,           // 每个请求后额外等待80ms（用于错开）
        REQUEST_TIMEOUT: 8000,
        BATCH_RENDER_SIZE: 10,       // 每10个渲染一次表格
    };

    const state = {
        uid: null,
        list: [],
        filteredList: [],
        csrf: document.cookie.match(/bili_jct=([^;]+)/)?.[1] || '',
        sortField: 'followTime',
        sortOrder: 'desc',
        loading: false,
        stopLoading: false,
        selected: new Set(),
        filter: { fansMin: 0, fansMax: 999999999, noUpdateDays: 0 },
        renderTimer: null,
        totalFollow: 0,
    };

    // 工具函数
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    }
    function formatDate(timestamp) {
        if (!timestamp) return '无动态';
        const date = new Date(timestamp * 1000);
        return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    }
    function formatNumber(num) {
        if (num>=1e8) return (num/1e8).toFixed(1)+'亿';
        if (num>=1e4) return (num/1e4).toFixed(1)+'万';
        return String(num);
    }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // 请求封装
    function fetchJSON(url, options = {}) {
        return new Promise((resolve, reject) => {
            let timeoutId = setTimeout(() => reject(new Error(`请求超时: ${url}`)), CONFIG.REQUEST_TIMEOUT);
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: Object.assign({ 'User-Agent': navigator.userAgent }, options.headers || {}),
                data: options.data,
                onload: (resp) => {
                    clearTimeout(timeoutId);
                    try {
                        const json = JSON.parse(resp.responseText);
                        resolve(json);
                    } catch(e) {
                        reject(new Error('JSON解析失败'));
                    }
                },
                onerror: () => {
                    clearTimeout(timeoutId);
                    reject(new Error('网络请求失败'));
                },
                ontimeout: () => {
                    clearTimeout(timeoutId);
                    reject(new Error('请求超时'));
                },
            });
        });
    }

    // 获取UID
    async function getMyUid() {
        try {
            const nav = await fetchJSON('https://api.bilibili.com/x/web-interface/nav');
            if (nav.code === 0 && nav.data.mid) return nav.data.mid;
        } catch(e) { console.warn('[UID] 接口失败:', e); }
        const match = location.pathname.match(/\/space\/(\d+)/);
        if (match) return match[1];
        const cookieMatch = document.cookie.match(/DedeUserID=(\d+)/);
        if (cookieMatch) return cookieMatch[1];
        throw new Error('无法获取UID，请确保已登录B站');
    }

    // 获取单页关注列表（映射字段）
    async function getFollowingsPage(pn) {
        const url = `https://api.bilibili.com/x/relation/followings?vmid=${state.uid}&pn=${pn}&ps=${CONFIG.PAGE_SIZE}&order=desc&order_type=attention`;
        let res;
        try {
            res = await fetchJSON(url);
        } catch(e) {
            throw new Error(`获取第${pn}页关注列表失败: ${e.message}`);
        }
        if (res.code !== 0) throw new Error(`获取关注列表失败: ${res.message}`);
        const mappedList = (res.data.list || []).map(item => ({
            mid: item.mid,
            uname: item.uname,
            followTime: item.mtime,
            fans: 0,
            lastDynamic: 0,
        }));
        return { list: mappedList, total: res.data.total };
    }

    // 获取单个UP主信息（粉丝数 + 最后动态）
    async function enrichUser(user) {
        if (state.stopLoading) throw new Error('停止加载');
        console.log(`[开始] ${user.uname}(${user.mid})`);
        try {
            const [statRes, dynamicRes] = await Promise.all([
                fetchJSON(`https://api.bilibili.com/x/relation/stat?vmid=${user.mid}`),
                fetchJSON(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?host_mid=${user.mid}`)
            ]);
            user.fans = statRes?.data?.follower || 0;
            const items = dynamicRes?.data?.items;
            if (items && items.length > 0) {
                user.lastDynamic = items[0]?.modules?.module_author?.pub_ts || 0;
            } else {
                user.lastDynamic = 0;
            }
            console.log(`[成功] ${user.uname} 粉丝:${user.fans} 最后动态:${user.lastDynamic || '无'} 关注时间:${user.followTime}`);
        } catch (err) {
            console.warn(`[失败] ${user.uname}(${user.mid})`, err.message);
        }
        return user;
    }

    // 并发处理一页的关注
    async function processPage(users, pageIndex, onProgress) {
        const total = users.length;
        let completed = 0;
        const queue = [...users];
        const workers = [];
        const runWorker = async () => {
            while (queue.length) {
                if (state.stopLoading) throw new Error('停止加载');
                const user = queue.shift();
                await enrichUser(user);
                // 更新全局列表
                const idx = state.list.findIndex(u => u.mid === user.mid);
                if (idx !== -1) {
                    state.list[idx] = { ...state.list[idx], ...user };
                } else {
                    state.list.push(user);
                }
                completed++;
                // 进度回调
                const globalCompleted = (pageIndex - 1) * CONFIG.PAGE_SIZE + completed;
                if (onProgress) onProgress(globalCompleted, state.totalFollow);
                // 渲染控制
                if (globalCompleted % CONFIG.BATCH_RENDER_SIZE === 0 || globalCompleted === state.totalFollow) {
                    if (state.renderTimer) clearTimeout(state.renderTimer);
                    state.renderTimer = setTimeout(() => {
                        applyFiltersAndSort();
                        renderTable();
                        state.renderTimer = null;
                    }, 100);
                }
                await delay(CONFIG.REQUEST_DELAY);
            }
        };
        // 启动并发
        for (let i = 0; i < CONFIG.CONCURRENT_LIMIT; i++) {
            workers.push(runWorker());
        }
        await Promise.all(workers);
        return users;
    }

    // 分批加载所有关注
    async function loadAllData(progressCallback) {
        if (state.loading) return;
        state.loading = true;
        state.stopLoading = false;
        state.list = [];
        state.selected.clear();

        let page = 1;
        try {
            const firstPage = await getFollowingsPage(1);
            state.totalFollow = firstPage.total;
            progressCallback(`共 ${state.totalFollow} 位UP主，开始分批加载...`, 0);

            await processPage(firstPage.list, page, (completed, total) => {
                const percent = completed / total;
                progressCallback(`加载中: ${completed}/${total}`, percent);
            });
            page++;

            while (page * CONFIG.PAGE_SIZE <= state.totalFollow) {
                if (state.stopLoading) throw new Error('停止加载');
                const pageData = await getFollowingsPage(page);
                await processPage(pageData.list, page, (completed, total) => {
                    const percent = completed / total;
                    progressCallback(`加载中: ${completed}/${total}`, percent);
                });
                page++;
            }

            if (state.stopLoading) throw new Error('停止加载');
            progressCallback('加载完成', 1);
        } catch (err) {
            if (err.message === '停止加载') {
                progressCallback('已停止加载', 0);
            } else {
                console.error(err);
                progressCallback(`加载失败: ${err.message}`, 0);
                alert(`加载失败: ${err.message}`);
            }
        } finally {
            state.loading = false;
            state.stopLoading = false;
        }
    }

    // 筛选和排序
    function applyFilters() {
        const now = Date.now() / 1000;
        let filtered = [...state.list];
        filtered = filtered.filter(item => (item.fans||0) >= state.filter.fansMin && (item.fans||0) <= state.filter.fansMax);
        if (state.filter.noUpdateDays > 0) {
            filtered = filtered.filter(item => {
                if (item.lastDynamic === 0) return true;
                const daysSince = (now - item.lastDynamic) / 86400;
                return daysSince >= state.filter.noUpdateDays;
            });
        }
        return filtered;
    }
    function sortData(data) {
        data.sort((a,b) => {
            let va = a[state.sortField]||0, vb = b[state.sortField]||0;
            return state.sortOrder === 'asc' ? va - vb : vb - va;
        });
        return data;
    }
    function applyFiltersAndSort() {
        let filtered = applyFilters();
        filtered = sortData(filtered);
        state.filteredList = filtered;
        return filtered;
    }

    // 表格渲染（彻底修复HTML实体）
    function renderTable() {
        const tbody = document.querySelector('#bili-fm-table-body');
        if (!tbody) return;
        if (!state.filteredList.length) {
            tbody.innerHTML = '}<td colspan="6" style="text-align:center;">暂无数据，请等待自动加载...';
            updateStats();
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const item of state.filteredList) {
            const checked = state.selected.has(item.mid) ? 'checked' : '';
            const tr = document.createElement('tr');
            tr.setAttribute('data-mid', item.mid);
            // 直接使用标准HTML标签，不使用任何转义字符串
            tr.innerHTML = `
                <td class="checkbox-cell"><input type="checkbox" class="row-checkbox" data-mid="${item.mid}" ${checked}></td>
                <td><a href="https://space.bilibili.com/${item.mid}" target="_blank">${escapeHtml(item.uname)}</a></td>
                <td>${formatNumber(item.fans)}</td>
                <td>${formatDate(item.followTime)}</td>
                <td>${formatDate(item.lastDynamic)}</td>
                <td><button class="unfollow-btn" data-mid="${item.mid}">取关</button></td>
            `;
            fragment.appendChild(tr);
        }
        tbody.innerHTML = '';
        tbody.appendChild(fragment);
        updateStats();
        attachEvents();
    }

    function attachEvents() {
        document.querySelectorAll('.row-checkbox').forEach(cb => cb.addEventListener('change', e => {
            let mid = parseInt(e.target.dataset.mid);
            e.target.checked ? state.selected.add(mid) : state.selected.delete(mid);
            updateSelectAll();
            updateStats();
        }));
        document.querySelectorAll('.unfollow-btn').forEach(btn => btn.addEventListener('click', async e => {
            let mid = parseInt(btn.dataset.mid);
            if (confirm('确定取关该UP主吗？')) await unfollowSingle(mid);
        }));
    }
    function updateSelectAll() {
        let sel = document.querySelector('#select-all');
        if (!sel) return;
        let mids = state.filteredList.map(i=>i.mid);
        sel.checked = mids.length>0 && mids.every(m=>state.selected.has(m));
    }
    function updateStats() {
        let t = document.querySelector('#total-count');
        let s = document.querySelector('#selected-count');
        if(t) t.textContent = state.list.length;
        if(s) s.textContent = state.selected.size;
    }

    // 取关操作
    async function unfollowSingle(mid) {
        const csrf = state.csrf;
        if (!csrf) {
            alert('CSRF token 获取失败，请刷新页面重试');
            return false;
        }
        const formData = new URLSearchParams();
        formData.append('fid', mid);
        formData.append('act', '2');
        formData.append('csrf', csrf);
        try {
            const res = await fetchJSON('https://api.bilibili.com/x/relation/modify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: formData.toString()
            });
            if (res.code === 0) {
                state.list = state.list.filter(u => u.mid !== mid);
                state.selected.delete(mid);
                applyFiltersAndSort();
                renderTable();
                return true;
            } else {
                alert('取关失败: ' + (res.message || '未知错误'));
                return false;
            }
        } catch(e) {
            console.error('取关请求异常:', e);
            alert('取关请求失败，请检查网络或刷新页面重试');
            return false;
        }
    }

    async function batchUnfollow() {
        let to = state.filteredList.filter(i => state.selected.has(i.mid));
        if (!to.length) { alert('请先勾选要取关的UP主'); return; }
        if (!confirm(`确定取关 ${to.length} 位UP主吗？操作不可逆。`)) return;
        let pc = document.getElementById('unfollow-progress-container');
        let pb = document.getElementById('unfollow-progress-bar');
        let pt = document.getElementById('unfollow-progress-text');
        pc.style.display = 'block';
        let success = 0;
        for (let i=0; i<to.length; i++) {
            let ok = await unfollowSingle(to[i].mid);
            if (ok) success++;
            let percent = ((i+1)/to.length)*100;
            pb.style.width = percent + '%';
            pt.textContent = `取关进度: ${i+1}/${to.length}`;
            await delay(500);
        }
        pc.style.display = 'none';
        alert(`取关完成：成功 ${success}，失败 ${to.length - success}`);
    }

    function sortBy(field) {
        if (state.sortField === field) state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
        else { state.sortField = field; state.sortOrder = 'desc'; }
        applyFiltersAndSort();
        renderTable();
    }

    // 导出CSV（使用 GM_download 避免页面跳转）
    function exportFullCSV() {
        const data = state.filteredList;
        if (!data.length) { alert('没有数据可导出'); return; }
        let csv = 'mid,UP主,粉丝数,关注日期,最后动态日期\n';
        for (const item of data) {
            csv += `${item.mid},"${item.uname}",${item.fans},${item.followTime},${item.lastDynamic}\n`;
        }
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        try {
            if (typeof GM_download === 'function') {
                GM_download({ url: url, name: 'bilibili_follows_full.csv', saveAs: true });
            } else {
                const a = document.createElement('a');
                a.href = url;
                a.download = 'bilibili_follows_full.csv';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    function importFullCSV(file) {
        const reader = new FileReader();
        reader.onload = e => {
            const lines = e.target.result.split('\n').slice(1);
            const imported = [];
            for (const line of lines) {
                if (!line.trim()) continue;
                const match = line.match(/^(\d+),"([^"]+)",(\d+),(\d+),(\d+)$/);
                if (match) {
                    imported.push({
                        mid: parseInt(match[1]),
                        uname: match[2],
                        fans: parseInt(match[3]),
                        followTime: parseInt(match[4]),
                        lastDynamic: parseInt(match[5]),
                    });
                }
            }
            if (imported.length === 0) { alert('导入文件格式错误'); return; }
            const existingMids = new Set(state.list.map(u => u.mid));
            const newUsers = imported.filter(u => !existingMids.has(u.mid));
            state.list = state.list.concat(newUsers);
            applyFiltersAndSort();
            renderTable();
            alert(`导入成功，新增 ${newUsers.length} 个UP主，总计 ${state.list.length} 个`);
        };
        reader.readAsText(file);
    }

    function updateFilterAndRender() {
        const min = parseInt(document.querySelector('#filter-fans-min').value) || 0;
        const max = parseInt(document.querySelector('#filter-fans-max').value) || 999999999;
        const days = parseInt(document.querySelector('#filter-no-update-days').value) || 0;
        state.filter.fansMin = min;
        state.filter.fansMax = max;
        state.filter.noUpdateDays = days;
        applyFiltersAndSort();
        renderTable();
    }

    // UI 创建
    function createUI() {
        const existing = document.getElementById('bili-fm-panel');
        if (existing) existing.remove();

        const panel = document.createElement('div');
        panel.id = 'bili-fm-panel';
        panel.innerHTML = `
            <div class="bili-fm-header">
                <h3>📺 关注管理助手（极速版）</h3>
                <button id="close-panel" class="close-btn">✕</button>
            </div>
            <div class="bili-fm-toolbar">
                <button id="load-data" class="btn btn-primary">🔄 重新加载</button>
                <button id="stop-load" class="btn btn-warning">⏹️ 停止加载</button>
                <button id="batch-unfollow" class="btn btn-danger">🗑 一键取关选中</button>
                <button id="export-full" class="btn">📥 导出CSV</button>
                <input type="file" id="import-file-input" accept=".csv" style="display:none;">
                <button id="import-full" class="btn">📂 导入CSV</button>
                <div class="stats">共 <span id="total-count">0</span> 人，已选 <span id="selected-count">0</span> 人</div>
            </div>
            <div class="bili-fm-filter">
                <label>粉丝数范围：</label>
                <input type="number" id="filter-fans-min" value="0" style="width:80px;"> -
                <input type="number" id="filter-fans-max" value="999999999" style="width:80px;">
                <label style="margin-left:10px;">未更新 ≥ </label>
                <input type="number" id="filter-no-update-days" value="0" style="width:80px;"> 天
                <button id="apply-filter" class="btn btn-sm">筛选</button>
                <button id="reset-filter" class="btn btn-sm">重置</button>
            </div>
            <div id="load-progress-container" class="progress-bar-container" style="display:none; margin:8px 16px;">
                <div id="load-progress-bar" class="progress-bar"></div>
                <span id="load-progress-text" class="progress-text"></span>
            </div>
            <div id="unfollow-progress-container" class="progress-bar-container" style="display:none; margin:8px 16px;">
                <div id="unfollow-progress-bar" class="progress-bar"></div>
                <span id="unfollow-progress-text" class="progress-text"></span>
            </div>
            <div class="bili-fm-table-wrapper">
                <table class="bili-fm-table">
                    <thead>
                        <tr>
                            <th class="checkbox-cell"><input type="checkbox" id="select-all"></th>
                            <th data-sort="uname">UP主</th>
                            <th data-sort="fans">粉丝数 <span class="sort-icon">↕️</span></th>
                            <th data-sort="followTime">关注日期 <span class="sort-icon">↕️</span></th>
                            <th data-sort="lastDynamic">最后动态日期 <span class="sort-icon">↕️</span></th>
                            <th>操作</th>
                         </tr>
                    </thead>
                    <tbody id="bili-fm-table-body">
                        <tr><td colspan="6">正在初始化，请稍候...</td></tr>
                    </tbody>
                </table>
            </div>
        `;
        document.body.appendChild(panel);
        console.log('[UI] 面板已创建');

        // 事件绑定
        document.getElementById('load-data').addEventListener('click', async () => {
            const loadBtn = document.getElementById('load-data');
            const stopBtn = document.getElementById('stop-load');
            loadBtn.disabled = true; stopBtn.disabled = false;
            loadBtn.textContent = '加载中...';
            const pc = document.getElementById('load-progress-container');
            const pb = document.getElementById('load-progress-bar');
            const pt = document.getElementById('load-progress-text');
            pc.style.display = 'block';
            await loadAllData((msg, p) => {
                if (p !== undefined) { pb.style.width = (p * 100) + '%'; pt.textContent = msg; }
                else pt.textContent = msg;
            });
            pc.style.display = 'none';
            loadBtn.disabled = false; stopBtn.disabled = true;
            loadBtn.textContent = '🔄 重新加载';
        });
        document.getElementById('stop-load').addEventListener('click', () => { if (state.loading) state.stopLoading = true; });
        document.getElementById('batch-unfollow').addEventListener('click', batchUnfollow);
        document.getElementById('close-panel').addEventListener('click', () => panel.remove());
        document.getElementById('select-all').addEventListener('change', e => {
            const checked = e.target.checked;
            for (const item of state.filteredList) checked ? state.selected.add(item.mid) : state.selected.delete(item.mid);
            renderTable();
        });
        document.getElementById('export-full').addEventListener('click', exportFullCSV);
        const importBtn = document.getElementById('import-full');
        const fileInput = document.getElementById('import-file-input');
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', e => { if (e.target.files.length) importFullCSV(e.target.files[0]); fileInput.value = ''; });
        document.getElementById('apply-filter').addEventListener('click', updateFilterAndRender);
        document.getElementById('reset-filter').addEventListener('click', () => {
            document.getElementById('filter-fans-min').value = '0';
            document.getElementById('filter-fans-max').value = '999999999';
            document.getElementById('filter-no-update-days').value = '0';
            updateFilterAndRender();
        });
        const ths = document.querySelectorAll('.bili-fm-table th[data-sort]');
        ths.forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (field === 'uname') {
                    const order = state.sortField === 'uname' && state.sortOrder === 'asc' ? 'desc' : 'asc';
                    state.filteredList.sort((a,b) => order === 'asc' ? a.uname.localeCompare(b.uname) : b.uname.localeCompare(a.uname));
                    state.sortField = 'uname'; state.sortOrder = order;
                } else sortBy(field);
                renderTable();
            });
        });
        makeDraggable(panel);
    }

    function makeDraggable(panel) {
        const header = panel.querySelector('.bili-fm-header');
        let isDragging = false, startX, startY, initLeft, initTop;
        header.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initLeft = rect.left; initTop = rect.top;
            panel.style.position = 'fixed';
            panel.style.margin = '0';
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            panel.style.left = `${initLeft + dx}px`;
            panel.style.top = `${initTop + dy}px`;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
            isDragging = false;
            document.body.style.userSelect = '';
        });
    }

    GM_addStyle(`
        #bili-fm-panel { position:fixed; top:80px; right:20px; width:1000px; max-width:90vw; height:80vh; background:#fff; border-radius:12px; box-shadow:0 8px 28px rgba(0,0,0,0.2); z-index:999999; display:flex; flex-direction:column; font-family:system-ui; font-size:14px; border:1px solid #e5e9ef; }
        .bili-fm-header { padding:12px 16px; background:#00a1d6; color:#fff; display:flex; justify-content:space-between; align-items:center; border-radius:12px 12px 0 0; cursor:move; }
        .bili-fm-header h3 { margin:0; font-size:16px; }
        .close-btn { background:none; border:none; color:#fff; font-size:20px; cursor:pointer; }
        .bili-fm-toolbar, .bili-fm-filter { padding:8px 16px; background:#f6f9fc; border-bottom:1px solid #e5e9ef; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
        .bili-fm-filter { background:#fff; border-bottom:none; padding-top:4px; padding-bottom:12px; }
        .btn { padding:6px 14px; border:none; border-radius:6px; cursor:pointer; font-size:13px; background:#fff; border:1px solid #ccd0d7; }
        .btn-primary { background:#00a1d6; color:#fff; border:none; }
        .btn-danger { background:#fb7299; color:#fff; border:none; }
        .btn-warning { background:#ff9800; color:#fff; border:none; }
        .btn-sm { padding:4px 10px; font-size:12px; }
        .stats { margin-left:auto; font-size:13px; color:#6d757a; }
        .bili-fm-table-wrapper { flex:1; overflow:auto; }
        .bili-fm-table { width:100%; border-collapse:collapse; }
        .bili-fm-table th, .bili-fm-table td { padding:10px 12px; text-align:left; border-bottom:1px solid #e5e9ef; }
        .bili-fm-table th { background:#fafbfc; font-weight:600; cursor:pointer; position:sticky; top:0; z-index:10; }
        .bili-fm-table th:hover { background:#f0f2f5; }
        .checkbox-cell { width:30px; text-align:center; }
        .sort-icon { font-size:10px; margin-left:4px; }
        .unfollow-btn { background:#fb7299; color:#fff; border:none; border-radius:4px; padding:4px 8px; cursor:pointer; }
        .progress-bar-container { background:#e5e9ef; border-radius:4px; height:8px; position:relative; }
        .progress-bar { background:#00a1d6; width:0%; height:100%; border-radius:4px; transition:width 0.2s; }
        .progress-text { position:absolute; top:-20px; right:0; font-size:12px; color:#6d757a; }
    `);

    // 入口
    async function init() {
        console.log('[初始化] 开始');
        try {
            state.uid = await getMyUid();
            console.log('[初始化] UID:', state.uid);
            createUI();
            const loadBtn = document.getElementById('load-data');
            const stopBtn = document.getElementById('stop-load');
            if (loadBtn) loadBtn.disabled = true;
            if (stopBtn) stopBtn.disabled = false;
            const pc = document.getElementById('load-progress-container');
            const pb = document.getElementById('load-progress-bar');
            const pt = document.getElementById('load-progress-text');
            if (pc) pc.style.display = 'block';
            await loadAllData((msg, p) => {
                if (pb && pt) {
                    if (p !== undefined) { pb.style.width = (p * 100) + '%'; pt.textContent = msg; }
                    else pt.textContent = msg;
                }
            });
            if (pc) pc.style.display = 'none';
            if (loadBtn) loadBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
        } catch (e) {
            console.error('[初始化失败]', e);
            alert('初始化失败: ' + e.message);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();