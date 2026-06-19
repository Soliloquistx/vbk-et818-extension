/**
 * VBK 订单详情页抓取脚本
 * 
 * 自动检测订单详情页，解析 DOM，存入 chrome.storage。
 * 
 * By 飞鱼
 */

(function () {
  'use strict';

  const SCRAPE_DELAY = 5000;
  const RETRY_INTERVAL = 2000;
  const MAX_RETRIES = 3;
  const STORAGE_KEY = 'vbk_orders';

  let lastScrapedUrl = '';
  let isScraping = false;

  // ── 主逻辑 ────────────────────────────────────────────────────

  function init() {
    if (isOrderDetailPage()) scheduleScrape();
    observeUrlChange(() => {
      if (isOrderDetailPage()) scheduleScrape();
    });
  }

  function isOrderDetailPage() {
    const url = location.href;
    return url.includes('orderDetail') || url.includes('holdOrderDetail');
  }

  function scheduleScrape() {
    if (location.href === lastScrapedUrl || isScraping) return;
    isScraping = true;
    showNotification('⏳', '正在抓取 VBK 订单数据…');

    setTimeout(async () => {
      try {
        await doScrape();
      } catch (e) {
        console.error('[VBK Scraper] 抓取失败:', e);
        showNotification('❌', '抓取失败: ' + e.message);
      } finally {
        isScraping = false;
      }
    }, SCRAPE_DELAY);
  }

  async function doScrape() {
    // Step 1: 如果加密信息还没解开，点击解密并轮询等待
    if (VBKParser.isInfoHidden()) {
      const clicked = VBKParser.clickRevealEncrypted();
      if (clicked) {
        showNotification('🔓', '已点击解密，等待数据加载…');
        const revealed = await VBKParser.waitForDecrypt(15000);
        if (!revealed) {
          showNotification('⚠️', '解密超时，部分数据可能不完整');
        }
      }
    }

    // Step 2: 解析 + 重试
    let data = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      data = VBKParser.parse();

      // 调试：详细输出到 Console（F12 可见）
      console.group(`[VBK Scraper] 解析 attempt ${attempt}`);
      console.log('订单号:', data?.order_no);
      console.log('产品:', data?.product_name);
      console.log('模板:', data?.route_name);
      console.log('日期:', data?.departure_date, '→', data?.return_date);
      console.log('联系人:', data?.customer_name);
      console.log('渠道:', data?.channel);
      console.log('出发城市:', data?.departure_city);
      console.log('大交通:', data?.transport_type);
      console.log('用房:', data?.room_info);
      console.log('总计:', data?.total_amount);
      console.log('加密状态:', data?.encrypted_hidden ? '🔒 未解密' : '🔓 已解密');
      console.log('航班:', data?.flights);
      console.log('接送:', data?.pickup_dropoff);
      console.table(data?.travellers?.map(t => ({
        姓名: t.name,
        性别: t.gender,
        类型: t.person_type,
        证件号: t.id_no || '(空)',
        电话: t.phone || '(空)',
        生日: t.birth_date ? `${t.birth_date.year}-${t.birth_date.month}-${t.birth_date.day}` : '(空)',
        拼房: t.room_sharing,
      })));
      console.log('has_real_id:', data?.travellers?.some(t => t.id_no && /\d{15,18}/.test(t.id_no)));
      console.log('has_phone:', data?.travellers?.some(t => t.phone && t.phone.length >= 11));
      console.groupEnd();

      // 关键字段检查：有 order_no 且至少有 1 个客人（或明确无客人）
      if (data?.order_no) {
        // 如果加密信息应该已解开但客人数据还是空的，重试
        const hasUsefulData = data.travellers?.length > 0 ||
                              data.customer_name ||
                              data.departure_date;
        if (hasUsefulData) break;

        if (attempt < MAX_RETRIES) {
          console.log('[VBK Scraper] 数据不完整，' + RETRY_INTERVAL + 'ms 后重试…');
          await sleep(RETRY_INTERVAL);
        }
      } else if (attempt < MAX_RETRIES) {
        console.log('[VBK Scraper] 未找到订单号，' + RETRY_INTERVAL + 'ms 后重试…');
        await sleep(RETRY_INTERVAL);
      }
    }

    if (!data || !data.order_no) {
      showNotification('⚠️', '未检测到订单数据，请确认页面已加载');
      return;
    }

    return saveOrder(data);
  }

  async function saveOrder(data) {
    data.scraped_at = Date.now();
    data.source_url = location.href;

    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const orders = stored[STORAGE_KEY] || {};
    orders[data.order_no] = data;

    const keys = Object.keys(orders);
    if (keys.length > 20) {
      const sorted = keys.sort((a, b) =>
        (orders[b].scraped_at || 0) - (orders[a].scraped_at || 0)
      );
      sorted.slice(20).forEach(k => delete orders[k]);
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: orders });

    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      count: Object.keys(orders).length,
    });

    lastScrapedUrl = location.href;

    const tCount = data.travellers ? data.travellers.length : 0;
    const fCount = data.flights ? data.flights.length : 0;
    const idCount = data.travellers ? data.travellers.filter(t => t.id_no && /\d{15,18}/.test(t.id_no)).length : 0;
    const phoneCount = data.travellers ? data.travellers.filter(t => t.phone && t.phone.length >= 11).length : 0;
    const info = [
      `订单号: ${data.order_no}`,
      `客人: ${tCount}人(${idCount}有证件${phoneCount}有电话)`,
      fCount > 0 ? `航班: ${fCount}段` : null,
      data.total_amount ? `总计: ¥${data.total_amount}` : null,
    ].filter(Boolean).join(' | ');

    showNotification('✅', `已抓取 → ${info}`);
  }

  // ── 手动重新抓取按钮 ──────────────────────────────────────────

  function addRescrapeButton() {
    if (document.getElementById('vbk-rescrape-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'vbk-rescrape-btn';
    btn.className = 'vbk-float-btn';
    btn.textContent = '🔄 重新抓取';
    btn.title = '重新抓取当前订单数据';
    btn.onclick = () => {
      lastScrapedUrl = '';
      isScraping = false;
      scheduleScrape();
    };
    document.body.appendChild(btn);
  }

  // ── 调试面板 ──────────────────────────────────────────────────

  function addDebugButton() {
    if (document.getElementById('vbk-debug-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'vbk-debug-btn';
    btn.className = 'vbk-float-btn';
    btn.style.bottom = '120px';
    btn.textContent = '🔍 调试';
    btn.title = '查看解析数据';
    btn.onclick = () => toggleDebugPanel();
    document.body.appendChild(btn);
  }

  let debugPanel = null;

  function toggleDebugPanel() {
    if (debugPanel) {
      debugPanel.remove();
      debugPanel = null;
      return;
    }
    debugPanel = document.createElement('div');
    debugPanel.id = 'vbk-debug-panel';
    debugPanel.innerHTML = `
      <div class="vbk-debug-header">
        <span>🔍 VBK 调试面板</span>
        <button onclick="this.closest('#vbk-debug-panel').remove()">✕</button>
      </div>
      <div class="vbk-debug-body" id="vbk-debug-body">点击「刷新数据」解析当前页面</div>
      <div class="vbk-debug-actions">
        <button id="vbk-debug-refresh">🔄 刷新数据</button>
        <button id="vbk-debug-raw">📋 原始文本</button>
        <button id="vbk-debug-decrypt">🔓 测试解密</button>
      </div>
    `;
    document.body.appendChild(debugPanel);

    document.getElementById('vbk-debug-refresh').onclick = () => refreshDebugData();
    document.getElementById('vbk-debug-raw').onclick = () => showRawText();
    document.getElementById('vbk-debug-decrypt').onclick = () => testDecrypt();
  }

  async function refreshDebugData() {
    const body = document.getElementById('vbk-debug-body');
    if (!body) return;
    body.innerHTML = '⏳ 解析中…';

    const data = VBKParser.parse();
    if (!data) {
      body.innerHTML = '<div class="vbk-debug-err">❌ 未检测到订单数据（非 VBK 订单页？）</div>';
      return;
    }

    // 加密状态
    const encStatus = data.encrypted_hidden
      ? '<span class="dbg-warn">🔒 加密未解密</span>'
      : '<span class="dbg-ok">🔓 已解密</span>';

    // 客人详情
    let travellerHtml = '';
    if (data.travellers?.length) {
      travellerHtml = data.travellers.map((t, i) => {
        const idOk = t.id_no && /\d{15,18}/.test(t.id_no);
        const phoneOk = t.phone && t.phone.length >= 11;
        const birthOk = t.birth_date?.year;
        return `
          <div class="dbg-person">
            <div class="dbg-person-name">${i + 1}. ${t.name} <span class="dbg-tag">${t.person_type || '成人'}</span> ${t.gender || ''}</div>
            <div class="dbg-field">证件号: <span class="${idOk ? 'dbg-ok' : 'dbg-miss'}">${t.id_no || '(空)'}</span></div>
            <div class="dbg-field">电话: <span class="${phoneOk ? 'dbg-ok' : 'dbg-miss'}">${t.phone || '(空)'}</span></div>
            <div class="dbg-field">生日: <span class="${birthOk ? 'dbg-ok' : 'dbg-miss'}">${t.birth_date?.year || '****'}-${t.birth_date?.month || '**'}-${t.birth_date?.day || '**'}</span></div>
            <div class="dbg-field">拼房: ${t.room_sharing || '(空)'} ${t.room_sharing_type || ''}</div>
          </div>
        `;
      }).join('');
    } else {
      travellerHtml = '<div class="dbg-miss">无客人数据</div>';
    }

    // 航班
    let flightHtml = '无';
    if (data.flights?.length) {
      flightHtml = data.flights.map(f => `${f.flight_no} ${f.departure_time || ''}`).join('<br>');
    }

    body.innerHTML = `
      <div class="dbg-section">
        <div class="dbg-label">订单</div>
        <div>${data.order_no} | ${data.order_type} | ${encStatus}</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">产品</div>
        <div>${data.product_name || '-'}</div>
        <div class="dbg-sub">模板: ${data.route_name || '-'}</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">日期</div>
        <div>出发: ${data.departure_date || '-'} → 返回: ${data.return_date || '-'}</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">联系人</div>
        <div>${data.customer_name || '-'} | 渠道: ${data.channel || '-'}</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">出发城市 / 大交通</div>
        <div>${data.departure_city || '-'} / ${data.transport_type || '-'}</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">用房</div>
        <div>${data.room_info?.star_rating || '-'} | ${data.room_info?.room_type || '-'} | ${data.room_info?.room_count || 0} 间</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">总计</div>
        <div>¥${data.total_amount || '-'}</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">航班 (${data.flights?.length || 0})</div>
        <div>${flightHtml}</div>
      </div>
      <div class="dbg-section">
        <div class="dbg-label">接送 (${data.pickup_dropoff?.length || 0})</div>
        ${data.pickup_dropoff?.length ? data.pickup_dropoff.map(s =>
          `<div>${s.direction} ${s.flight_no} ${s.register_airport} ${s.register_time}</div>`
        ).join('') : '<div>无</div>'}
      </div>
      <div class="dbg-section">
        <div class="dbg-label">客人 (${data.travellers?.length || 0})</div>
        ${travellerHtml}
      </div>
      <div class="dbg-section">
        <div class="dbg-label">备注</div>
        <div>${data.merchant_note || '(空)'}</div>
      </div>
    `;
  }

  function showRawText() {
    const body = document.getElementById('vbk-debug-body');
    if (!body) return;
    const text = document.body.innerText;
    // 截取出行人区域
    const start = text.indexOf('出行人');
    const end = text.indexOf('物流单', start);
    const section = start >= 0
      ? text.substring(start, end > start ? end : start + 2000)
      : text.substring(0, 3000);
    body.innerHTML = `
      <div class="dbg-section">
        <div class="dbg-label">出行人区域原始文本</div>
        <pre class="dbg-raw">${section.replace(/</g, '&lt;')}</pre>
      </div>
    `;
  }

  async function testDecrypt() {
    const body = document.getElementById('vbk-debug-body');
    if (!body) return;

    const hidden = VBKParser.isInfoHidden();
    body.innerHTML = `<div class="dbg-section">加密状态: ${hidden ? '🔒 需要解密' : '🔓 已解密'}</div>`;

    if (hidden) {
      body.innerHTML += '<div class="dbg-section">⏳ 正在点击解密…</div>';
      VBKParser.clickRevealEncrypted();
      body.innerHTML += '<div class="dbg-section">⏳ 等待数据加载…</div>';
      const ok = await VBKParser.waitForDecrypt(15000);
      body.innerHTML += `<div class="dbg-section">${ok ? '✅ 解密成功' : '⚠️ 解密超时'}</div>`;
      // 自动刷新数据
      setTimeout(() => refreshDebugData(), 500);
    }
  }

  // ── URL 变化监听（SPA） ───────────────────────────────────────

  function observeUrlChange(callback) {
    window.addEventListener('popstate', callback);
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(callback, 100);
    };
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(callback, 100);
    };
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(callback, 200);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── 通知 ──────────────────────────────────────────────────────

  function showNotification(icon, message) {
    const old = document.getElementById('vbk-scraper-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.id = 'vbk-scraper-toast';
    toast.className = 'vbk-toast';
    toast.innerHTML = `<span class="vbk-toast-icon">${icon}</span> ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('vbk-toast-fade');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── 启动 ──────────────────────────────────────────────────────

  if (document.readyState === 'complete') {
    init();
    if (isOrderDetailPage()) { addRescrapeButton(); addDebugButton(); }
  } else {
    window.addEventListener('load', () => {
      init();
      if (isOrderDetailPage()) { addRescrapeButton(); addDebugButton(); }
    });
  }
})();
