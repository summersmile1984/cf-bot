/**
 * Web Push Service Worker（notifications T4）：空载荷推送 → 拉取最新通知展示；点击聚焦并深链。
 */
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = '你有一条新通知';
    let body = '';
    let link = null;
    try {
      const r = await fetch('/notifications?limit=1', { credentials: 'include' });
      const j = await r.json();
      const n = (j && j.items && j.items[0]) || null;
      if (n) {
        title = n.title || title;
        body = n.body || '';
        link = n.link || null;
      }
    } catch { /* 拉取失败也弹默认文案，不丢 push */ }
    await self.registration.showNotification(title, {
      body,
      tag: 'cf-bot-push',
      data: { link },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || null;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        await client.focus();
        if (link) client.postMessage({ type: 'navigate', link });
        return;
      }
    }
    await self.clients.openWindow('/');
  })());
});
