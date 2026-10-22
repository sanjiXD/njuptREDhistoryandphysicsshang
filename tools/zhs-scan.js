/* ============================================================================
 * 智慧树课程页「结构扫描」脚本（只读，不点任何东西）
 * 用法：F12 → Console → 整段粘贴 → 回车 → 结果自动复制到剪贴板
 * 把复制到的 JSON 发我，我就能把自动连播脚本精确适配到你的页面。
 * ========================================================================== */
(() => {
  const short = (s, n = 60) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const docs = [];
  (function walk(root, depth) {
    docs.push(root);
    if (depth > 3) return;
    try {
      root.querySelectorAll('iframe').forEach((f) => {
        try { if (f.contentDocument) walk(f.contentDocument, depth + 1); } catch (e) {}
      });
    } catch (e) {}
  })(document, 0);

  const all = (sel) => {
    const r = [];
    docs.forEach((d) => { try { r.push(...d.querySelectorAll(sel)); } catch (e) {} });
    return r;
  };
  const vis = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    } catch (e) { return false; }
  };
  const count = (sel) => { try { return all(sel).length; } catch (e) { return -1; } };

  const LIST_SELECTORS = [
    '.chapter-content .chapter-item', '.chapter-content-second',
    '.child-main', '.clearfix.video', '.file-item',
    '.resources-item', '.source-icon', '[class*="card-container"]',
    '.el-collapse-item', '.catalogue_title',
    '.el-tree-node', '.el-tree-node__content', '.custom-tree-node',
    '.source-icon', '.file-name',
  ];

  const report = {
    url: location.href,
    title: document.title,
    at: new Date().toLocaleString(),
    iframes: [...document.querySelectorAll('iframe')].map((f) => {
      let same = false;
      try { same = !!f.contentDocument; } catch (e) {}
      return { src: short(f.src, 100), sameOrigin: same };
    }),
    videos: all('video').map((v, i) => {
      let box = '?';
      try { const r = v.getBoundingClientRect(); box = `${Math.round(r.width)}x${Math.round(r.height)}`; } catch (e) {}
      return {
        i,
        src: short(v.currentSrc || v.src, 120),
        duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null,
        currentTime: Number.isFinite(v.currentTime) ? +v.currentTime.toFixed(2) : null,
        paused: v.paused, ended: v.ended, readyState: v.readyState,
        box,
        parent: short(v.parentElement && v.parentElement.className, 80),
      };
    }),
    counts: Object.fromEntries(LIST_SELECTORS.map((s) => [s, count(s)])),
    // 目录项样本：取每个候选列表的前 5 个，看结构就知道该点谁
    samples: {},
    // 所有“下一节/继续学习”类按钮
    nextButtons: all('button,a,div,span,li,p,i,[role="button"]')
      .filter((el) => vis(el) && el.children.length <= 2 &&
        /下一|继续学习|继续观看|播放下一/.test(String(el.textContent || '').replace(/\s+/g, '')) &&
        String(el.textContent || '').replace(/\s+/g, '').length <= 10)
      .slice(0, 15)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: short(el.className, 80),
        text: short(el.textContent, 25),
        title: el.getAttribute('title') || '',
        disabled: !!el.disabled || /disabled/.test(String(el.className)),
      })),
    dialogs: all('[class*="dialog"],[class*="modal"],[class*="popup"],[class*="mask"]')
      .filter(vis).slice(0, 12)
      .map((el) => ({ cls: short(el.className, 80), text: short(el.textContent, 80) })),
  };

  LIST_SELECTORS.forEach((sel) => {
    let els = [];
    try { els = all(sel); } catch (e) {}
    if (!els.length) return;
    report.samples[sel] = els.slice(0, 5).map((el) => ({
      cls: short(el.className, 70),
      text: short(el.textContent, 40),
      active: /(^|\s)(current|active|current_play|activeNode|is-current)(\s|$)/.test(String(el.className)),
      finish: !!(el.querySelector && el.querySelector('.finish-icon,.time_icofinish,.isFinish,.icon-finish,label.success,i.select')),
      progress: (() => {
        const p = el.querySelector && el.querySelector('.el-progress,[role="progressbar"],.progress-num,.rate');
        return p ? short(p.getAttribute('aria-valuenow') || p.textContent, 12) : null;
      })(),
      html: short(el.outerHTML, 180),
    }));
  });

  console.log(report);
  try { copy(JSON.stringify(report, null, 2)); console.log('%c[SCAN] 已复制到剪贴板，直接粘贴给开发者', 'color:#0a0;font-weight:bold'); }
  catch (e) { console.log('[SCAN] 请右键上面的对象 → Copy object'); }
  return report;
})();
