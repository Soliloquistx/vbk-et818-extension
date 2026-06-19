/**
 * ET818 悬浮面板 + 一键填表引擎
 *
 * 在 ET818 页面注入悬浮面板，展示 VBK 订单数据，
 * 点击「一键填表」后直接操作 DOM 完成表单填充。
 *
 * 关键难点：
 * - ET818 是 SysMain 父框架 + iframe 子页面结构
 * - 搜索型下拉 (.dropdown-item) 渲染在父框架 document
 * - 日期是三段式 input（年/月/日）
 *
 * By 飞鱼
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'vbk_orders';
  let currentOrder = null;
  let panel = null;

  // ── 初始化 ────────────────────────────────────────────────────

  async function init() {
    // 读取 storage 中的 VBK 订单数据
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const orders = stored[STORAGE_KEY] || {};
    const orderList = Object.values(orders)
      .sort((a, b) => (b.scraped_at || 0) - (a.scraped_at || 0));

    if (orderList.length === 0) return; // 没有数据就不注入面板

    currentOrder = orderList[0]; // 默认用最新一条
    buildPanel(orderList);

    // 监听 storage 变化，实时刷新面板
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[STORAGE_KEY]) {
        const updated = changes[STORAGE_KEY].newValue || {};
        const list = Object.values(updated)
          .sort((a, b) => (b.scraped_at || 0) - (a.scraped_at || 0));
        if (list.length > 0) {
          currentOrder = list[0];
          updatePanelSummary(list);
        }
      }
    });
  }

  // ── 面板构建 ──────────────────────────────────────────────────

  function buildPanel(orderList) {
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'vbk-et818-panel';
    panel.innerHTML = `
      <div class="vbk-panel-header" id="vbk-panel-drag">
        <span class="vbk-panel-title">🔷 VBK 订单数据</span>
        <div class="vbk-panel-controls">
          <button id="vbk-panel-collapse" title="折叠">—</button>
          <button id="vbk-panel-close" title="关闭">✕</button>
        </div>
      </div>
      <div class="vbk-panel-body" id="vbk-panel-body">
        <div id="vbk-panel-summary"></div>
        ${orderList.length > 1 ? `
          <div class="vbk-panel-orders">
            <select id="vbk-order-select">
              ${orderList.map((o, i) =>
                `<option value="${i}" ${i === 0 ? 'selected' : ''}>
                  ${o.order_no} — ${o.product_name || '未知产品'}
                </option>`
              ).join('')}
            </select>
          </div>
        ` : ''}
        <div class="vbk-panel-actions">
          <button id="vbk-fill-all" class="vbk-btn-primary">⚡ 一键填表</button>
          <button id="vbk-fill-guest" class="vbk-btn-secondary">👥 仅填客人</button>
          <button id="vbk-clear" class="vbk-btn-ghost">清空</button>
        </div>
        <div id="vbk-panel-log" class="vbk-panel-log"></div>
      </div>
    `;

    document.body.appendChild(panel);
    updatePanelSummary(orderList);
    bindPanelEvents(orderList);
    makeDraggable(panel, panel.querySelector('.vbk-panel-header'));
  }

  function updatePanelSummary(orderList) {
    const el = document.getElementById('vbk-panel-summary');
    if (!el || !currentOrder) return;

    const o = currentOrder;
    const tCount = o.travellers ? o.travellers.length : 0;
    const names = o.travellers
      ? o.travellers.slice(0, 4).map(t => t.name).join('、') + (tCount > 4 ? ` 等${tCount}人` : '')
      : '无';
    const fCount = o.flights ? o.flights.length : 0;
    const flightInfo = fCount > 0
      ? o.flights.map(f => f.flight_no).join(' / ')
      : '无航班';
    const pickupCount = o.pickup_dropoff ? o.pickup_dropoff.length : 0;

    // 客人详情
    const travellerDetails = o.travellers
      ? o.travellers.map((t, i) => {
          const share = t.room_sharing === '是' ? '拼房' : t.room_sharing === '否' ? '不拼' : '';
          return `${i + 1}.${t.name} ${t.gender || ''} ${t.person_type || ''} ${share ? '[' + share + ']' : ''}`;
        }).join('<br>  ')
      : '';

    el.innerHTML = `
      <div class="vbk-summary-row"><span class="vk">订单号</span><span class="vv">${o.order_no}</span></div>
      <div class="vbk-summary-row"><span class="vk">产品</span><span class="vv">${o.route_name || o.product_name || '-'}</span></div>
      <div class="vbk-summary-row"><span class="vk">日期</span><span class="vv">${o.departure_date || '-'} → ${o.return_date || '-'}</span></div>
      <div class="vbk-summary-row"><span class="vk">城市</span><span class="vv">${o.departure_city || '-'} / ${o.transport_type || '-'}</span></div>
      <div class="vbk-summary-row"><span class="vk">渠道</span><span class="vv">${o.channel || '携程83(默认)'}</span></div>
      <div class="vbk-summary-row"><span class="vk">电话/姓名</span><span class="vv">${o.customer_name || '-'}</span></div>
      <div class="vbk-summary-row"><span class="vk">参团</span><span class="vv">${tCount} 人</span></div>
      <div class="vbk-summary-row"><span class="vk">客人</span><span class="vv">${names}</span></div>
      ${travellerDetails ? `<div class="vbk-summary-row" style="font-size:11px;color:#888;"><span class="vk">详情</span><span class="vv">${travellerDetails}</span></div>` : ''}
      <div class="vbk-summary-row"><span class="vk">航班</span><span class="vv">${flightInfo}</span></div>
      ${pickupCount > 0 ? `<div class="vbk-summary-row"><span class="vk">接送</span><span class="vv">${pickupCount} 段</span></div>` : ''}
      ${o.room_info ? `<div class="vbk-summary-row"><span class="vk">用房</span><span class="vv">${o.room_info.star_rating || ''} ${o.room_info.biao > 0 ? o.room_info.biao + '标间' : ''} ${o.room_info.dachuang > 0 ? o.room_info.dachuang + '大床' : ''}</span></div>` : ''}
      ${o.merchant_note ? `<div class="vbk-summary-row"><span class="vk">备注</span><span class="vv">${o.merchant_note.substring(0, 30)}</span></div>` : ''}
      ${o.total_amount ? `<div class="vbk-summary-row"><span class="vk">总计</span><span class="vv">¥${o.total_amount}</span></div>` : ''}
      ${o.encrypted_hidden ? '<div class="vbk-summary-warn">⚠️ 加密未解密</div>' : ''}
    `;
  }

  function bindPanelEvents(orderList) {
    // 关闭
    document.getElementById('vbk-panel-close')?.addEventListener('click', () => {
      panel.style.display = 'none';
    });

    // 折叠
    document.getElementById('vbk-panel-collapse')?.addEventListener('click', () => {
      const body = document.getElementById('vbk-panel-body');
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    // 切换订单
    document.getElementById('vbk-order-select')?.addEventListener('change', (e) => {
      currentOrder = orderList[parseInt(e.target.value)];
      updatePanelSummary(orderList);
    });

    // 一键填表
    document.getElementById('vbk-fill-all')?.addEventListener('click', () => {
      if (!currentOrder) return log('❌ 没有可用订单数据');
      fillAll(currentOrder);
    });

    // 仅填客人
    document.getElementById('vbk-fill-guest')?.addEventListener('click', () => {
      if (!currentOrder) return log('❌ 没有可用订单数据');
      fillTravellers(currentOrder);
    });

    // 清空
    document.getElementById('vbk-clear')?.addEventListener('click', async () => {
      await chrome.storage.local.remove(STORAGE_KEY);
      log('🗑️ 已清空所有 VBK 数据');
      panel.querySelector('.vbk-panel-body').innerHTML =
        '<div class="vbk-empty">无数据，请先在 VBK 订单页抓取</div>';
    });
  }

  // ── 拖拽 ──────────────────────────────────────────────────────

  function makeDraggable(el, handle) {
    let isDragging = false, startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.left = (startLeft + e.clientX - startX) + 'px';
      el.style.top = (startTop + e.clientY - startY) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  ET818 填表引擎
  // ══════════════════════════════════════════════════════════════

  // ── 查找 ET818 iframe ─────────────────────────────────────────

  function findEt818Iframe() {
    const iframes = document.querySelectorAll('iframe');

    // 优先：按 src 精确匹配 AddDSN 新增页
    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (src.includes('AddDSN') || src.includes('PageType=add')) {
        try {
          const doc = iframe.contentDocument;
          if (doc && doc.body) return iframe;
        } catch (e) { /* 跨域 */ }
      }
    }

    // 兜底：按内容关键词匹配（找包含表单字段的 iframe）
    for (const iframe of iframes) {
      const src = iframe.src || '';
      // 跳过列表页和桌面页
      if (src.includes('ListRegDS') || src.includes('MyDesk') || src.includes('QryStat')) continue;
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.body &&
          (doc.body.innerText.includes('线路模板') ||
            doc.body.innerText.includes('订单电话'))) {
          return iframe;
        }
      } catch (e) { /* 跨域 */ }
    }

    // 如果表单直接在页面上（不在 iframe 里），返回 null
    if (document.body.innerText.includes('线路模板') && document.body.innerText.includes('参团人数')) {
      return null; // fillAll 会检测到这种情况
    }

    return null;
  }

  function getIframeDoc(iframe) {
    try {
      return iframe.contentDocument || iframe.contentWindow?.document;
    } catch (e) {
      return null;
    }
  }

  // ── 查找主信息表 ──────────────────────────────────────────────

  function findMainTable(doc) {
    const tables = doc.querySelectorAll('table');
    // 找含 "线路模板" 的表作为主信息表
    for (const t of tables) {
      const text = t.innerText || '';
      if (text.includes('线路模板')) return t;
    }
    // 兜底：找含 "订单电话" 的表
    for (const t of tables) {
      const text = t.innerText || '';
      if (text.includes('订单电话')) return t;
    }
    return null;
  }

  // ── 字段定位（label → 右侧 value cell） ──────────────────────

  function findFieldCell(table, labelText) {
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      for (let i = 0; i < cells.length - 1; i++) {
        if (cells[i].textContent.trim().includes(labelText)) {
          return cells[i + 1]; // 右侧 cell 是 value
        }
      }
    }
    return null;
  }

  // ── 直接输入 ──────────────────────────────────────────────────

  function _commitInput(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.blur();
  }

  function setDirectInput(cell, value) {
    if (!cell || value === undefined || value === null) return false;
    const input = cell.querySelector('input, textarea');
    if (!input) return false;

    _setVueInput(input, String(value));
    input.focus();
    _commitInput(input);
    return (input.value || '').trim() === String(value);
  }

  /**
   * 绕过 Vue/iView 响应式设置 input 值
   */
  function _setVueInput(input, value) {
    const inputWin = input.ownerDocument.defaultView;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      inputWin.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNumberInput(input, value) {
    if (!input) return false;
    _setVueInput(input, String(value));
    input.focus();
    _commitInput(input);
    return (input.value || '').trim() === String(value);
  }

  /**
   * 设置 et-date 日期组件
   * 内容脚本保留 isolated world，通过注入主世界脚本访问 Vue 实例
   */
  function _setEtDate(etDateEl, dateStr) {
    const ownerDoc = etDateEl && etDateEl.ownerDocument;
    if (!etDateEl || !dateStr || !ownerDoc) return { ok: false, detail: 'missing-args' };

    const dateParts = dateStr.split('-');
    const trigger = etDateEl.querySelector('.input-icon, .et-date-input, .padding-left, .input');
    if (trigger) {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    const segmentedInputs = Array.from(etDateEl.querySelectorAll('input[placeholder]')).slice(0, 3);
    if (dateParts.length === 3 && segmentedInputs.length >= 3) {
      const [year, month, day] = dateParts;
      _setVueInput(segmentedInputs[0], year || '');
      _setVueInput(segmentedInputs[1], (month || '').padStart(2, '0'));
      _setVueInput(segmentedInputs[2], (day || '').padStart(2, '0'));
      segmentedInputs[2].blur();

      const values = segmentedInputs.map(input => (input.value || '').trim());
      const vue = etDateEl.__vue__;
      if (vue && vue.inputDate) {
        vue.inputDate.year = year || '';
        vue.inputDate.month = (month || '').padStart(2, '0');
        vue.inputDate.date = (day || '').padStart(2, '0');
        try {
          if (typeof vue.changeDate === 'function') {
            vue.changeDate(dateStr);
          } else if (typeof vue.onConfirm === 'function') {
            vue.onConfirm(dateStr);
          }
        } catch (error) {
          console.warn('[ET818 Filler] date confirm failed:', error);
        }
      }

      const threePartOk = values[0] === (year || '')
        && values[1] === (month || '').padStart(2, '0')
        && values[2] === (day || '').padStart(2, '0');
      if (vue && vue.etValue === dateStr) {
        return { ok: true, detail: 'three-part+confirm' };
      }
      if (threePartOk) {
        return { ok: true, detail: 'three-part' };
      }
    }

    const markId = 'vbk_date_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    etDateEl.setAttribute('data-vbk-mark', markId);

    const script = ownerDoc.createElement('script');
    script.textContent = [
      '(function(){',
      '  var el = document.querySelector(\'[data-vbk-mark="' + markId + '"]\');',
      '  if (!el) return;',
      '  var result = "fail";',
      '  try {',
      '    var vue = el.__vue__;',
      '    if (vue && typeof vue.changeDate === "function") {',
      '      vue.changeDate("' + dateStr + '");',
      '      result = vue.etValue === "' + dateStr + '" ? "ok" : (vue.etValue || "mismatch");',
      '    } else {',
      '      var inputs = el.querySelectorAll("input");',
      '      if (inputs.length >= 3) {',
      '        var parts = "' + dateStr + '".split("-");',
      '        inputs[0].value = parts[0] || "";',
      '        inputs[1].value = (parts[1] || "").padStart(2, "0");',
      '        inputs[2].value = (parts[2] || "").padStart(2, "0");',
      '        inputs[0].dispatchEvent(new Event("input", { bubbles: true }));',
      '        inputs[1].dispatchEvent(new Event("input", { bubbles: true }));',
      '        inputs[2].dispatchEvent(new Event("input", { bubbles: true }));',
      '        result = "fallback";',
      '      }',
      '    }',
      '  } catch (error) {',
      '    result = "err:" + error.message;',
      '  }',
      '  el.setAttribute("data-vbk-ok", result);',
      '})();'
    ].join('\n');

    (ownerDoc.head || ownerDoc.body || ownerDoc.documentElement).appendChild(script);
    script.remove();

    const okVal = etDateEl.getAttribute('data-vbk-ok') || '';
    etDateEl.removeAttribute('data-vbk-mark');
    etDateEl.removeAttribute('data-vbk-ok');

    if (okVal === 'ok') return { ok: true, detail: okVal };
    if (okVal === `et=${dateStr}`) return { ok: true, detail: okVal };
    if (okVal === 'fallback') {
      const inputs = etDateEl.querySelectorAll('input');
      const [year, month, day] = dateStr.split('-');
      const ok = inputs.length >= 3
        && (inputs[0].value || '').trim() === (year || '')
        && (inputs[1].value || '').trim() === (month || '').padStart(2, '0')
        && (inputs[2].value || '').trim() === (day || '').padStart(2, '0');
      return { ok, detail: ok ? 'fallback' : `fallback-mismatch:${okVal}` };
    }
    return { ok: okVal === dateStr, detail: okVal || 'empty' };
  }

  // ── 三段日期 ──────────────────────────────────────────────────

  function setThreePartDate(cell, dateStr) {
    if (!cell || !dateStr) return false;
    const parts = dateStr.split('-');
    if (parts.length < 3) return false;

    const inputs = cell.querySelectorAll('input');
    if (inputs.length < 3) return false;

    // 年
    inputs[0].focus();
    inputs[0].value = parts[0];
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));

    // 月
    inputs[1].focus();
    inputs[1].value = parts[1].padStart(2, '0');
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].dispatchEvent(new Event('change', { bubbles: true }));

    // 日
    inputs[2].focus();
    inputs[2].value = parts[2].padStart(2, '0');
    inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[2].dispatchEvent(new Event('change', { bubbles: true }));

    inputs[2].blur();
    return true;
  }

  // ── 搜索型下拉（核心难题） ────────────────────────────────────

  async function setSearchableDropdown(iframeDoc, parentDoc, cell, keyword, fullValue, options = {}) {
    if (!cell) return false;

    const input = cell.querySelector('input[type="text"], input:not([type])');
    if (!input) return false;

    // Step 1: 清空并输入关键词
    input.focus();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);

    input.value = keyword;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);

    // Step 2: ArrowDown 触发候选刷新
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true
    }));
    await sleep(800);

    // Step 3: 在 iframe 和 parent 两处搜索候选
    let candidate = null;
    if (options.pick_first) {
      candidate = findFirstDropdownCandidate(iframeDoc);
      if (!candidate && parentDoc !== iframeDoc) {
        candidate = findFirstDropdownCandidate(parentDoc);
      }
    } else {
      candidate = findDropdownCandidate(iframeDoc, fullValue || keyword);
      if (!candidate && parentDoc !== iframeDoc) {
        candidate = findDropdownCandidate(parentDoc, fullValue || keyword);
      }
    }

    if (!candidate) {
      await sleep(1000);
      if (options.pick_first) {
        candidate = findFirstDropdownCandidate(iframeDoc);
        if (!candidate && parentDoc !== iframeDoc) {
          candidate = findFirstDropdownCandidate(parentDoc);
        }
      } else {
        candidate = findDropdownCandidate(iframeDoc, fullValue || keyword);
        if (!candidate && parentDoc !== iframeDoc) {
          candidate = findDropdownCandidate(parentDoc, fullValue || keyword);
        }
      }
    }

    if (!candidate) return false;

    // Step 4: 点击候选项
    clickCandidate(candidate);
    await sleep(options.after_select_wait || 500);

    // Step 5: 验证
    const committed = input.value;
    if (options.pick_first) {
      return !!committed.trim();
    }
    return committed.includes(keyword) || committed.includes(fullValue || '');
  }

  function findDropdownCandidate(doc, text) {
    const items = doc.querySelectorAll('.dropdown-item, .layui-anim dd, .chosen-results li');
    for (const item of items) {
      if (item.offsetParent === null) continue;
      if (item.textContent.trim().includes(text)) return item;
    }
    for (const item of items) {
      if (item.offsetParent === null) continue;
      const itemText = item.textContent.trim();
      if (text.includes(itemText) || itemText.includes(text.substring(0, 4))) return item;
    }
    return null;
  }

  function findFirstDropdownCandidate(doc) {
    const items = doc.querySelectorAll('.dropdown-item, .layui-anim dd, .chosen-results li');
    for (const item of items) {
      if (item.offsetParent === null) continue;
      const text = item.textContent.trim();
      if (text) return item;
    }
    return null;
  }

  function clickCandidate(el) {
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  // ── 原生 select ──────────────────────────────────────────────

  function setNativeSelect(cell, value) {
    if (!cell || !value) return false;
    const select = cell.querySelector('select');
    if (!select) return false;

    // 找到匹配的 option
    for (const opt of select.options) {
      if (opt.value === value || opt.textContent.trim() === value) {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    // 模糊匹配
    for (const opt of select.options) {
      if (opt.textContent.includes(value) || value.includes(opt.textContent.trim())) {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // ── 用房设置 ──────────────────────────────────────────────────

  function setRoomNeed(table, travellers) {
    // 用房字段通常在 "用房" label 右侧
    const cell = findFieldCell(table, '用房');
    if (!cell) return false;

    // 计算房需：根据拼房规则
    const roomCalc = calculateRoomNeed(travellers);

    // 尝试在 cell 里找到数字 input 并填入
    const inputs = cell.querySelectorAll('input[type="number"], input:not([type])');
    if (inputs.length > 0 && roomCalc.standard > 0) {
      inputs[0].focus();
      inputs[0].value = roomCalc.standard;
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      inputs[0].blur();
      return true;
    }
    return false;
  }

  /**
   * 用房计算（与 parser.extractRoomInfo 逻辑一致）
   * 返回 { biao: 标间数, dachuang: 大床数 }
   */
  function calculateRoomNeed(travellers) {
    if (!travellers || travellers.length === 0) return { biao: 0, dachuang: 0 };

    const n = travellers.length;
    const sharing = travellers.filter(t => t.room_sharing === '是');
    const notSharing = travellers.filter(t => t.room_sharing === '否');

    if (sharing.length === n) {
      return { biao: n * 0.5, dachuang: 0 };
    } else if (notSharing.length === n) {
      return { biao: Math.floor(n / 2), dachuang: n % 2 };
    }
    return { biao: Math.ceil(n / 2), dachuang: 0 };
  }

  // ══════════════════════════════════════════════════════════════
  //  主填表流程
  // ══════════════════════════════════════════════════════════════

  async function fillAll(order) {
    log('⚡ 开始一键填表…');

    const ADDSN_URL = 'https://t16.et818.com/XWJ/PlanReg/AddDSN/PlanMng.ListRegDSN1?PageType=add&RegID=0&BizMode=15';

    let iframe = findEt818Iframe();
    let doc = null;
    let parentDoc = document;

    if (iframe) {
      const src = iframe.src || '';
      // 检查是否已经在 AddDSN 页面
      if (!src.includes('AddDSN') && !src.includes('PageType=add')) {
        log('🔄 当前不在新增页，自动导航到 AddDSN…');
        iframe.src = ADDSN_URL;
        await sleep(3000);
        doc = getIframeDoc(iframe);
        if (!doc) {
          log('❌ 导航后无法访问 iframe');
          return;
        }
        log('✅ 已导航到新增页, tables: ' + doc.querySelectorAll('table').length);
      } else {
        log('✅ 已在新增页: ' + src.substring(0, 60));
        doc = getIframeDoc(iframe);
        if (!doc) {
          log('❌ 无法访问 iframe 内容（可能是跨域限制）');
          return;
        }
      }

      // 已在 AddDSN 页面 → 直接填表（不再点"保存并新增"）
      log('✅ 新增表单已就绪, tables: ' + doc.querySelectorAll('table').length);
    } else {
      // 没找到 AddDSN iframe → 尝试找到主内容区 iframe 并导航
      log('ℹ️ 未找到 AddDSN iframe，尝试导航主内容区…');
      const mainIframe = document.querySelector('#LAY_app_body iframe, .layadmin-tabsbody-item iframe');
      if (mainIframe) {
        mainIframe.src = ADDSN_URL;
        await sleep(3000);
        iframe = mainIframe;
        doc = getIframeDoc(iframe);
        if (!doc) {
          log('❌ 导航后无法访问 iframe');
          return;
        }
        log('✅ 已导航到新增页, tables: ' + doc.querySelectorAll('table').length);
      } else {
        log('❌ 找不到任何可导航的 iframe');
        return;
      }
    }

    let mainTable = findMainTable(doc);
    if (!mainTable) {
      log('❌ 未找到主信息表，tables count: ' + doc.querySelectorAll('table').length);
      // 列出所有 table 的关键词
      doc.querySelectorAll('table').forEach((t, i) => {
        const txt = (t.innerText || '').substring(0, 60).replace(/\s+/g, ' ');
        log('  T' + i + ': ' + txt);
      });
      return;
    }
    log('✅ 主信息表已定位, rows: ' + mainTable.querySelectorAll('tr').length);

    let successCount = 0;
    let failCount = 0;
    // ── Step 1: 线路模板 ──────────────────────────────────────
    // 必须先自动选中模板第一个候选，页面结构会随之变化
    let templateKeyword = '';
    const rn = order.route_name || order.product_name || '';
    if (rn) {
      const dayMatch = rn.match(/([\d]+)[日天]/);
      const prefix = rn.split(/[-\u3010【]/)[0];
      if (dayMatch) {
        templateKeyword = (prefix || rn).substring(0, 4) + dayMatch[1];
      } else {
        templateKeyword = rn.substring(0, 4);
      }
    }
    if (templateKeyword) {
      const cell = findFieldCell(mainTable, '线路模板');
      if (cell) {
        log(`🔍 搜索线路模板: "${templateKeyword}"`);
        const templateOk = await setSearchableDropdown(doc, parentDoc, cell, templateKeyword, templateKeyword, {
          pick_first: true,
          after_select_wait: 1200,
        });
        if (templateOk) {
          log('  ✅ 线路模板: 已选择第一个候选');
          successCount++;
          await sleep(1200);
          const refreshedMainTable = findMainTable(doc);
          if (refreshedMainTable) {
            mainTable = refreshedMainTable;
            log('  ✅ 线路模板选择后已重新定位主信息表');
          }
        } else {
          log(`  ⚠️ 线路模板未选中: ${templateKeyword}`);
          failCount++;
        }
      }
    }

    // ── Step 2: 日期字段 ─────────────────────────────────────
    // world: MAIN 可直接访问 Vue 实例，无需脚本注入
    const dateFields = [
      { label: '出团日期', value: order.departure_date },
      { label: '返程日期', value: order.return_date },
    ];
    for (const f of dateFields) {
      if (!f.value) continue;
      const cell = findFieldCell(mainTable, f.label);
      if (!cell) { log(`  ⚠️ ${f.label} 未找到单元格`); failCount++; continue; }
      const etDate = cell.querySelector('.et-date');
      if (!etDate) {
        const ok = setThreePartDate(cell, f.value);
        if (ok) { log(`  ✅ ${f.label}: ${f.value}`); successCount++; }
        else { log(`  ⚠️ ${f.label} 写入失败`); failCount++; }
        continue;
      }

      const dateResult = _setEtDate(etDate, f.value);
      if (dateResult.ok) { log(`  ✅ ${f.label}: ${f.value}`); successCount++; }
      else { log(`  ⚠️ ${f.label} 写入失败 [${dateResult.detail}]`); failCount++; }
    }

    // ── Step 3: 直接输入字段 ──────────────────────────────────
    const directFields = [
      { label: '订单电话/姓名', value: order.customer_name },
      { label: '订单号', value: order.order_no },
      { label: '景区订单号', value: order.order_no },
    ];
    for (const f of directFields) {
      if (!f.value) continue;
      const cell = findFieldCell(mainTable, f.label);
      const ok = setDirectInput(cell, f.value);
      if (ok) { log(`  ✅ ${f.label}: ${f.value}`); successCount++; }
      else { log(`  ⚠️ ${f.label} 写入失败`); failCount++; }
    }

    // ── Step 4: 搜索型下拉 ───────────────────────────────────

    // 大交通：优先 parser 判断；无航班时默认“当地参”作为兜底
    {
      const transportValue = order.transport_type || '当地参';
      const cell = findFieldCell(mainTable, '大交通');
      const ok = await setSearchableDropdown(doc, parentDoc, cell, transportValue, transportValue);
      if (ok) { log(`  ✅ 大交通: ${transportValue}`); successCount++; }
      else { log(`  ⚠️ 大交通未选中: ${transportValue}`); failCount++; }
    }

    // 团队类别：默认快拼团
    {
      const cell = findFieldCell(mainTable, '团队类别');
      const ok = await setSearchableDropdown(doc, parentDoc, cell, '快拼团', '快拼团');
      if (ok) { log(`  ✅ 团队类别: 快拼团`); successCount++; }
      else { log(`  ⚠️ 团队类别未选中`); failCount++; }
    }

    // 收客渠道：默认携程83（门店单→携程门店83）
    {
      const channelKeyword = order.channel || '携程83';
      const cell = findFieldCell(mainTable, '收客渠道');
      const ok = await setSearchableDropdown(doc, parentDoc, cell, channelKeyword.substring(0, 3), channelKeyword);
      if (ok) { log(`  ✅ 收客渠道: ${channelKeyword}`); successCount++; }
      else { log(`  ⚠️ 收客渠道未选中: ${channelKeyword}`); failCount++; }
    }

    // ── Step 5: 参团人数 ─────────────────────────────────────
    if (order.travellers?.length) {
      const cell = findFieldCell(mainTable, '参团人数');
      const adults = order.travellers.filter(t => t.person_type === '成人').length;
      const children = order.travellers.filter(t => t.person_type === '儿童').length;
      const countStr = children > 0 ? `${adults}大${children}小` : `${adults}`;
      const ok = setDirectInput(cell, countStr);
      if (ok) { log(`  ✅ 参团人数: ${countStr}`); successCount++; }
      else { log('  ⚠️ 参团人数写入失败'); failCount++; }
    }

    // ── Step 5.5: 销售 ──────────────────────────────────────
    {
      const cell = findFieldCell(mainTable, '销售');
      if (cell) {
        const ok = setDirectInput(cell, '李明强');
        if (ok) { log('  ✅ 销售: 李明强'); successCount++; }
        else { log('  ⚠️ 销售写入失败'); failCount++; }
      }
    }

    // ── Step 6: 用房 ─────────────────────────────────────────
    // ET818 用房结构: [星级下拉] [标间数] [大床数] [三人间数] [单女] [单男] [晚]
    if (order.room_info || order.travellers?.length) {
      const roomCell = findFieldCell(mainTable, '用房');
      if (roomCell) {
        const roomParent = roomCell.nextElementSibling;
        if (roomParent) {
          if (order.room_info?.star_rating) {
            const ok = await setSearchableDropdown(doc, parentDoc, roomCell, order.room_info.star_rating, order.room_info.star_rating);
            if (ok) { log(`  ✅ 用房星级: ${order.room_info.star_rating}`); successCount++; }
            else { log(`  ⚠️ 用房星级未选中: ${order.room_info.star_rating}`); failCount++; }
          }

          let biao = order.room_info?.biao || 0;
          let dachuang = order.room_info?.dachuang || 0;
          if (!biao && !dachuang && order.travellers?.length) {
            const roomCalc = calculateRoomNeed(order.travellers);
            biao = roomCalc.biao || 0;
            dachuang = roomCalc.dachuang || 0;
          }

          const roomInputs = roomParent.querySelectorAll('input');
          if (roomInputs.length >= 3) {
            const okBiao = setNumberInput(roomInputs[1], biao || 0);
            const okDachuang = setNumberInput(roomInputs[2], dachuang || 0);
            if (okBiao) { log(`  ✅ 用房: ${biao || 0} 标间`); successCount++; }
            else { log(`  ⚠️ 用房标间写入失败: ${biao || 0}`); failCount++; }
            if (okDachuang) { log(`  ✅ 用房: ${dachuang || 0} 大床`); successCount++; }
            else { log(`  ⚠️ 用房大床写入失败: ${dachuang || 0}`); failCount++; }
          }
        }
      }
    }

    // ── Step 7: 团费第一栏 ─────────────────────────────────────
    if (order.total_amount) {
      const feeTable = Array.from(doc.querySelectorAll('table')).find(t => (t.innerText || '').includes('团费') && (t.innerText || '').includes('单价') && (t.innerText || '').includes('数量'));
      if (feeTable) {
        const feeRows = Array.from(feeTable.querySelectorAll('tr')).filter(r => r.querySelectorAll('input').length >= 3);
        const firstFeeRow = feeRows[0];
        if (firstFeeRow) {
          const feeInputs = firstFeeRow.querySelectorAll('input');
          if (feeInputs[1]) _setVueInput(feeInputs[1], String(order.total_amount));
          if (feeInputs[2]) _setVueInput(feeInputs[2], '1');
          log(`  ✅ 团费单价: ${order.total_amount}`);
          log('  ✅ 团费数量: 1');
          successCount += 2;
        }
      }
    }

    // ── Step 8: 备注 ─────────────────────────────────────────
    if (order.merchant_note) {
      // 备注在"产品-备注信息"里，需要先展开"产品"区块
      // 找到"产品"标签并点击展开
      const productTabs = doc.querySelectorAll('div, span, a, li');
      for (const tab of productTabs) {
        if (tab.textContent.trim() === '产品' && tab.offsetParent !== null) {
          tab.click();
          await sleep(500);
          break;
        }
      }

      // 找备注字段（可能叫"备注信息"或"备注"）
      const noteCell = findFieldCell(mainTable, '备注信息') || findFieldCell(mainTable, '备注');
      if (noteCell) {
        const ok = setDirectInput(noteCell, order.merchant_note);
        if (ok) { log('  ✅ 备注已填写'); successCount++; }
        else { log('  ⚠️ 备注写入失败'); failCount++; }
      } else {
        log('  ⚠️ 未找到备注字段');
        failCount++;
      }
    }

    // ── Step 9: 客人名单 ─────────────────────────────────────
    await fillTravellers(order, doc);

    // ── Step 10: 接送信息 ─────────────────────────────────────
    if (order.pickup_dropoff?.length) {
      // 有航班 → 填接送段（从航班信息提取）
      const ok = await fillPickupDropoff(order, doc, parentDoc);
      if (ok) { log(`  ✅ 接送信息: ${order.pickup_dropoff.length} 段`); successCount++; }
      else { log('  ⚠️ 接送信息填写失败'); failCount++; }
    } else if (!order.has_flights && order.departure_date && order.return_date) {
      // 无航班 → 填"接机 出团日期" + "送机 返程日期"
      const ok = await fillPickupDropoffSimple(order, doc, parentDoc);
      if (ok) { log('  ✅ 接送信息: 接机+送机'); successCount++; }
      else { log('  ⚠️ 接机送机填写失败'); failCount++; }
    }

    log(`\n📊 填表完成: ${successCount} 成功 / ${failCount} 失败`);
  }

  // ── 客人表填写 ────────────────────────────────────────────────

  async function fillTravellers(order, doc) {
    if (!order.travellers || order.travellers.length === 0) {
      log('  ℹ️ 无客人数据');
      return;
    }

    if (!doc) {
      const iframe = findEt818Iframe();
      if (!iframe) { log('❌ 未找到 ET818 iframe'); return; }
      doc = getIframeDoc(iframe);
      if (!doc) { log('❌ 无法访问 iframe'); return; }
    }

    log(`👥 填写客人名单 (${order.travellers.length}人)…`);

    // 找客人表：#locationGuestList 下的第二张 #guestTable（带 tbody 的）
    const guestTables = doc.querySelectorAll('#locationGuestList table#guestTable, #guestTable');
    let guestTable = null;
    for (const t of guestTables) {
      if (t.querySelector('tbody')) {
        guestTable = t;
        break;
      }
    }
    if (!guestTable && guestTables.length > 1) {
      guestTable = guestTables[1]; // 备选：取第二张
    }

    if (!guestTable) {
      log('  ❌ 未找到客人表格 #guestTable');
      return;
    }

    const tbody = guestTable.querySelector('tbody');
    const rows = tbody ? tbody.querySelectorAll('tr') : guestTable.querySelectorAll('tr');

    let filled = 0;
    for (let i = 0; i < order.travellers.length; i++) {
      const t = order.travellers[i];
      const row = rows[i];
      if (!row) {
        log(`  ⚠️ 第${i + 1}位客人无对应行`);
        continue;
      }

      const cells = row.querySelectorAll('td, th');
      if (cells.length < 10) continue;

      // 按已验证的列映射填入
      // cells[1]=姓名 [2]=电话 [3]=证件类型(select) [4]=证件号码
      // [5]=性别(select) [6]=出生日期(3 inputs) [7]=年龄 [9]=籍贯 [10]=备注
      setDirectInput(cells[1], t.name);
      setDirectInput(cells[2], t.phone || '');
      setNativeSelect(cells[3], t.id_type || '身份证');
      setDirectInput(cells[4], t.id_no || '');
      setNativeSelect(cells[5], t.gender || '');

      // 出生日期：三段式
      if (t.birth_date && cells[6]) {
        const inputs = cells[6].querySelectorAll('input');
        if (inputs.length >= 3) {
          inputs[0].value = t.birth_date.year || '';
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[1].value = t.birth_date.month || '';
          inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[2].value = t.birth_date.day || '';
          inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      // 年龄（如果有的话）
      if (t.birth_date?.year && cells[7]) {
        const age = new Date().getFullYear() - parseInt(t.birth_date.year);
        setDirectInput(cells[7], String(age));
      }

      filled++;
    }

    log(`  ✅ 已填 ${filled}/${order.travellers.length} 位客人`);
  }

  // ── 接送信息填写 ────────────────────────────────────────────

  async function fillPickupDropoff(order, doc, parentDoc) {
    if (!order.pickup_dropoff || order.pickup_dropoff.length === 0) return false;

    // 找接送表：含 "航班号" 和 "路线" 的表
    const tables = doc.querySelectorAll('table');
    let pickupTable = null;
    for (const t of tables) {
      const text = t.innerText || '';
      if (text.includes('航班号') && (text.includes('路线') || text.includes('出发地'))) {
        pickupTable = t;
        break;
      }
    }

    if (!pickupTable) {
      log('  ℹ️ 未找到接送表格（可能需要先点击"新增接送"）');
      return false;
    }

    const headerMap = _buildHeaderMap(pickupTable);
    const rows = pickupTable.querySelectorAll('tr');

    let filled = 0;
    for (let i = 0; i < order.pickup_dropoff.length; i++) {
      const seg = order.pickup_dropoff[i];
      const row = rows[i + 1]; // 跳过表头
      if (!row) {
        log(`  ⚠️ 接送表第${i + 1}行不存在`);
        continue;
      }

      const cells = row.querySelectorAll('td, th');

      // 填写各字段
      if (seg.flight_no) setDirectInput(cells[headerMap['航班号']], seg.flight_no);

      // 日期：使用 register_time（去程=到达时间，返程=出发时间）
      const dateStr = seg.register_time ? seg.register_time.split(' ')[0] : '';
      if (dateStr) {
        const dateCell = cells[headerMap['日期']] || cells[headerMap['接送日期']];
        if (dateCell) setDirectInput(dateCell, dateStr);
      }

      // 时间：使用 register_time
      const timeStr = seg.register_time ? seg.register_time.split(' ')[1] || '' : '';
      if (timeStr) {
        const timeCell = cells[headerMap['时间']] || cells[headerMap['接送时间']];
        if (timeCell) setDirectInput(timeCell, timeStr);
      }

      // 路线：使用 register_airport（去程=到达机场，返程=出发机场）
      if (seg.register_airport) {
        const routeCell = cells[headerMap['路线']] || cells[headerMap['出发地']] || cells[headerMap['目的地']];
        if (routeCell) setDirectInput(routeCell, seg.register_airport);
      }

      filled++;
    }

    log(`  ✅ 已填 ${filled}/${order.pickup_dropoff.length} 段接送`);
    return filled > 0;
  }

  /**
   * 无航班时填接机+送机
   * 第1行: 接机, 日期=出团日期, 出发地=出发城市
   * 第2行: 送机, 日期=返程日期, 出发地=出发城市
   * ET818接送表: [序号] [操作/类型] [日期] [出发地] [班次] [班次时间] [接送描述] [用车安排]
   */
  async function fillPickupDropoffSimple(order, doc, parentDoc) {
    const tables = doc.querySelectorAll('table');
    let pickupTable = null;
    for (const t of tables) {
      const text = t.innerText || '';
      if ((text.includes('操作') && text.includes('日期') && text.includes('出发地') && text.includes('班次')) ||
          (text.includes('出发地') && text.includes('班次'))) {
        pickupTable = t;
        break;
      }
    }
    if (!pickupTable) {
      log('  ℹ️ 未找到接送表格');
      return false;
    }

    const dataRows = Array.from(pickupTable.querySelectorAll('tr')).filter(function(r) {
      const firstCell = r.querySelector('td');
      const firstText = firstCell ? firstCell.textContent.trim() : '';
      return firstText === '1' || firstText === '2';
    });

    if (dataRows.length < 2) {
      log('  ℹ️ 接送表数据行不足: ' + dataRows.length);
      return false;
    }

    const entries = [
      { type: '1接机/站', date: order.departure_date, city: (order.departure_city || '') + '机场' },
      { type: '2送机/站', date: order.return_date, city: (order.departure_city || '') + '机场' },
    ];

    let filled = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const row = dataRows[i];
      if (!row) continue;

      const inputs = row.querySelectorAll('input');
      if (inputs[0]) {
        _setVueInput(inputs[0], entry.type);
        inputs[0].focus();
        _commitInput(inputs[0]);
        if ((inputs[0].value || '').trim() === entry.type) log(`  ✅ 接送${i + 1}类型: ${entry.type}`);
        else log(`  ⚠️ 接送${i + 1}类型未选中: ${entry.type}`);
      }

      const etDate = row.querySelector('.et-date');
      if (etDate && entry.date) {
        const dateResult = _setEtDate(etDate, entry.date);
        if (dateResult.ok) log(`  ✅ 接送${i + 1}日期: ${entry.date}`);
        else log(`  ⚠️ 接送${i + 1}日期写入失败: ${entry.date} [${dateResult.detail}]`);
      }

      if (inputs[4] && entry.city) {
        _setVueInput(inputs[4], entry.city);
        inputs[4].focus();
        _commitInput(inputs[4]);
        if ((inputs[4].value || '').trim() === entry.city) log(`  ✅ 接送${i + 1}出发地: ${entry.city}`);
        else log(`  ⚠️ 接送${i + 1}出发地未选中: ${entry.city}`);
      }

      filled++;
    }

    log(`  ✅ 已填 ${filled} 段接送`);
    return filled > 0;
  }
  function _buildHeaderMap(table) {
    const map = {};
    const rows = table.querySelectorAll('tr');
    if (rows.length === 0) return map;
    const cells = rows[0].querySelectorAll('th, td');
    cells.forEach((cell, idx) => {
      const text = cell.textContent.trim().replace(/\s+/g, '');
      if (text) map[text] = idx;
    });
    return map;
  }

  // ── 工具 ──────────────────────────────────────────────────────

  function log(msg) {
    const el = document.getElementById('vbk-panel-log');
    if (el) {
      el.innerHTML += `<div>${msg}</div>`;
      el.scrollTop = el.scrollHeight;
    }
    console.log('[ET818 Filler]', msg);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── 启动 ──────────────────────────────────────────────────────

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
