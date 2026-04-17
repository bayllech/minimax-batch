// ==UserScript==
// @name         MiniMax 音乐批量生成
// @namespace    https://www.minimaxi.com/
// @version      1.7.6
// @description  批量输入风格提示词，按顺序逐条自动生成音乐，且支持完成后自动下载无水印版
// @author       批量工具
// @match        https://www.minimaxi.com/audio/music*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=minimaxi.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────
  //  配置常量
  // ─────────────────────────────────────────
  const POLL_INTERVAL     = 2000;   // 检测完成的轮询间隔（ms）
  const MAX_WAIT_MS       = 300000; // 单条最长等待时间 5 分钟
  const MAX_BTN_WAIT_MS   = 300000; // 等待按钮就绪的最长时间延长至 5 分钟
  const INJECT_DELAY      = 1500;   // 页面加载后注入 UI 的延迟（ms）
  const POST_CLICK_DELAY  = 3000;   // 点击后等待作品列表更新的延迟（ms）

  // ─────────────────────────────────────────
  //  状态管理
  // ─────────────────────────────────────────
  const state = {
    running:        false,
    paused:         false,
    prompts:        [],
    current:        0,
    startTime:      0,
    prevWorkCount:  0,
    prevFirstId:    '',
    waitPhase:      'waiting_new_item',
    btnWaitStart:   0,
    pollTimer:      null,
    generationId:   0,
    autoDownload:   true,
    downloadFolder: 'MiniMaxMusic'
  };

  /** 全局日志函数 */
  function log(msg, type = 'log') {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const prefix = `%c[MiniMaxBatch ${time}]`;
    const style = 'color: #8b5cf6; font-weight: bold;';
    if (type === 'error') console.error(prefix, msg, style);
    else if (type === 'warn') console.warn(prefix, msg, style);
    else console.log(prefix, msg, style);
  }

  // ─────────────────────────────────────────
  //  全局下载拦截器 (v1.7.5 抢跑版)
  // ─────────────────────────────────────────
  (function() {
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (typeof state !== 'undefined' && state.running && state.autoDownload && this.href) {
        const isAudio = this.href.includes('.mp3') || this.href.includes('blob:') || this.download;
        if (isAudio) {
          const fileName = this.download || (this.href.split('/').pop().split('?')[0]) || `Music_${Date.now()}.mp3`;
          const safeFileName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim();
          const safeFolder = state.downloadFolder.replace(/[\\:*?"<>|]/g, '_').trim();
          const saveName = safeFolder ? `./${safeFolder}/${safeFileName}` : safeFileName;
          
          log(`🎯 [事件拦截] 捕获点击! 路径: "${saveName}"`);
          
          if (typeof GM_download === 'function') {
            GM_download({
              url: this.href,
              name: saveName,
              saveAs: false,
              onload: () => log(`✅ 归档成功: ${saveName}`),
              onerror: (err) => log(`❌ 归档失败: ${err.error}`, 'error')
            });
            return;
          }
        }
      }
      return originalAnchorClick.apply(this, arguments);
    };

    window.addEventListener('click', function(e) {
      if (typeof state !== 'undefined' && state.running && state.autoDownload) {
        const a = e.target.closest('a');
        if (a && a.href && (a.download || a.href.includes('.mp3') || a.href.includes('blob:'))) {
          const fileName = a.download || (a.href.split('/').pop().split('?')[0]) || `Music_${Date.now()}.mp3`;
          const safeFileName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim();
          const safeFolder = state.downloadFolder.replace(/[\\:*?"<>|]/g, '_').trim();
          const saveName = safeFolder ? `./${safeFolder}/${safeFileName}` : safeFileName;
          log(`🎯 [事件拦截] 捕获捕获点击! 路径: "${saveName}"`);
          if (typeof GM_download === 'function') {
            e.preventDefault();
            e.stopPropagation();
            GM_download({ url: a.href, name: saveName, saveAs: false, onload: () => log(`✅ 归档成功: ${saveName}`), onerror: (err) => log(`❌ 归档失败: ${err.error}`, 'error') });
          }
        }
      }
    }, true);
  })();

  // ─────────────────────────────────────────
  //  DOM 工具
  // ─────────────────────────────────────────

  /** React 兼容的 textarea 值设置 */
  function setReactValue(el, value) {
    const proto = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    if (proto && proto.set) {
      proto.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 获取风格输入框 */
  function getTextarea() {
    return document.querySelector('#music-styles-input');
  }

  /** 获取生成按钮（不论状态） */
  function getGenerateBtn() {
    const btns = Array.from(document.querySelectorAll('button'));
    // 排除列表：Header中的按钮、脚本面板自身的按钮
    const excludeTexts = ['开始创作', '暂停', '停止', '开始批量', '再次批量'];
    
    // 优先：寻找主区域的"限时免费"按钮
    const readyBtn = btns.find(b => {
        const t = b.innerText || '';
        return t.includes('限时免费') && !excludeTexts.some(ex => t.includes(ex));
    });
    if (readyBtn) return readyBtn;

    // 备选：寻找处于忙碌态的主按钮
    const busyBtn = btns.find(b => {
        const t = b.innerText || '';
        const isBusy = t.includes('创作中') || t.includes('生成中') || t.includes('执行中');
        return isBusy && !excludeTexts.some(ex => t.includes(ex));
    });
    return busyBtn || null;
  }

  /** 判断生成按钮是否处于就绪（可点击）状态 */
  function isGenerateBtnReady() {
    const btn = getGenerateBtn();
    if (!btn) return false;
    const t = btn.innerText || '';
    // 只有包含"限时免费"且不带 disabled 类名才算真正就绪
    return t.includes('限时免费') && !btn.className.includes('cursor-not-allowed');
  }

  /**
   * 获取右侧作品列表容器
   * 真实选择器：div.absolute.inset-0（有 overflow-y-scroll，子项为作品卡片）
   */
  function getWorkList() {
    // 优先用精确类名
    let el = document.querySelector('div.absolute.inset-0[class*="overflow-y-scroll"]');
    if (el && el.children.length > 0) return el;
    // 备用：找含最多子项的滚动容器
    const candidates = Array.from(document.querySelectorAll('div[class*="overflow-y"]'));
    let best = null, max = 0;
    for (const c of candidates) {
      if (c.children.length > max) { max = c.children.length; best = c; }
    }
    return best;
  }

  /** 获取当前作品列表快照（强制滚动到顶确保准确性） */
  function getWorkListSnapshot() {
    const list = getWorkList();
    if (!list) return { count: 0, firstText: '' };
    
    // 🛡️ 强制滚动回顶部，确保第一项永远是最新作品，不受虚拟列表翻页干扰
    list.scrollTop = 0;
    
    const items = list.children;
    return {
      count:     items.length,
      firstText: items.length > 0 ? items[0].innerText.substring(0, 50) : ''
    };
  }

  /**
   * 判断最新一条作品（列表第一项）是否仍在生成中
   * 生成中通常有：animate-spin / skeleton / 特定 loading 类
   */
  function isLatestWorkGenerating() {
    const list = getWorkList();
    if (!list || list.children.length === 0) return false;
    const first = list.children[0];
    // 检测 loading 态：有 animate-spin 或特定 skeleton 元素
    return !!(
      first.querySelector('[class*="animate-spin"]') ||
      first.querySelector('[class*="skeleton"]') ||
      first.querySelector('[class*="loading"]') ||
      first.className.includes('animate-')
    );
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ─────────────────────────────────────────
  //  核心批量执行逻辑
  // ─────────────────────────────────────────
  async function runNext() {
    log(`>>> 开始处理第 ${state.current + 1} 项...`);
    if (!state.running || state.paused) {
        log('脚本未运行或已暂停，退出 runNext');
        return;
    }
    if (state.current >= state.prompts.length) {
      log('所有任务已完成');
      finishAll();
      return;
    }

    const prompt = state.prompts[state.current];
    const idx    = state.current + 1;
    const total  = state.prompts.length;

    // 0. 先等待生成按钮恢复就绪状态（防止上一条还没完全结束）
    const btnWaitDeadline = Date.now() + MAX_BTN_WAIT_MS;
    while (!isGenerateBtnReady()) {
      if (!state.running || state.paused) return;
      if (Date.now() > btnWaitDeadline) {
        updateStatus('⚠️ 等待按钮就绪超时，尝试继续...', 'warn');
        break;
      }
      updateStatus(`⏳ 第 ${idx}/${total}：等待按钮重置中...`, 'running');
      await sleep(1000);
    }
    if (!state.running || state.paused) return;

    // 🛡️ 只有在按钮真正变紫色（就绪）后，才开始 5-10 秒的模拟思考时间
    updateProgressBar();
    const delayMs = Math.floor(Math.random() * 5001) + 5000;
    for (let i = Math.ceil(delayMs / 1000); i > 0; i--) {
        if (!state.running || state.paused) return;
        updateStatus(`☕ 按钮已就绪，思考中 (${i}s)...`, 'running');
        await sleep(1000);
    }
    if (!state.running || state.paused) return;

    const textarea = getTextarea();
    if (!textarea) {
      const msg = '❌ 找不到风格输入框，请确认在音乐创作页面';
      log(msg, 'error');
      updateStatus(msg, 'error');
      stopBatch(msg);
      return;
    }

    log(`正在自动填写提示词 [${prompt.substring(0, 20)}...]`);
    updateStatus(`▶ 第 ${idx}/${total}：正在填写提示词…`, 'running');

    // 1. 清空并写入提示词
    textarea.focus();
    setReactValue(textarea, '');
    await sleep(300);
    setReactValue(textarea, prompt);

    // 等待 React 响应（增加到 1.5s 以确保按钮状态同步）
    await sleep(1500);
    if (!state.running || state.paused) return;

    // 🛡️ 二次校验：确保按钮依然是就绪的（这里的等待时间与 MAX_BTN_WAIT_MS 对齐）
    let waitStart = Date.now();
    while (!isGenerateBtnReady() && (Date.now() - waitStart < MAX_BTN_WAIT_MS)) {
        const currentBtn = getGenerateBtn();
        const btnText = currentBtn ? currentBtn.innerText : '未找到';
        const elapsed = Math.round((Date.now() - waitStart) / 1000);
        
        log(`等待按钮从繁忙中恢复 (当前: ${btnText}, 已等 ${elapsed}s)...`);
        updateStatus(`⏳ 第 ${idx}/${total}：按钮忙碌 (${btnText}), 已候 ${elapsed}s...`, 'running');
        await sleep(2000);
    }

    const btn = getGenerateBtn();
    if (!btn || !isGenerateBtnReady()) {
      const btnText = btn ? btn.innerText : '未找到';
      const msg = `❌ 按钮状态异常 (${btnText})，无法点击生成`;
      log(msg, 'error');
      // 输出所有按钮文本供调试
      const allBtns = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t);
      log(`全页面按钮列表: ${JSON.stringify(allBtns)}`);
      updateStatus(msg, 'error');
      stopBatch(msg);
      return;
    }

    // 2. 记录点击前快照
    log('正在获取点击前列表快照...');
    const beforeSnap      = getWorkListSnapshot();
    state.prevWorkCount   = beforeSnap.count;
    state.prevFirstText   = beforeSnap.firstText;
    state.startTime       = Date.now();
    state.waitPhase       = 'waiting_new_item';

    log(`点击点击快照: 数量=${state.prevWorkCount}, 首项=${state.prevFirstText}`);
    updateStatus(`▶ 第 ${idx}/${total}：点击生成…`, 'running');

    // 3. 点击生成按钮
    log('执行按钮点击...');
    btn.click();

    // 等待一段时间后开始轮询（让页面有时间添加新作品卡片）
    await sleep(POST_CLICK_DELAY);

    updateStatus(`⏳ 第 ${idx}/${total}：等待作品出现…`, 'running');

    // 4. 轮询检测完成
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.generationId++;               // 每次生成递增，旧回调对不上就忽略
    const myGenId = state.generationId;
    state.pollTimer = setInterval(() => checkComplete(idx, total, myGenId), POLL_INTERVAL);
  }

  function checkComplete(idx, total, myGenId) {
    // 🛡️ guard：若 generationId 已变（说明下一条已启动），丢弃此过期回调
    if (state.generationId !== myGenId) return;
    if (!state.running || state.paused) return;

    const elapsed = Date.now() - state.startTime;
    const sec     = Math.round(elapsed / 1000);

    // 超时保护
    if (elapsed > MAX_WAIT_MS) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      updateStatus(`⚠️ 第 ${idx}/${total} 超时（5分钟），跳过，继续下一条`, 'warn');
      advanceToNext();
      return;
    }

    const list = getWorkList();
    if (list) list.scrollTop = 0; // 轮询时也强制置顶
    const nowSnap = getWorkListSnapshot();

    // 阶段1：等待新作品卡片出现
    if (state.waitPhase === 'waiting_new_item') {
      const newItemAppeared =
        nowSnap.count > state.prevWorkCount ||
        (nowSnap.count > 0 && nowSnap.firstText !== state.prevFirstText);
      
      // 🛡️ 深度保险：如果第一项文本包含"生成中"或带动画，直接判定为新任务已启动
      const reallyGenerating = isLatestWorkGenerating();

      if (newItemAppeared || reallyGenerating) {
        state.waitPhase = 'waiting_done';
        updateStatus(`⏳ 第 ${idx}/${total}：检测到新生成任务已启动... ${sec}s`, 'running');
      } else {
        updateStatus(`⏳ 第 ${idx}/${total}：等待列表更新... ${sec}s`, 'running');
      }
      return;
    }

    // 阶段2：等待第一条作品的 loading 动画消失
    if (state.waitPhase === 'waiting_done') {
      const stillLoading = isLatestWorkGenerating();
      if (!stillLoading) {
        // 作品 loading 消失，但按钮可能还在"创作中"，进入阶段3等待按钮就绪
        state.waitPhase    = 'waiting_btn_ready';
        state.btnWaitStart = Date.now();
        updateStatus(`✅ 第 ${idx}/${total} 作品完成，等待按钮就绪…`, 'success');
      } else {
        updateStatus(`⏳ 第 ${idx}/${total}：生成中… ${sec}s`, 'running');
      }
      return;
    }

    // 阶段3：等待生成按钮恢复"限时免费"就绪状态，再执行下一条
    if (state.waitPhase === 'waiting_btn_ready') {
      const btnWaitSec = Math.round((Date.now() - state.btnWaitStart) / 1000);
      if (isGenerateBtnReady()) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        updateStatus(`✅ 第 ${idx}/${total} 完成（${sec}s），准备下一条…`, 'success');
        advanceToNext();
      } else if (Date.now() - state.btnWaitStart > MAX_BTN_WAIT_MS) {
        // 按钮等待超时，强制继续
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        updateStatus(`⚠️ 第 ${idx}/${total} 按钮恢复超时，强制继续`, 'warn');
        advanceToNext();
      } else {
        updateStatus(`✅ 第 ${idx}/${total} 完成，等按钮就绪… ${btnWaitSec}s`, 'success');
      }
    }
  }

  /** [v1.7.0] 仅下载模式：全自动化滚动并下载列表 */
  async function startBatchDownloadOnly() {
    state.running = true;
    updateStatus('📦 启动批量下载模式...', 'running');
    log('>>> 启动纯下载模式，将扫描整个列表...');
    
    document.getElementById('mmb-start-btn').disabled = true;
    document.getElementById('mmb-download-only-btn').disabled = true;
    document.getElementById('mmb-stop-btn').style.display = 'inline-flex';

    const downloadedTitles = new Set();
    const list = getWorkList();
    if (!list) {
      updateStatus('❌ 找不到作品列表', 'error');
      stopBatch();
      return;
    }

    let lastHeight = 0;
    let unchangedCount = 0;

    while (state.running) {
      list.scrollTop = lastHeight;
      await sleep(1500); // 等待滚动加载

      const cards = Array.from(list.querySelectorAll('div')).filter(el => {
        const h = el.offsetHeight;
        const text = el.innerText || '';
        return h > 60 && h < 200 && (text.includes('纯音乐') || text.includes(':'));
      });

      if (cards.length === 0) {
        log('当前视野内未发现作品，尝试向下滚动...');
        list.scrollTop += 500;
        if (list.scrollTop === lastHeight) unchangedCount++;
        else unchangedCount = 0;
      } else {
        let newFound = false;
        for (const card of cards) {
          if (!state.running) break;

          const titleEl = card.querySelector('div[style*="font-weight"], span[style*="font-weight"]');
          const title = titleEl ? titleEl.innerText.trim() : card.innerText.split('\n')[0].trim();
          
          if (downloadedTitles.has(title)) continue;

          newFound = true;
          log(`发现新作品: ${title}，准备下载...`);
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(500);
          
          await downloadSingleCard(card, title);
          downloadedTitles.add(title);
          
          updateStatus(`📥 已下: ${downloadedTitles.size} 首 | 当前: ${title.substring(0,10)}...`, 'running');
          await sleep(3000); // 避免并发过快
        }

        if (!newFound) {
          log('当前视野内作品已全部处理，继续下滚...');
          list.scrollTop += 600;
          if (list.scrollTop === lastHeight) unchangedCount++;
          else unchangedCount = 0;
        } else {
          unchangedCount = 0;
        }
      }

      if (unchangedCount > 3) {
        log('检测到已到达列表底部，结束任务');
        break;
      }
      lastHeight = list.scrollTop;
    }

    updateStatus(`✅ 批量下载完成，共 ${downloadedTitles.size} 首`, 'success');
    stopBatch();
  }

  /** [v1.7.0] 针对单个卡片执行下载点击流 */
  async function downloadSingleCard(card, title) {
    const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '_');
    
    // 定位下载按钮
    const elements = Array.from(card.querySelectorAll('.ant-dropdown-trigger, div, button'));
    const downloadBtn = elements.find(el => {
        const html = el.innerHTML || '';
        return (el.classList.contains('ant-dropdown-trigger') || el.className?.includes?.('ant-dropdown-trigger'))
               && html.includes('15.6001H5.59844');
    });

    if (!downloadBtn) {
        log(`跳过 ${title}: 未找到下载按钮`, 'warn');
        return;
    }

    downloadBtn.click();
    await sleep(1000);

    const menuItems = Array.from(document.querySelectorAll('div, li, span'))
        .filter(el => {
            const t = el.innerText || '';
            return t.includes('无水印') || t.includes('MP3(无水印)');
        });
    
    if (menuItems.length > 0) {
        menuItems[menuItems.length - 1].click();
        log(`已发出下载请求: ${cleanTitle}`);
    }
  }

  /** [v1.6.2] 兼容旧逻辑：自动下载最新生成的项 */
  async function downloadFirstItem() {
    const list = getWorkList();
    if (!list) return;
    list.scrollTop = 0;
    await sleep(1000);

    const allDivs = Array.from(list.querySelectorAll('div'));
    const firstCard = allDivs.find(el => {
        const h = el.offsetHeight;
        const text = el.innerText || '';
        return h > 60 && h < 200 && (text.includes('纯音乐') || text.includes(':'));
    });
    
    if (!firstCard) return;

    let title = 'MiniMax_Music';
    const titleEl = firstCard.querySelector('div[style*="font-weight"], span[style*="font-weight"]');
    title = titleEl ? titleEl.innerText.trim() : firstCard.innerText.split('\n')[0].trim();
    
    await downloadSingleCard(firstCard, title);
  }

  async function advanceToNext() {
    // 增加自动下载环节
    if (state.autoDownload) {
        await downloadFirstItem();
        await sleep(2000); // 留出一点处理时间
    }

    state.current++;
    updateProgressBar();
    
    if (state.current >= state.prompts.length) {
      finishAll();
      return;
    }

    // 状态归零，直接进入下一轮的 runNext（内部会自动处理延迟和按钮等待）
    runNext();
  }

  function finishAll() {
    state.running = false;
    const total = state.prompts.length;
    updateStatus(`🎉 全部 ${total} 条提示词已执行完毕！`, 'done');
    updateProgressBar();
    resetBtnState(true);
  }

  function stopBatch(reason = '') {
    state.running = false;
    log(`脚本停止运行。原因: ${reason || '手动停止'}`, 'warn');
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const displayMsg = reason ? `■ 已停止: ${reason}` : '■ 已停止';
    updateStatus(displayMsg, 'error');
    updateProgressBar();
    resetBtnState(false);
  }

  function resetBtnState(done) {
    const startBtn = document.getElementById('mmb-start-btn');
    const pauseBtn = document.getElementById('mmb-pause-btn');
    const stopBtn  = document.getElementById('mmb-stop-btn');
    if (!startBtn) return;
    startBtn.disabled   = false;
    startBtn.textContent = done ? '▶ 再次批量' : '▶ 开始批量';
    pauseBtn.style.display = 'none';
    stopBtn.style.display  = 'none';
    pauseBtn.textContent = '⏸ 暂停';
  }

  // ─────────────────────────────────────────
  //  UI 创建
  // ─────────────────────────────────────────
  function createUI() {
    if (document.getElementById('mmb-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'mmb-panel';
    panel.innerHTML = `
      <div id="mmb-header">
        <span id="mmb-title">🎵 批量音乐生成</span>
        <span id="mmb-collapse-btn" title="折叠/展开">▲</span>
      </div>
      <div id="mmb-body">
        <label class="mmb-row" style="margin-bottom: 2px; cursor: pointer;">
          <input type="checkbox" id="mmb-auto-download" style="margin-right: 6px;">
          自动下载无水印版 (MP3)
        </label>
        <div class="mmb-row" style="margin-bottom: 2px;">
          <span>文件夹:</span>
          <input type="text" id="mmb-download-folder" placeholder="默认: MiniMaxMusic" 
                 style="flex: 1; padding: 2px 6px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #fff;">
        </div>
        <div style="font-size:10px; color:#fb7185; margin-bottom: 8px; line-height:1.2; padding-left: 2px;">
           ⚠️ 路径失效? 需在【油猴设置-通用】将<b>下载模式</b>改为<b>"浏览器 API"</b>，并关闭浏览器的"下载前询问"。
        </div>

        <label class="mmb-label">
          提示词列表
          <small>每行一条风格描述</small>
        </label>
        <textarea id="mmb-prompts" placeholder="每行一条风格描述，例如：
流行 电子 节奏感强 120BPM
民谣 吉他 温柔抒情
爵士 放松 深夜咖啡馆
古典 弦乐 大气磅礴"></textarea>

        <div id="mmb-info-row">
          <span id="mmb-count-tip">共 <b id="mmb-prompt-count">0</b> 条</span>
        </div>

        <div id="mmb-controls">
          <button id="mmb-start-btn">▶ 开始批量生成</button>
          <button id="mmb-download-only-btn" style="background:#10b981; margin-top:6px;">📥 仅批量下载列表</button>
          <button id="mmb-pause-btn" style="display:none">⏸ 暂停</button>
          <button id="mmb-stop-btn"  style="display:none">⏹ 停止</button>
        </div>

        <div id="mmb-progress-wrap">
          <div id="mmb-progress-bar">
            <div id="mmb-progress-fill"></div>
          </div>
          <span id="mmb-progress-text">0 / 0</span>
        </div>

        <div id="mmb-status">等待开始…</div>
      </div>
    `;
    document.body.appendChild(panel);
    injectStyles();
    bindEvents(panel);
  }

  function bindEvents(panel) {
    // 提示词统计
    document.getElementById('mmb-prompts').addEventListener('input', () => {
      const lines = document.getElementById('mmb-prompts').value
        .split('\n').map(s => s.trim()).filter(Boolean).length;
      document.getElementById('mmb-prompt-count').textContent = lines;
    });

    // 折叠/展开
    document.getElementById('mmb-collapse-btn').addEventListener('click', () => {
      const body = document.getElementById('mmb-body');
      const btn  = document.getElementById('mmb-collapse-btn');
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'flex' : 'none';
      btn.textContent = collapsed ? '▲' : '▼';
    });

    // 拖拽
    let dragging = false, ox = 0, oy = 0;
    document.getElementById('mmb-header').addEventListener('mousedown', e => {
      if (e.target.id === 'mmb-collapse-btn') return;
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left   = (e.clientX - ox) + 'px';
      panel.style.top    = (e.clientY - oy) + 'px';
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // 开始按钮
    document.getElementById('mmb-start-btn').addEventListener('click', () => {
      const raw = document.getElementById('mmb-prompts').value.trim();
      if (!raw) { updateStatus('❌ 请先输入至少一条提示词', 'error'); return; }
      const prompts = raw.split('\n').map(s => s.trim()).filter(Boolean);
      if (!prompts.length) { updateStatus('❌ 没有有效提示词', 'error'); return; }

      state.prompts = prompts;
      state.autoDownload = document.getElementById('mmb-auto-download').checked;
      state.downloadFolder = document.getElementById('mmb-download-folder').value.trim() || 'MiniMaxMusic';
      state.current = 0;
      state.running = true;
      state.paused  = false;

      const startBtn = document.getElementById('mmb-start-btn');
      const pauseBtn = document.getElementById('mmb-pause-btn');
      const stopBtn  = document.getElementById('mmb-stop-btn');
      startBtn.disabled    = true;
      startBtn.textContent = '执行中…';
      pauseBtn.style.display = 'inline-flex';
      stopBtn.style.display  = 'inline-flex';

      updateProgressBar();
      runNext();
    });

    // 仅批量下载按钮
    document.getElementById('mmb-download-only-btn').addEventListener('click', () => {
      if (state.running) return;
      state.autoDownload = document.getElementById('mmb-auto-download').checked;
      state.downloadFolder = document.getElementById('mmb-download-folder').value.trim() || 'MiniMaxMusic';
      
      if (!state.autoDownload) {
        if (confirm('尚未开启“自动下载”开关，是否立即开启并开始下载？')) {
           document.getElementById('mmb-auto-download').checked = true;
           state.autoDownload = true;
        } else {
           return;
        }
      }
      
      startBatchDownloadOnly();
    });

    // 暂停/继续
    document.getElementById('mmb-pause-btn').addEventListener('click', () => {
      const btn = document.getElementById('mmb-pause-btn');
      if (state.paused) {
        state.paused = false;
        btn.textContent = '⏸ 暂停';
        updateStatus('▶ 继续执行…', 'running');
        if (!state.pollTimer) runNext();
      } else {
        state.paused = true;
        btn.textContent = '▶ 继续';
        updateStatus('⏸ 已暂停', 'idle');
      }
    });

    // 停止
    document.getElementById('mmb-stop-btn').addEventListener('click', stopBatch);
  }

  // ─────────────────────────────────────────
  //  UI 更新方法
  // ─────────────────────────────────────────
  function updateStatus(msg, type = 'idle') {
    const el = document.getElementById('mmb-status');
    if (!el) return;
    el.textContent = msg;
    el.className   = '';
    el.classList.add('mmb-status-' + type);
  }

  function updateProgressBar() {
    const fill = document.getElementById('mmb-progress-fill');
    const text = document.getElementById('mmb-progress-text');
    if (!fill || !text) return;
    const total = state.prompts.length || 0;
    const done  = Math.min(state.current, total);
    fill.style.width = total > 0 ? (done / total * 100) + '%' : '0%';
    text.textContent = `${done} / ${total}`;
  }

  // ─────────────────────────────────────────
  //  样式注入
  // ─────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'mmb-styles';
    style.textContent = `
      #mmb-panel {
        position: fixed;
        right: 20px;
        bottom: 80px;
        width: 340px;
        background: #13131f;
        border: 1px solid rgba(108, 99, 255, 0.3);
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(108,99,255,0.1);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
        font-size: 13px;
        color: #e0e0f0;
        overflow: hidden;
        backdrop-filter: blur(12px);
      }
      #mmb-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 11px 14px;
        background: linear-gradient(135deg, #6c63ff 0%, #3b82f6 100%);
        cursor: move;
        user-select: none;
      }
      #mmb-title {
        font-weight: 700;
        font-size: 14px;
        color: #fff;
        letter-spacing: 0.3px;
      }
      #mmb-collapse-btn {
        cursor: pointer;
        color: rgba(255,255,255,0.75);
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 6px;
        transition: background 0.15s;
        line-height: 1.8;
      }
      #mmb-collapse-btn:hover { background: rgba(255,255,255,0.2); }

      #mmb-body {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 9px;
      }
      .mmb-row {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #e0e0f0;
        font-size: 12px;
      }
      .mmb-row input[type="text"] { font-size: 12px; outline: none; border: 1px solid rgba(255,255,255,0.1); }
      .mmb-row input[type="text"]:focus { border-color: #6c63ff; }
      .mmb-label {
        display: flex;
        align-items: baseline;
        gap: 6px;
        font-size: 12px;
        font-weight: 600;
        color: #9090b0;
      }
      .mmb-label small {
        font-weight: 400;
        font-size: 11px;
        opacity: 0.7;
      }
      #mmb-prompts {
        width: 100%;
        height: 120px;
        background: #0c0c18;
        border: 1px solid rgba(108,99,255,0.2);
        border-radius: 10px;
        color: #dde0f5;
        font-size: 12px;
        padding: 9px 10px;
        resize: vertical;
        outline: none;
        line-height: 1.7;
        box-sizing: border-box;
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        transition: border-color 0.2s;
      }
      #mmb-prompts:focus { border-color: rgba(108,99,255,0.6); }
      #mmb-prompts::placeholder { color: #444466; }

      #mmb-info-row {
        display: flex;
        justify-content: flex-end;
        font-size: 11px;
        color: #606080;
      }
      #mmb-prompt-count { color: #7c72ff; }

      #mmb-controls {
        display: flex;
        gap: 7px;
      }
      #mmb-controls button {
        flex: 1;
        padding: 7px 8px;
        border: none;
        border-radius: 9px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        transition: all 0.18s;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        letter-spacing: 0.2px;
      }
      #mmb-start-btn {
        background: linear-gradient(135deg, #6c63ff, #3b82f6);
        color: #fff;
        box-shadow: 0 2px 12px rgba(108,99,255,0.35);
      }
      #mmb-start-btn:hover:not(:disabled) {
        filter: brightness(1.12);
        box-shadow: 0 4px 18px rgba(108,99,255,0.5);
        transform: translateY(-1px);
      }
      #mmb-start-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }
      #mmb-pause-btn {
        background: rgba(245, 158, 11, 0.1);
        color: #f59e0b;
        border: 1px solid rgba(245,158,11,0.25);
      }
      #mmb-pause-btn:hover { background: rgba(245,158,11,0.18); }
      #mmb-stop-btn {
        background: rgba(239, 68, 68, 0.1);
        color: #f87171;
        border: 1px solid rgba(239,68,68,0.25);
      }
      #mmb-stop-btn:hover { background: rgba(239,68,68,0.18); }

      #mmb-progress-wrap {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      #mmb-progress-bar {
        flex: 1;
        height: 5px;
        background: rgba(255,255,255,0.06);
        border-radius: 3px;
        overflow: hidden;
      }
      #mmb-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #6c63ff, #3b82f6);
        border-radius: 3px;
        width: 0%;
        transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
      }
      #mmb-progress-text {
        font-size: 11px;
        color: #6060a0;
        white-space: nowrap;
        min-width: 38px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      #mmb-status {
        padding: 7px 10px;
        border-radius: 8px;
        font-size: 12px;
        background: rgba(0,0,0,0.25);
        line-height: 1.6;
        word-break: break-all;
        min-height: 32px;
        border: 1px solid rgba(255,255,255,0.04);
      }
      .mmb-status-idle    { color: #6060a0; }
      .mmb-status-running { color: #60a5fa; }
      .mmb-status-success { color: #34d399; }
      .mmb-status-warn    { color: #fbbf24; }
      .mmb-status-error   { color: #f87171; }
      .mmb-status-done    {
        color: #a78bfa;
        font-weight: 700;
      }
    `;
    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────
  //  初始化（等待 React 渲染完成）
  // ─────────────────────────────────────────
  function init() {
    if (document.getElementById('mmb-panel')) return;
    if (!document.querySelector('#music-styles-input')) {
      setTimeout(init, 800);
      return;
    }
    createUI();
  }

  // 页面加载后延迟注入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, INJECT_DELAY));
  } else {
    setTimeout(init, INJECT_DELAY);
  }

  // 监听 SPA 路由变化（URL 变化时重新检查并注入）
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, INJECT_DELAY + 500);
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
