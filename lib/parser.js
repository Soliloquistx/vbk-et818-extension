/**
 * VBK 订单详情页解析器
 *
 * 从 VBK DOM 提取结构化订单数据。
 * 支持标准单 (orderDetail) 和占位单 (holdOrderDetail)。
 * 支持 HTML table 和纯文本两种页面结构。
 *
 * By 飞鱼
 */

const VBKParser = (() => {

  // ── 页面类型检测 ──────────────────────────────────────────────

  function detectOrderType() {
    const url = location.href;
    if (url.includes('holdOrderDetail')) return 'hold';
    if (url.includes('orderDetail')) return 'standard';
    return null;
  }

  // ── 加密信息处理 ──────────────────────────────────────────────

  function isInfoHidden() {
    const btn = _findEncryptButton();
    return btn && btn.textContent.includes('查看加密信息');
  }

  function clickRevealEncrypted() {
    const btn = _findEncryptButton();
    if (btn && btn.textContent.includes('查看加密信息')) {
      btn.click();
      return true;
    }
    return false;
  }

  /**
   * 等待解密完成：MutationObserver + 轮询双保险
   * @param {number} timeout - 最长等待时间 ms
   * @returns {boolean} 解密是否成功
   */
  async function waitForDecrypt(timeout = 15000) {
    // 方案 A: MutationObserver 监听 DOM 变化
    const domChanged = await new Promise(resolve => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(false); }
      }, timeout);

      const observer = new MutationObserver(() => {
        // 检测：出现 18 位身份证号（不要求 **** 全部消失，因为电话里可能还有）
        const bodyText = document.body.innerText;
        if (/\d{17}[\dXx]/.test(bodyText)) {
          if (!resolved) { resolved = true; clearTimeout(timer); observer.disconnect(); resolve(true); }
        }
        // 检测：按钮变成"隐藏加密信息"
        const btn = _findEncryptButton();
        if (btn && btn.textContent.includes('隐藏加密信息')) {
          if (!resolved) { resolved = true; clearTimeout(timer); observer.disconnect(); resolve(true); }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      // 方案 B: 兜底轮询
      const poll = async () => {
        while (!resolved) {
          await _sleep(1000);
          if (resolved) break;
          const bodyText = document.body.innerText;
          if (/\d{17}[\dXx]/.test(bodyText)) {
            if (!resolved) { resolved = true; clearTimeout(timer); observer.disconnect(); resolve(true); }
            break;
          }
        }
      };
      poll();
    });

    return domChanged;
  }

  function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function _findEncryptButton() {
    // 优先找 span（精确文本匹配）
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      if (span.textContent.trim() === '查看加密信息' && span.offsetParent !== null) {
        // 返回最近的可点击父元素（button 或 a）
        return span.closest('button, a') || span;
      }
    }
    // 备选：找 button 直接包含该文本
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes('查看加密信息') && btn.offsetParent !== null) {
        return btn;
      }
    }
    return null;
  }

  // ── 订单元信息提取（修复：适配实际页面格式） ──────────────────

  function extractOrderMeta() {
    const bodyText = document.body.innerText;
    const meta = {};

    // 订单号 — 支持冒号或空格分隔
    const orderNoMatch = bodyText.match(/订单号[\s：:]+(\d{10,})/);
    if (orderNoMatch) meta.order_no = orderNoMatch[1];

    // 供应商产品名称 — 优先，比产品标题更适合 ET818 模板匹配
    const supplierMatch = bodyText.match(/供应商产品名称[\s：:]+(.+?)[\n\r|]/);
    if (supplierMatch) meta.route_name = supplierMatch[1].trim();

    // 产品名称（完整标题）
    // 在 "订单号 xxx" 和 "产品快照" 之间的文本就是产品名
    const productBlock = bodyText.match(/订单号[\s：:]+\d+[\s\n]+(.+?)[\n\r]+.*?产品快照/s);
    if (productBlock) {
      meta.product_name = productBlock[1].trim().replace(/[\n\r]+/g, ' ');
    }

    // 出发/返回日期 — 格式 "出发/返回日期： 2026-06-22 / 2026-06-28"
    const dateMatch = bodyText.match(/出发\/返回日期[\s：:]+([\d-]+)\s*\/\s*([\d-]+)/);
    if (dateMatch) {
      meta.departure_date = _normalizeDate(dateMatch[1]);
      meta.return_date = _normalizeDate(dateMatch[2]);
    }

    // 联系人
    const contactMatch = bodyText.match(/联系人[\s：:]+([\u4e00-\u9fa5]{2,6})/);
    if (contactMatch) meta.customer_name = contactMatch[1];

    // 分销渠道
    const channelMatch = bodyText.match(/分销渠道[\s：:]+(.+?)[\n\r]/);
    if (channelMatch) {
      const ch = channelMatch[1].trim();
      if (ch && ch !== '-') {
        // 门店单 → "携程门店83"，其他 → 原值
        if (ch.includes('门店')) meta.channel = '携程门店83';
        else meta.channel = ch;
      }
    }

    // 商家备注
    const noteMatch = bodyText.match(/商家备注[\s：:]+(.+?)(?:\n我的预订|$)/s);
    if (noteMatch) {
      const note = noteMatch[1].trim();
      if (note && note !== '添加商家备注') meta.merchant_note = note;
    }

    return meta;
  }

  // ── 客人表解析（双策略：DOM table 优先，文本兜底） ─────────────

  function parseTravellers() {
    // 策略 1: 尝试从 DOM table 解析
    let travellers = parseTravellersFromDOM();
    if (travellers.length > 0) return travellers;

    // 策略 2: 从页面文本解析
    travellers = parseTravellersFromText();
    return travellers;
  }

  // --- DOM table 解析 ---
  function parseTravellersFromDOM() {
    const table = _findTableByHeaders(['姓名', '证件号']);
    if (!table) return [];

    const headerMap = _buildHeaderMap(table);
    const rows = table.querySelectorAll('tr');
    const travellers = [];

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td, th');
      if (cells.length < 5) continue;

      const name = _cellText(cells, headerMap['姓名']);
      if (!name || _isNoise(name)) continue;

      // 清理姓名：去掉尾部的年龄提示（如 "洪茂钦60岁以上老人" → "洪茂钦"）
      const cleanName = name.replace(/\d+岁以上.*$/, '').trim();

      // 性别类型可能在同一列（如 "男 成人"）
      const genderTypeText = _cellText(cells, headerMap['性别']) || _cellText(cells, headerMap['类型']);
      let gender = '', personType = '';
      if (genderTypeText) {
        if (genderTypeText.includes('男')) gender = '男';
        if (genderTypeText.includes('女')) gender = '女';
        if (genderTypeText.includes('成人')) personType = '成人';
        else if (genderTypeText.includes('儿童')) personType = '儿童';
        else if (genderTypeText.includes('婴儿')) personType = '婴儿';
      }

      // 证件类型证件号可能在同一列（如 "身份证 3101..."）
      const idText = _cellText(cells, headerMap['证件号']) || _cellText(cells, headerMap['证件类型']);
      let idType = '身份证', idNo = '';
      if (idText) {
        if (idText.includes('护照')) idType = '护照';
        const idMatch = idText.match(/(?:[\d*]{15,17}[\d*Xx]?|[\d*]{14,17}[Xx])/);
        if (idMatch) idNo = idMatch[0];
      }

      travellers.push({
        name: cleanName || name,
        gender: _normGender(gender),
        person_type: personType,
        birth_date: _parseDateParts(_cellText(cells, headerMap['生日'])),
        id_type: idType,
        id_no: idNo || _extractIdNo(_cellText(cells, headerMap['证件号'])),
        room_sharing: _cellText(cells, headerMap['是否拼房']) || '',
        room_sharing_type: _cellText(cells, headerMap['拼房类型']) || '',
        phone: _extractPhone(_cellText(cells, headerMap['电话'])),
      });
    }
    return travellers;
  }

  // --- 纯文本解析（兜底） ---
  function parseTravellersFromText() {
    const bodyText = document.body.innerText;
    const travellers = [];

    // 找到出行人数据区：多种定位策略
    let dataSection = '';

    // 策略 1: 姓名 → 操作（标准表头）
    let headerIdx = bodyText.indexOf('姓名');
    let headerEnd = headerIdx >= 0 ? bodyText.indexOf('操作', headerIdx) : -1;
    if (headerEnd > headerIdx) {
      const dataStart = headerEnd + 2;
      const dataEnd = bodyText.indexOf('物流单', dataStart);
      dataSection = dataEnd > dataStart
        ? bodyText.substring(dataStart, dataEnd)
        : bodyText.substring(dataStart, dataStart + 3000);
    }

    // 策略 2: 出行人 → 物流单/机票（备用关键词）
    if (!dataSection || dataSection.length < 20) {
      const secStart = bodyText.indexOf('出行人');
      if (secStart >= 0) {
        const secEnd = bodyText.indexOf('物流单', secStart);
        dataSection = secEnd > secStart
          ? bodyText.substring(secStart, secEnd)
          : bodyText.substring(secStart, secStart + 3000);
      }
    }

    // 策略 3: 直接找「男」/「女」独占行，往前取姓名
    if (!dataSection || dataSection.length < 20) {
      dataSection = bodyText; // 全文扫描
    }

    // 用正则按"姓名"切割成块
    // 姓名独占一行，后面可能跟提示语（如"60岁以上老人"），再后面是性别
    // 验证：姓名行后面 4 行内必须出现性别（男/女）独占一行
    const namePattern = /\n([^\n]{2,50})\n/g;
    const blocks = [];
    let match;

    const lines = dataSection.split('\n').map(l => l.trim()).filter(Boolean);
    const namePositions = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 跳过已知噪音/表头
      if (_isNoise(line)) continue;
      // 候选姓名：2-50 字符，不是纯数字
      if (line.length < 2 || line.length > 50 || /^\d+$/.test(line)) continue;

      // 验证：往后看 4 行内是否有性别标记
      let hasGender = false;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j] === '男' || lines[j] === '女') {
          hasGender = true;
          break;
        }
      }
      if (!hasGender) continue;

      // 记录姓名行在原始文本中的位置
      const pos = dataSection.indexOf('\n' + line + '\n');
      if (pos >= 0) {
        namePositions.push({ index: pos + 1 }); // +1 跳过前导 \n
      }
    }

    if (namePositions.length === 0) return [];

    // 按姓名位置切割
    for (let i = 0; i < namePositions.length; i++) {
      const start = namePositions[i].index;
      const end = i + 1 < namePositions.length ? namePositions[i + 1].index : dataSection.length;
      const block = dataSection.substring(start, end).trim();
      if (block) blocks.push(block);
    }

    for (const block of blocks) {
      const t = _parseTravellerBlock(block);
      if (t) travellers.push(t);
    }

    return travellers;
  }

  function _parseTravellerBlock(block) {
    // 把 block 按 tab 和换行分割成 parts
    const parts = block.split(/[\t\n]+/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;

    const name = parts[0];
    // 姓名：2-50 字符，不能是纯数字/已知噪音
    if (name.length < 2 || name.length > 50 || /^\d+$/.test(name)) return null;

    // 清理姓名：去掉尾部的年龄提示（如 "洪茂钦60岁以上老人" → "洪茂钦"）
    const cleanName = name.replace(/\d+岁以上.*$/, '').trim();

    let gender = '', personType = '', birthday = '', idType = '身份证', idNo = '';
    let roomSharing = '', roomSharingType = '', phone = '';

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      if (!p) continue;

      if (p === '男' || p === '女') {
        gender = p;
      } else if (p === '成人' || p === '儿童' || p === '婴儿') {
        personType = p;
      } else if (/^[\u4e00-\u9fa5]{2,8}$/.test(p) && !_isNoise(p)) {
        // 纯中文 2-8 字且非噪音 → 可能是附加标签（如"60岁以上老人"含数字，不匹配此分支）
        // 也可能是表头残留，跳过
      } else if (/^\d+岁以上/.test(p)) {
        // 红色提示语（如 "60岁以上老人"），跳过
      } else if (/^\*{4}-\*{2}-\*{2}$/.test(p) || /^\d{4}-\d{2}-\d{2}$/.test(p)) {
        birthday = p;
      } else if (p.startsWith('身份证') || p.startsWith('护照')) {
        idType = p.includes('护照') ? '护照' : '身份证';
        // 可能含证件号： "身份证 • 1201***********542"
        const idMatch = p.match(/(?:[\d*]{15,17}[\d*Xx]?|[\d*]{14,17}[Xx])/);
        if (idMatch) idNo = idMatch[0];
      } else if (/\d{15,18}/.test(p) || /[\d*]{14,17}[Xx]/.test(p) || /[\d*]{15,17}[\d*Xx]?/.test(p)) {
        const idMatch2 = p.match(/(?:[\d*]{15,17}[\d*Xx]?|[\d*]{14,17}[Xx])/);
        if (idMatch2 && !idNo) idNo = idMatch2[0];
      } else if (p.startsWith('是') || p === '否') {
        roomSharing = p.startsWith('是') ? '是' : '否';
        if (p.includes('拼房')) roomSharingType = p;
      } else if (p.includes('拼房')) {
        roomSharingType = p;
      } else if (/1[3-9]\d{9}/.test(p)) {
        const m = p.match(/1[3-9]\d{9}/);
        if (m) phone = m[0];
      } else if (/^\d{3,5}[\s-]?\d{7,12}/.test(p)) {
        phone = _extractPhone(p);
      }
    }

    // 默认成人
    if (!personType) personType = '成人';

    return {
      name: cleanName || name,
      gender: _normGender(gender),
      person_type: personType,
      birth_date: _parseDateParts(birthday),
      id_type: idType,
      id_no: idNo,
      room_sharing: roomSharing,
      room_sharing_type: roomSharingType,
      phone,
    };
  }

  // ── 航班/交通信息解析 ─────────────────────────────────────────

  function parseFlights() {
    const bodyText = document.body.innerText;
    const flights = [];

    // 从文本中提取航班信息
    // 格式: HU7498 或 MU6263 航班号出现在机票表区域
    const flightSection = _extractSection(bodyText, '机票', '出行人');

    if (flightSection) {
      // 匹配航班号模式：2字母+数字
      const flightNos = flightSection.match(/[A-Z]{2}\d{3,5}/g) || [];
      // 匹配起飞时间
      const times = flightSection.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g) || [];

      for (let i = 0; i < flightNos.length; i++) {
        flights.push({
          flight_no: flightNos[i],
          departure_time: times[i * 2] || '', // 每个航班有起飞和到达两个时间
        });
      }
    }

    // 备选：从 DOM table 提取
    if (flights.length === 0) {
      const table = _findTableByHeaders(['航班', '起飞']);
      if (table) {
        const headerMap = _buildHeaderMap(table);
        const rows = table.querySelectorAll('tr');
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td, th');
          if (cells.length < 3) continue;
          const flightNo = _cellText(cells, headerMap['航班号']) ||
            _cellText(cells, headerMap['航班']) || '';
          if (!flightNo) continue;
          flights.push({
            flight_no: flightNo,
            departure_time: _cellText(cells, headerMap['起飞时间']) || '',
          });
        }
      }
    }

    return flights;
  }

  // ── 总计金额提取 ──────────────────────────────────────────────

  function extractTotal() {
    const bodyText = document.body.innerText;

    // 标准单：总计：6125.62CNY
    const m1 = bodyText.match(/总计[\s：:]+([\d,]+\.?\d*)\s*(?:CNY|元|￥|¥)?/);
    if (m1) return _parseMoney(m1[1]);

    // 占位单：订单总额 ... 金额
    const m2 = bodyText.match(/订单总额[\s\S]*?([\d,]+\.\d{2})/);
    if (m2) return _parseMoney(m2[1]);

    return null;
  }

  // ── 出发城市提取 ─────────────────────────────────────────────

  function extractDepartureCity() {
    // 从资源表提取出发城市（table 含 "资源名称" + "出发城市" 表头）
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headerText = _getTableHeaderText(table);
      if (headerText.includes('资源名称') && headerText.includes('出发城市')) {
        const headerMap = _buildHeaderMap(table);
        const rows = table.querySelectorAll('tr');
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td, th');
          const city = _cellText(cells, headerMap['出发城市']);
          if (city && city !== '--' && city.length >= 2) return city;
        }
      }
    }

    // 备选：从航班出发机场推断
    const bodyText = document.body.innerText;
    const airportMatch = bodyText.match(/(?:长乐|虹桥|浦东|白云|宝安|双流|江北|咸阳|萧山|咸阳|禄口|天河|美兰|龙洞堡)/);
    if (airportMatch) {
      const airportMap = {
        '长乐': '福州', '虹桥': '上海', '浦东': '上海',
        '白云': '广州', '宝安': '深圳', '双流': '成都',
        '江北': '重庆', '咸阳': '西安', '萧山': '杭州',
        '禄口': '南京', '天河': '武汉', '美兰': '海口',
        '龙洞堡': '贵阳',
      };
      return airportMap[airportMatch[0]] || '';
    }

    return '';
  }

  // ── 大交通类型提取 ───────────────────────────────────────────

  /**
   * 交通类型判断逻辑：
   * - 有航班信息 → 从产品名判断具体类型（双飞/双卧/双高等），默认双飞
   * - 无航班信息 → 返回空（由 filler 处理为接机送机）
   */
  function extractTransportType(productName, flights) {
    const hasFlights = flights && flights.length > 0;

    if (hasFlights) {
      // 有航班 → 从产品名精确判断
      const patterns = [
        { re: /双飞/, value: '双飞' },
        { re: /双卧/, value: '双卧' },
        { re: /双高/, value: '双高' },
        { re: /单飞单卧|飞卧/, value: '单飞单卧' },
        { re: /单卧单飞|卧飞/, value: '单卧单飞' },
      ];
      for (const p of patterns) {
        if (p.re.test(productName || '')) return p.value;
      }
      // 有航班但产品名无明确标识 → 默认双飞
      return '双飞';
    }

    // 无航班 → 不设默认值，由 filler 处理
    return '';
  }

  // ── 用房信息提取 ─────────────────────────────────────────────

  /**
   * 用房规则（用户确认）：
   *   同性拼房 (room_sharing='是'):
   *     每人0.5标间 → 2人=1标间, 3人=1.5标间
   *   不拼房 (room_sharing='否'):
   *     1人=1大床, 2人=1标间, 3人=1标间+1大床, 4人=2标间
   *   单房差（商家备注含"单房差"）:
   *     有单房差的客人不论拼房状态，1人=1大床
   *   返回: { star_rating, 标间数, 大床数 }
   */
  function extractRoomInfo(note, travellers, routeName) {
    // 从供应商产品名称提取钻级
    let starRating = '';
    if (routeName) {
      const starMatch = routeName.match(/(\d)钻/);
      if (starMatch) starRating = starMatch[1] + '钻';
    }

    if (!travellers || travellers.length === 0) {
      return { star_rating: starRating, biao: 0, dachuang: 0, single_room_diff_needed: false };
    }

    // 检测单房差：商家备注中包含"单房差"
    const hasDanFangCha = note && note.includes('单房差');

    const sharing = travellers.filter(t => t.room_sharing === '是');
    const notSharing = travellers.filter(t => t.room_sharing === '否');
    const unknown = travellers.filter(t => !t.room_sharing || (t.room_sharing !== '是' && t.room_sharing !== '否'));

    // 单房差规则：有单房差的客人不论拼房状态，1人=1大床
    if (hasDanFangCha) {
      // 所有客人都因单房差获得独立用房，每人1大床
      return {
        star_rating: starRating,
        biao: 0,
        dachuang: travellers.length,
        single_room_diff_needed: true,
      };
    }

    // 标准逻辑：未知状态默认按拼房处理
    const effectiveSharing = sharing.length + unknown.length;

    return {
      star_rating: starRating,
      biao: effectiveSharing * 0.5,
      dachuang: notSharing.length,
      single_room_diff_needed: notSharing.length > 0,
    };
  }

  // ── 接送信息提取 ─────────────────────────────────────────────

  function parsePickupDropoff() {
    // 从航班表提取接送段
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headerText = _getTableHeaderText(table);
      if (headerText.includes('出发机场') && headerText.includes('航班号')) {
        const headerMap = _buildHeaderMap(table);
        const rows = table.querySelectorAll('tr');
        const segments = [];

        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td, th');
          if (cells.length < 4) continue;

          const route = _cellText(cells, headerMap['出发机场-到达机场']) ||
                        _cellText(cells, headerMap['出发机场']) || '';
          if (!route || route === '--') continue;

          const departureTime = _cellText(cells, headerMap['起飞时间(当地时间)']) ||
                                _cellText(cells, headerMap['起飞时间']) || '';
          const arrivalTime = _cellText(cells, headerMap['到达时间(当地时间)']) ||
                              _cellText(cells, headerMap['到达时间']) || '';
          const flightNo = _cellText(cells, headerMap['航班号']) || '';

          // 解析路线：出发机场-到达机场
          const routeParts = route.split('-');
          const from = routeParts[0] || '';
          const to = routeParts.slice(1).join('-') || '';

          segments.push({
            direction: i === 1 ? '去程' : '回程',
            flight_no: flightNo,
            from: _mapAirportToCity(from),
            to: _mapAirportToCity(to),
            departure_time: departureTime,
            arrival_time: arrivalTime,
            // 去程登记：到达机场+到达时间；返程登记：出发机场+出发时间
            register_airport: _mapAirportToCity(i === 1 ? to : from),
            register_time: i === 1 ? arrivalTime : departureTime,
          });
        }

        if (segments.length > 0) return segments;
      }
    }

    return [];
  }

  // ── 主解析入口 ────────────────────────────────────────────────

  function parse() {
    const orderType = detectOrderType();
    if (!orderType) return null;

    const meta = extractOrderMeta();
    const travellers = parseTravellers();
    const flights = parseFlights();
    const total = extractTotal();
    const departureCity = extractDepartureCity();
    const transportType = extractTransportType(meta.route_name || meta.product_name || '', flights);
    const roomInfo = extractRoomInfo(meta.merchant_note || '', travellers, meta.route_name || '');
    const pickupDropoff = parsePickupDropoff();

    const encrypted_hidden = isInfoHidden();

    return {
      order_no: meta.order_no || '',
      order_type: orderType,
      product_name: meta.product_name || '',
      route_name: meta.route_name || meta.product_name || '',
      departure_date: meta.departure_date || '',
      return_date: meta.return_date || '',
      customer_name: meta.customer_name || '',
      channel: meta.channel || '',
      merchant_note: meta.merchant_note || '',
      departure_city: departureCity,
      transport_type: transportType,
      room_info: roomInfo,
      travellers,
      flights,
      pickup_dropoff: pickupDropoff,
      has_flights: flights.length > 0,
      total_amount: total,
      encrypted_hidden,
      scraped_at: Date.now(),
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  内部工具
  // ══════════════════════════════════════════════════════════════

  // ── 机场名→城市名映射 ───────────────────────────────────────

  function _mapAirportToCity(airportName) {
    if (!airportName) return '';
    const map = {
      '长乐国际机场': '福州长乐',
      '中川机场T3': '兰州中川',
      '中川机场': '兰州中川',
      '曹家堡机场': '西宁',
      '虹桥机场': '上海虹桥',
      '浦东机场': '上海浦东',
      '白云机场': '广州白云',
      '宝安机场': '深圳宝安',
      '双流机场': '成都双流',
      '江北机场': '重庆江北',
      '咸阳机场': '西安咸阳',
      '萧山机场': '杭州萧山',
      '禄口机场': '南京禄口',
      '天河机场': '武汉天河',
      '美兰机场': '海口美兰',
      '龙洞堡机场': '贵阳龙洞堡',
      '首都机场': '北京首都',
      '大兴机场': '北京大兴',
      '新郑机场': '郑州新郑',
      '黄花机场': '长沙黄花',
      '新白云机场': '广州白云',
    };
    // 精确匹配
    if (map[airportName]) return map[airportName];
    // 模糊匹配（去掉 T3/T2/T1 后缀）
    const cleanName = airportName.replace(/T\d$/i, '');
    if (map[cleanName]) return map[cleanName];
    // 关键词匹配
    for (const [key, value] of Object.entries(map)) {
      if (airportName.includes(key) || key.includes(airportName)) return value;
    }
    return airportName;
  }

  function _findTableByHeaders(keywords) {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headerText = _getTableHeaderText(table);
      if (keywords.every(kw => headerText.includes(kw))) return table;
    }
    return null;
  }

  function _getTableHeaderText(table) {
    const rows = table.querySelectorAll('tr');
    let text = '';
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      text += ' ' + rows[i].textContent;
    }
    return text;
  }

  function _buildHeaderMap(table) {
    const map = {};
    const rows = table.querySelectorAll('tr');
    if (rows.length === 0) return map;
    const cells = rows[0].querySelectorAll('th, td');
    cells.forEach((cell, idx) => {
      const text = cell.textContent.trim().replace(/\s+/g, '');
      if (text) {
        map[text] = idx;
        // 处理合并表头：拆分 "证件类型证件号" → 同时映射 "证件类型" 和 "证件号"
        const parts = _splitCombinedHeader(text);
        for (const part of parts) {
          if (!(part in map)) map[part] = idx;
        }
      }
    });
    return map;
  }

  // 拆分合并表头（如 "证件类型证件号" → ["证件类型", "证件号"]）
  function _splitCombinedHeader(text) {
    const keywords = [
      '姓名', '性别', '类型', '生日', '出生地', '国家地区', '证件类型', '证件号',
      '签发地', '证件有效期', '签发日期', '是否拼房', '拼房类型', '电话', '操作',
    ];
    const parts = [];
    for (const kw of keywords) {
      if (text.includes(kw) && text !== kw) {
        parts.push(kw);
      }
    }
    return parts;
  }

  function _cellText(cells, idx) {
    if (idx === undefined || idx === null || !cells[idx]) return '';
    return cells[idx].textContent.trim();
  }

  function _extractSection(text, startKeyword, endKeyword) {
    const start = text.indexOf(startKeyword);
    if (start < 0) return null;
    const end = endKeyword ? text.indexOf(endKeyword, start) : -1;
    return end > start ? text.substring(start, end) : text.substring(start, start + 1000);
  }

  function _isNoise(text) {
    // 精确匹配噪音值，不用 includes 避免误杀 "60岁以上老人" 等附加标签
    const exactNoise = ['成人', '儿童', '婴儿', '中国大陆', '身份证', '护照',
      'CN', '--', '操作', '姓名', '性别', '类型', '生日', '证件类型',
      '证件号', '电话', '查看加密信息', '签发地', '证件有效期', '签发日期',
      '是否拼房', '拼房类型', '国家/地区', '出生地'];
    if (exactNoise.includes(text)) return true;
    if (/^\d+$/.test(text)) return true;        // 纯数字
    if (text.length > 30) return true;           // 太长（非姓名）
    if (text.length < 1) return true;            // 空
    return false;
  }

  function _normGender(g) {
    if (!g) return '';
    if (g.includes('男')) return '男';
    if (g.includes('女')) return '女';
    return g;
  }

  function _normIdType(t) {
    if (!t) return '身份证';
    if (t.includes('护照')) return '护照';
    return '身份证';
  }

  function _extractIdNo(text) {
    if (!text) return '';
    // 匹配身份证号（可能脱敏）：1201***********542 或完整18位（含末尾X）
    // 优先匹配含 Xx 结尾的，兜底匹配无 X 的
    const m = text.match(/(?:[\d*]{15,17}[\d*Xx]?|[\d*]{14,17}[Xx])/);
    return m ? m[0] : text.trim();
  }

  function _extractPhone(text) {
    if (!text) return '';
    // 优先：从"真实号码"后提取（VBK 解密后格式）
    const realMatch = text.match(/真实号码[+86]*(1[3-9]\d{9})/);
    if (realMatch) return realMatch[1];
    // 匹配真实手机号
    const mobile = text.match(/1[3-9]\d{9}/);
    if (mobile) return mobile[0];
    // 固话/总机
    const landline = text.match(/\d{3,4}[\s-]?\d{7,8}/);
    if (landline) return landline[0];
    return '';
  }

  function _parseDateParts(dateStr) {
    if (!dateStr || dateStr.includes('****')) return { year: '', month: '', day: '' };
    const parts = dateStr.split(/[-\/]/);
    return {
      year: parts[0] || '',
      month: parts[1] || '',
      day: parts[2] || '',
    };
  }

  function _normalizeDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split(/[-\/]/);
    if (parts.length === 3) {
      const y = parts[0].length === 2 ? '20' + parts[0] : parts[0];
      return `${y}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    }
    return dateStr;
  }

  function _parseMoney(str) {
    return parseFloat(str.replace(/,/g, '')) || 0;
  }

  // ── 公开 API ──────────────────────────────────────────────────

  return {
    parse,
    parseTravellers,
    parseTravellersFromText,
    parseFlights,
    extractTotal,
    extractOrderMeta,
    detectOrderType,
    isInfoHidden,
    clickRevealEncrypted,
    waitForDecrypt,
  };
})();
