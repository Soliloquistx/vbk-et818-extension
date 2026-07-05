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
  const SALES_KEY = 'vbk_sales_person';
  const ADDSN_URL = 'https://t16.et818.com/XWJ/PlanReg/AddDSN/PlanMng.ListRegDSN1?PageType=add&RegID=0&BizMode=15';
  const ROUTE_TEMPLATE_NAMES = [
    '甘南天水', '甘南牧歌', '甘南九寨', '甘南莲宝',
    '丝路华章', '天境青甘', '河西走廊', '西北精华', '西北风向标', '悠游西北',
    '全景华章+甘南', '全景华章+天水', '全景精华+天水',
    '全景水雅+甘南', '全景水雅+天水',
    '青海秘境', '青海一地', '藏韵九寨', '南疆', '北疆', '北疆风华',
    '云南漫时光', '云南滇西北', '疆山行迹', '疆山如画', '北疆精华',
    '蜀行九寨', '迈动九寨', '川西小环线',
  ].sort((a, b) => b.length - a.length);
  let currentOrder = null;
  let currentSalesPerson = '李明强';
  let panel = null;
  window.__vbkErrors = window.__vbkErrors || [];
  if (!window.__vbkErrorHooked) {
    window.__vbkErrorHooked = true;
    window.addEventListener('error', (event) => {
      window.__vbkErrors.push({ type: 'error', message: event.message, stack: event.error?.stack || '', when: Date.now() });
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__vbkErrors.push({ type: 'unhandledrejection', message: reason?.message || String(reason), stack: reason?.stack || '', when: Date.now() });
    });
  }

  // ── 初始化 ────────────────────────────────────────────────────

  async function init() {
    // 读取 storage 中的 VBK 订单数据
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const orders = stored[STORAGE_KEY] || {};
    const orderList = Object.values(orders)
      .sort((a, b) => (b.scraped_at || 0) - (a.scraped_at || 0));

    if (orderList.length === 0) return; // 没有数据就不注入面板

    currentOrder = orderList[0]; // 默认用最新一条

    // ponytail: 读存储的销售姓名
    const salesStored = (await chrome.storage.local.get(SALES_KEY))[SALES_KEY];
    if (salesStored) currentSalesPerson = salesStored;

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
    panel.className = 'vbk-minimized';
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
        <div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">
          <label style="font-size:11px;color:#656d76;">销售</label>
          <input id="vbk-sales-input" value="${currentSalesPerson}"
            style="flex:1;padding:2px 6px;border:1px solid #d0d7de;border-radius:4px;font-size:12px;">
        </div>
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
      ${o.room_info ? `<div class="vbk-summary-row"><span class="vk">用房</span><span class="vv">${o.room_info.star_rating || ''} ${o.room_info.biao > 0 ? o.room_info.biao + '标间' : ''} ${o.room_info.dachuang > 0 ? o.room_info.dachuang + '大床' : ''}${o.room_info.single_room_diff_needed ? ' ｜核对单房差' : ''}</span></div>` : ''}
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

    // 折叠/展开
    document.getElementById('vbk-panel-collapse')?.addEventListener('click', () => {
      panel.classList.toggle('vbk-minimized');
    });

    // 切换订单
    document.getElementById('vbk-order-select')?.addEventListener('change', (e) => {
      currentOrder = orderList[parseInt(e.target.value)];
      updatePanelSummary(orderList);
    });

    // 一键填表
    document.getElementById('vbk-fill-all')?.addEventListener('click', async () => {
      if (!currentOrder) return log('❌ 没有可用订单数据');
      try {
        await fillAll(currentOrder);
      } catch (error) {
        console.error('[ET818 Filler] fillAll failed:', error);
        log(`❌ 填表异常: ${error.message}`);
      }
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

    // ponytail: 销售姓名存储
    document.getElementById('vbk-sales-input')?.addEventListener('blur', (e) => {
      const name = e.target.value.trim();
      if (name && name !== currentSalesPerson) {
        currentSalesPerson = name;
        chrome.storage.local.set({ [SALES_KEY]: name });
      }
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

  function isAddDsnUrl(src) {
    return !!src && (src.includes('AddDSN') || src.includes('PageType=add'));
  }

  function isAddDsnDoc(doc) {
    return !!findMainTable(doc);
  }

  function isVisibleIframe(iframe) {
    const rect = iframe.getBoundingClientRect();
    return iframe.offsetParent !== null && rect.width > 20 && rect.height > 20;
  }

  function findNavigationIframe() {
    const selectors = [
      '#LAY_app_body .layadmin-tabsbody-item.layui-show iframe',
      '.layadmin-tabsbody-item.layui-show iframe',
      '#LAY_app_body .layui-show iframe',
      '.layui-show iframe',
      '#LAY_app_body iframe',
      '.layadmin-tabsbody-item iframe',
      'iframe',
    ];

    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const iframe of document.querySelectorAll(selector)) {
        if (seen.has(iframe)) continue;
        seen.add(iframe);
        candidates.push(iframe);
      }
    }

    return candidates.find(isVisibleIframe)
      || candidates.find(iframe => getIframeDoc(iframe))
      || candidates[0]
      || null;
  }

  async function waitForAddDsnDoc(iframe, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const doc = getIframeDoc(iframe);
      if (doc && doc.body && isAddDsnDoc(doc)) return doc;
      await sleep(250);
    }
    return getIframeDoc(iframe);
  }

  async function ensureAddDsnDocument() {
    if (isAddDsnDoc(document)) {
      return { doc: document, parentDoc: document, iframe: null, mode: 'top' };
    }

    const existingAddIframe = Array.from(document.querySelectorAll('iframe'))
      .find(iframe => isAddDsnUrl(iframe.src || '') && getIframeDoc(iframe));
    if (existingAddIframe) {
      const doc = await waitForAddDsnDoc(existingAddIframe);
      return { doc, parentDoc: document, iframe: existingAddIframe, mode: 'existing' };
    }

    const navIframe = findNavigationIframe();
    if (!navIframe) return { doc: null, parentDoc: document, iframe: null, mode: 'missing' };

    log('🔄 当前页面不是新增表单，正在打开 AddDSN…');
    navIframe.src = ADDSN_URL;
    const doc = await waitForAddDsnDoc(navIframe);
    return { doc, parentDoc: document, iframe: navIframe, mode: 'navigated' };
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

  function normalizeLabelText(text) {
    return (text || '').trim().replace(/[\s：:*＊]/g, '');
  }

  function findFieldCell(table, labelText) {
    if (!table || !labelText) return null;
    const rows = table.querySelectorAll('tr');
    const target = normalizeLabelText(labelText);

    for (const exactOnly of [true, false]) {
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        for (let i = 0; i < cells.length - 1; i++) {
          const cellText = normalizeLabelText(cells[i].textContent);
          const matched = exactOnly ? cellText === target : cellText.includes(target);
          if (matched) return cells[i + 1];
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
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.blur();
    closeDropdowns(input.ownerDocument);
  }

  function closeDropdowns(doc) {
    if (!doc) return;
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    doc.body?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    doc.body?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    doc.body?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    closeTypeaheadMenus(doc);
  }

  function closeTypeaheadMenus(doc) {
    if (!doc) return;
    Array.from(doc.querySelectorAll('.typeahead.dropdown-menu')).forEach(menu => {
      menu.style.display = 'none';
      menu.classList.remove('open');
    });
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
    const proto = input.tagName === 'TEXTAREA'
      ? inputWin.HTMLTextAreaElement.prototype
      : inputWin.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(input, value);

    const wrappers = [input.parentElement, input.parentElement?.parentElement].filter(Boolean);
    for (const wrapper of wrappers) {
      const vue = wrapper.__vue__;
      if (!vue) continue;
      if ('currentValue' in vue) vue.currentValue = value;
      if ('value' in vue && typeof vue.value !== 'function') vue.value = value;
      if (typeof vue.setCurrentValue === 'function') {
        try { vue.setCurrentValue(value); } catch (error) { console.warn('[ET818 Filler] setCurrentValue failed:', error); }
      }
    }

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

  function setDirectInputByLabel(table, labelText, value) {
    const cell = findFieldCell(table, labelText);
    return setDirectInput(cell, value);
  }

  async function setTypeaheadInput(cell, value) {
    if (!cell || value === undefined || value === null) return false;
    const input = cell.querySelector('input, textarea');
    if (!input) return false;

    _setVueInput(input, String(value));
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
    await sleep(250);

    const doc = input.ownerDocument;
    const candidate = Array.from(doc.querySelectorAll('.typeahead.dropdown-menu .dropdown-item, .dropdown-item'))
      .filter(item => item.offsetParent !== null)
      .find(item => item.textContent.trim() === String(value))
      || Array.from(doc.querySelectorAll('.typeahead.dropdown-menu .dropdown-item, .dropdown-item'))
        .filter(item => item.offsetParent !== null)
        .find(item => item.textContent.trim().includes(String(value)) || String(value).includes(item.textContent.trim()));

    if (candidate) {
      clickCandidate(candidate);
      await sleep(150);
    }

    _commitInput(input);
    closeTypeaheadMenus(doc);
    return (input.value || '').trim() === String(value);
  }

  async function fillFeeFirstRow(doc, totalAmount) {
    if (!totalAmount) return { priceOk: false, countOk: false, found: false };
    const feeTable = Array.from(doc.querySelectorAll('table')).find(t => {
      const text = normalizeLabelText(t.innerText);
      return text.includes('项目类别') && text.includes('项目名称')
        && text.includes('单价') && text.includes('数量')
        && text.includes('单位') && text.includes('金额');
    });
    if (!feeTable) return { priceOk: false, countOk: false, found: false };

    await ensureTableRows(feeTable, 1, getNumberedRows, '团费表');
    const headerMap = _buildHeaderMap(feeTable);
    const feeRows = Array.from(feeTable.querySelectorAll('tr')).filter(r => {
      const firstCell = r.querySelector('td, th');
      return firstCell && /^\d+$/.test(firstCell.textContent.trim()) && r.querySelectorAll('input').length >= 3;
    });
    const firstFeeRow = feeRows[0];
    if (!firstFeeRow) return { priceOk: false, countOk: false, found: true };

    const cells = firstFeeRow.querySelectorAll('td, th');
    const priceCell = cells[headerMap['单价']];
    const countCell = cells[headerMap['数量']];
    const priceInput = priceCell && priceCell.querySelector('input');
    const countInput = countCell && countCell.querySelector('input');
    return {
      found: true,
      priceOk: setNumberInput(priceInput, totalAmount),
      countOk: setNumberInput(countInput, 1),
    };
  }

  function fillParticipantCounts(table, travellers) {
    const cell = findFieldCell(table, '参团人数');
    if (!cell || !travellers) return false;
    const adults = travellers.filter(t => t.person_type === '成人').length;
    const children = travellers.filter(t => t.person_type === '儿童').length;
    const inputs = getEditableInputs(cell);
    if (inputs.length < 2) return false;
    const adultOk = setNumberInput(inputs[0], adults || 0);
    const childOk = setNumberInput(inputs[1], children || 0);
    return adultOk && childOk;
  }

  function fillProductRemark(doc, remark) {
    if (!remark) return false;
    const productTable = Array.from(doc.querySelectorAll('table')).find(table => {
      const text = normalizeLabelText(table.innerText);
      return text.includes('备注信息') && text.includes('服务标准')
        && text.includes('费用包含') && text.includes('费用不含');
    });
    if (!productTable) return false;
    const noteCell = findFieldCell(productTable, '备注信息');
    return setDirectInput(noteCell, remark);
  }

  function getEditableInputs(root) {
    return Array.from(root.querySelectorAll('input')).filter(input => {
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden' || type === 'button' || type === 'submit') return false;
      if (input.disabled || input.readOnly) return false;
      return true;
    });
  }

  function getNumberedRows(table) {
    return Array.from(table.querySelectorAll('tr')).filter(row => {
      const firstCell = row.querySelector('td, th');
      return firstCell && /^\d+$/.test(firstCell.textContent.trim());
    });
  }

  function findTableAddButton(table) {
    if (!table) return null;
    const doc = table.ownerDocument;
    const tableRect = table.getBoundingClientRect();
    const candidates = Array.from(doc.querySelectorAll('i.glyphicon-plus, .glyphicon-plus, .ivu-icon-plus, button, a, span'))
      .filter(el => el.offsetParent !== null)
      .filter(el => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || '').trim();
        const cls = String(el.className || '');
        const looksLikeAdd = text === '+' || cls.includes('glyphicon-plus') || cls.includes('ivu-icon-plus') || cls.includes('plus');
        if (!looksLikeAdd) return false;
        return rect.top >= tableRect.top - 140 && rect.top <= tableRect.top + 80 && rect.left <= tableRect.left + 260;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const ad = Math.abs(ar.top - tableRect.top) + Math.abs(ar.left - tableRect.left);
        const bd = Math.abs(br.top - tableRect.top) + Math.abs(br.left - tableRect.left);
        return ad - bd;
      });
    if (!candidates.length) return null;
    return candidates[0].closest('button, a') || candidates[0];
  }

  async function ensureTableRows(table, requiredRows, rowSelectorFn = getNumberedRows, label = '表格') {
    if (!table || requiredRows <= 0) return false;
    let rows = rowSelectorFn(table);
    if (rows.length >= requiredRows) return true;

    let attempts = 0;
    while (rows.length < requiredRows && attempts < 10) {
      const addButton = findTableAddButton(table);
      if (!addButton) {
        log(`  ⚠️ ${label} 行数不足 ${rows.length}/${requiredRows}，未找到左上角+号`);
        return false;
      }
      addButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      addButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(500);
      rows = rowSelectorFn(table);
      attempts++;
    }

    if (rows.length >= requiredRows) {
      log(`  ✅ ${label} 已扩展到 ${rows.length} 行`);
      return true;
    }
    log(`  ⚠️ ${label} 扩行后仍不足 ${rows.length}/${requiredRows}`);
    return false;
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

    // Step 4: 点击候选项并强制提交/关闭浮层
    clickCandidate(candidate);
    await sleep(options.after_select_wait || 500);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.blur();
    closeDropdowns(input.ownerDocument);
    await sleep(300);

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

  function parseRouteTemplateIntent(text) {
    const s = String(text || '').replace(/\s+/g, '').replace(/＋/g, '+');
    const route = ROUTE_TEMPLATE_NAMES.find(name => s.includes(name)) || '';
    const dayMatch = s.match(/(\d{1,2})[日天]/);
    const cityText = s
      .replace(/兰州/g, '兰').replace(/西宁/g, '西').replace(/成都/g, '成').replace(/敦煌/g, '敦')
      .replace(/乌鲁木齐|乌市/g, '乌').replace(/喀什/g, '喀').replace(/伊宁/g, '伊')
      .replace(/昆明/g, '昆').replace(/丽江/g, '丽').replace(/版纳|西双版纳/g, '版');
    const sameCity = cityText.match(/([\u4e00-\u9fa5])进出/) || cityText.match(/([\u4e00-\u9fa5])进\1出/);
    const diffCity = cityText.match(/([\u4e00-\u9fa5])进([\u4e00-\u9fa5])出/);
    return {
      route,
      days: dayMatch ? dayMatch[1] : '',
      city: sameCity ? `${sameCity[1]}进${sameCity[1]}出` : (diffCity ? `${diffCity[1]}进${diffCity[2]}出` : ''),
    };
  }

  function findBestRouteCandidate(docs, intent) {
    const items = docs.flatMap(doc => Array.from(doc.querySelectorAll('.dropdown-item, .layui-anim dd, .chosen-results li')))
      .filter(item => item.offsetParent !== null)
      .map(item => ({ item, text: item.textContent.trim(), intent: parseRouteTemplateIntent(item.textContent) }))
      .filter(x => x.intent.route === intent.route && x.intent.days === intent.days);
    if (!items.length) return null;
    if (intent.city) {
      const cityMatched = items.find(x => x.intent.city === intent.city);
      if (cityMatched) return cityMatched.item;
    }
    return items[0].item;
  }

  async function selectRouteTemplate(doc, parentDoc, cell, orderText, searchKeyword) {
    const intent = parseRouteTemplateIntent(orderText);
    if (!intent.route || !intent.days) {
      log(`  ⚠️ 线路模板缺少路线或天数: ${orderText || '(空)'}`);
      return false;
    }
    const input = cell && cell.querySelector('input[type="text"], input:not([type])');
    if (!input) return false;
    _setVueInput(input, '');
    await sleep(200);
    _setVueInput(input, searchKeyword || intent.route);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
    await sleep(1000);
    let candidate = findBestRouteCandidate([doc, parentDoc], intent);
    if (!candidate) {
      await sleep(1000);
      candidate = findBestRouteCandidate([doc, parentDoc], intent);
    }
    if (!candidate) return false;
    clickCandidate(candidate);
    await sleep(1200);
    input.blur();
    closeDropdowns(input.ownerDocument);
    log(`  ✅ 线路模板候选: ${candidate.textContent.trim()}`);
    return true;
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

  function findScenicVisit(doc) {
    const scenicMatchers = [
      { scenic: '四姑娘山', test: text => text.includes('四姑娘山') },
      { scenic: '九寨沟', test: text => /九寨沟(风景区|景区)/.test(text) },
      { scenic: '莫高窟', test: text => text.includes('莫高窟') },
      { scenic: '喀纳斯禾木', test: text => text.includes('喀纳斯') || text.includes('禾木') },
    ];
    const tables = Array.from(doc.querySelectorAll('table'));
    const productTable = tables.find(table => {
      const text = table.innerText || '';
      return text.includes('日期') && text.includes('旅游线路') && text.includes('交通工具');
    });
    if (!productTable) return null;
    for (const row of productTable.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length < 3) continue;
      const routeText = Array.from(cells[2].querySelectorAll('input, textarea'))
        .map(input => input.value || '')
        .join(' ') || cells[2].textContent || '';
      const matched = scenicMatchers.find(item => item.test(routeText));
      if (!matched) continue;
      const dateInputs = cells[0].querySelectorAll('input');
      const rowText = Array.from(cells).map(cell => cell.textContent || '').join(' ');
      const rowDate = rowText.match(/20\d{2}-\d{1,2}-\d{1,2}/);
      if (dateInputs.length < 3) return { scenic: matched.scenic, date: rowDate ? rowDate[0].replace(/-(\d)(?=-|$)/g, '-0$1') : '' };
      const year = (dateInputs[0].value || '').trim();
      const month = (dateInputs[1].value || '').trim().padStart(2, '0');
      const day = (dateInputs[2].value || '').trim().padStart(2, '0');
      return { scenic: matched.scenic, date: year && month && day ? `${year}-${month}-${day}` : (rowDate ? rowDate[0].replace(/-(\d)(?=-|$)/g, '-0$1') : '') };
    }
    return null;
  }

  async function waitForScenicVisit(doc, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      const scenicVisit = findScenicVisit(doc);
      if (scenicVisit?.date) return scenicVisit;
      await sleep(300);
    }
    return findScenicVisit(doc);
  }

  function clickCandidate(el) {
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
    if (!travellers || travellers.length === 0) {
      return { biao: 0, dachuang: 0, single_room_diff_needed: false };
    }

    const sharing = travellers.filter(t => t.room_sharing === '是');
    const notSharing = travellers.filter(t => t.room_sharing === '否');
    const unknown = travellers.filter(t => !t.room_sharing || (t.room_sharing !== '是' && t.room_sharing !== '否'));

    // 未知状态默认按拼房处理
    const effectiveSharing = sharing.length + unknown.length;

    return {
      biao: effectiveSharing * 0.5,
      dachuang: notSharing.length,
      single_room_diff_needed: notSharing.length > 0,
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  主填表流程
  // ══════════════════════════════════════════════════════════════

  async function fillAll(order) {
    log('⚡ 开始一键填表…');

    const addPage = await ensureAddDsnDocument();
    const iframe = addPage.iframe;
    const doc = addPage.doc;
    const parentDoc = addPage.parentDoc;
    if (!doc || !doc.body) {
      log('❌ 无法打开新增表单：未找到可导航的 ET818 iframe');
      return;
    }
    log('✅ 新增表单已就绪, tables: ' + doc.querySelectorAll('table').length);

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

    function step(name) {
      log(`➡️ ${name}`);
    }

    let successCount = 0;
    let failCount = 0;
    // ── Step 1: 线路模板 ──────────────────────────────────────
    // 必须先自动选中模板第一个候选，页面结构会随之变化
    let templateKeyword = '';
    const rn = order.route_name || order.product_name || '';
    if (rn) {
      const intent = parseRouteTemplateIntent(rn);
      templateKeyword = intent.route ? `${intent.route}${intent.days || ''}` : rn;
    }
    if (templateKeyword) {
      const cell = findFieldCell(mainTable, '线路模板');
      if (cell) {
        log(`🔍 搜索线路模板: "${templateKeyword}"`);
        const templateOk = await selectRouteTemplate(doc, parentDoc, cell, rn, templateKeyword);
        if (templateOk) {
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
      { label: '景区订单号', value: '' },
    ];
    for (const f of directFields) {
      if (f.value === undefined || f.value === null) continue;
      const ok = setDirectInputByLabel(mainTable, f.label, f.value);
      if (ok) { log(`  ✅ ${f.label}: ${f.value || '(空)'}`); successCount++; }
      else { log(`  ⚠️ ${f.label} 写入失败`); failCount++; }
    }

    const scenicVisit = await waitForScenicVisit(doc);
    const visitDate = scenicVisit?.date || order.departure_date;
    if (visitDate) {
      const visitDateCell = findFieldCell(mainTable, '参观日期');
      const visitEtDate = visitDateCell && visitDateCell.querySelector('.et-date');
      const visitDateResult = visitEtDate ? _setEtDate(visitEtDate, visitDate) : { ok: setThreePartDate(visitDateCell, visitDate), detail: 'three-part' };
      if (visitDateResult.ok) { log(`  ✅ 参观日期: ${visitDate}`); successCount++; }
      else { log(`  ⚠️ 参观日期写入失败: ${visitDate} [${visitDateResult.detail}]`); failCount++; }
    }

    // ── Step 4: 搜索型下拉 ───────────────────────────────────
    step('主信息下拉字段');

    // 预约景区：产品组日期行命中需预约景区时选景区，否则默认无需预约
    {
      const scenicBookingValue = scenicVisit?.scenic || '无需预约';
      const cell = findFieldCell(mainTable, '预约景区');
      const ok = await setSearchableDropdown(doc, parentDoc, cell, scenicBookingValue, scenicBookingValue);
      if (ok) { log(`  ✅ 预约景区: ${scenicBookingValue}`); successCount++; }
      else { log(`  ⚠️ 预约景区未选中: ${scenicBookingValue}`); failCount++; }
      if (scenicVisit?.date) log(`  ✅ 预约景区参观日期: ${scenicVisit.date}`);
    }

    // 大交通：优先 parser 判断；无航班时默认“当地参”作为兜底
    {
      const transportValue = order.transport_type || '当地参';
      const cell = findFieldCell(mainTable, '大交通');
      const ok = await setSearchableDropdown(doc, parentDoc, cell, transportValue, transportValue);
      if (ok) { log(`  ✅ 大交通: ${transportValue}`); successCount++; }
      else { log(`  ⚠️ 大交通未选中: ${transportValue}`); failCount++; }
    }

    // 团队类别：从 VBK 意向团标签提取，兜底快拼团
    {
      const cell = findFieldCell(mainTable, '团队类别');
      const teamMap = { '普通': '快拼团', '老友': '老友团', '青年': '青年团', '亲子': '亲子团' };
      const teamValue = teamMap[order.team_category] || order.team_category || '快拼团';
      const ok = await setSearchableDropdown(doc, parentDoc, cell, teamValue, teamValue);
      if (ok) { log(`  ✅ 团队类别: ${teamValue}`); successCount++; }
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
      const adults = order.travellers.filter(t => t.person_type === '成人').length;
      const children = order.travellers.filter(t => t.person_type === '儿童').length;
      const ok = fillParticipantCounts(mainTable, order.travellers);
      if (ok) { log(`  ✅ 参团人数: ${adults || 0}大${children || 0}小`); successCount++; }
      else { log('  ⚠️ 参团人数写入失败'); failCount++; }
    }

    // ── Step 5.5: 销售 ──────────────────────────────────────
    {
      const cell = findFieldCell(mainTable, '销售');
      if (cell) {
        const ok = await setSearchableDropdown(doc, parentDoc, cell, currentSalesPerson, currentSalesPerson);
        if (ok) { log(`  ✅ 销售: ${currentSalesPerson}`); successCount++; }
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

          const roomNeed = order.travellers?.length ? calculateRoomNeed(order.travellers) : null;
          let starRating = order.room_info?.star_rating || '';
          if (roomNeed) {
            var biao = roomNeed.biao || 0;
            var dachuang = roomNeed.dachuang || 0;
            var singleRoomFlag = roomNeed.single_room_diff_needed;
            log(`  🔍 房型计算: 是拼房${order.travellers.filter(t=>t.room_sharing==='是').length}人/否拼房${order.travellers.filter(t=>t.room_sharing==='否').length}人 → ${biao}标间+${dachuang}大床`);
          } else {
            var biao = order.room_info?.biao || 0;
            var dachuang = order.room_info?.dachuang || 0;
            var singleRoomFlag = false;
          }

          const refreshedRoomCell = findFieldCell(mainTable, '用房') || roomCell;
          const roomInputs = getEditableInputs(refreshedRoomCell);
          if (roomInputs.length >= 3) {
            const okBiao = setNumberInput(roomInputs[1], biao || 0);
            const okDachuang = setNumberInput(roomInputs[2], dachuang || 0);
            if (okBiao) { log(`  ✅ 用房: ${biao || 0} 标间`); successCount++; }
            else { log(`  ⚠️ 用房标间写入失败: ${biao || 0}`); failCount++; }
            if (okDachuang) { log(`  ✅ 用房: ${dachuang || 0} 大床`); successCount++; }
            else { log(`  ⚠️ 用房大床写入失败: ${dachuang || 0}`); failCount++; }
            if (singleRoomFlag || order.room_info?.single_room_diff_needed) {
              log('  ℹ️ 存在不拼房客人：请核对是否已补单房差');
            }
          } else {
            log(`  ⚠️ 用房输入框不足: ${roomInputs.length}`);
            failCount++;
          }
        }
      }
    }

    // ── Step 7: 团费第一栏 ─────────────────────────────────────
    if (order.total_amount) {
      const feeResult = await fillFeeFirstRow(doc, order.total_amount);
      if (!feeResult.found) {
        log('  ⚠️ 未找到团费表');
        failCount++;
      } else {
        if (feeResult.priceOk) { log(`  ✅ 团费单价: ${order.total_amount}`); successCount++; }
        else { log(`  ⚠️ 团费单价写入失败: ${order.total_amount}`); failCount++; }
        if (feeResult.countOk) { log('  ✅ 团费数量: 1'); successCount++; }
        else { log('  ⚠️ 团费数量写入失败'); failCount++; }
      }
    }

    // ── Step 8: 备注 ─────────────────────────────────────────
    step('备注信息');
    if (order.merchant_note) {
      const ok = fillProductRemark(doc, order.merchant_note);
      if (ok) { log('  ✅ 备注信息已填写'); successCount++; }
      else { log('  ⚠️ 备注信息写入失败'); failCount++; }
    }

    // ── Step 9: 客人名单 ─────────────────────────────────────
    step('客人名单');
    await fillTravellers(order, doc);

    // ── Step 10: 接送信息 ─────────────────────────────────────
    step('接送信息');
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

    // ── Step 11: 联动后最终补写 ─────────────────────────────────
    const finalMainTable = findMainTable(doc) || mainTable;
    if (order.order_no) {
      const orderOk = setDirectInputByLabel(finalMainTable, '订单号', order.order_no);
      const scenicOk = setDirectInputByLabel(finalMainTable, '景区订单号', '');
      if (orderOk) { log(`  ✅ 最终补写订单号: ${order.order_no}`); successCount++; }
      else { log(`  ⚠️ 最终补写订单号失败: ${order.order_no}`); failCount++; }
      if (scenicOk) { log('  ✅ 最终清空景区订单号'); successCount++; }
      else { log('  ⚠️ 最终清空景区订单号失败'); failCount++; }
    }
    if (visitDate) {
      const visitDateCell = findFieldCell(finalMainTable, '参观日期');
      const visitEtDate = visitDateCell && visitDateCell.querySelector('.et-date');
      const visitDateResult = visitEtDate ? _setEtDate(visitEtDate, visitDate) : { ok: setThreePartDate(visitDateCell, visitDate), detail: 'three-part' };
      if (visitDateResult.ok) { log(`  ✅ 最终补写参观日期: ${visitDate}`); successCount++; }
      else { log(`  ⚠️ 最终补写参观日期失败: ${visitDate} [${visitDateResult.detail}]`); failCount++; }
    }
    if (order.total_amount) {
      const feeResult = await fillFeeFirstRow(doc, order.total_amount);
      if (feeResult.found && feeResult.priceOk) { log(`  ✅ 最终补写团费单价: ${order.total_amount}`); successCount++; }
      else { log(`  ⚠️ 最终补写团费单价失败: ${order.total_amount}`); failCount++; }
      if (feeResult.found && feeResult.countOk) { log('  ✅ 最终补写团费数量: 1'); successCount++; }
      else { log('  ⚠️ 最终补写团费数量失败'); failCount++; }
    }
    await sleep(300);
    closeDropdowns(doc);
    closeTypeaheadMenus(doc);

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

    await ensureTableRows(guestTable, order.travellers.length, getNumberedRows, '客人表');
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

    const tables = doc.querySelectorAll('table');
    let pickupTable = null;
    for (const t of tables) {
      const text = t.innerText || '';
      if ((text.includes('操作') && text.includes('日期') && text.includes('出发地') && text.includes('班次')) ||
          (text.includes('出发地') && text.includes('班次时间') && text.includes('接送描述'))) {
        pickupTable = t;
        break;
      }
    }

    if (!pickupTable) {
      log('  ℹ️ 未找到接送表格（可能需要先点击"新增接送"）');
      return false;
    }

    const headerMap = _buildHeaderMap(pickupTable);
    await ensureTableRows(pickupTable, order.pickup_dropoff.length, getNumberedRows, '接送表');
    const dataRows = Array.from(pickupTable.querySelectorAll('tr')).filter(function(r) {
      const firstCell = r.querySelector('td');
      const firstText = firstCell ? firstCell.textContent.trim() : '';
      return /^\d+$/.test(firstText);
    });

    function getPickupCell(row, names, fallbackIndex) {
      const cells = row.querySelectorAll('td, th');
      for (const name of names) {
        if (headerMap[name] !== undefined && cells[headerMap[name]]) return cells[headerMap[name]];
      }
      return cells[fallbackIndex] || null;
    }

    let filled = 0;
    for (let i = 0; i < order.pickup_dropoff.length; i++) {
      const seg = order.pickup_dropoff[i];
      const row = dataRows[i];
      if (!row) {
        log(`  ⚠️ 接送表第${i + 1}行不存在`);
        continue;
      }

      const flightCell = getPickupCell(row, ['班次', '航班号'], 4);
      const dateCell = getPickupCell(row, ['日期', '接送日期'], 2);
      const placeCell = getPickupCell(row, ['出发地', '路线', '目的地'], 3);
      const typeCell = getPickupCell(row, ['操作', '类型'], 1);
      const timeCell = getPickupCell(row, ['班次时间', '时间', '接送时间'], 5);

      let typeOk = true;
      const typeValue = i === 0 ? '1接机/站' : '2送机/站';
      if (typeCell) {
        typeOk = await setSearchableDropdown(doc, parentDoc, typeCell, typeValue, typeValue);
        if (typeOk) log(`  ✅ 接送${i + 1}类型: ${typeValue}`);
        else log(`  ⚠️ 接送${i + 1}类型未选中: ${typeValue}`);
      }

      let flightOk = true;
      if (seg.flight_no) {
        flightOk = setDirectInput(flightCell, seg.flight_no);
        if (flightOk) log(`  ✅ 接送${i + 1}班次: ${seg.flight_no}`);
        else log(`  ⚠️ 接送${i + 1}班次写入失败: ${seg.flight_no}`);
      }

      let dateOk = false;
      const dateStr = seg.register_time ? seg.register_time.split(' ')[0] : '';
      if (dateStr) {
        const etDate = dateCell ? dateCell.querySelector('.et-date') : null;
        if (etDate) {
          const result = _setEtDate(etDate, dateStr);
          dateOk = result.ok;
          if (dateOk) log(`  ✅ 接送${i + 1}日期: ${dateStr}`);
          else log(`  ⚠️ 接送${i + 1}日期写入失败: ${dateStr} [${result.detail}]`);
        } else if (dateCell) {
          dateOk = setDirectInput(dateCell, dateStr);
          if (dateOk) log(`  ✅ 接送${i + 1}日期: ${dateStr}`);
          else log(`  ⚠️ 接送${i + 1}日期写入失败: ${dateStr}`);
        }
      }

      let timeOk = true;
      const timeStr = seg.register_time ? (seg.register_time.split(' ')[1] || '').slice(0, 5) : '';
      if (timeStr) {
        timeOk = setDirectInput(timeCell, timeStr);
        if (timeOk) log(`  ✅ 接送${i + 1}班次时间: ${timeStr}`);
        else log(`  ⚠️ 接送${i + 1}班次时间写入失败: ${timeStr}`);
      }

      let placeOk = true;
      if (seg.register_airport) {
        const normalizedPlace = _normalizeCityName(seg.register_airport);
        placeOk = await setSearchableDropdown(doc, parentDoc, placeCell, normalizedPlace, normalizedPlace);
        if (placeOk) log(`  ✅ 接送${i + 1}出发地: ${normalizedPlace}`);
        else log(`  ⚠️ 接送${i + 1}出发地未选中: ${normalizedPlace}`);
      }

      if (typeOk || flightOk || dateOk || timeOk || placeOk) filled++;
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

    await ensureTableRows(pickupTable, 2, getNumberedRows, '接送表');
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
      { type: '1接机/站', date: order.departure_date, city: _normalizeCityName((order.departure_city || '') + '机场') },
      { type: '2送机/站', date: order.return_date, city: _normalizeCityName((order.departure_city || '') + '机场') },
    ];

    const headerMap = _buildHeaderMap(pickupTable);
    function getPickupCell(row, names, fallbackIndex) {
      const cells = row.querySelectorAll('td, th');
      for (const name of names) {
        if (headerMap[name] !== undefined && cells[headerMap[name]]) return cells[headerMap[name]];
      }
      return cells[fallbackIndex] || null;
    }

    let filled = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const row = dataRows[i];
      if (!row) continue;

      const typeCell = getPickupCell(row, ['操作', '类型'], 1);
      const dateCell = getPickupCell(row, ['日期', '接送日期'], 2);
      const cityCell = getPickupCell(row, ['出发地', '目的地'], 3);
      const typeOk = await setSearchableDropdown(doc, parentDoc, typeCell, entry.type, entry.type);
      if (typeOk) log(`  ✅ 接送${i + 1}类型: ${entry.type}`);
      else log(`  ⚠️ 接送${i + 1}类型未选中: ${entry.type}`);

      let dateOk = false;
      const etDate = dateCell ? dateCell.querySelector('.et-date') : null;
      if (etDate && entry.date) {
        const dateResult = _setEtDate(etDate, entry.date);
        dateOk = dateResult.ok;
        if (dateResult.ok) log(`  ✅ 接送${i + 1}日期: ${entry.date}`);
        else log(`  ⚠️ 接送${i + 1}日期写入失败: ${entry.date} [${dateResult.detail}]`);
      } else if (dateCell && entry.date) {
        dateOk = setDirectInput(dateCell, entry.date);
        if (dateOk) log(`  ✅ 接送${i + 1}日期: ${entry.date}`);
        else log(`  ⚠️ 接送${i + 1}日期写入失败: ${entry.date}`);
      }

      const cityOk = await setSearchableDropdown(doc, parentDoc, cityCell, _normalizeCityName(entry.city), _normalizeCityName(entry.city));
      if (cityOk) log(`  ✅ 接送${i + 1}出发地: ${_normalizeCityName(entry.city)}`);
      else log(`  ⚠️ 接送${i + 1}出发地未选中: ${_normalizeCityName(entry.city)}`);

      if (typeOk || dateOk || cityOk) filled++;
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

  // ── 城市名称标准化（与 parser.js 同步）─────────────────────────

  function _normalizeCityName(name) {
    if (!name) return '';
    const map = {
      '蘭州': '兰州',
      '西寧': '西宁',
      '敦煌': '敦煌',
    };
    if (map[name]) return map[name];
    if (name.includes('曹家堡')) return '西宁';
    let result = name;
    for (const [trad, simp] of Object.entries(map)) {
      result = result.split(trad).join(simp);
    }
    // ponytail: strip airport suffix — ET818 下拉只有城市名
    result = result.replace(/机场(T\d)?/g, '').trim();
    // ponytail: strip district suffixes — "兰州中川" → "兰州"
    result = result.replace(/中川|浦东|虹桥|双流|江北|咸阳|萧山|禄口|天河|美兰|龙洞堡|首都|大兴|新郑|黄花|宝安|白云|长乐/g, '').trim();
    return result;
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
