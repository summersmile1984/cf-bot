/**
 * cf-bot 交办助手（browser-ext S2.1）：捕获当前页/选中内容 → 打开 L1 站点预填任务草稿。
 * 零新鉴权面：复用浏览器里已登录的 L1 会话，用户回车即发（HITL 精神）。
 */
const DEFAULT_L1 = 'http://localhost:4120';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'cf-bot-page', title: '把这页发给秘书', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'cf-bot-selection', title: '把选中内容发给秘书', contexts: ['selection'] });
});

async function getL1() {
  const { l1Url } = await chrome.storage.sync.get('l1Url');
  return String(l1Url || DEFAULT_L1).replace(/\/+$/, '');
}

async function sendToSecretary(tab, extraText) {
  const l1 = await getL1();
  const title = String(tab?.title ?? '');
  const url = String(tab?.url ?? '');
  const body = extraText ? `选中内容：\n${extraText.slice(0, 6000)}` : '（请帮忙处理与这个网页相关的事）';
  const draft = `【网页交办】${title}\n${url}\n\n${body}`;
  chrome.tabs.create({ url: `${l1}/?task=${encodeURIComponent(draft)}` });
}

chrome.action.onClicked.addListener((tab) => sendToSecretary(tab, ''));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'cf-bot-page') sendToSecretary(tab, '');
  else if (info.menuItemId === 'cf-bot-selection') sendToSecretary(tab, info.selectionText || '');
});
