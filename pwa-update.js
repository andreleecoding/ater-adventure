/* 亞特的冒險 v1.0.2 — PWA 更新管理（與遊戲程式獨立） */
(() => {
  'use strict';
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const notice = document.getElementById('pwaUpdateNotice');
  const now = document.getElementById('pwaUpdateNow');
  const later = document.getElementById('pwaUpdateLater');
  let registration = null;
  let waitingWorker = null;
  let refreshing = false;
  let dismissedWorker = null;
  let initialController = !!navigator.serviceWorker.controller;

  function checkWaiting(reg) {
    if (!reg || !reg.waiting || !navigator.serviceWorker.controller) return;
    waitingWorker = reg.waiting;
    if (waitingWorker !== dismissedWorker) notice.hidden = false;
  }
  function track(reg) {
    if (!reg) return;
    registration = reg;
    checkWaiting(reg);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') checkWaiting(reg);
      });
    });
  }
  now.addEventListener('click', () => {
    if (!waitingWorker) return;
    now.disabled = true;
    now.textContent = '更新中…';
    // 只有使用者按下「立即更新」才切換版本，避免中斷當局遊戲。
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });
  later.addEventListener('click', () => {
    dismissedWorker = waitingWorker;
    notice.hidden = true;
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    // 首次啟用 SW 不重載；只有舊版切換到新版才重新啟動。
    if (!initialController) { initialController = true; return; }
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(reg => {
      track(reg);
      // 首次開啟、回到前景，以及定時確認更新。
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { reg.update().catch(() => {}); checkWaiting(reg); }
      });
      window.addEventListener('focus', () => { reg.update().catch(() => {}); checkWaiting(reg); });
      setInterval(() => { if (!document.hidden) reg.update().catch(() => {}); }, 60 * 60 * 1000);
    })
    .catch(err => console.warn('離線功能未啟用：', err));
})();
