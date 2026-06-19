/**
 * Service Worker — 后台脚本
 * 职责：badge 数字管理
 * By 飞鱼
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPDATE_BADGE') {
    const count = msg.count || 0;
    chrome.action.setBadgeText({
      text: count > 0 ? String(count) : '',
      tabId: sender.tab?.id,
    });
    chrome.action.setBadgeBackgroundColor({
      color: '#1a73e8',
      tabId: sender.tab?.id,
    });
    sendResponse({ ok: true });
  }
});
