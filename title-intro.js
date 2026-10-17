/* 標題動畫獨立於戰鬥與存檔邏輯。 */
(() => {
  'use strict';
  const title = document.getElementById('startScreen');
  const rotate = document.getElementById('rotateHint');
  const subtitle = title.querySelector('.t2');
  let playing = false;
  let ready = false;
  let generation = 0;
  let fallback;
  const visible = () => !document.hidden && !title.classList.contains('hidden') &&
    (!rotate || rotate.classList.contains('hidden'));
  function revealMenu() {
    if (!playing || !visible()) return;
    ready = true;
    clearTimeout(fallback);
    title.classList.add('title-menu-ready');
  }
  subtitle.addEventListener('animationend', event => {
    if (event.target === subtitle) revealMenu();
  });
  function sync() {
    if (ready) return;
    if (!visible()) {
      playing = false;
      generation++;
      clearTimeout(fallback);
      if (title.classList.contains('title-intro-playing')) title.classList.remove('title-intro-playing');
      return;
    }
    if (playing) return;
    playing = true;
    const token = ++generation;
    // 先繪製透明初始狀態，避免 Safari 在初始化期間已跑完動畫。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== generation || !visible()) return;
      title.classList.remove('title-intro-pending');
      title.classList.add('title-intro-playing');
      fallback = setTimeout(revealMenu, 4000);
    }));
  }
  const observer = new MutationObserver(sync);
  observer.observe(title, { attributes:true, attributeFilter:['class'] });
  if (rotate) observer.observe(rotate, { attributes:true, attributeFilter:['class'] });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pageshow', sync);
  sync();
})();
