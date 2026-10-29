// ==UserScript==
// @name         智慧树 · 智能课程自动下一节（必学 x/y）
// @namespace    local.zhs.smartcourse
// @version      2.0.1
// @description  适配 ai-smart-course-student-pro / smartcoursestudent：播完自动切下一知识点，未记为完成则重播
// @author       local
// @match        *://ai-smart-course-student-pro.zhihuishu.com/*
// @match        *://smartcoursestudent.zhihuishu.com/*
// @run-at       document-start
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

  const VERSION = '2.0.1';
  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return true; } })();

  /* ---------- 关键接口嗅探 ----------
     list-knowledge-resource 的响应里有每个资源的真实状态：
       studyStatus（1=已完成）、schedule（百分比）、
       resourcesTime（总时长）、quoteDetail.videoStartTime/videoEndTime（要求片段）
     initVideoNew?videoID=xxx 给出当前播放器对应的资源文件 ID。 */
  const API = { videoId: '', resources: [], resourceAt: 0, knowledge: [], dicAt: 0 };

  (function patchApi() {
    const onBody = (url, text) => {
      try {
        if (/initVideoNew/.test(url)) {
          const m = url.match(/videoID=(\d+)/);
          if (m) API.videoId = m[1];
          return;
        }
        if (/list-knowledge-resource/.test(url) && text) {
          const j = JSON.parse(text);
          const list = j && j.data && j.data.resourceList;
          if (Array.isArray(list) && list.length) {
            API.resources = list;
            API.resourceAt = Date.now();
          }
          return;
        }
        // 整门课的知识点清单（顺序 + 所属单元/模块）
        if (/get-course-knowledge-dic/.test(url) && text) {
          const j = JSON.parse(text);
          const themes = j && j.data && j.data.themeList;
          if (!Array.isArray(themes)) return;
          const flat = [];
          for (const t of themes) {
            const pushList = (unitName, list) => {
              for (const k of (list || [])) {
                if (!k || !k.knowledgeName) continue;
                flat.push({
                  id: String(k.knowledgeId || ''),
                  name: String(k.knowledgeName),
                  theme: String(t.themeName || ''),
                  unit: String(unitName || ''),
                });
              }
            };
            if (Array.isArray(t.subThemeList) && t.subThemeList.length) {
              for (const st of t.subThemeList) pushList(st.themeName, st.knowledgeList);
            } else {
              pushList(t.themeName, t.knowledgeList);
            }
          }
          if (flat.length) {
            API.knowledge = flat;
            API.dicAt = Date.now();
          }
        }
      } catch (e) {}
    };
    try {
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) {
        this.__zhsUrl = String(u || '');
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        const xhr = this;
        xhr.addEventListener('load', () => {
          try {
            const t = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : '';
            onBody(xhr.__zhsUrl || '', t);
          } catch (e) {}
        });
        return send.apply(this, arguments);
      };
    } catch (e) {}
    try {
      const of = window.fetch;
      window.fetch = function (input) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const p = of.apply(this, arguments);
        if (/initVideoNew|list-knowledge-resource|get-course-knowledge-dic/.test(url)) {
          p.then((res) => {
            try { res.clone().text().then((t) => onBody(url, t)).catch(() => {}); } catch (e) {}
          }).catch(() => {});
        }
        return p;
      };
    } catch (e) {}
  })();

  /* 这个站的播放器会在没有用户手势时直接 play()（带声音），Chrome 会抛
     NotAllowedError: play() failed because the user didn't interact with the document first.
     在 play 前强制静音，既符合自动播放策略，也不会再刷红字。
     @run-at document-start 保证这段比页面播放器先执行。 */
  (function patchPlay() {
    if (!CFG.muted) return;
    try {
      const proto = HTMLMediaElement.prototype;
      if (proto.__zhsPlayPatched) return;
      const orig = proto.play;
      proto.play = function () {
        try {
          this.muted = true;
          this.volume = 0;
          this.setAttribute('playsinline', '');
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      proto.__zhsPlayPatched = true;
    } catch (e) {}
  })();

  const K_STOP = '__zhs_stop__';
  const K_LAST = '__zhs_last__';
  const K_COUNT = '__zhs_count__';
  const K_LOCK = '__zhs_lock__';
  const K_SEEN = '__zhs_seen__';
  const K_ADV = '__zhs_adv__';
  const K_RETRY = '__zhs_retry__';
  const K_KI = '__zhs_ki__';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => CFG.verbose && console.log('%c[ZHS]', 'color:#2d8cf0;font-weight:bold', ...a);
  const STEPS = [];
  const step = (m) => {
    STEPS.push(String(m));
    if (STEPS.length > 50) STEPS.shift();
    log(m);
  };
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
  // 智能课程目录：“必学 0/1” → { done: 0, total: 1 }
  const progressOf = (el) => {
    const t = String((el && el.textContent) || '').replace(/\s+/g, '');
    const m = t.match(/必学(\d+)\/(\d+)/);
    return m ? { done: +m[1], total: +m[2] } : null;
  };
  let smartCache = [];
  let smartCacheAt = 0;

  /* 右侧资源卡片出现“已完成”标记，也是这一节学完的可靠信号。
     这个平台经常是资源已完成、左栏 必学 x/y 还没刷新。
     优先只看“必学资源”区域，避免把“选学资源”里的已完成算进来。 */
  function resourceDone() {
    const headings = all('*').filter(
      (el) => el.children.length === 0 && /^必学资源$/.test(String(el.textContent || '').trim())
    );
    const scopes = [];
    for (const h of headings) {
      let node = h;
      for (let i = 0; i < 3 && node.parentElement; i++) node = node.parentElement;
      scopes.push(node);
    }
    if (!scopes.length) scopes.push(document);
    for (const scope of scopes) {
      let marks = [];
      try { marks = scope.querySelectorAll('span,div,em,i,label,p,b'); } catch (e) { continue; }
      for (const el of marks) {
        if (el.children.length > 0) continue;
        const t = String(el.textContent || '').trim();
        if (t !== '已完成' && t !== '已学完') continue;
        if (visible(el)) return true;
      }
    }
    return false;
  }

  /* 当前播放器对应的资源（接口数据） */
  function currentResource() {
    const list = API.resources || [];
    if (!list.length) return null;
    if (API.videoId) {
      const hit = list.find((r) => r && r.resourcesDetail &&
        String(r.resourcesDetail.resourcesFileId) === String(API.videoId));
      if (hit) return hit;
    }
    const dur = state.video && state.video.duration;
    if (Number.isFinite(dur)) {
      let best = null, diff = Infinity;
      for (const r of list) {
        const t = r && r.resourcesDetail && Number(r.resourcesDetail.resourcesTime);
        if (!t) continue;
        const d = Math.abs(t - dur);
        if (d < diff) { diff = d; best = r; }
      }
      if (best) return best;
    }
    return list[0];
  }

  function apiComplete() {
    const r = currentResource();
    if (!r) return false;
    if (r.studyStatus === 1) return true;
    return typeof r.schedule === 'number' && r.schedule >= 100;
  }

  /* 严格匹配：只有接口真的按 videoId 认出当前视频时才算。
     刚切知识点时旧 <video> 还在，用兜底猜的资源会对错课件。 */
  function strictResource() {
    const list = API.resources || [];
    if (!list.length || !API.videoId) return null;
    return list.find((r) => r && r.resourcesDetail &&
      String(r.resourcesDetail.resourcesFileId) === String(API.videoId)) || null;
  }

  function apiInfo() {
    const r = currentResource();
    if (!r) return null;
    const d = r.resourcesDetail || {};
    const q = r.resourcesQuoteDetail || {};
    return {
      name: d.resourcesName,
      fileId: d.resourcesFileId,
      status: r.studyStatus,
      schedule: r.schedule,
      watched: r.studyTotalTime,
      total: d.resourcesTime,
      clip: q.videoStartTime != null ? q.videoStartTime + '-' + q.videoEndTime : '',
    };
  }

  /* ==================== 课件级推进（一个知识点多个课件 / PPT 课件） ====================
     课程里有两类情况：
       1) 一个知识点挂多个课件（左栏“必学 1/2”），视频播完只是第一个课件完成，还得点第二个；
       2) 整个知识点只有 PPT/文档，没有 <video>，点进卡片平台就算已学习。
     所以“视频结束”不等于“知识点结束”：先看这个知识点还有没有没完成的课件，
     有就点右侧“必学资源”里的那张卡片；全部课件都完成了才进下一个知识点。 */
  function resDoneOne(r) {
    if (!r) return true;
    if (r.studyStatus === 1) return true;
    return typeof r.schedule === 'number' && r.schedule >= 100;
  }

  function resName(r) {
    const d = (r && r.resourcesDetail) || {};
    return String(d.resourcesName || '');
  }

  function isPptResource(r) {
    const d = (r && r.resourcesDetail) || {};
    const n = resName(r) + ' ' + String(d.resourcesUrl || '');
    return /\.(pptx?|pdf|docx?|xlsx?)(\b|$)/i.test(n);
  }

  // 只看“必学资源”区域的卡片，避免把“选学资源”也算进来
  function reqScopes() {
    const out = [];
    for (const el of all('*')) {
      if (el.children.length) continue;
      if (!/^必学资源$/.test(String(el.textContent || '').trim())) continue;
      let node = el;
      for (let i = 0; i < 3 && node.parentElement; i++) node = node.parentElement;
      out.push(node);
    }
    return out.length ? out : [document];
  }

  function cardDone(card) {
    const t = norm(card && card.textContent);
    return t.indexOf('已完成') >= 0 || t.indexOf('已学完') >= 0;
  }

  function cardOf(r) {
    const raw = norm(resName(r)).replace(/\.(mp4|m4v|mp3|pptx?|pdf|docx?|xlsx?|zip|rar)$/i, '');
    if (!raw || raw.length < 3) return null;
    for (const scope of reqScopes()) {
      let best = null;
      let nodes = [];
      try { nodes = scope.querySelectorAll('*'); } catch (e) { continue; }
      for (const el of nodes) {
        if (el.children.length) continue;
        if (!visible(el)) continue;
        const t = norm(el.textContent || '');
        if (!t || t.indexOf(raw) < 0) continue;
        let card = el;
        for (let i = 0; i < 4; i++) {
          const p = card.parentElement;
          if (!p || p === scope) break;
          const pr = p.getBoundingClientRect();
          if (pr.height > 200 || pr.width < 120) break;
          if (pr.height >= 48) card = p;
        }
        if (!best || card.contains(best)) best = card;
      }
      if (best) return best;
    }
    return null;
  }

  function resNodeOf(list) {
    for (const r of (list || [])) {
      const n = r && r.resourcesDetail && r.resourcesDetail.nodeUid;
      if (n != null && String(n)) return String(n);
    }
    return '';
  }

  /* 资源清单可能是上一个知识点的（切知识点后还没重新请求），
     用 nodeUid 和当前大标题对一下，避免把别的知识点的课件点开。 */
  function resourcesBelongHere() {
    const list = API.resources || [];
    if (!list.length) return false;
    const node = resNodeOf(list);
    if (!node) return true;               // 没有 nodeUid 就按老逻辑
    const title = contentTitle();
    if (!title) return true;
    const k = API.knowledge.find((x) => x.id === node);
    if (k) return norm(k.name) === title;
    return false;
  }

  /* 这个知识点里还有没完成的课件（排除刚点过的那个，避免反复点同一张卡） */
  function pendingResource(except) {
    if (!resourcesBelongHere()) return null;
    const cur = except || null;
    const last = state.lastRes || null;
    for (const r of (API.resources || [])) {
      if (r === cur) continue;
      if (resDoneOne(r)) continue;
      const name = resName(r);
      if (last && name && norm(last.name) === norm(name) && Date.now() - last.at < 30000) continue;
      const card = cardOf(r);
      if (!card) continue;                 // 卡片不在“必学资源”里（多半是选学），不碰
      if (cardDone(card)) continue;
      return r;
    }
    return null;
  }

  async function openResource(r) {
    const card = cardOf(r);
    const name = resName(r);
    if (!card) { step('找不到课件卡片：' + short(name, 22)); return false; }
    step('切换课件：' + short(name, 22));
    setBadge('切换课件：' + short(name, 22));
    state.lastRes = { name, at: Date.now() };
    state.resAt = Date.now();
    clickItem(card);
    await sleep(1800);
    return true;
  }

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
      // 2026 智能课程：左栏每一行是“知识点名 + 必学 x/y”，没有树、没有百分比
      name: '智能课程（必学 x/y）',
      items() {
        if (Date.now() - smartCacheAt < 1200 && smartCache.length && smartCache.every((el) => el.isConnected)) {
          return smartCache;
        }
        const out = [];
        const seen = new Set();
        const add = (el) => {
          if (!el || seen.has(el)) return;
          const r = el.getBoundingClientRect();
          if (r.width < 80 || r.height < 18 || r.height > 140) return;
          seen.add(el);
          out.push(el);
        };
        const textOf = (el) => String((el && el.textContent) || '').replace(/\s+/g, '');
        const looksLikeRow = (el) => {
          const t = textOf(el);
          return t.indexOf('必学') >= 0 && /\d+\s*\/\s*\d+/.test(t);
        };
        // 从命中的最内层节点往上扩到“整行”，这样 “必学” 和 “0/1” 分开渲染也能覆盖
        const climb = (el) => {
          let row = el;
          for (let i = 0; i < 4; i++) {
            const p = row.parentElement;
            if (!p || p === document.body) break;
            const r = p.getBoundingClientRect();
            if (r.height > 140 || r.width < 80) break;
            if (looksLikeRow(p)) row = p;
          }
          return row;
        };

        // A. 先用已知的课程卡片结构
        const known = ['.section-item-collapse-info', '[class*="card-container"]', '[class*="section-item"]', '[class*="collapse-info"]'];
        for (const sel of known) {
          for (const el of all(sel)) {
            if (looksLikeRow(el)) add(climb(el));
          }
        }

        // B. 结构不认识时，按完整文本找最内层节点
        if (!out.length) {
          const cands = all('*').filter((el) => looksLikeRow(el));
          const leaves = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
          leaves.forEach((el) => add(climb(el)));
        }

        // C. 有些单元（免考）的行不显示“必学 x/y”，只能靠接口清单里的知识点名字识别
        if (API.knowledge.length) {
          const names = new Set(API.knowledge.map((k) => norm(k.name)));
          for (const el of all('*')) {
            if (el.children.length) continue;
            if (!names.has(norm(el.textContent || ''))) continue;
            if (!visible(el)) continue;
            let row = el;
            for (let i = 0; i < 4; i++) {
              const p = row.parentElement;
              if (!p) break;
              const pr = p.getBoundingClientRect();
              if (pr.height > 140 || pr.width < 80) break;
              if (pr.height >= 24) row = p;
            }
            add(row);
          }
        }

        // 去掉互相包含的，保留最内层
        const filtered = out.filter((el) => !out.some((o) => o !== el && el.contains(o)));
        smartCache = filtered;
        smartCacheAt = Date.now();
        return filtered;
      },
      active(el) {
        const hit = (node) => {
          const c = String(node.className || '');
          return /(^|[\s-])(active|current|selected|checked)([\s-]|$)/i.test(c) ||
            node.getAttribute('aria-current') === 'true';
        };
        let p = el;
        for (let i = 0; i < 4 && p; i++) { if (hit(p)) return true; p = p.parentElement; }
        return false;
      },
      current(items) {
        const byAttr = items.find((el) => el.getAttribute('aria-current') === 'true');
        if (byAttr) return byAttr;
        // 背景色和别的行不一样的那一行，通常就是当前知识点；
        // 找行自身或它内部第一个有底色的元素（高亮经常挂在内层 div 上）
        const bgOf = (el) => {
          const s0 = style(el);
          if (s0 && s0.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(s0.backgroundColor)) return s0.backgroundColor;
          for (const c of el.querySelectorAll('*')) {
            const s = style(c);
            if (s && s.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(s.backgroundColor)) return s.backgroundColor;
          }
          return 'transparent';
        };
        const info = items.map(bgOf);
        const counts = {};
        info.forEach((b) => { counts[b] = (counts[b] || 0) + 1; });
        const uniq = [];
        info.forEach((b, i) => {
          if (counts[b] !== 1) return;
          if (/transparent/.test(b)) return;
          uniq.push(i);
        });
        if (uniq.length === 1) return items[uniq[0]];
        // 多数行同色、只有一行不同，也认为它是当前行
        const mode = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        const diff = info.map((b, i) => [b, i]).filter(([b]) => b !== mode && !/transparent/.test(b));
        if (diff.length === 1) return items[diff[0][1]];
        return null;
      },
      done(el) {
        const m = progressOf(el);
        return !!m && m.total > 0 && m.done >= m.total;
      },
      progress(el) {
        const m = progressOf(el);
        return m && m.total > 0 ? Math.round((m.done / m.total) * 100) : null;
      },
      label(el) {
        return short(String(el.textContent || '').replace(/必学\s*\d+\s*\/\s*\d+/, '').trim(), 40);
      },
      click(el) {
        const href = location.href;
        const fire = (t, type) => {
          try { t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
        };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => fire(el, t));
        setTimeout(() => {
          if (location.href !== href) return;
          const title = el.querySelector('[class*="title"], [class*="name"], span, div');
          if (title && title !== el) ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => fire(title, t));
        }, 700);
        return true;
      },
    },
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
    expandingAll: false,
    expandedAt: 0,
    noVideoAt: 0,         // 从什么时候开始页面上没有视频（PPT 课件判断用）
    resAt: 0,             // 上次切换课件的时间（冷却）
    lastRes: null,        // 最近点过的课件，防止反复点同一张卡
    nkAt: 0,              // 上次“无视频→进下一知识点”的时间
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
    v.addEventListener('seeking', () => {
      state.lastSeekAt = Date.now();
      // 手动拖动进度条（常见于测试）时，清掉“这一节已处理”标记，允许重新判断
      try { sessionStorage.removeItem(K_ADV); } catch (e) {}
    });
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
    // 最可靠：页面正上方的大标题就是当前知识点名字
    const title = contentTitle();
    if (title) {
      const hit = items.find((el) => norm(ad.label(el)) === title);
      if (hit) return hit;
    }
    // 其次用适配器自己的判断（智能课程靠背景色区分）
    if (typeof ad.current === 'function') {
      try { const c = ad.current(items); if (c) return c; } catch (e) {}
      try { const a = items.find(ad.active); if (a) return a; } catch (e) {}
    }
    // 其余页面：目录里高亮的那一行
    return items.find((el) => el.classList.contains('is-current')) ||
      items.find((el) => el.querySelector('.custom-tree-node.current, .file-name.current')) ||
      null;
  }

  /* 页面顶部的大标题（= 当前知识点名），用字号最大的那个同名元素判定 */
  let titleCache = '';
  let titleAt = 0;
  function contentTitle() {
    if (Date.now() - titleAt < 1500) return titleCache;
    titleAt = Date.now();
    titleCache = '';
    const ad = state.adapter;
    const items = itemsNow();
    if (!ad || !items.length) return '';
    const labels = new Set(items.map((el) => norm(ad.label(el))));
    let best = '', bestSize = 0;
    for (const el of all('*')) {
      if (el.children.length) continue;
      const t = norm(el.textContent || '');
      if (!t || t.length > 40 || !labels.has(t)) continue;
      if (!visible(el)) continue;
      const s = style(el);
      const fs = parseFloat(s && s.fontSize) || 0;
      if (fs > bestSize) { bestSize = fs; best = t; }
    }
    titleCache = best;
    return best;
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

  /* ---------- 树状目录：展开下一个“知识单元 / 知识模块” ---------- */
  function fireClick(el) {
    const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const t of types) {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    }
  }

  function domSig() {
    return sectionHeaders().length * 1000 + itemsNow().length;
  }

  /* 这个单元下的知识点名字，在 DOM 里出现了几个（接口清单提供名字） */
  function unitKnowledgeCount(unit) {
    const un = norm(unit);
    const names = new Set(
      API.knowledge.filter((x) => norm(x.unit) === un).map((x) => norm(x.name))
    );
    if (!names.size) return 0;
    let n = 0;
    for (const el of all('*')) {
      if (el.children.length) continue;
      if (!names.has(norm(el.textContent || ''))) continue;
      if (!visible(el)) continue;        // 折叠时可能留有隐藏的同名节点，不能算
      n++;
    }
    return n;
  }

  /* 展开单元：数“名字出现个数”，变多就说明开了。
     点击目标不确定绑在哪一层，所以从标题文字开始逐层向上试点，
     每点一层就检查一次，出现名字立即停手（不会来回开合）。 */
  async function openUnit(unitHeader, unitName) {
    const before = unitKnowledgeCount(unitName);
    step('单元内可见知识点数：' + before);
    if (before > 0) return true;

    let el = unitHeader;
    for (let level = 0; level < 5 && el; level++) {
      step(`尝试点击第 ${level} 层`);
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(150);
      fireClick(el);
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        await sleep(300);
        const now = unitKnowledgeCount(unitName);
        if (now > before) {
          step('展开后可见知识点数：' + now);
          return true;
        }
      }
      el = el.parentElement;
    }
    return false;
  }

  function unitNameOf(header) {
    return norm(header.textContent || '').replace(/^知识单元[:：]?/, '');
  }

  async function openUnitAuto(header) {
    const name = unitNameOf(header);
    step('展开单元：' + short(name, 18));
    return openUnit(header, name);
  }

  /* 只点一次，然后盯住“这个标题下面有没有出现行/子标题”。
     不能拿全局变化当依据，也不能急着点父级——折叠组件点两次会关回去。 */
  /* 让目录里被裁掉的部分渲染出来：找到可滚动的祖先，往下滚一段 */
  function nudgeScroll(el, dy = 280) {
    let p = el && el.parentElement;
    while (p) {
      const s = style(p);
      if (s && /(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 20) {
        try { p.scrollTop = Math.min(p.scrollHeight, p.scrollTop + dy); } catch (e) {}
        return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  async function clickHeader(el) {
    const isModuleHeader = /^知识模块/.test(textOfEl(el));
    const isOpen = () => {
      const hs = sectionHeaders();
      const t = hs.includes(el) ? el : hs.find((x) => textOfEl(x) === textOfEl(el));
      if (!t) return false;
      // 模块只认“下面有没有单元标题”；单元才看知识点行
      if (isModuleHeader) return hasChildHeader(hs, t);
      return rowsUnder(hs, t).length > 0 || hasChildHeader(hs, t);
    };
    const waitOpen = async (maxMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        await sleep(400);
        smartCacheAt = 0;
        if (isOpen()) return true;
      }
      return false;
    };

    if (isOpen()) return true;

    // 从标题文字开始，逐层向上点（最多 5 层），每层都检查是否展开
    let node = el;
    for (let level = 0; level < 5 && node; level++) {
      step(`点击层级 ${level}`);
      try { node.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(150);
      fireClick(node);
      nudgeScroll(node);
      if (await waitOpen(level === 0 ? 3000 : 2000)) return true;
      node = node.parentElement;
    }

    // 最后试一次卡片里的箭头图标
    const holder = el.parentElement || el;
    const icon = holder.querySelector &&
      holder.querySelector('svg, i, [class*="arrow"], [class*="caret"], [class*="icon"]');
    if (icon) {
      step('点击箭头图标');
      try { icon.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(150);
      fireClick(icon);
      nudgeScroll(icon);
      if (await waitOpen(2500)) return true;
    }
    return false;
  }

  function sectionHeaders() {
    const cands = [];
    for (const el of all('*')) {
      const t = String(el.textContent || '').replace(/\s+/g, '');
      if (!/^(知识单元|知识模块)/.test(t)) continue;
      if (t.length > 60) continue;                 // 排除包含多个标题的大容器
      if (/必学\d+\/\d+/.test(t)) continue;         // 排除知识点行
      // 只有“知识单元:”这种标签、没有名字的不算标题
      if (t.replace(/^知识(单元|模块)[:：]?/, '').length < 2) continue;
      if (!visible(el)) continue;
      cands.push(el);
    }
    // 只保留最内层（不再包含其它候选标题）
    return cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
  }

  const isAfter = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  const textOfEl = (el) => String((el && el.textContent) || '').replace(/\s+/g, '');

  /* 取“标题 h 与下一个标题之间”的知识点行 */
  function rowsUnder(headers, h) {
    const i = headers.indexOf(h);
    if (i < 0) return [];
    const next = headers[i + 1] || null;
    return itemsNow().filter((r) => isAfter(h, r) && (!next || isAfter(r, next)));
  }

  /* h 与下一个标题之间是否还有子标题（说明这个模块已经展开） */
  /* 模块是否已经展开：看它后面、下一个模块之前，有没有“知识单元”标题。
     不能拿“紧邻的下一个标题”当边界——展开后紧邻的正是它的第一个单元。 */
  function hasChildHeader(headers, h) {
    if (headers.indexOf(h) < 0) return false;
    if (!/^知识模块/.test(textOfEl(h))) return false;
    for (const x of headers) {
      if (x === h) continue;
      if (!isAfter(h, x)) continue;
      if (/^知识模块/.test(textOfEl(x))) break;   // 到了下一个模块
      if (/^知识单元/.test(textOfEl(x))) return true;
    }
    return false;
  }

  /* 当前列表到头时：一层层展开后面的单元/模块，直到出现知识点行并点它。
     关键：用“上一次展开的标题”当定位锚，避免旧行被折叠后锚点失效、跳回前面的单元。 */
  async function expandNextSection(curKey) {
    const clicked = new Set();
    let frontier = anchorItem() || itemsNow().slice(-1)[0] || null;
    let lastKey = '';
    log('当前单元结束，开始找下一段…');

    for (let attempt = 0; attempt < 8; attempt++) {
      // 当前行还可见时，优先以它为锚（和 1.5 的行为一致）
      const liveCur = anchorItem();
      if (liveCur) frontier = liveCur;
      // 锚点被重新渲染掉了，就用上次展开的标题找回位置
      if ((!frontier || !frontier.isConnected) && lastKey) {
        frontier = sectionHeaders().find((x) => textOfEl(x) === lastKey) || null;
      }

      const headers = sectionHeaders();
      if (!headers.length) return false;
      const afterFrontier = (h) => (frontier && frontier.isConnected ? isAfter(frontier, h) : true);

      // 优先找“后面没有子内容”的折叠标题（折叠的单元，或折叠的模块）
      let target = null;
      for (const h of headers) {
        if (!afterFrontier(h)) continue;
        if (clicked.has(textOfEl(h))) continue;
        if (rowsUnder(headers, h).length) continue;
        if (hasChildHeader(headers, h)) continue;   // 模块已展开，交给它的单元
        target = h;
        break;
      }
      // 其次：模块已展开，但里面的单元收着
      if (!target) {
        target = headers.find((h) => afterFrontier(h) && !clicked.has(textOfEl(h)) &&
          /^知识单元/.test(textOfEl(h)) && rowsUnder(headers, h).length === 0) || null;
      }
      if (!target) return false;

      const key = textOfEl(target);
      clicked.add(key);
      lastKey = key;
      log('展开：', short(target.textContent, 30));
      const changed = await clickHeader(target);
      if (!changed) {
        log('点击后目录没有变化，换下一个标题');
        continue;
      }

      const hs = sectionHeaders();
      const t2 = hs.find((x) => textOfEl(x) === key) || null;
      if (!t2) continue;
      frontier = t2;
      const rows = rowsUnder(hs, t2);
      if (rows.length) {
        const first = rows[0];
        log('进入新单元：', short(state.adapter.label(first), 30));
        if (curKey) store.set(K_ADV, curKey);
        markSeen(first);
        state.count += 1;
        store.set(K_COUNT, state.count);
        clickItem(first);
        return true;
      }
      // 没出现行：说明刚展开的是模块，下一轮继续展开它的单元
    }
    return false;
  }

  /* ---------- 按知识点清单直接进入下一节 ---------- */
  function knowledgeIndexByName(name) {
    if (!name) return -1;
    const n = norm(name);
    return API.knowledge.findIndex((k) => norm(k.name) === n);
  }

  /* 当前知识点在清单里的下标：优先用资源接口的 nodeUid（最准），标题兜底 */
  function currentKnowledgeIndex() {
    if (!API.knowledge.length) return -1;
    const r = currentResource();
    const node = r && r.resourcesDetail && r.resourcesDetail.nodeUid;
    if (node) {
      const i = API.knowledge.findIndex((k) => k.id === String(node));
      if (i >= 0) { store.set(K_KI, String(i)); return i; }
    }
    const byName = knowledgeIndexByName(contentTitle());
    if (byName >= 0) { store.set(K_KI, String(byName)); return byName; }
    // 都认不出时，用上次成功识别的位置兜底（至少不会退回目录顶部）
    const last = parseInt(store.get(K_KI, ''), 10);
    if (Number.isInteger(last) && API.knowledge[last]) return last;
    return -1;
  }

  function nextKnowledge() {
    const i = currentKnowledgeIndex();
    if (i < 0) return null;
    return API.knowledge[i + 1] || null;
  }

  async function clickKnowledgeByName(k) {
    const targetNorm = norm(k.name);
    // 行文本常带“免考/新/已学”等后缀，允许前缀匹配
    const sameName = (t) => {
      if (!t) return false;
      if (t === targetNorm) return true;
      if (t.indexOf(targetNorm) === 0 && t.length <= targetNorm.length + 4) return true;
      return false;
    };
    const findRow = () => {
      const rows = itemsNow();
      const hit = rows.find((el) => sameName(norm(state.adapter.label(el))));
      if (hit) return hit;
      // 只在“可见”的文字里找，避免点到折叠留下的隐藏副本
      for (const el of all('*')) {
        if (el.children.length) continue;
        if (!sameName(norm(el.textContent || ''))) continue;
        if (!visible(el)) continue;
        // 向上找到“行”大小的那层（不要求有“必学”，免考单元没有这个文本）
        let r = el;
        for (let i = 0; i < 4; i++) {
          const p = r.parentElement;
          if (!p) break;
          const pr = p.getBoundingClientRect();
          if (pr.height > 120 || pr.width < 80) break;
          if (pr.height >= 24) r = p;
        }
        if (visible(r)) return r;
      }
      return null;
    };

    let row = findRow();
    if (!row) {
      const unitOf = (list) => {
        if (!k.unit) return null;
        const un = norm(k.unit);
        return list.find((h) => /^知识单元/.test(textOfEl(h)) && textOfEl(h).indexOf(un) >= 0) || null;
      };
      const theme = norm(k.theme);
      const triedUnits = new Set();
      let targetUnitTried = false;
      const triedModules = new Map();
      for (let round = 0; round < 10 && !row; round++) {
        const hs = sectionHeaders();
        // 1) 目标单元：先展开它（只试一次）
        const unit = unitOf(hs);
        if (unit && !targetUnitTried) {
          targetUnitTried = true;
          triedUnits.add(textOfEl(unit));
          await openUnitAuto(unit);
          smartCacheAt = 0;
          row = findRow();
          continue;
        }
        // 2) 目标模块还收着：先展开模块（同一模块最多试两次）
        const mod = hs.find((h) => /^知识模块/.test(textOfEl(h)) && theme && textOfEl(h).indexOf(theme) >= 0);
        if (mod && !hasChildHeader(hs, mod)) {
          const mk = textOfEl(mod);
          const n = triedModules.get(mk) || 0;
          if (n >= 2) break;
          triedModules.set(mk, n + 1);
          step('展开模块：' + short(mod.textContent, 16));
          await clickHeader(mod);
          continue;
        }
        // 3) 目标单元里没有：继续展开同模块下其它单元，最后遍历全页
        const mi = mod ? hs.indexOf(mod) : -1;
        const afterMod = hs.slice(mi + 1).filter((h) =>
          /^知识单元/.test(textOfEl(h)) && rowsUnder(hs, h).length === 0 &&
          !triedUnits.has(textOfEl(h)) && (!mod || isAfter(mod, h)));
        const anyUnit = afterMod[0] || hs.find((h) =>
          /^知识单元/.test(textOfEl(h)) && rowsUnder(hs, h).length === 0 &&
          !triedUnits.has(textOfEl(h)));
        if (anyUnit) {
          triedUnits.add(textOfEl(anyUnit));
          await openUnitAuto(anyUnit);
          smartCacheAt = 0;
          row = findRow();
          continue;
        }
        break;
      }
      row = findRow();
    }

    if (!row) return false;

    const v0 = pickVideo();
    const srcBefore = v0 ? (v0.currentSrc || v0.src || '') : '';
    const keyBefore = currentKeyNow();
    const hrefBefore = location.href;

    // 行里的文字元素（点它更接近真人操作）
    let innerText = row;
    try {
      for (const el of row.querySelectorAll('*')) {
        if (el.children.length === 0 && norm(el.textContent || '') === targetNorm) { innerText = el; break; }
      }
    } catch (e) {}

    const tryClick = async (el) => {
      clickItem(el);
      // 标题、视频源、高亮、URL 任一变化都算跳转成功（标题常常慢半拍）
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        titleAt = 0;
        if (norm(contentTitle()) === targetNorm) return true;
        const v = pickVideo();
        const src = v ? (v.currentSrc || v.src || '') : '';
        if (srcBefore && src && src !== srcBefore) return true;
        if (hrefBefore !== location.href) return true;
        if (keyBefore && currentKeyNow() && currentKeyNow() !== keyBefore) return true;
      }
      return false;
    };

    step('点击行：' + short(k.name, 20));
    if (await tryClick(innerText)) return true;
    if (innerText !== row) {
      step('点文字没反应，改点整行');
      if (await tryClick(row)) return true;
    }
    step('点击后未跳转');
    return false;
  }

  /* 把所有折叠的单元/模块展开（只点一次；展开后就不再点，避免又收回去） */
  async function ensureExpandedAll() {
    if (state.expandingAll) return;
    state.expandingAll = true;
    try {
      for (let round = 0; round < 40; round++) {
        const headers = sectionHeaders();
        let target = null;
        for (const h of headers) {
          if (rowsUnder(headers, h).length) continue;      // 已展开
          if (hasChildHeader(headers, h)) continue;        // 模块已展开
          target = h;
          break;
        }
        if (!target) break;
        log('预展开：', short(target.textContent, 24));
        fireClick(target);
        await sleep(600);
        smartCacheAt = 0;
      }
    } finally {
      state.expandingAll = false;
    }
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
      if (resourceDone()) return true;                // 右侧资源已标“已完成”
      const cur = anchorItem();
      if (!cur) return true;
      if (ad.done(cur)) return true;                  // 左栏 必学 x/y 满了
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

  /* 以接口为准的完成判定：等页面刷新 list-knowledge-resource 后看 studyStatus / schedule。
     这个站“左栏 0/1、右栏已完成”会滞后，接口才是真状态。 */
  async function waitSmartDone(ms) {
    const startAt = Date.now();
    const completeNow = () => {
      const r = currentResource();
      if (!r) return true;                      // 没有资源数据，别卡住
      if (r.studyStatus === 1) return true;
      if (typeof r.schedule === 'number' && r.schedule >= 100) return true;
      return false;
    };
    const domOk = () => {
      if (resourceDone()) return true;
      const cur = anchorItem();
      return !!(cur && state.adapter && state.adapter.done(cur));
    };
    while (Date.now() - startAt < ms) {
      if (API.resourceAt > startAt) return completeNow();   // 有“新鲜”数据才信
      if (domOk()) return true;
      await sleep(800);
    }
    // 超时还没刷新：按完成处理，避免无限重播同一节
    step('完成校验超时，按已完成处理');
    return true;
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
    if (!CFG.autoNext || state.advancing || state.stopped) {
      step('onEnded 被跳过：autoNext=' + CFG.autoNext + ' advancing=' + state.advancing + ' stopped=' + state.stopped);
      return;
    }
    if (!tryLock()) { step('onEnded 被锁跳过'); return; }
    state.advancing = true;
    const v = state.video;
    try {
      const cur = anchorItem();
      const curKey = cur ? keyOf(cur) : '';
      // 一个知识点可能有多个课件：同一个知识点换了课件也要能再判一次结束
      const rNow = currentResource();
      const advKey = (curKey || 'x') + '|' + norm(resName(rNow));
      step('检测到播放结束：' + (curKey || '(未知)'));
      // 同一节同一课件只处理一次（ended 事件 + 轮询会重复触发）
      if (curKey && store.get(K_ADV, '') === advKey) {
        step('这一节已处理过，等待下次拖动/播放');
        log('这一节已经处理过，忽略重复触发');
        return;
      }

      log('播放结束', curKey || '');
      setBadge('播放结束，等平台记录…');
      handleDialogs();

      if (!state.adapter) state.adapter = detectAdapter();   // 目录可能被折叠过，重试识别
      if (!state.adapter && sectionHeaders().length) {
        state.adapter = ADAPTERS.find((a) => /智能课程/.test(a.name)) || null;
      }
      if (!state.adapter) {
        step('未识别目录，放弃本次');
        warnThrottled('noad', '没有识别到课程目录，无法自动切下一节（可执行 __ZHS__.scan() 排查）');
        setBadge('未识别目录，请查看控制台');
        return;
      }
      step('目录已识别');

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
          setBadge('播放结束，等平台确认完成…');
          const recorded = await waitSmartDone(CFG.completeWaitMs);
          const info = apiInfo();
          if (info) {
            log(`接口状态：${info.name} status=${info.status} schedule=${info.schedule}% 已看=${info.watched}s 要求片段=${info.clip}`);
          }
          if (!recorded) {
            const n = bumpRetry(curKey);
            if (v && n <= CFG.maxReplay) {
              const r = currentResource();
              const q = (r && r.resourcesQuoteDetail) || {};
              const from = Number(q.videoStartTime);
              const startAt = Number.isFinite(from) && from > 0 ? from : 0;
              log(`本节未完成（第 ${n}/${CFG.maxReplay} 次），从 ${startAt}s 重播`);
              step(`未完成，重播本节（${n}/${CFG.maxReplay}）`);
              setBadge(`未完成，重播本节（${n}/${CFG.maxReplay}）`);
              try {
                v.currentTime = startAt;
                await forcePlay(v);
              } catch (e) {}
              return;
            }
            warn(`重播 ${CFG.maxReplay} 次仍未完成，先切下一节`);
          } else {
            log('接口/页面已确认完成，准备切下一节');
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

      // 这个知识点还有别的课件没看（必学 1/2 的那种）：先切课件，不切知识点
      const pend = pendingResource(strictResource() || currentResource());
      if (pend) {
        step('本节还有未完成课件，先切课件');
        setBadge('切换到下一个课件…');
        if (await openResource(pend)) {
          if (curKey) store.set(K_ADV, advKey);
          return;
        }
        step('课件卡片点击失败，退回知识点推进');
      }

      // 等待期间平台自己跳了：绝不能再点，否则会一次前进两节
      if (moved()) {
        step('平台已自行跳转，脚本不再点击');
        log('平台已自行跳到下一节，脚本不再点击');
        if (curKey) store.set(K_ADV, advKey);
        return;
      }

      await sleep(CFG.clickDelayMs);
      if (moved()) {
        log('平台已自行跳到下一节，脚本不再点击');
        if (curKey) store.set(K_ADV, advKey);
        return;
      }

      // 首选：按知识点清单点击（带展开、验证、步骤），失败才退回“点可视下一行”
      const ki = currentKnowledgeIndex();
      const nk = ki >= 0 ? (API.knowledge[ki + 1] || null) : null;
      if (nk) {
        step('按清单进入：' + nk.name);
        setBadge('正在进入：' + nk.name);
        for (let attempt = 0; attempt < 2; attempt++) {
          const ok = await clickKnowledgeByName(nk);
          if (ok) {
            if (curKey) store.set(K_ADV, advKey);
            state.count += 1;
            store.set(K_COUNT, state.count);
            step('已进入：' + nk.name);
            return;
          }
          await sleep(1000);
        }
        step('按清单进入失败，改用可视下一行');
        warn('按清单进入失败：', nk.name);
      }

      const target = pickNext();
      if (!target) {
        step('无可视下一行：ki=' + ki + '，清单=' + API.knowledge.length);
        if (ki >= 0 && ki === API.knowledge.length - 1) {
          log('知识点清单已到最后一条，全部完成 🎉');
          setBadge('全部完成 🎉');
          state.stopped = true;
          store.set(K_STOP, '1');
          return;
        }
        // 清单没抓到 / 当前节没匹配上：退回“展开目录”
        setBadge('当前单元结束，尝试进入下一段…');
        const advanced = await expandNextSection(curKey);
        if (advanced) {
          store.set(K_LAST, '');   // 锚点交给新点中的行
          return;
        }
        const idxNow = anchorIndex(itemsNow());
        if (idxNow < 0) {
          step('无法定位当前课时');
          warn('无法定位当前课时，未自动跳转（执行 __ZHS__.api() 查看）');
          setBadge('无法定位当前课时');
          return;
        }
        log('后面没有可展开的单元了，全部走完 🎉');
        setBadge('全部完成 🎉');
        state.stopped = true;
        store.set(K_STOP, '1');
        return;
      }
      step('改点可视下一行：' + short(state.adapter.label(target), 20));

      const label = short(state.adapter.label(target));
      log('下一节 →', label);
      setBadge('正在切到：' + label);
      store.set(K_LAST, norm(label));
      store.set(K_ADV, advKey);       // 先占位，防止这一节重复触发
      markSeen(target);
      state.count += 1;
      store.set(K_COUNT, state.count);

      clickItem(target);

      await sleep(2000);
      if (moved()) {
        step('已跳转（可视行）');
        log('已跳转');
        return;
      }

      // 再给 3 秒（切视频有时慢），确实没跳才回退
      await sleep(3000);
      if (moved()) {
        step('已跳转（可视行，慢）');
        log('已跳转');
        return;
      }
      step('可视行点击没反应');

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
    } catch (e) {
      step('onEnded 异常：' + (e && e.message ? e.message : String(e)));
      warn('onEnded 异常', e);
    } finally {
      state.advancing = false;
    }
  }

  /* 页面上没有视频时：先补点没完成的课件（PPT 也算），都完成了就进下一知识点 */
  async function handleNoVideo() {
    if (!state.running || state.stopped || state.advancing) return;
    if (!state.adapter) return;
    const title = contentTitle();
    if (!title) return;
    // 刚点过哪张课件卡，就以它为“当前课件”（PPT 没有 video，接口里的 videoId 还是旧的）
    let cur = currentResource();
    const last = state.lastRes;
    if (last && last.name && Date.now() - last.at < 120000) {
      const hit = (API.resources || []).find((r) => norm(resName(r)) === norm(last.name));
      if (hit) cur = hit;
    }
    const pend = pendingResource(cur);
    if (pend) {
      await openResource(pend);
      return;
    }
    // 只有确认当前课件是 PPT/文档（本来就没有视频）才自动进下一知识点，
    // 否则可能只是播放器还没加载出来，贸然点走会漏课。
    if (!cur || !isPptResource(cur)) return;
    if (Date.now() - (state.nkAt || 0) < 20000) return;
    // 等平台把这张 PPT 记成“已完成”；等太久（25s）就按已学处理，避免卡死
    const card = cardOf(cur);
    const marked = (card && cardDone(card)) || resDoneOne(cur);
    const waited = last && last.name && norm(last.name) === norm(resName(cur)) ? Date.now() - last.at : 0;
    if (!marked && waited < 25000) return;
    const nk = nextKnowledge();
    if (!nk) {
      setBadge('全部完成 🎉');
      state.stopped = true;
      store.set(K_STOP, '1');
      return;
    }
    state.nkAt = Date.now();
    step('PPT 课件已记录，进入下一知识点：' + nk.name);
    setBadge('进入下一知识点：' + nk.name);
    const ok = await clickKnowledgeByName(nk);
    if (ok) {
      state.count += 1;
      store.set(K_COUNT, state.count);
    } else {
      step('下一知识点点击失败：' + nk.name);
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
        // 所有单元都折叠时一行都扫不到，但“知识单元”标题还在，靠它认页
        if (!state.adapter && sectionHeaders().length) {
          state.adapter = ADAPTERS.find((a) => /智能课程/.test(a.name)) || null;
          if (state.adapter) log('按“知识单元”标题识别为智能课程');
        }
      }
      // 预展开已停用：它会反复点“绪论”把目录开开关关。
      // 现在改成按知识点清单定向进入下一节（见 clickKnowledgeByName）。
      handleDialogs();

      const captcha = one('.yidun_popup');
      if (captcha && visible(captcha)) return;

      const v = pickVideo();
      if (!v) {
        // 没有 <video>：可能是 PPT/文档课件（点开即算学过），也可能是刚切课件还没挂上播放器
        state.noVideoAt = state.noVideoAt || Date.now();
        if (!state.advancing && Date.now() - state.noVideoAt > 9000) {
          state.noVideoAt = 0;
          handleNoVideo();
        }
        updateBadge();
        return;
      }
      state.noVideoAt = 0;
      if (v !== state.video) attach(v);
      applyPrefs(v);

      if (state.advancing) return;

      // 这个知识点有多个课件（必学 1/2）：当前这个已经完成，就别再重看，直接切到没完成的那个
      if (API.resources.length > 1 && Date.now() - (API.resourceAt || 0) < 90000 &&
          Date.now() - (state.resAt || 0) > 8000) {
        const rCur = strictResource();   // 必须按 videoId 认出来，不能用兜底猜的
        if (rCur && resDoneOne(rCur)) {
          const rPend = pendingResource(rCur);
          if (rPend) {
            step('当前课件已完成，切到未完成的课件');
            openResource(rPend);
            return;
          }
        }
      }

      // 当前课时变了（这个站切课时 URL 不一定变）→ 旧视频可能还 ended，等新视频播起来
      const ck = currentKeyNow();
      if (ck && ck !== state.curKey) {
        state.curKey = ck;
        state.ignoreEnded = true;
        state.expandedAt = 0;
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
    if (!document.documentElement) return;   // document-start 阶段可能还没 html 节点
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
    tryNext: async () => {
      STEPS.length = 0;
      const k = nextKnowledge();
      if (!k) return { ok: false, reason: '清单里没有下一节', steps: [] };
      step('手动测试：进入 ' + k.name);
      const ok = await clickKnowledgeByName(k);
      step(ok ? '成功' : '失败');
      return { ok, next: k, steps: STEPS.slice() };
    },
    probe: () => {
      const k = nextKnowledge();
      const out = {
        next: k,
        headers: sectionHeaders().map((h) => ({
          text: short(h.textContent, 30),
          cls: String(h.className || ''),
          html: h.outerHTML.slice(0, 220),
        })),
        target: null,
      };
      if (k) {
        const name = norm(k.name);
        for (const el of all('*')) {
          if (el.children.length) continue;
          if (norm(el.textContent || '') !== name) continue;
          const row = el.closest('div, li, a');
          if (row && /必学\d+\/\d+/.test(row.textContent || '')) {
            out.target = {
              textEl: el.outerHTML.slice(0, 220),
              rowCls: String(row.className || ''),
              rowHtml: row.outerHTML.slice(0, 600),
            };
            break;
          }
        }
      }
      console.log(out);
      try { copy(JSON.stringify(out, null, 2)); console.log('%c[ZHS] 已复制到剪贴板', 'color:#0a0'); } catch (e) {}
      return out;
    },
    steps: () => STEPS.slice(),
    play: () => forcePlay(state.video),
    /* 课件诊断：跑在“必学 1/2”那个知识点上，把返回值发我 */
    res: () => {
      const list = API.resources || [];
      return {
        title: contentTitle(),
        belongs: resourcesBelongHere(),
        listNode: resNodeOf(list),
        listAge: API.resourceAt ? Math.round((Date.now() - API.resourceAt) / 1000) + 's' : null,
        list: list.map((r) => {
          const card = cardOf(r);
          return {
            name: resName(r),
            node: String((r.resourcesDetail || {}).nodeUid || ''),
            status: r.studyStatus,
            schedule: r.schedule,
            time: (r.resourcesDetail || {}).resourcesTime,
            ppt: isPptResource(r),
            hasCard: !!card,
            cardDone: cardDone(card),
            isCurrent: r === currentResource(),
          };
        }),
      };
    },
    api: () => ({
      videoId: API.videoId,
      updatedAt: API.resourceAt ? new Date(API.resourceAt).toLocaleTimeString() : null,
      knowledgeCount: API.knowledge.length,
      currentKnowledge: (API.knowledge[currentKnowledgeIndex()] || {}).name || null,
      nextKnowledge: (nextKnowledge() || {}).name || null,
      resource: apiInfo(),
    }),
    headers: () => sectionHeaders().map((h) => ({
      text: short(h.textContent, 30),
      html: h.outerHTML.slice(0, 100),
    })),
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
