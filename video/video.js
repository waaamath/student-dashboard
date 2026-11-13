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
  let token, sid, groups = [], events = [], overlay = new Map(), catalogs = new Map();
  let unsubs = [], eventUnsub, eventKey = '', status = 'idle', error = '', retryAction;
  let host, flow = null, player, playerTicket = 0, busy = false, readyEvents = false;
  let preview = null, ytPromise;

  function init(o) {
    opts = o;
    window.addEventListener('pagehide', () => leave());
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
    return VideoLogic.derive(VideoLogic.recentGroups(groups), [...merged.values()]);
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
    if (eventUnsub) eventUnsub();
    eventUnsub = null; eventKey = ''; readyEvents = false;
    token = null; sid = null; groups = []; events = []; overlay = new Map(); catalogs = new Map();
    flow = null; if (host) host.replaceChildren(); busy = false; status = 'idle'; error = ''; retryAction = null; preview = null;
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
      unsubs.push(s.onSnapshot(s.query(s.collection(s.db, 'students', sid, 'groups'), s.orderBy('seq')), snap => {
        if (gen !== generation) return;
        groups = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        if (flow && !groups.some(g => g.id === flow.group.id && g.status === 'assigned' && g.items.some(i => i.gid === flow.item.gid))) leave();
        const ids = VideoLogic.recentGroups(groups).map(g => g.id);
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
    return el('ul', { class: 'video-list' }, group.items.map((i, n) => el('li', null,
      button(`${n + 1}. ${label(i)}${d.pending.some(e => e.gid === i.gid) ? '・待問老師' : i.done ? '・已完成' : ''}`, () => open(group, i)),
      el('small', { text: place(i) }))));
  }
  function render() {
    if (!host) return;
    // Keep an active iframe in place when unrelated dashboard updates arrive.
    if (flow && flow.page === 'play' && host.querySelector('.video-player') && (player || (preview && host.querySelector('.video-placeholder'))) && !error) return;
    const nodes = [];
    if (error) {
      nodes.push(el('div', { class: 'video-error', role: 'alert' }, el('p', { text: error }), button('再試一次', () => {
        if (busy) return;
        error = ''; const retry = retryAction; retryAction = null;
        if (retry) retry();
      })));
      host.replaceChildren(...nodes);
      return;
    }
    if (status !== 'ready') {
      if (!error) nodes.push(el('p', { text: '正在讀取影片任務…' }));
    } else if (flow) {
      nodes.push(button('返回影片任務', () => { leave(); notify(); }));
      nodes.push(el('p', { class: 'video-eyebrow', text: `第 ${flow.group.seq} 組・本組第 ${flow.group.items.findIndex(i => i.gid === flow.item.gid) + 1} 個` }),
        el('h2', { text: label(flow.item) }), el('p', { text: place(flow.item) }));
      if (flow.page === 'report') {
        nodes.push(el('h3', { text: '這次看得怎麼樣？' }), el('div', { class: 'video-reports' },
          button('看懂了', () => report('ok'), true), button('再看一次', () => report('again')), button('還是不懂', () => report('ask'))));
      } else {
        nodes.push(el('div', { class: 'video-player', 'aria-label': '影片播放器' }),
          button('我看完了', () => {
            stopClock(); destroyPlayer(); flow.page = 'report'; notify();
          }, true));
      }
    } else {
      const d = state(), g = d.current || d.lastCompleted;
      if (!groups.length) nodes.push(el('h2', { text: '目前沒有影片任務' }));
      else if (!d.current) nodes.push(el('h2', { text: g ? '這組完成了，等老師安排下一組' : '等待老師安排' }));
      if (g) {
        nodes.push(el('p', { class: 'video-progress', text: `第 ${g.seq} 組・${g.doneCount}/${g.items.length}` }));
        if (d.current) nodes.push(button('繼續', () => open(g, g.items.find(i => !i.done)), true));
        nodes.push(list(g, d));
      }
      nodes.push(el('h3', { text: `待問老師（${d.askCount}）` }),
        ...d.pending.map(e => {
          const g = d.groups.find(g => g.id === e.groupId), item = g.items.find(i => i.gid === e.gid);
          return g.status === 'assigned' ? button(`${label(item)}・${place(item)}`, () => open(g, item)) : el('p', { text: `${label(item)}・待問老師（任務已收回）` });
        }));
      if (groups.length > 30) nodes.push(el('p', { class: 'video-muted', text: '此頁進度與待問清單顯示最近 30 組。' }));
    }
    host.replaceChildren(...nodes);
    if (flow && flow.page === 'play' && !error && !busy) mountPlayer();
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
    stopClock(); playerTicket++;
    if (player) { try { player.destroy(); } catch (_) { /* not ready */ } player = null; }
  }
  function leave() {
    const previous = flow;
    destroyPlayer(); flow = null;
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
    const { id, ...data } = event;
    // Stable event ID + transaction: a retry after a lost acknowledgement never duplicates a report.
    await enqueueWrite(() => s.runTransaction(s.db, async tx => {
      const existing = await tx.get(ref);
      if (existing.exists()) {
        if (event.type === 'start') tx.update(student, summary(s));
        return;
      }
      tx.set(ref, { ...data, at: s.serverTimestamp() });
      tx.update(student, summary(s));
    }));
  }
  async function open(group, item) {
    if (busy || group.status !== 'assigned') return;
    leave(); error = ''; flow = newFlow(group, item);
    flow.startId = preview ? 'preview-start-' + Date.now() : eventRef().id;
    await start(flow);
  }
  async function start(f) {
    const gen = generation;
    busy = true; notify();
    try {
      await persist({ id: f.startId, gid: f.item.gid, groupId: f.group.id, type: 'start', by: 'student', at: Date.now() },
        s => ({ watchingGid: f.item.gid, watchingAt: s.serverTimestamp() }));
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
      const d = state(f.reportEvent);
      await persist(f.reportEvent, s => ({ watchingGid: null, doneCount: Math.min(1000, d.doneCount), askCount: Math.min(1000, d.askCount), lastEventAt: s.serverTimestamp() }));
      if (gen !== generation || flow !== f) return;
      if (!events.some(e => e.id === f.reportEvent.id && e.at)) overlay.set(f.reportEvent.id, f.reportEvent);
      const nextState = state();
      const group = nextState.groups.find(g => g.id === f.group.id);
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
      const mount = el('div'); target.append(mount);
      player = new YT.Player(mount, {
        videoId: f.item.youtubeId, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: e => { e.target.getIframe().setAttribute('allowfullscreen', ''); },
          onStateChange: e => {
            if (flow !== f) return;
            stopClock();
            if (e.data === YT.PlayerState.PLAYING) f.playingAt = now();
          },
          onPlaybackRateChange: e => { if (flow === f) f.rate = e.data; },
          onError: () => { if (flow === f) { destroyPlayer(); fail(() => { render(); }); } },
        },
      });
    } catch (_) { if (flow === f) fail(() => { render(); }); }
  }
  return { init, load, reset, signOut, hasTab, section, homeCard, afterRender, leave };
})();
