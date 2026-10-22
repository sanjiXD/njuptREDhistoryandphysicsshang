// ==UserScript==
// @name         智慧树 网络全量嗅探（诊断用，不点击）
// @namespace    local.zhs.netsniff
// @version      1.1
// @description  记录页面所有 XHR/fetch/beacon（不筛选），用于定位“学完”接口
// @author       local
// @match        *://ai-smart-course-student-pro.zhihuishu.com/*
// @match        *://smartcoursestudent.zhihuishu.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  if (window.__NETLOG__) return;

  const MAX = 400;
  const log = [];
  const KEY = /(progress|study|record|report|learn|duration|complete|finish|heartbeat|video|course|chapter|knowledge|point|schedule|process|learnTime|play)/i;

  const short = (s, n = 500) => {
    let t;
    try { t = typeof s === 'string' ? s : JSON.stringify(s); }
    catch (e) { t = String(s); }
    if (t == null) t = '';
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  const push = (rec) => {
    rec.ms = Date.now();
    rec.rel = KEY.test(rec.url + ' ' + rec.req + ' ' + rec.res);
    log.push(rec);
    if (log.length > MAX) log.shift();
  };

  /* ---------- fetch ---------- */
  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const body = init && init.body;
      const bodyText = typeof body === 'string' ? body : '';
      const t0 = Date.now();
      return origFetch.apply(this, arguments).then((res) => {
        try {
          const clone = res.clone();
          clone.text().then((txt) => {
            push({
              t: new Date().toLocaleTimeString(), type: 'fetch', method,
              url: short(url, 400), req: short(bodyText, 800),
              status: res.status, res: short(txt, 2000), ms: Date.now() - t0,
            });
          }).catch(() => {});
        } catch (e) {}
        return res;
      });
    };
  } catch (e) {}

  /* ---------- XMLHttpRequest ---------- */
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__zhsInfo = { method: String(method || 'GET'), url: String(url || '') };
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const info = this.__zhsInfo || {};
      const bodyText = typeof body === 'string' ? body : '';
      const t0 = Date.now();
      const xhr = this;
      xhr.addEventListener('load', () => {
        let txt = '';
        try {
          txt = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : '[' + xhr.responseType + ']';
        } catch (e) {}
        push({
          t: new Date().toLocaleTimeString(), type: 'xhr', method: info.method,
          url: short(info.url, 400), req: short(bodyText, 800),
          status: xhr.status, res: short(txt, 2000), ms: Date.now() - t0,
        });
      });
      return origSend.apply(this, arguments);
    };
  } catch (e) {}

  /* ---------- sendBeacon（很多播放器用它上报） ---------- */
  try {
    const origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (origBeacon) {
      navigator.sendBeacon = function (url, data) {
        let txt = '';
        try {
          if (typeof data === 'string') txt = data;
          else if (data && data.text) data.text().then((x) => push({ t: new Date().toLocaleTimeString(), type: 'beacon', method: 'POST', url: short(String(url), 400), req: short(x, 800), status: 0, res: '', ms: 0 })).catch(() => {});
        } catch (e) {}
        if (txt) push({ t: new Date().toLocaleTimeString(), type: 'beacon', method: 'POST', url: short(String(url), 400), req: short(txt, 800), status: 0, res: '', ms: 0 });
        return origBeacon.apply(this, arguments);
      };
    }
  } catch (e) {}

  /* ---------- WebSocket ---------- */
  try {
    const OrigWS = window.WebSocket;
    if (OrigWS) {
      window.WebSocket = function (url, protocols) {
        const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
        try {
          ws.addEventListener('message', (ev) => {
            const data = typeof ev.data === 'string' ? ev.data : '';
            if (!data) return;
            push({ t: new Date().toLocaleTimeString(), type: 'ws', method: 'MESSAGE', url: short(String(url), 300), req: '', status: 0, res: short(data, 1500), ms: 0 });
          });
          ws.addEventListener('open', () => {
            push({ t: new Date().toLocaleTimeString(), type: 'ws', method: 'OPEN', url: short(String(url), 300), req: '', status: 1, res: '', ms: 0 });
          });
        } catch (e) {}
        return ws;
      };
      window.WebSocket.prototype = OrigWS.prototype;
    }
  } catch (e) {}

  const dumpRows = (rows, kw) => {
    console.table(rows.map((r) => ({
      time: r.t,
      type: r.type,
      method: r.method,
      url: r.url.split('?')[0].slice(-90),
      status: r.status,
      req: r.req.slice(0, 90),
      res: r.res.slice(0, 140),
      rel: r.rel ? '★' : '',
    })));
    try {
      copy(JSON.stringify(rows, null, 2));
      console.log('%c[NET] 已复制 ' + rows.length + ' 条到剪贴板', 'color:#0a0;font-weight:bold');
    } catch (e) {
      console.log(JSON.stringify(rows, null, 2));
    }
    if (kw && !rows.length) console.warn('[NET] 关键词 "' + kw + '" 没有命中，先用 __NETLOG__.dump() 看全量');
    return rows;
  };

  window.__NETLOG__ = {
    all: () => log.slice(),
    clear: () => { log.length = 0; console.log('%c[NET] 已清空，现在去触发操作', 'color:#0a0'); },
    grep: (kw) => log.filter((r) => new RegExp(kw, 'i').test(r.url + ' ' + r.req + ' ' + r.res)),
    dump: (kw) => dumpRows(kw ? window.__NETLOG__.grep(kw) : log.slice(), kw),
    last: (n) => dumpRows(log.slice(-(n || 20))),
  };

  console.log('%c[NET] 全量嗅探已启用。用法：__NETLOG__.clear() → 触发操作 → __NETLOG__.dump()', 'color:#0a0;font-weight:bold');
})();
