'use strict';

// Optional module. Loading this file never loads Firebase; only load() does.
const Video = (() => {
  const CONFIG = {
    apiKey: 'AIzaSyDLKj9cZ0ZM4kKlR2IUtodVnEOzsKiKB5o',
    authDomain: 'student-dashboard-513701.firebaseapp.com',
    projectId: 'student-dashboard-513701',
    appId: '1:863861496583:web:67cafde64a8351b7ca83a2',
  };
  let opts, sdkPromise, sdk, authSerial = Promise.resolve(), writesSerial = Promise.resolve(), generation = 0;
  let token, sid, groups = [], events = [], overlay = new Map(), catalogs = new Map(), summary = {}, asks = [], resolved = [];
  let recent = [], extras = new Map(), extraStops = new Map();
  let unsubs = [], eventUnsub, eventKey = '', status = 'idle', error = '', retryAction;
  let host, flow = null, player, playerTicket = 0, busy = false, readyEvents = false;
  let preview = null, ytPromise, shownSig = null, shownPage = null;
  let playerReady = false, ticker = null, seeking = false, viewportBefore = null;

  function init(o) {
    opts = o;
    window.addEventListener('pagehide', () => leave());
    ['resize', 'orientationchange'].forEach(name => window.addEventListener(name, () => { fitClip(); setTimeout(fitClip, 300); }));
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(name => document.addEventListener(name, () => {
      // 跳出全螢幕（例如按手機的返回鍵）就當作看到這裡，直接進回報頁。
      if (!document.fullscreenElement && !document.webkitFullscreenElement && flow && flow.page === 'play' && flow.entered) finish();
      else { fitClip(); setTimeout(fitClip, 300); }
    }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && player) {
        stopClock();
        try { player.pauseVideo(); } catch (_) { /* not ready */ }
      }
    });
  }
  const hasTab = st => !!st && st.video === true;
  const now = () => performance.now();
  function state(extra) {
    const merged = new Map(events.map(e => [e.id, e]));
    overlay.forEach((e, id) => merged.set(id, e));
    if (extra) merged.set(extra.id, extra);
    let s = summary;
    if (s.version === 5) overlay.forEach(e => { s = VideoLogic.reportSummary(s, e); });
    if (extra && s.version === 5) s = VideoLogic.reportSummary(s, extra);
    return VideoLogic.derive(groups, [...merged.values(), ...asks, ...resolved], s);
  }
  function notify() {
    if (host && host.isConnected) render();
    opts.changed();
  }
  function fail(action) {
    destroyPlayer();
    error = navigator.onLine === false ? '目前離線，請連上網路後再試一次。' : '影片暫時無法使用，請再試一次。';
    retryAction = action || (() => load(token));
    notify();
  }
  async function firebase() {
    if (!sdkPromise) sdkPromise = Promise.all([
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
    ]).then(([a, b, c]) => {
      const app = a.getApps().find(x => x.name === 'video') || a.initializeApp(CONFIG, 'video');
      sdk = { ...b, ...c, auth: b.getAuth(app), db: c.getFirestore(app) };
      return sdk;
    }).catch(e => { sdkPromise = null; throw e; });
    return sdkPromise;
  }
  function subFromToken(jwt) {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const value = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))).sub;
    if (typeof value !== 'string' || !value) throw new Error('identity');
    return value;
  }
  function reset() {
    leave();
    generation++;
    unsubs.forEach(f => f()); unsubs = [];
    extraStops.forEach(f => f()); extraStops.clear(); extras.clear(); recent = []; summary = {}; asks = []; resolved = [];
    if (eventUnsub) eventUnsub();
    eventUnsub = null; eventKey = ''; readyEvents = false;
    token = null; sid = null; groups = []; events = []; overlay = new Map(); catalogs = new Map();
    flow = null; if (host) host.replaceChildren(); shownSig = null; shownPage = null; busy = false; status = 'idle'; error = ''; retryAction = null; preview = null;
  }
  async function signOut() {
    reset();
    // Serialize against an in-flight login, including account changes while SDK is loading.
    authSerial = authSerial.catch(() => {}).then(async () => {
      if (sdk) await sdk.signOut(sdk.auth);
    });
    return authSerial;
  }
  async function load(idToken) {
    reset(); token = idToken; status = 'loading';
    const gen = generation;
    if (window.VIDEO_PREVIEW) {
      preview = window.VIDEO_PREVIEW;
      groups = preview.groups; events = preview.events;
      Object.entries(preview.catalogs).forEach(([k, v]) => catalogs.set(k, v));
      readyEvents = true; status = 'ready';
      if (preview.page === 'play' || preview.page === 'report') {
        const g = groups[0]; flow = newFlow(g, g.items[0]); flow.page = preview.page;
      }
      notify(); return;
    }
    notify();
    try {
      authSerial = authSerial.catch(() => {}).then(async () => {
        const s = await firebase();
        if (gen !== generation) return;
        await s.auth.authStateReady();
        const sub = subFromToken(idToken);
        if (s.auth.currentUser) {
          const r = await s.auth.currentUser.getIdTokenResult();
          const ids = r.claims.firebase && r.claims.firebase.identities;
          if (!ids || !ids['google.com'] || ids['google.com'][0] !== sub) await s.signOut(s.auth);
        }
        if (gen !== generation) return;
        await s.signInWithCredential(s.auth, s.GoogleAuthProvider.credential(idToken));
        if (gen !== generation) return;
        const access = await s.getDocFromServer(s.doc(s.db, 'access', sub));
        if (gen !== generation) return;
        const self = access.exists() && access.data().self;
        if (!Array.isArray(self) || self.length !== 1 || typeof self[0] !== 'string' || !self[0] || self[0].includes('/')) {
          throw new Error('ambiguous access');
        }
        sid = self[0];
      });
      await authSerial;
      if (gen !== generation) return;
      const s = sdk;
      const listenError = () => { if (gen === generation) { status = 'error'; fail(); } };
      unsubs.push(s.onSnapshot(s.doc(s.db, 'students', sid), snap => {
        if (gen !== generation) return;
        summary = snap.exists() ? snap.data() : {};
        syncGroups(gen); refresh(gen);
      }, listenError));
      for (const [kind, filters] of [['ask', [s.where('type', '==', 'report'), s.where('result', '==', 'ask')]], ['resolve', [s.where('type', '==', 'resolve')]]]) {
        unsubs.push(s.onSnapshot(s.query(s.collection(s.db, 'students', sid, 'events'), ...filters), snap => {
          if (gen !== generation) return;
          const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
          if (kind === 'ask') asks = rows; else resolved = rows;
          notify();
        }, listenError));
      }
      unsubs.push(s.onSnapshot(s.query(s.collection(s.db, 'students', sid, 'groups'), s.orderBy('seq', 'desc'), s.limit(10)), snap => {
        if (gen !== generation) return;
        recent = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        syncGroups(gen);
        syncFlow();
        const ids = recent.map(g => g.id);
        const key = JSON.stringify(ids);
        if (key !== eventKey) {
          eventKey = key; readyEvents = false;
          if (eventUnsub) eventUnsub();
          events = [];
          if (!ids.length) { readyEvents = true; status = 'ready'; notify(); return; }
          eventUnsub = s.onSnapshot(s.query(s.collection(s.db, 'students', sid, 'events'), s.where('groupId', 'in', ids)), es => {
            if (gen !== generation || key !== eventKey) return;
            events = es.docs.map(d => ({ ...d.data(), id: d.id }));
            es.docs.forEach(d => { if (!d.metadata.hasPendingWrites) overlay.delete(d.id); });
            readyEvents = true;
            refresh(gen);
          }, () => { if (gen === generation) { status = 'error'; fail(); } });
        }
        refresh(gen);
      }, () => { if (gen === generation) { status = 'error'; fail(); } }));
    } catch (_) { if (gen === generation) { status = 'error'; fail(); } }
  }
  function syncGroups(gen) {
    const wanted = new Set([...(summary.activeGroups || []).map(g => g.id), ...Object.values(summary.pendingAsks || {}).map(a => a.groupId)]
      .filter(id => !recent.some(g => g.id === id)));
    extraStops.forEach((stop, id) => { if (!wanted.has(id)) { stop(); extraStops.delete(id); extras.delete(id); } });
    wanted.forEach(id => {
      if (extraStops.has(id)) return;
      extraStops.set(id, sdk.onSnapshot(sdk.doc(sdk.db, 'students', sid, 'groups', id), snap => {
        if (gen !== generation || !extraStops.has(id)) return;
        if (snap.exists()) extras.set(id, { ...snap.data(), id });
        if (!snap.exists()) extras.delete(id);
        groups = [...recent, ...extras.values()]; syncFlow(); refresh(gen);
      }, () => { if (gen === generation) fail(); }));
    });
    groups = [...recent, ...extras.values()];
  }
  function syncFlow() {
    if (!flow) return;
    const group = groups.find(g => g.id === flow.group.id);
    const item = group?.items.find(i => i.gid === flow.item.gid);
    if (!group || group.status !== 'assigned' || !item) { leave(); return; }
    flow.group = group; flow.item = item;
  }
  async function refresh(gen) {
    if (!readyEvents) return;
    try {
      const needed = new Map();
      VideoLogic.recentGroups(groups).forEach(g => g.items.forEach(i => needed.set(`${i.book}_${i.chapter}`, i)));
      await Promise.all([...needed.keys()].map(async key => {
        if (catalogs.has(key)) return;
        const d = await sdk.getDocFromServer(sdk.doc(sdk.db, 'catalog', key));
        if (!d.exists()) throw new Error('catalog missing');
        if (gen === generation) catalogs.set(key, d.data());
      }));
      if (gen !== generation) return;
      status = 'ready'; notify();
    } catch (_) { if (gen === generation) { status = 'error'; fail(); } }
  }
  function metadata(item) {
    const chapter = catalogs.get(`${item.book}_${item.chapter}`);
    return chapter && chapter.items.find(i => i.gid === item.gid);
  }
  function label(item) { const m = metadata(item); return m && m.label || '積木 ' + item.gid; }
  function place(item) {
    const m = metadata(item);
    const match = /^(re|j)?sb(\d+)(B?)$/.exec(item.book);
    const book = !match ? item.book : match[1] === 're' ? `學測複習講義part${match[2]}${match[3]}`
      : `${match[1] === 'j' ? '國中' : ''}第${match[2]}冊${match[3]}`;
    return `${book}・第 ${item.chapter} 章` + (m ? `・第 ${m.section} 節` : '');
  }
  function homeCard(open) {
    const d = state(), g = d.current || d.lastCompleted;
    return el('button', { class: 'home-card video-card', on: { click: open } },
      el('span', { text: '影片' }), el('strong', { text: error ? '暫時無法使用' : status === 'ready' ? `${g ? g.doneCount : 0}/${g ? g.items.length : 0}・待問 ${d.askCount}` : '讀取中' }),
      el('small', { text: error ? '暫時無法使用・點此重試 ›' : '查看影片任務 ›' }));
  }
  function section() {
    if (!host) host = el('section', { class: 'video-section', 'aria-label': '影片任務' });
    return [host];
  }
  function button(text, click, primary = false) {
    return el('button', { class: primary ? 'primary' : '', text, disabled: busy ? '' : null, on: { click } });
  }
  function list(group, d) {
    return el('ul', { class: 'video-list' }, VideoLogic.itemAccess(group).map((i, n) => {
      const locked = i.access === 'locked';
      return el('li', { class: 'video-item-' + i.access },
        el('button', { text: `${locked ? '🔒 ' : ''}${n + 1}. ${label(i)}・${i.access === 'done' ? '已完成' : locked ? '尚未解鎖' : '現在這個'}${d.pending.some(e => e.gid === i.gid) ? '・待問老師' : ''}`,
          'aria-disabled': locked ? 'true' : null, on: { click: () => open(group, i) } }),
        el('small', { text: place(i) }));
    }));
  }
  function render() {
    if (!host) return;
    // Keep an active iframe in place when unrelated dashboard updates arrive.
    if (flow && flow.page === 'play' && host.querySelector('.video-player') && (player || (preview && host.querySelector('.video-placeholder'))) && !error) return;
    const nodes = [];
    if (error) {
      immersive(false);
      nodes.push(el('div', { class: 'video-error', role: 'alert' }, el('p', { text: error }), button('再試一次', () => {
        if (busy) return;
        error = ''; const retry = retryAction; retryAction = null;
        if (retry) retry();
      })));
      place_(nodes, 'error');
      return;
    }
    if (status !== 'ready') {
      if (!error) nodes.push(el('p', { text: '正在讀取影片任務…' }));
    } else if (flow && flow.page === 'play') {
      // 播放頁：蓋滿螢幕、鎖住捲動與縮放。播放中只有影片和底下的時間條；看完或跳出就進回報頁。
      const index = flow.group.items.findIndex(i => i.gid === flow.item.gid) + 1;
      const plain = (text, click, props = {}) => el('button', { text, on: { click }, ...props });
      nodes.push(el('div', { class: 'video-stage' },
        el('div', { class: 'video-player', 'aria-label': '影片播放器' }),
        el('div', { class: 'video-tap', on: { click: togglePlayer } }),
        el('div', { class: 'video-cover' },
          el('strong', { text: label(flow.item) }),
          el('small', { text: `第 ${flow.group.seq} 組・本組第 ${index} 個・${place(flow.item)}` }),
          plain(preview ? '▶ 播放' : '載入中…', startPlayer, { class: 'primary video-start' }),
          button('返回影片任務', () => { leave(); notify(); }),
          el('small', { class: 'video-build', text: '版本 1114-1' })),
        el('div', { class: 'video-bar' },
          plain('▶', togglePlayer, { class: 'video-toggle', 'aria-label': '暫停或播放' }),
          el('input', { class: 'video-seek', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': '播放進度',
            on: { input: e => { seeking = true; showTime(e.target.value / 1000 * duration()); },
              change: e => { seekTo(e.target.value / 1000 * duration()); seeking = false; } } }),
          el('span', { class: 'video-time', text: '0:00 / 0:00' }),
          plain('1x', cycleRate, { class: 'video-rate', 'aria-label': '播放速度' }),
          button('我看完了', finish))));
    } else if (flow) {
      nodes.push(button('返回影片任務', () => { leave(); notify(); }));
      nodes.push(el('p', { class: 'video-eyebrow', text: `第 ${flow.group.seq} 組・本組第 ${flow.group.items.findIndex(i => i.gid === flow.item.gid) + 1} 個` }),
        el('h2', { text: label(flow.item) }), el('p', { text: place(flow.item) }));
      nodes.push(el('h3', { text: '這次看得怎麼樣？' }), el('div', { class: 'video-reports' },
        button('看懂了', () => report('ok'), true), button('再看一次', () => report('again')), button('還是不懂', () => report('ask'))));
    } else {
      const d = state(), g = d.current || d.lastCompleted;
      if (!preview && summary.version !== 5) nodes.push(el('p', { text: '影片進度待同步，請老師更新摘要。' }));
      else if (!groups.length) nodes.push(el('h2', { text: '目前沒有影片任務' }));
      else if (!d.current) nodes.push(el('h2', { text: g ? '這組完成了，等老師安排下一組' : '等待老師安排' }));
      if (g) {
        nodes.push(el('p', { class: 'video-progress', text: `第 ${g.seq} 組・${g.doneCount}/${g.items.length}` }));
        if (d.current) nodes.push(button('繼續', () => open(g, g.items.find(i => !i.done)), true));
        nodes.push(list(g, d));
      }
      nodes.push(el('h3', { text: `待問老師（${d.askCount}）` }),
        ...d.pending.map(e => {
          const g = d.groups.find(g => g.id === e.groupId), item = g?.items.find(i => i.gid === e.gid);
          if (!g || !item) return el('p', { text: `積木 ${e.gid}・待問老師` });
          return g.status === 'assigned' ? button(`${label(item)}・${place(item)}`, () => open(g, item)) : el('p', { text: `${label(item)}・待問老師（任務已收回）` });
        }));
    }
    place_(nodes, status !== 'ready' ? 'loading' : flow ? `${flow.group.id}:${flow.item.gid}:${flow.page}` : 'list');
    immersive(!!(flow && flow.page === 'play' && status === 'ready'));
    if (flow && flow.page === 'play' && !error && !busy) mountPlayer();
  }
  /** 播放頁開著時鎖住整頁捲動；離開時一併退出全螢幕與橫向鎖定。 */
  function immersive(on) {
    const root = document.documentElement;
    if (root && root.classList) root.classList.toggle('video-immersive', on);
    try {
      // 鎖住縮放：播放時雙擊或兩指都不會把畫面放大；離開時還原。
      const meta = document.querySelector('meta[name="viewport"]');
      if (meta && on && viewportBefore === null) {
        viewportBefore = meta.getAttribute('content') || '';
        meta.setAttribute('content', viewportBefore + ', maximum-scale=1, user-scalable=no');
      } else if (meta && !on && viewportBefore !== null) {
        meta.setAttribute('content', viewportBefore); viewportBefore = null;
      }
    } catch (_) { /* 沒有 viewport 設定 */ }
    if (on) return;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        const done = exit && exit.call(document);
        if (done && done.catch) done.catch(() => {});
      }
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    } catch (_) { /* 不支援全螢幕的瀏覽器 */ }
  }
  /** 只能在使用者點按的當下呼叫。不支援時（例如 iPhone）維持蓋滿視窗的版面。 */
  function enterFullscreen(node) {
    try {
      const request = node.requestFullscreen || node.webkitRequestFullscreen;
      if (!request) return;
      Promise.resolve(request.call(node)).then(() => {
        if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape');
      }).catch(() => {});
    } catch (_) { /* 不支援 */ }
  }
  const RATES = [1, 1.25, 1.5, 2];
  function fitClip() {
    const target = host && host.querySelector && host.querySelector('.video-stage .video-player');
    const clip = target && target.querySelector && target.querySelector('.video-clip');
    if (!clip || !clip.style || !target.clientWidth || !target.clientHeight) return;
    const width = Math.min(target.clientWidth, target.clientHeight * 16 / 9);
    clip.style.width = Math.floor(width) + 'px';
    clip.style.height = Math.floor(width * 9 / 16) + 'px';
  }
  const stage = () => host && host.querySelector('.video-stage');
  let playing = false;
  /** 開始播放後封面就不再出現：暫停時畫面停在那一格、完全不遮，學生可以看著抄筆記。 */
  function setPlaying(on) {
    playing = on;
    const node = stage();
    if (node && node.classList) {
      node.classList.toggle('is-playing', on);
      if (on) node.classList.add('is-started');
    }
    const toggle = host && host.querySelector('.video-toggle');
    if (toggle) toggle.textContent = on ? '⏸' : '▶';
  }
  function togglePlayer() {
    if (playing) pausePlayer(); else startPlayer();
  }
  /** 看完、按「我看完了」或跳出全螢幕：收掉播放器，進回報頁。 */
  function finish() {
    if (!flow || flow.page !== 'play' || busy) return;
    stopClock(); destroyPlayer(); flow.page = 'report'; immersive(false); notify();
  }
  /** 自己的播放鈕：點下去才有權限進全螢幕並開始播放。 */
  function startPlayer() {
    const node = stage();
    if (preview) { if (node) enterFullscreen(node); if (flow) flow.entered = true; setPlaying(true); return; }
    if (!player || !playerReady || !flow) return;
    if (node && !document.fullscreenElement && !document.webkitFullscreenElement) enterFullscreen(node);
    flow.entered = true;
    try {
      if (flow.atEnd) { flow.atEnd = false; player.seekTo(0, true); }
      player.playVideo();
    } catch (_) { /* 播放器還沒好，再按一次 */ }
  }
  function pausePlayer() {
    if (preview) { setPlaying(false); return; }
    try { if (player && playerReady) player.pauseVideo(); } catch (_) { /* not ready */ }
  }
  function duration() { try { return player && playerReady && player.getDuration() || 0; } catch (_) { return 0; } }
  function clock(seconds) {
    const t = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }
  function showTime(current) {
    const text = host && host.querySelector('.video-time');
    if (text) text.textContent = `${clock(current)} / ${clock(duration())}`;
  }
  function seekTo(seconds) {
    try {
      if (player && playerReady) {
        if (flow && seconds < duration() - 1) flow.atEnd = false;
        player.seekTo(Math.max(0, seconds), true); showTime(seconds);
      }
    } catch (_) { /* not ready */ }
  }
  function showRate(rate) {
    const b = host && host.querySelector('.video-rate');
    if (b) b.textContent = rate + 'x';
  }
  function cycleRate() {
    if (!flow) return;
    const next = RATES[(RATES.indexOf(flow.rate) + 1) % RATES.length] || 1;
    try { if (player && playerReady) player.setPlaybackRate(next); } catch (_) { /* not ready */ }
    if (preview) flow.rate = next;
    showRate(next);
  }
  function tick() {
    if (!player || !playerReady || seeking) return;
    try {
      const current = player.getCurrentTime(), total = duration(), bar = host.querySelector('.video-seek');
      if (playing && flow && total > 1 && current >= total - 0.4) { flow.atEnd = true; player.pauseVideo(); }
      if (bar && total > 0) bar.value = String(Math.round(current / total * 1000));
      showTime(current);
    } catch (_) { /* not ready */ }
  }
  /**
   * 內容沒變就不重畫：即時更新一直進來時，手指下的按鈕不會被換掉。
   * 換頁（清單→播放→回報→下一個）時把影片區捲回最上面，位置固定，不會停在舊頁面捲到一半的地方。
   */
  function place_(nodes, page) {
    const html = nodes.map(n => n.outerHTML);
    const sig = html.every(h => typeof h === 'string') ? page + '|' + html.join('') : null;
    if (sig !== null && sig === shownSig && host.childNodes && host.childNodes.length) return;
    const changedPage = shownPage !== null && page !== shownPage;
    shownSig = sig; shownPage = page;
    host.replaceChildren(...nodes);
    if (changedPage && host.isConnected && typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'start' });
  }
  function afterRender(showing) {
    if (!showing) { if (flow) leave(); return; }
    render();
  }
  function newFlow(group, item) {
    return { group, item, page: 'play', opened: now(), played: 0, playingAt: null, rate: 1,
      startId: null, reportEvent: null };
  }
  function stopClock() {
    if (!flow) return;
    if (flow.playingAt !== null) { flow.played += (now() - flow.playingAt) / 1000; flow.playingAt = null; }
    try { if (player) flow.rate = player.getPlaybackRate() || flow.rate; } catch (_) { /* not ready */ }
  }
  function destroyPlayer() {
    stopClock(); playerTicket++; playerReady = false; seeking = false; playing = false;
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (player) { try { player.destroy(); } catch (_) { /* not ready */ } player = null; }
  }
  function leave() {
    const previous = flow;
    destroyPlayer(); flow = null; immersive(false);
    if (previous && sdk && sid && !preview) {
      const gen = generation, ref = sdk.doc(sdk.db, 'students', sid);
      clearWatching(ref, gen);
    }
  }
  function enqueueWrite(fn) {
    const pending = writesSerial.catch(() => {}).then(fn);
    writesSerial = pending;
    return pending;
  }
  function clearWatching(ref, gen) {
    // A clear from the previous player must settle before the next start writes its gid.
    return enqueueWrite(() => {
      if (navigator.onLine === false) throw new Error('offline');
      // Transactions fail offline instead of leaving an update queued indefinitely.
      return sdk.runTransaction(sdk.db, async tx => {
        await tx.get(ref);
        tx.update(ref, { watchingGid: null });
      });
    }).catch(() => {
      if (gen === generation && !flow && !error) fail(() => {
        if (gen === generation && !flow) clearWatching(ref, gen).then(() => notify());
        else notify();
      });
    });
  }
  function eventRef() { return sdk.doc(sdk.collection(sdk.db, 'students', sid, 'events')); }
  async function persist(event, summary) {
    if (navigator.onLine === false) throw new Error('offline');
    if (preview) {
      preview.events.push(event); events = preview.events;
      return;
    }
    const s = sdk, ref = s.doc(s.db, 'students', sid, 'events', event.id), student = s.doc(s.db, 'students', sid);
    const studentId = sid, gen = generation;
    const { id, ...data } = event;
    // Stable event ID + transaction: a retry after a lost acknowledgement never duplicates a report.
    await enqueueWrite(() => s.runTransaction(s.db, async tx => {
      if (gen !== generation) throw new Error('stale session');
      const ss = await tx.get(student);
      const existing = await tx.get(ref);
      const group = await tx.get(s.doc(s.db, 'students', studentId, 'groups', event.groupId));
      if (!ss.exists() || ss.data().version !== 5 || !group.exists() || group.data().status !== 'assigned') throw new Error('summary/group unavailable');
      if (existing.exists()) {
        if (event.type === 'start') tx.update(student, summary(s));
        return;
      }
      const next = VideoLogic.reportSummary(ss.data(), event);
      if (gen !== generation) throw new Error('stale session');
      tx.set(ref, { ...data, at: s.serverTimestamp() });
      tx.update(student, { ...summary(s), activeGroups: next.activeGroups, understoodGids: next.understoodGids,
        pendingAsks: next.pendingAsks, viewing: next.viewing, askCount: next.askCount, doneCount: next.doneCount });
    }));
  }
  async function open(group, item) {
    // Re-read current progress: an old DOM callback must not bypass the lock.
    const latest = state().groups.find(g => g.id === group.id);
    const target = latest && VideoLogic.itemAccess(latest).find(i => i.gid === item.gid);
    if (busy || latest?.status !== 'assigned' || !target || target.access === 'locked') return;
    group = latest; item = target;
    leave(); error = ''; flow = newFlow(group, item);
    flow.startId = preview ? 'preview-start-' + Date.now() : eventRef().id;
    await start(flow);
  }
  async function start(f) {
    const gen = generation;
    busy = true; notify();
    try {
      await persist({ id: f.startId, gid: f.item.gid, groupId: f.group.id, type: 'start', by: 'student', at: Date.now() },
        s => ({ watchingGid: f.item.gid, watchingLabel: label(f.item).slice(0, 80), watchingAt: s.serverTimestamp() }));
      if (gen !== generation || flow !== f) {
        // leave() already queued the clear after this start and before any later start.
        return;
      }
    } catch (_) { if (gen === generation && flow === f) fail(() => retryFlow(f, () => start(f))); }
    finally { if (gen === generation) { busy = false; notify(); } }
  }
  function retryFlow(f, action) {
    if (!groups.some(g => g.id === f.group.id && g.status === 'assigned' && g.items.some(i => i.gid === f.item.gid))) {
      load(token); return;
    }
    // Returning from another tab must keep the failed operation and its stable event ID.
    if (!flow) flow = f;
    return action();
  }
  async function report(result) {
    if (busy || !flow) return;
    const f = flow, gen = generation;
    if (f.reportEvent && f.reportEvent.result !== result) {
      error = '上次回報尚未確認，請先重試原本的回報。'; notify(); return;
    }
    if (!f.reportEvent) f.reportEvent = {
      id: preview ? 'preview-report-' + Date.now() : eventRef().id,
      gid: f.item.gid, groupId: f.group.id, type: 'report', by: 'student', at: Date.now(), result,
      spentSec: Math.min(86400, Math.max(0, Math.round((now() - f.opened) / 1000))),
      playedSec: Math.min(86400, Math.max(0, Math.round(f.played))), rate: Math.min(4, Math.max(0.25, f.rate)),
    };
    busy = true; error = ''; notify();
    try {
      await persist(f.reportEvent, s => ({ watchingGid: null, lastEventAt: s.serverTimestamp() }));
      if (gen !== generation || flow !== f) return;
      if (!events.some(e => e.id === f.reportEvent.id && e.at)) overlay.set(f.reportEvent.id, f.reportEvent);
      const nextState = state();
      const original = nextState.groups.find(g => g.id === f.group.id);
      const group = result === 'again' ? original : nextState.current;
      flow = null; busy = false;
      if (result === 'again') { await open(group, f.item); return; }
      const next = group && group.status === 'assigned' && group.items.find(i => !i.done);
      if (next) { await open(group, next); return; }
      notify();
    } catch (_) { if (gen === generation && flow === f) fail(() => retryFlow(f, () => report(result))); }
    finally { if (gen === generation) { busy = false; notify(); } }
  }
  function youtube() {
    if (window.YT && YT.Player) return Promise.resolve();
    if (!ytPromise) ytPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      const timer = setTimeout(() => { ytPromise = null; reject(new Error('youtube timeout')); }, 15000);
      window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); if (previous) previous(); resolve(); };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => { clearTimeout(timer); script.remove(); ytPromise = null; reject(new Error('youtube')); };
      document.head.append(script);
    });
    return ytPromise;
  }
  async function mountPlayer() {
    const f = flow, ticket = ++playerTicket, target = host.querySelector('.video-player');
    if (!target || player) return;
    if (preview) {
      target.append(el('div', { class: 'video-placeholder', text: '虛構播放器預覽・不連 YouTube' })); return;
    }
    try {
      await youtube();
      if (ticket !== playerTicket || flow !== f || !target.isConnected) return;
      // 裁切框剛好是 16:9 的影片大小；裡面的播放器上下各多出一段，
      // YouTube 暫停時的標題、分享、「更多影片」都在多出來的那段，被裁掉看不到。
      const clip = el('div', { class: 'video-clip' }), mount = el('div');
      clip.append(mount); target.append(clip); fitClip();
      player = new YT.Player(mount, {
        videoId: f.item.youtubeId, width: '100%', height: '100%',
        // 控制列用自己的：YouTube 的按鈕、標題與相關影片都不顯示，學生也點不出去。
        playerVars: { playsinline: 1, rel: 0, controls: 0, fs: 0, disablekb: 1, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => {
            if (flow !== f) return;
            playerReady = true;
            const start = host.querySelector('.video-start');
            if (start) start.textContent = '▶ 播放';
            if (!ticker) ticker = setInterval(tick, 250);
            tick();
          },
          onStateChange: e => {
            if (flow !== f) return;
            stopClock();
            if (e.data === YT.PlayerState.PLAYING) f.playingAt = now();
            if (e.data === YT.PlayerState.PLAYING) setPlaying(true);
            else if (e.data === YT.PlayerState.ENDED) {
              f.atEnd = true; setPlaying(false);
              try { e.target.seekTo(Math.max(0, duration() - 0.5), true); e.target.pauseVideo(); } catch (_) { /* not ready */ }
              return;
            }
            else if (e.data !== YT.PlayerState.BUFFERING) setPlaying(false);
          },
          onPlaybackRateChange: e => { if (flow === f) { f.rate = e.data; showRate(e.data); } },
          onError: () => { if (flow === f) { destroyPlayer(); fail(() => { render(); }); } },
        },
      });
    } catch (_) { if (flow === f) fail(() => { render(); }); }
  }
  return { init, load, reset, signOut, hasTab, section, homeCard, afterRender, leave };
})();
