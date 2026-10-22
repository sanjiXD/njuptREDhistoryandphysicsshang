// ==UserScript==
// @name         智慧树 · 播完自动下一节 v2（带视频加载守护）
// @namespace    local.zhs.autonext.v2
// @version      1.9
// @description  视频播完自动切到目录的下一节并续播；未记为完成则重播本节；带视频加载失败自动重试
// @author       local
// @match        *://*.zhihuishu.com/*
// @match        *://*.polymas.com/*
// @exclude      *://ai-smart-course-student-pro.zhihuishu.com/*
// @exclude      *://smartcoursestudent.zhihuishu.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 原理：
 *   1. 接管页面里的 <video>，监听 ended（并用 Worker 定时器兜底，后台标签页不被节流）
 *   2. 播完等平台把本节标记为已完成（打勾 / 百分比消失 / ≥99%）
 *   3. 记上了 → 点目录里的下一节；没记上 → 回放本节，最多 2 次
 *   4. 视频加载失败（代理/网络拦截）会自动 load + play 重试，最多 3 次
 */
(() => {
  'use strict';

  /* ============================ 可调参数 ============================ */
  const CFG = {
    rate: 1,                  // 倍速：1 / 1.25 / 1.5（智慧树超过 1.5 有风控）
    muted: true,              // 静音播放，后台自动播放最稳；想出声改成 false
    keepPlaying: true,        // 被意外暂停时自动续播
    autoNext: true,           // 播完自动下一节
    waitDoneMs: 8000,         // 播完后等平台记进度的时间
    tailRetry: 1,             // 进度没记满时回退到结尾重播几次
    completeWaitMs: 12000,    // 播完后等平台记为“已完成”的上限
    maxReplay: 2,             // 没记为完成时，重播本节的次数上限
    clickDelayMs: 1200,       // 点下一节前的缓冲
    videoRetry: 3,            // 视频加载失败时最多重试几次
    dismissQuizzes: false,    // 是否自动关“弹题/AI随堂练习”弹窗（会随便选一项，仅解阻塞）
    badge: true,              // 右下角状态标签
    verbose: true,            // 控制台日志
  };

  const VERSION = '1.9';
  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return true; } })();

  const K_STOP = '__zhs_stop__';
  const K_LAST = '__zhs_last__';
  const K_COUNT = '__zhs_count__';
  const K_LOCK = '__zhs_lock__';
  const K_SEEN = '__zhs_seen__';
  const K_ADV = '__zhs_adv__';
  const K_RETRY = '__zhs_retry__';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => CFG.verbose && console.log('%c[ZHS]', 'color:#2d8cf0;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[ZHS]', 'color:#f90;font-weight:bold', ...a);
  const _warnAt = {};
  const warnThrottled = (k, ...a) => {
    const now = Date.now();
    if (now - (_warnAt[k] || 0) < 6000) return;
    _warnAt[k] = now; warn(...a);
  };
  const short = (s, n = 46) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').trim();
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  // 节点文本里文件名和百分比是粘在一起的（"...初心.mp4" + "11.37%"），先把扩展名去掉再解析
  const cleanText = (el) => String((el && el.textContent) || '')
    .replace(/\.(mp4|mp3|m4v|mov|avi|pdf|pptx?|docx?|xlsx?|zip|rar)/gi, '')
    .replace(/\s+/g, '');

  const store = {
    get(k, d) { try { const v = sessionStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { sessionStorage.setItem(k, String(v)); } catch (e) {} },
  };

  /* ============================ 基础工具 ============================ */
  function style(el) {
    try { return (el.ownerDocument.defaultView || window).getComputedStyle(el); } catch (e) { return null; }
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = style(el);
      if (!s || s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      let p = el.parentElement, guard = 0;
      while (p && guard++ < 40) {
        const ps = style(p);
        if (ps && (ps.display === 'none' || ps.visibility === 'hidden')) return false;
        p = p.parentElement;
      }
      return true;
    } catch (e) { return false; }
  }

  let DOCS = [];
  function collectDocs(root = document, out = [], depth = 0) {
    out.push(root);
    if (depth > 3) return out;
    let frames = [];
    try { frames = root.querySelectorAll('iframe'); } catch (e) { return out; }
    frames.forEach((f) => {
      try { if (f.contentDocument) collectDocs(f.contentDocument, out, depth + 1); } catch (e) {}
    });
    return out;
  }
  const all = (sel) => {
    const r = [];
    for (const d of DOCS) { try { r.push(...d.querySelectorAll(sel)); } catch (e) {} }
    return r;
  };
  const one = (sel) => {
    for (const d of DOCS) { try { const el = d.querySelector(sel); if (el) return el; } catch (e) {} }
    return null;
  };

  /* ============================ 页面适配器 ============================ */
  const ADAPTERS = [
    {
      // hike 教学中心：el-tree，叶子节点带 data-key，URL 里就含当前课时的 data-key
      name: 'AI教学中心（el-tree）',
      items() {
        return all('.el-tree-node').filter((e) => {
          const leaf = e.querySelector(':scope > .el-tree-node__content .el-tree-node__expand-icon.is-leaf');
          if (!leaf) return false;                 // 排除课程根节点/章节点
          return !!e.querySelector('.file-name, .custom-tree-node');
        });
      },
      active(el) {
        // 这个站切课时不一定改 URL，所以先认目录里的高亮节点
        if (el.classList.contains('is-current')) return true;
        if (el.querySelector('.custom-tree-node.current, .file-name.current')) return true;
        const k = el.getAttribute('data-key');
        return !!(k && location.href.indexOf(k) >= 0);
      },
      // 这个目录每个节点都有 .check/.el-checkbox；打勾（is-checked）= 已完成
      forceAdvance: true,
      done(el) {
        if (el.querySelector('.el-checkbox.is-checked, .el-checkbox__input.is-checked')) return true;
        if (el.getAttribute('aria-checked') === 'true') return true;
        const t = cleanText(el);
        if (/(^|[^\d.])100(\.0+)?%/.test(t)) return true;
        return /已完成|已学完/.test(t);
      },
      progress(el) {
        const m = cleanText(el).match(/(\d{1,3}(?:\.\d+)?)%/);
        return m ? +m[1] : null;
      },
      label: (el) => (el.querySelector('.file-name') || el).textContent,
      click(el) {
        const row = el.querySelector(':scope > .el-tree-node__content') || el;
        const name = el.querySelector('.file-name') || el.querySelector('.custom-tree-node') || row;
        const href = location.href;
        try { row.scrollIntoView({ block: 'center' }); } catch (e) {}
        const fire = (t, type) => {
          try { t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
        };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => fire(row, t));
        // 这个站对合成 click 不总买账：700ms 后若还没跳转，再点一次文件名。
        // 只有“没跳转”才补点，避免一次前进两节。
        setTimeout(() => {
          if (location.href === href) {
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => fire(name, t));
          }
        }, 700);
        return true;
      },
    },
    {
      name: '智慧共享课（chapter-item）',
      items() {
        const out = [];
        const chapters = all('.chapter-content .chapter-item');
        if (chapters.length) {
          chapters.forEach((ch) => {
            const kids = ch.querySelectorAll('.chapter-content-second');
            if (kids.length) kids.forEach((k) => out.push(k));
            else out.push(ch);
          });
        } else {
          all('.chapter-content-second').forEach((el) => out.push(el));
        }
        return out;
      },
      active: (el) => el.classList.contains('current'),
      done: (el) => !!el.querySelector('.finish-icon') || el.classList.contains('finished'),
      progress: (el) => { const p = el.querySelector('.el-progress'); return p ? num(p.getAttribute('aria-valuenow')) : null; },
      label: (el) => (el.querySelector('.item-name') || el).textContent,
    },
    {
      name: '新共享课（child-main）',
      items() {
        return all('.child-main').filter(
          (el) => (el.parentElement && el.parentElement.querySelector('.child-time')) || el.querySelector('.child-time')
        );
      },
      active: (el) => el.classList.contains('current'),
      done: (el) => !!(el.parentElement && el.parentElement.querySelector('.finish-icon')) || !!el.querySelector('.finish-icon'),
      label: (el) => (el.querySelector('.child-name') || el).textContent,
    },
    {
      name: '融合课 / AI课',
      items() {
        const cards = all('.resources-item');
        if (cards.length) return cards;
        return all('.clearfix.video').filter((el) => el.querySelector('.resource-box'));
      },
      active: (el) => /(^|\s)(active|activeNode)(\s|$)/.test(String(el.className)),
      done: (el) => !!el.querySelector('.isFinish'),
      label: (el) => (el.querySelector('.file-name') || el).textContent,
    },
    {
      name: '旧共享课（clearfix video）',
      items: () => all('.clearfix.video'),
      active: (el) => el.classList.contains('current_play'),
      done: (el) => !!el.querySelector('.time_icofinish') ||
        /100/.test((el.querySelector('.progress-num') || {}).textContent || ''),
      progress: (el) => num(((el.querySelector('.progress-num') || {}).textContent || '').replace('%', '')),
      label: (el) => (el.querySelector('#lessonOrder, .lessonName') || el).textContent,
    },
    {
      name: '校内课（file-item）',
      items: () => all('.file-item'),
      active: (el) => el.classList.contains('active'),
      done: (el) => !!el.querySelector('.icon-finish'),
      label: (el) => el.textContent,
    },
  ];

  function detectAdapter() {
    for (const ad of ADAPTERS) {
      try { if (ad.items().length) return ad; } catch (e) {}
    }
    return null;
  }

  const state = {
    running: false,
    adapter: null,
    video: null,
    advancing: false,
    ticking: false,
    docsAt: 0,
    timer: null,
    worker: null,
    stopped: store.get(K_STOP, '') === '1',
    count: Number(store.get(K_COUNT, '0')) || 0,
    lastSeekAt: 0,
    curKey: '',
    vsrc: '',
    ignoreEnded: false,   // 刚切课时，等新视频真正播放后才允许判结束
    videoErrors: 0,       // 视频加载失败次数
    videoRetryAt: 0,      // 上次重试时间
    noSourceAt: 0,        // 处于“无数据源”状态的起始时间
  };

  /* ============================ 视频 ============================ */
  function pickVideo() {
    const vids = all('video').filter((v) => {
      try {
        if (!v.isConnected) return false;
        if (!v.currentSrc && !v.src && v.readyState === 0) return false;
        const r = v.getBoundingClientRect();
        return r.width >= 40 && r.height >= 20;
      } catch (e) { return false; }
    });
    if (vids.length) {
      vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
      return vids[0];
    }
    const any = all('video').filter((v) => { try { return v.isConnected && (v.duration > 0 || v.currentSrc); } catch (e) { return false; } });
    return any[0] || null;
  }

  async function forcePlay(v) {
    if (!v) return false;
    try { v.muted = CFG.muted; if (CFG.muted) v.volume = 0; } catch (e) {}
    try { await v.play(); return true; } catch (e) {}
    try { v.muted = true; v.volume = 0; await v.play(); return true; } catch (e) {}
    // 点播放器/大播放按钮，再试一次
    const btn = ['.vjs-big-play-button', '.prism-big-play-btn', '.play-btn', '.video-play', '.videoArea', '.video-player', '#player']
      .map((s) => one(s)).find((el) => el && visible(el));
    if (btn) {
      try { btn.click(); } catch (e) {}
      await sleep(300);
      try { await v.play(); return true; } catch (e) {}
    }
    warnThrottled('play', '浏览器拦截了自动播放，请手动点一次播放器');
    return false;
  }

  function applyPrefs(v) {
    try {
      if (CFG.muted && !v.muted) { v.muted = true; v.volume = 0; }
      if (!CFG.muted && v.muted) { v.muted = false; v.volume = 1; }
      if (CFG.rate && Math.abs((v.playbackRate || 1) - CFG.rate) > 0.01) v.playbackRate = CFG.rate;
    } catch (e) {}
  }

  /* 视频加载失败时，重新 load + play；多次失败给出网络提示 */
  function onVideoError(v) {
    // 已经在正常播放时忽略（切源瞬间经常会有一次假报错）
    if (v.readyState >= 2 && !v.paused) return;
    const code = v.error ? v.error.code : 0;
    const msg = v.error ? v.error.message : '';
    state.videoErrors += 1;
    warn(`视频加载出错（code=${code}${msg ? '，' + msg : ''}），第 ${state.videoErrors} 次`);
    if (state.videoErrors <= CFG.videoRetry) {
      setBadge(`视频加载失败，重试中（${state.videoErrors}/${CFG.videoRetry}）`);
      const delay = 1500 * state.videoErrors;
      setTimeout(() => {
        if (!v.isConnected) return;
        try { v.load(); } catch (e) {}
        forcePlay(v);
      }, delay);
      return;
    }
    warn('视频连续加载失败：多半是代理把 *.aliyuncs.com 解析成内网 IP，被 Chrome 拦截（PNA）。请让该域名直连或关闭 fake-ip。');
    setBadge('视频加载失败：检查代理/网络');
  }

  function attach(v) {
    if (!v) return;
    state.video = v;
    if (v.__zhsAttached === VERSION) return;
    v.__zhsAttached = VERSION;
    v.addEventListener('ended', () => { if (CFG.autoNext) onEnded(); });
    v.addEventListener('seeking', () => { state.lastSeekAt = Date.now(); });
    v.addEventListener('error', () => onVideoError(v));
    v.addEventListener('playing', () => { state.videoErrors = 0; state.noSourceAt = 0; });
    v.addEventListener('timeupdate', () => { if (v.currentTime > 3) state.videoErrors = 0; });
    log('已接管视频，时长', Number.isFinite(v.duration) ? v.duration.toFixed(1) + 's' : '未知');
  }

  /* ============================ 目录 ============================ */
  function itemsNow() {
    try { return state.adapter ? state.adapter.items() : []; } catch (e) { return []; }
  }
  function currentItem() {
    const ad = state.adapter;
    if (!ad) return null;
    const items = itemsNow();
    // 只认“目录里高亮的那一行”，不再用 URL（这个站切课时 URL 经常不更新）
    return items.find((el) => el.classList.contains('is-current')) ||
      items.find((el) => el.querySelector('.custom-tree-node.current, .file-name.current')) ||
      null;
  }

  /* 当前课时：优先高亮行，其次上次点击的、URL 里的 key */
  function anchorItem() {
    const items = itemsNow();
    if (!items.length) return null;
    const i = anchorIndex(items);
    return i >= 0 ? items[i] : null;
  }
  function currentKeyNow() {
    const cur = currentItem();
    return cur ? keyOf(cur) : '';
  }

  function itemDone(el) {
    const ad = state.adapter;
    if (!ad || !el) return false;
    try {
      if (ad.done(el)) return true;
      if (ad.progress) { const p = ad.progress(el); if (typeof p === 'number' && p >= 100) return true; }
    } catch (e) {}
    return false;
  }
  function platformDone() {
    const ad = state.adapter;
    if (!ad) return true;
    const cur = currentItem();
    return cur ? itemDone(cur) : false;
  }

  /* 整页刷新后 is-current 可能还没渲染，用上次点过的课时名当锚点 */
  function anchorIndex(items) {
    const ad = state.adapter;
    const cur = currentItem();
    let i = cur ? items.indexOf(cur) : -1;
    if (i >= 0) return i;
    const last = norm(store.get(K_LAST, ''));
    if (last) {
      const j = items.findIndex((el) => norm(ad.label(el)).startsWith(last) || last.startsWith(norm(ad.label(el))));
      if (j >= 0) return j;
    }
    // 再退一步才用 URL 里的 data-key
    const u = items.findIndex((el) => {
      const k = el.getAttribute('data-key');
      return !!(k && location.href.indexOf(k) >= 0);
    });
    if (u >= 0) return u;
    // 兜底：只有一节是“看了一部分”的，通常就是当前这节
    try {
      const partial = [];
      items.forEach((el, idx) => {
        const p = ad.progress ? ad.progress(el) : null;
        if (typeof p === 'number' && p > 0 && p < 100) partial.push(idx);
      });
      if (partial.length === 1) return partial[0];
    } catch (e) {}
    return -1;
  }

  function keyOf(el) {
    try {
      const ad = state.adapter;
      return String((el.getAttribute && el.getAttribute('data-key')) || (ad ? norm(ad.label(el)) : ''));
    } catch (e) { return ''; }
  }
  function seenMap() {
    try { const m = JSON.parse(store.get(K_SEEN, '{}')); return m && typeof m === 'object' ? m : {}; }
    catch (e) { return {}; }
  }
  function isSeen(k) {
    const t = seenMap()[k];
    return !!t && Date.now() - t < 3 * 60 * 60000;   // 3 小时内的点击记录有效
  }
  function markSeen(el) {
    try {
      const m = seenMap();
      const now = Date.now();
      m[keyOf(el)] = now;
      Object.keys(m).forEach((k) => { if (now - m[k] > 6 * 60 * 60000) delete m[k]; });
      store.set(K_SEEN, JSON.stringify(m));
    } catch (e) {}
  }
  function unmarkSeen(el) {
    try {
      const m = seenMap();
      delete m[keyOf(el)];
      store.set(K_SEEN, JSON.stringify(m));
    } catch (e) {}
  }

  function retryMap() {
    try { const m = JSON.parse(store.get(K_RETRY, '{}')); return m && typeof m === 'object' ? m : {}; }
    catch (e) { return {}; }
  }
  function bumpRetry(k) {
    if (!k) return 999;
    try {
      const m = retryMap();
      m[k] = (m[k] || 0) + 1;
      store.set(K_RETRY, JSON.stringify(m));
      return m[k];
    } catch (e) { return 1; }
  }

  /* 严格顺序：当前是第几条，就取第几条 + 1。
     不跳过“已完成”，也不管本轮点过没有，避免全被过滤后误报“全部完成”。 */
  function pickNext() {
    const items = itemsNow();
    if (!items.length) return null;
    const idx = anchorIndex(items);
    if (idx < 0) return null;
    return items[idx + 1] || null;
  }

  async function waitPlatformDone(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (platformDone()) return true;
      await sleep(500);
    }
    return platformDone();
  }

  /* 等平台把“当前这一节”记为已完成。
     这个站的规律：播放中节点后面带百分比，记为完成后百分比消失（换成勾）。
     所以：有百分比且 < 99 = 没记上；没百分比 或 >= 99 或打勾 = 已记上。 */
  async function waitRecorded(ms) {
    const ad = state.adapter;
    if (!ad) return true;
    const finished = () => {
      const cur = anchorItem();
      if (!cur) return true;
      if (ad.done(cur)) return true;                  // 打勾
      const p = ad.progress ? ad.progress(cur) : null;
      if (p === null) return true;                    // 百分比消失
      return p >= 99;
    };
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (finished()) return true;
      await sleep(1000);
    }
    return finished();
  }

  /* ============================ 弹窗 ============================ */
  function handleDialogs() {
    const ai = one('.ai-class-exercise-dialog');
    if (ai && visible(ai)) {
      if (!CFG.dismissQuizzes) { warnThrottled('ai', '检测到 AI 随堂练习弹窗，请手动作答/关闭'); return true; }
      try {
        const close = ai.querySelector('.header-icon, .el-dialog__headerbtn');
        if (close) close.click();
        else {
          const opt = ai.querySelector('.ques-list .item .option, .option');
          if (opt) opt.click();
          const sub = ai.querySelector('.el-dialog__footer .el-button.btn, .el-dialog__footer .el-button--primary');
          if (sub) sub.click();
        }
        setTimeout(() => forcePlay(state.video), 800);
      } catch (e) {}
      return true;
    }

    const topic = one('#playTopic-dialog');
    if (topic && visible(topic)) {
      if (!CFG.dismissQuizzes) { warnThrottled('topic', '检测到课中弹题，请手动完成后会自动继续'); return true; }
      try {
        const opt = topic.querySelector('ul .topic-item');
        if (opt) opt.click();
        const close = topic.querySelector('.close-btn, .btn');
        if (close) close.click();
        setTimeout(() => forcePlay(state.video), 800);
      } catch (e) {}
      return true;
    }

    const yidun = one('.yidun_popup');
    if (yidun && visible(yidun)) {
      warnThrottled('yidun', '检测到安全验证，请手动完成（脚本会自动等待）');
      return true;
    }
    return false;
  }

  function tryLock() {
    try {
      const now = Date.now();
      const at = Number(sessionStorage.getItem(K_LOCK) || 0);
      if (now - at < 4000) return false;
      sessionStorage.setItem(K_LOCK, String(now));
      return true;
    } catch (e) { return true; }
  }

  function clickItem(el) {
    const ad = state.adapter;
    try {
      if (ad && typeof ad.click === 'function') return !!ad.click(el);
      el.click();
      return true;
    } catch (e) { warn('点击失败', e); return false; }
  }

  /* ============================ 下一节 ============================ */
  async function onEnded() {
    if (!CFG.autoNext || state.advancing || state.stopped) return;
    if (!tryLock()) return;
    state.advancing = true;
    const v = state.video;
    try {
      const cur = anchorItem();
      const curKey = cur ? keyOf(cur) : '';
      // 同一节只处理一次（ended 事件 + 轮询会重复触发）
      if (curKey && store.get(K_ADV, '') === curKey) {
        log('这一节已经处理过，忽略重复触发');
        return;
      }

      log('播放结束', curKey || '');
      setBadge('播放结束，等平台记录…');
      handleDialogs();

      if (!state.adapter) {
        warnThrottled('noad', '没有识别到课程目录，无法自动切下一节（可执行 __ZHS__.scan() 排查）');
        setBadge('未识别目录，请查看控制台');
        return;
      }

      const hrefAtEnd = location.href;
      const srcAtEnd = v ? (v.currentSrc || v.src || '') : '';
      // 判断“是否已经换课”：课时高亮 / URL / 视频源，任一变化即可
      const moved = () => {
        const nv = pickVideo();
        const nsrc = nv ? (nv.currentSrc || nv.src || '') : '';
        const nkey = currentKeyNow();
        return (curKey && nkey && nkey !== curKey) ||
          hrefAtEnd !== location.href ||
          (srcAtEnd && nsrc && nsrc !== srcAtEnd);
      };
      const seeked = Date.now() - state.lastSeekAt < 20000;
      if (state.adapter.forceAdvance) {
        if (seeked) {
          log('检测到你手动拖过进度条，跳过完成校验');
        } else {
          setBadge('播放结束，等平台记为已完成…');
          const recorded = await waitRecorded(CFG.completeWaitMs);
          if (!recorded) {
            const n = bumpRetry(curKey);
            if (v && n <= CFG.maxReplay) {
              log(`本节还没记为已完成（第 ${n}/${CFG.maxReplay} 次），重播本节`);
              setBadge(`未记录完成，重播本节（${n}/${CFG.maxReplay}）`);
              try {
                v.currentTime = 0;
                await forcePlay(v);
              } catch (e) {}
              return;
            }
            warn(`重播 ${CFG.maxReplay} 次仍未记为完成，先切下一节`);
          } else {
            log('本节点已记为完成，准备切下一节');
          }
        }
      } else if (seeked) {
        log('检测到你手动拖了进度条，跳过进度等待');
      } else {
        let done = await waitPlatformDone(CFG.waitDoneMs);
        for (let i = 0; i < CFG.tailRetry && !done; i++) {
          log(`进度未记满，回退重播（${i + 1}/${CFG.tailRetry}）`);
          try { if (v && v.duration > 6) { v.currentTime = v.duration - 6; await v.play(); } } catch (e) {}
          done = await waitPlatformDone(15000);
        }
        if (!done) warn('平台进度疑似未记满（<100%），仍继续切下一节');
      }

      // 等待期间平台自己跳了：绝不能再点，否则会一次前进两节
      if (moved()) {
        log('平台已自行跳到下一节，脚本不再点击');
        if (curKey) store.set(K_ADV, curKey);
        return;
      }

      await sleep(CFG.clickDelayMs);
      if (moved()) {
        log('平台已自行跳到下一节，脚本不再点击');
        if (curKey) store.set(K_ADV, curKey);
        return;
      }

      const target = pickNext();
      if (!target) {
        const idxNow = anchorIndex(itemsNow());
        if (idxNow < 0) {
          warn('无法定位当前课时，未自动跳转（执行 __ZHS__.why() 查看）');
          setBadge('无法定位当前课时');
          return;
        }
        log('已经是目录最后一条，全部走完 🎉');
        setBadge('全部完成 🎉');
        state.stopped = true;
        store.set(K_STOP, '1');
        return;
      }

      const label = short(state.adapter.label(target));
      log('下一节 →', label);
      setBadge('正在切到：' + label);
      store.set(K_LAST, norm(label));
      store.set(K_ADV, curKey);       // 先占位，防止这一节重复触发
      markSeen(target);
      state.count += 1;
      store.set(K_COUNT, state.count);

      clickItem(target);

      await sleep(2000);
      if (moved()) {
        log('已跳转');
        return;
      }

      // 再给 3 秒（切视频有时慢），确实没跳才回退
      await sleep(3000);
      if (moved()) {
        log('已跳转');
        return;
      }

      // 点了没反应：撤销占位和“已点过”标记，锚点退回当前节，重新取一次目标再点一次
      if (curKey) store.set(K_ADV, '');
      unmarkSeen(target);
      if (cur) store.set(K_LAST, norm(state.adapter.label(cur)));
      const again = pickNext();
      if (again) {
        log('点击未生效，重试一次：', short(state.adapter.label(again)));
        clickItem(again);
        await sleep(2500);
        if (moved()) log('已跳转');
        else warn('重试后仍未跳转，请检查目录点击是否需要别的元素');
      }
    } finally {
      state.advancing = false;
    }
  }

  /* ============================ 主循环 ============================ */
  async function tick() {
    if (!state.running || state.ticking) return;
    state.ticking = true;
    try {
      if (Date.now() - state.docsAt > 5000) {
        DOCS = collectDocs();
        state.docsAt = Date.now();
      }
      if (!state.adapter) {
        state.adapter = detectAdapter();
        if (state.adapter) log('识别目录：', state.adapter.name);
      }
      handleDialogs();

      const captcha = one('.yidun_popup');
      if (captcha && visible(captcha)) return;

      const v = pickVideo();
      if (!v) { updateBadge(); return; }
      if (v !== state.video) attach(v);
      applyPrefs(v);

      if (state.advancing) return;

      // 当前课时变了（这个站切课时 URL 不一定变）→ 旧视频可能还 ended，等新视频播起来
      const ck = currentKeyNow();
      if (ck && ck !== state.curKey) {
        state.curKey = ck;
        state.ignoreEnded = true;
        log('当前课时已切换，等新视频开始播放再判结束');
      }
      // 视频源变了也算换课（有些切换不改 URL 也不改高亮）
      const srcNow = v.currentSrc || v.src || '';
      if (srcNow && state.vsrc && srcNow !== state.vsrc) {
        state.ignoreEnded = true;
        log('视频源已切换，等新视频开始播放');
      }
      if (srcNow) state.vsrc = srcNow;

      // 视频长时间没数据（被代理/网络拦了也会这样），主动重新加载
      if (v.readyState === 0 && v.networkState === 3) {
        if (!state.noSourceAt) state.noSourceAt = Date.now();
        if (Date.now() - state.noSourceAt > 12000 &&
            Date.now() - state.videoRetryAt > 20000 &&
            state.videoErrors <= CFG.videoRetry) {
          state.videoRetryAt = Date.now();
          state.videoErrors += 1;
          log('视频长时间无数据源，尝试重新加载');
          setBadge('视频无数据，正在重新加载…');
          try { v.load(); } catch (e) {}
          forcePlay(v);
        }
      } else {
        state.noSourceAt = 0;
      }
      if (state.ignoreEnded) {
        if (!v.paused && v.currentTime > 1) {
          state.ignoreEnded = false;
        } else {
          // 新视频可能停在 0 秒，主动拉起来；旧视频已经 ended，别去播它
          if (!v.ended && v.paused) forcePlay(v);
          updateBadge();
          return;
        }
      }

      const dur = v.duration;
      // 拖到结尾被暂停时可能不触发 ended，这里兜一层
      const nearEnd = Number.isFinite(dur) && dur > 0 && v.currentTime >= dur - 3;
      const ended = v.ended || (nearEnd && (v.paused || v.currentTime >= dur - 0.4));
      if (ended) { onEnded(); return; }

      if (CFG.keepPlaying && v.paused && !v.ended) forcePlay(v);
      updateBadge();
    } catch (e) {
      warnThrottled('tick', 'tick 异常', e);
    } finally {
      state.ticking = false;
    }
  }

  /* ============================ 标签 ============================ */
  let badgeEl = null;
  function setBadge(text) {
    if (!CFG.badge || !IS_TOP) return;
    if (!badgeEl || !badgeEl.isConnected) {
      badgeEl = document.createElement('div');
      badgeEl.id = '__zhs_badge__';
      badgeEl.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'background:rgba(17,24,39,.92)', 'color:#fff', 'font:12px/1.5 system-ui,sans-serif',
        'padding:8px 12px', 'border-radius:999px', 'cursor:pointer',
        'box-shadow:0 4px 14px rgba(0,0,0,.35)', 'user-select:none', 'max-width:60vw',
        'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
      ].join(';');
      badgeEl.title = '点击暂停/恢复自动连播';
      badgeEl.addEventListener('click', () => {
        if (state.stopped) resume(); else pause();
      });
      document.documentElement.appendChild(badgeEl);
    }
    badgeEl.textContent = '▶ ' + text;
  }
  function updateBadge() {
    if (!CFG.badge) return;
    const name = state.adapter ? state.adapter.name : '未识别页面';
    setBadge(`${name} · 已切 ${state.count} 节`);
  }

  /* ============================ 启停 ============================ */
  function startTimer() {
    try {
      const src = 'let t=null;onmessage=e=>{if(e.data==="start"){clearInterval(t);t=setInterval(()=>postMessage(1),500)}else{clearInterval(t)}}';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      state.worker = new Worker(url);
      state.worker.onmessage = () => tick();
      state.worker.postMessage('start');
    } catch (e) {
      state.timer = setInterval(tick, 500);
    }
  }
  function stopTimer() {
    try { if (state.worker) { state.worker.postMessage('stop'); state.worker.terminate(); } } catch (e) {}
    state.worker = null;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.stopped = false;
    store.set(K_STOP, '');
    startTimer();
    log(`已启动 v${VERSION}，倍速 ${CFG.rate}x，静音 ${CFG.muted}`);
    tick();
    updateBadge();
  }

  function pause() {
    state.stopped = true;
    store.set(K_STOP, '1');
    state.running = false;
    stopTimer();
    setBadge('已暂停（点此恢复）');
    log('已暂停自动连播');
  }

  function resume() {
    state.stopped = false;
    state.running = false;
    start();
  }

  /* ============================ 诊断 ============================ */
  function scan() {
    DOCS = collectDocs();
    const ad = detectAdapter();
    const report = {
      version: VERSION,
      url: location.href,
      detected: ad ? ad.name : '未识别',
      iframes: [...document.querySelectorAll('iframe')].map((f) => {
        let same = false; try { same = !!f.contentDocument; } catch (e) {}
        return { src: short(f.src, 100), sameOrigin: same };
      }),
      videos: all('video').map((v, i) => ({
        i, src: short(v.currentSrc || v.src, 100),
        duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null,
        currentTime: Number.isFinite(v.currentTime) ? +v.currentTime.toFixed(2) : null,
        paused: v.paused, ended: v.ended, readyState: v.readyState,
      })),
      nodes: [],
    };
    if (ad) {
      report.nodes = ad.items().slice(0, 40).map((el, i) => ({
        i,
        key: (el.getAttribute && el.getAttribute('data-key')) || '',
        text: short(ad.label(el), 60),
        cls: String(el.className || '').slice(0, 70),
        active: !!ad.active(el),
        done: !!ad.done(el),
        progress: ad.progress ? ad.progress(el) : null,
      }));
    }
    console.log(report);
    try { copy(JSON.stringify(report, null, 2)); console.log('%c[ZHS] 已复制到剪贴板', 'color:#0a0'); } catch (e) {}
    return report;
  }

  /* 手动立即切下一节（测试用，不等进度） */
  async function forceNext() {
    DOCS = collectDocs();
    if (!state.adapter) state.adapter = detectAdapter();
    if (!state.adapter) { console.log('%c[ZHS] 未识别到课程目录', 'color:#f90'); return null; }
    const t = pickNext();
    if (!t) { console.log('%c[ZHS] 没有下一个未完成课时', 'color:#f90'); return null; }
    const label = short(state.adapter.label(t));
    console.log('%c[ZHS] 手动切换 →', 'color:#2d8cf0', label);
    markSeen(t);
    clickItem(t);
    return label;
  }

  /* 为什么没动？把判断依据全部打出来 */
  function why() {
    DOCS = collectDocs();
    if (!state.adapter) state.adapter = detectAdapter();
    const ad = state.adapter;
    const items = itemsNow();
    const idx = ad ? anchorIndex(items) : -1;
    const nxt = ad ? pickNext() : null;
    const info = {
      running: state.running,
      stopped: state.stopped,
      adapter: ad ? ad.name : null,
      items: items.length,
      currentIndex: idx,
      current: ad && idx >= 0 ? short(ad.label(items[idx])) : null,
      currentPercent: ad && idx >= 0 && ad.progress ? ad.progress(items[idx]) : null,
      currentDone: ad && idx >= 0 ? !!ad.done(items[idx]) : null,
      next: nxt ? short(ad.label(nxt)) : null,
      video: state.video ? {
        t: +state.video.currentTime.toFixed(1),
        d: state.video.duration,
        paused: state.video.paused,
        ended: state.video.ended,
        src: short(state.video.currentSrc || state.video.src, 80),
      } : null,
      lastSeek: state.lastSeekAt ? new Date(state.lastSeekAt).toLocaleTimeString() : null,
      sample: ad ? items.slice(0, 6).map((el, i) => ({
        i,
        text: short(ad.label(el), 34),
        done: !!ad.done(el),
        progress: ad.progress ? ad.progress(el) : null,
      })) : [],
    };
    console.log(info);
    return info;
  }

  window.__ZHS__ = {
    version: VERSION,
    cfg: CFG,
    start, pause, resume, scan, why,
    next: forceNext,
    play: () => forcePlay(state.video),
    reset: () => {
      try { [K_STOP, K_LAST, K_COUNT, K_SEEN, K_ADV, K_RETRY, K_LOCK].forEach((k) => sessionStorage.removeItem(k)); } catch (e) {}
      location.reload();
    },
    status: () => ({
      running: state.running, stopped: state.stopped,
      adapter: state.adapter && state.adapter.name,
      count: state.count,
      videoErrors: state.videoErrors,
      video: state.video ? {
        duration: state.video.duration, currentTime: state.video.currentTime,
        paused: state.video.paused, ended: state.video.ended,
        readyState: state.video.readyState, networkState: state.video.networkState,
        error: state.video.error ? state.video.error.code : null,
        src: short(state.video.currentSrc || state.video.src, 90),
      } : null,
    }),
  };

  /* ============================ 启动 ============================ */
  async function boot() {
    DOCS = collectDocs();
    for (let i = 0; i < 40; i++) {
      if (detectAdapter() || pickVideo()) break;
      await sleep(500);
      DOCS = collectDocs();
    }
    if (state.stopped) {
      setBadge('已暂停（点此恢复）');
      log('上次是暂停状态，点右下角标签或执行 __ZHS__.resume() 恢复');
      return;
    }
    start();
    // 切回标签页时立刻检查一次
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  boot();
})();
