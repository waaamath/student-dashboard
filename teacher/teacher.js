/* Teacher video assignments. Personal roster data stays in this session's memory. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../video/logic.js'));
  else {
    root.TeacherVideo = factory(root.VideoLogic);
    if (root.document.getElementById('teacher-app')) root.TeacherVideo.create().init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (logic) {
  'use strict';
  const CLIENT_ID = '863861496583-i8ttdlflo03fscvcbvdc3hibqds4v7rn.apps.googleusercontent.com';
  const API_URL = 'https://script.google.com/macros/s/AKfycbxvwBJFQMB-fsjs4Nbw1HhQVZVgcFqIWjOTiYAt04A-rviphe3xK7MmKCwluvJ8pAkv/exec';
  const CONFIG = { apiKey: 'AIzaSyDLKj9cZ0ZM4kKlR2IUtodVnEOzsKiKB5o', authDomain: 'student-dashboard-513701.firebaseapp.com',
    projectId: 'student-dashboard-513701', appId: '1:863861496583:web:67cafde64a8351b7ca83a2' };
  async function firebase() {
    const [a, b, c] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
    ]);
    const app = a.getApps().find(x => x.name === 'teacher-video') || a.initializeApp(CONFIG, 'teacher-video');
    const auth = b.getAuth(app);
    // Firebase must not persist the Google account's display name/email on this page.
    await b.setPersistence(auth, b.inMemoryPersistence);
    return { ...b, ...c, auth, db: c.getFirestore(app) };
  }
  async function api(token, action) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ idToken: token, action }), signal: ctrl.signal });
      if (!r.ok) throw new Error('network');
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  function subFromToken(token) {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const sub = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))).sub;
    if (typeof sub !== 'string' || !sub) throw new Error('identity');
    return sub;
  }
  function create(options = {}) {
    const win = options.window || window, doc = options.document || document;
    const host = options.host || doc.getElementById('teacher-app');
    const el = options.el || ((tag, props, ...children) => {
      const n = doc.createElement(tag);
      Object.entries(props || {}).forEach(([k, v]) => {
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') n.textContent = v;
        else if (k === 'on') Object.entries(v).forEach(([name, fn]) => n.addEventListener(name, fn));
        else n.setAttribute(k, v === true ? '' : v);
      });
      children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false).forEach(x => n.append(x));
      return n;
    });
    let sdk, sdkPromise, authSerial = Promise.resolve(), generation = 0, unsubs = [], watchSerial = 0;
    let token, roster = [], selected = null, records = new Map(), catalogs = new Map(), catalogLoads = new Map(), chapters = [], chapterKey = '';
    let dragFrom = null, renderQueued = false;
    let draft = [], pendingAssign = null, resolves = new Map(), busy = false, ready = false, message = '', error = '', retry;
    let detailStops = [], detailTicket = 0, detailRefresh, checked = new Set(), unlocked = new Set(), templates = [], modal = null;
    let filter = 'today', classFilter = '', today = [], scheduleReason = '', batch = null, previewMode = false;
    let editing = null, pendingEdit = null, insertBefore = null, showRecalled = false;
    let historyMore, expandEvents, thumbObserver, thumbNodes = [], thumbCache = new Map(), thumbPopup = null;
    const rows = snap => snap.docs.map(d => ({ ...d.data(), id: d.id }));
    const rec = () => records.get(selected);
    const state = r => logic.derive(r.groups, r.events, r.summary);
    const multiple = () => checked.size >= 2;
    const marksFor = (r, gid) => ({ understood: (r.summary.understoodGids || []).includes(gid),
      pending: !!r.summary.pendingAsks?.[gid], assigned: (r.summary.activeGroups || []).some(g => g.gids.includes(gid)) });
    const metadata = i => catalogs.get(`${i.book}_${i.chapter}`)?.items.find(x => x.gid === i.gid);
    const label = i => metadata(i)?.label || '積木 ' + i.gid;
    const place = i => `${logic.bookLabel(i.book)}・第 ${i.chapter} 章`;
    const button = (text, click, props = {}) => el('button', { type: 'button', text, disabled: busy, on: { click }, ...props });
    const studentRef = sid => sdk.doc(sdk.db, 'students', sid);
    const collectionRef = (sid, name) => sdk.collection(sdk.db, 'students', sid, name);
    const live = gen => { if (gen !== generation) throw new Error('stale session'); };
    const confirm = text => (options.confirm || win.confirm.bind(win))(text);
    const dirty = () => editing ? JSON.stringify(draft.map(i => i.gid)) !== editing.key : draft.length > 0;
    function discard() { return !dirty() || confirm('有尚未儲存的修改，確定放棄並切換？'); }
    function clearEditor() { editing = null; pendingEdit = null; insertBefore = null; draft = []; }
    function closeThumb() { thumbPopup?.remove?.(); thumbPopup = null; }
    function showThumb(box, data, pinned = false, gid = null) {
      if (!data || thumbPopup?.pinned && !pinned) return;
      closeThumb();
      const popup = el('div', { class: 'thumb-popup', role: 'dialog', 'aria-label': '積木預覽', on: {
        mouseleave: () => { if (!popup.pinned) closeThumb(); } } },
        el('img', { src: data.url, alt: '積木題目放大圖', width: data.w, height: data.h }),
        pinned ? button('關閉預覽（Esc）', closeThumb, { disabled: false }) : null);
      // A pinned layer lives outside the app root, so it survives re-renders until Esc or an outside click.
      popup.pinned = pinned; popup.gid = gid;
      const rect = box.getBoundingClientRect?.();
      if (rect && popup.style) {
        // Estimate: 8px padding each side, borders, plus the pinned close button row.
        const width = Math.min(data.w + 18, win.innerWidth - 32), height = Math.min(data.h * Math.min(1, (width - 18) / data.w) + (pinned ? 66 : 20), win.innerHeight - 32);
        // Prefer the side away from this row's checkbox. Hover layers pass clicks through.
        let left = rect.left >= width + 24 ? rect.left - width - 12 : rect.right + 12;
        left = Math.max(16, Math.min(left, win.innerWidth - width - 16));
        let top = Math.max(16, Math.min(rect.top, win.innerHeight - height - 16));
        if (left < rect.right && left + width > rect.left) top = rect.bottom + height + 16 <= win.innerHeight ? rect.bottom + 8 : Math.max(16, rect.top - height - 8);
        Object.assign(popup.style, { left: left + 'px', top: top + 'px', width: width + 'px' });
      }
      if (pinned) popup.classList?.add('is-pinned');
      doc.body?.append(popup); thumbPopup = popup;
    }
    function thumbnail(item) {
      let data = null;
      const box = el('button', { type: 'button', class: 'thumb-slot', 'aria-label': `預覽 ${label(item)}`, on: {
        mouseenter: () => showThumb(box, data), mouseleave: () => { if (!thumbPopup?.pinned) closeThumb(); },
        focus: () => showThumb(box, data), blur: () => { if (!thumbPopup?.pinned) closeThumb(); },
        click: e => { e?.stopPropagation?.(); if (thumbPopup?.pinned && thumbPopup.gid === item.gid) closeThumb(); else showThumb(box, data, true, item.gid); } } });
      box.loadThumb = async () => {
        if (!thumbCache.has(item.gid)) {
          const gen = generation;
          thumbCache.set(item.gid, (async () => {
            try {
              const d = options.thumbnail ? await options.thumbnail(item.gid) : previewMode ? null : await sdk.getDocFromServer(sdk.doc(sdk.db, 'thumbs', String(item.gid)));
              const value = d?.exists ? d.exists() && d.data() : d;
              if (!value || gen !== generation) return null;
              const bytes = value.image?.toUint8Array ? value.image.toUint8Array() : value.image;
              if (!bytes || !value.w || !value.h) return null;
              const url = win.URL.createObjectURL(new win.Blob([bytes], { type: 'image/webp' }));
              return { url, w: value.w, h: value.h };
            } catch (_) { return null; }
          })());
        }
        data = await thumbCache.get(item.gid);
        if (!data) { box.hidden = true; return; }
        const image = el('img', { src: data.url, alt: '', width: data.w, height: data.h, on: { error: () => { box.hidden = true; } } });
        box.replaceChildren(image); box.classList?.add('is-loaded');
      };
      thumbNodes.push(box); return box;
    }
    function observeThumbs() {
      thumbObserver?.disconnect();
      if (!win.IntersectionObserver) return; // Keep text-only when lazy observation is unavailable.
      thumbObserver = new win.IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting) { thumbObserver.unobserve(entry.target); entry.target.loadThumb(); }
      }), { threshold: 0.01 });
      thumbNodes.forEach(n => thumbObserver.observe(n));
    }
    function stopDetails() { detailTicket++; detailStops.forEach(f => f()); detailStops = []; detailRefresh = null; }
    function stopListeners() { watchSerial++; unsubs.forEach(f => f()); unsubs = []; stopDetails(); }
    function reset() {
      thumbObserver?.disconnect(); closeThumb();
      thumbCache.forEach(p => p.then(d => { if (d?.url) win.URL.revokeObjectURL(d.url); })); thumbCache.clear(); thumbNodes = [];
      clearEditor(); historyMore = null; expandEvents = null; showRecalled = false;
      generation++; stopListeners(); token = null; roster = []; selected = null; records = new Map();
      catalogs = new Map(); catalogLoads = new Map(); chapters = []; chapterKey = ''; draft = []; resolves = new Map(); pendingAssign = null;
      ready = false; busy = false; message = ''; error = ''; retry = null;
      checked.clear(); unlocked.clear(); templates = []; modal = null; batch = null; filter = 'today'; today = []; scheduleReason = ''; previewMode = false;
    }
    function fail(action, text = '暫時無法讀寫影片任務，請檢查網路後再試一次。') {
      error = text; retry = action; render();
    }
    async function signOut() {
      if (dirty() && !confirm('有尚未儲存的修改，確定登出？')) return;
      reset(); render();
      win.google?.accounts.id.disableAutoSelect();
      authSerial = authSerial.catch(() => {}).then(async () => { if (sdk) await sdk.signOut(sdk.auth); });
      try { await authSerial; } catch (_) { fail(signOut, '登出尚未完成，請再試一次。'); }
    }
    async function load(idToken) {
      reset(); token = idToken; message = '正在確認老師身分…'; render();
      const gen = generation;
      try {
        const res = await (options.api || api)(idToken);
        if (gen !== generation) return;
        if (!res.ok) throw new Error('api');
        if (res.role !== 'teacher') {
          // An already-loaded teacher session must also be signed out on account change.
          authSerial = authSerial.catch(() => {}).then(async () => { if (sdk) await sdk.signOut(sdk.auth); });
          await authSerial;
          if (gen === generation) { message = '這個頁面只給老師使用'; render(); }
          return;
        }
        roster = res.students.filter(s => typeof s.videoId === 'string' && s.videoId && !s.videoId.includes('/'))
          .map(s => ({ name: s.name, className: s.className, videoId: s.videoId }));
        authSerial = authSerial.catch(() => {}).then(async () => {
          live(gen);
          if (!sdkPromise) sdkPromise = (options.firebase || firebase)().catch(e => { sdkPromise = null; throw e; });
          sdk = await sdkPromise; live(gen);
          await sdk.auth.authStateReady(); live(gen);
          const sub = (options.subFromToken || subFromToken)(idToken);
          if (sdk.auth.currentUser) {
            const r = await sdk.auth.currentUser.getIdTokenResult(); live(gen);
            if (r.claims.firebase?.identities?.['google.com']?.[0] !== sub) await sdk.signOut(sdk.auth);
          }
          live(gen);
          await sdk.signInWithCredential(sdk.auth, sdk.GoogleAuthProvider.credential(idToken)); live(gen);
          const access = await sdk.getDocFromServer(sdk.doc(sdk.db, 'access', sub)); live(gen);
          if (!access.exists() || access.data().teacher !== true) throw new Error('access');
        });
        await authSerial; live(gen);
        const index = await sdk.getDocFromServer(sdk.doc(sdk.db, 'catalog', '_index')); live(gen);
        if (!index.exists() || !Array.isArray(index.data().chapters)) throw new Error('catalog');
        chapters = index.data().chapters;
        ready = true; message = ''; watchStudents(); render();
        (options.api || api)(idToken, 'video.today').then(result => {
          if (gen !== generation) return;
          today = Array.isArray(result.videoIds) ? result.videoIds : [];
          scheduleReason = result.reason || (!result.ok ? 'unavailable' : ''); render();
        }).catch(() => { if (gen === generation) { scheduleReason = 'unavailable'; render(); } });
        if (chapters.length) await chooseChapter(chapters[0].id);
      } catch (_) { if (gen === generation) fail(() => load(idToken), '目前無法使用影片指派，請再試一次。'); }
    }
    async function ensureCatalogs(items, gen = generation) {
      const keys = [...new Set(items.map(i => `${i.book}_${i.chapter}`))];
      await Promise.all(keys.map(async key => {
        if (catalogs.has(key)) return;
        if (!catalogLoads.has(key)) catalogLoads.set(key, (async () => {
          const d = await sdk.getDocFromServer(sdk.doc(sdk.db, 'catalog', key)); live(gen);
          if (!d.exists()) throw new Error('catalog');
          catalogs.set(key, d.data());
        })().catch(e => { if (gen === generation) catalogLoads.delete(key); throw e; }));
        await catalogLoads.get(key);
      }));
    }
    function watchStudents() {
      stopListeners();
      const gen = generation, watch = watchSerial;
      const valid = () => gen === generation && watch === watchSerial;
      unsubs.push(sdk.onSnapshot(sdk.collection(sdk.db, 'templates'), snap => { if (valid()) { templates = rows(snap); render(); } },
        () => { if (valid()) fail(() => watchStudents()); }));
      roster.forEach(st => {
        const old = records.get(st.videoId);
        const r = { ...st, summary: {}, groups: old?.groups || [], events: old?.events || [], loaded: new Set() }; records.set(st.videoId, r);
        const listen = (name, ref, update) => {
          unsubs.push(sdk.onSnapshot(ref, snap => {
            if (!valid()) return;
            update(snap); r.loaded.add(name); render();
          }, () => { if (valid()) fail(() => { watchStudents(); render(); }); }));
        };
        listen('summary', studentRef(st.videoId), s => { r.summary = s.exists() ? s.data() : {}; if (selected === st.videoId) detailRefresh?.(); });
      });
      if (selected && !multiple()) watchDetails(selected);
    }
    function watchDetails(sid) {
      stopDetails();
      if (previewMode || multiple()) return;
      const gen = generation, ticket = detailTicket, r = records.get(sid);
      const valid = () => gen === generation && ticket === detailTicket && selected === sid;
      let recent = [], local = [], asks = [], resolved = [], eventStop, autoLocated = false, cursor = null, exhausted = false, loadingHistory = false;
      let autoPages = 0, fillCompleted;
      const history = new Map(), expandedEvents = new Map(), expandedStops = new Map();
      r.expanded = new Set(); r.completedLimit = 3; r.historyExhausted = false;
      const extra = new Map(), stops = new Map();
      detailStops.push(() => { eventStop?.(); stops.forEach(f => f()); expandedStops.forEach(f => f()); });
      const update = async (fill = true) => {
        if (!valid()) return;
        r.groups = [...new Map([...history.values(), ...recent, ...extra.values()].map(g => [g.id, g])).values()];
        r.events = [...new Map([...local, ...asks, ...resolved, ...[...expandedEvents.values()].flat()].map(e => [e.id, e])).values()];
        const wanted = new Set([...(r.summary.activeGroups || []).map(g => g.id), r.summary.lastAssignedGroupId,
          ...Object.values(r.summary.pendingAsks || {}).map(a => a.groupId)].filter(id => id && !recent.some(g => g.id === id)));
        stops.forEach((f, id) => { if (!wanted.has(id)) { f(); stops.delete(id); extra.delete(id); } });
        wanted.forEach(id => {
          if (stops.has(id)) return;
          stops.set(id, sdk.onSnapshot(sdk.doc(collectionRef(sid, 'groups'), id), snap => {
            if (!valid()) return;
            if (snap.exists()) extra.set(id, { ...snap.data(), id });
            update();
          }, failure));
        });
        try {
          await ensureCatalogs(r.groups.flatMap(g => g.items), gen);
          if (!valid()) return;
          const last = r.groups.find(g => g.id === r.summary.lastAssignedGroupId);
          if (last && !autoLocated) {
            autoLocated = true; const i = last.items.at(-1);
            await chooseChapter(`${i.book}_${i.chapter}`);
            if (!valid()) return;
            doc.getElementById('section-' + metadata(i)?.section)?.scrollIntoView?.({ block: 'start' });
          }
          render();
          // Wait until the summary is known: completion status depends on activeGroups.
          if (fill && r.summary?.version === 5 && r.loaded.has('events') && !loadingHistory && cursor && !exhausted && autoPages < 5 && completedCount() < r.completedLimit) fillCompleted();
        } catch (_) { if (valid()) fail(() => watchDetails(sid)); }
      };
      const failure = () => { if (valid()) fail(() => watchDetails(sid)); };
      // Completed groups may all sit outside the newest ten. Page backwards (10 per read,
      // at most 5 pages per trigger) until the requested number of completed groups is shown.
      const completedCount = () => state(r).groups.filter(g => g.status === 'assigned' && g.complete).length;
      fillCompleted = async () => {
        if (!valid() || loadingHistory) return;
        loadingHistory = true;
        try {
          while (valid() && cursor && !exhausted && autoPages < 5 && completedCount() < r.completedLimit) {
            autoPages++;
            const snap = await sdk.getDocsFromServer(sdk.query(collectionRef(sid, 'groups'), sdk.orderBy('seq', 'desc'), sdk.startAfter(cursor), sdk.limit(10)));
            if (!valid()) return;
            rows(snap).forEach(g => history.set(g.id, g)); cursor = snap.docs.at(-1) || cursor;
            exhausted = snap.docs.length < 10; r.historyExhausted = exhausted;
            r.groups = [...new Map([...history.values(), ...recent, ...extra.values()].map(g => [g.id, g])).values()];
          }
        } catch (_) { if (valid()) { loadingHistory = false; fail(() => { autoPages = 0; return fillCompleted(); }); return; } }
        finally { loadingHistory = false; }
        if (valid()) await update(false);
      };
      historyMore = async () => {
        if (!valid() || loadingHistory) return;
        r.completedLimit += 10; autoPages = 0;
        if (exhausted || !cursor || completedCount() >= r.completedLimit) { render(); return; }
        await fillCompleted();
      };
      expandEvents = group => {
        if (!valid() || expandedStops.has(group.id)) return;
        if (recent.some(g => g.id === group.id)) return; // Already in the ten-group events listener.
        expandedStops.set(group.id, sdk.onSnapshot(sdk.query(collectionRef(sid, 'events'), sdk.where('groupId', '==', group.id)), es => {
          if (!valid()) return;
          expandedEvents.set(group.id, rows(es)); update();
        }, failure));
        // Older pages are fetched on demand; watch an expanded document for edits/recall.
        if (!recent.some(g => g.id === group.id) && !extra.has(group.id)) {
          detailStops.push(sdk.onSnapshot(sdk.doc(collectionRef(sid, 'groups'), group.id), s => {
            if (!valid()) return;
            if (s.exists()) history.set(group.id, { ...s.data(), id: group.id }); else history.delete(group.id);
            update();
          }, failure));
        }
      };
      // Summary changes may add an old active/pending group outside the history window.
      detailRefresh = update;
      for (const [kind, filters] of [['ask', [sdk.where('type', '==', 'report'), sdk.where('result', '==', 'ask')]], ['resolve', [sdk.where('type', '==', 'resolve')]]]) {
        detailStops.push(sdk.onSnapshot(sdk.query(collectionRef(sid, 'events'), ...filters), snap => {
          if (!valid()) return;
          if (kind === 'ask') asks = rows(snap); else resolved = rows(snap); update();
        }, failure));
      }
      detailStops.push(sdk.onSnapshot(sdk.query(collectionRef(sid, 'groups'), sdk.orderBy('seq', 'desc'), sdk.limit(10)), snap => {
        if (!valid()) return;
        recent = rows(snap); r.loaded.add('groups'); eventStop?.(); local = [];
        if (!history.size) { cursor = snap.docs.at(-1); exhausted = snap.docs.length < 10; r.historyExhausted = exhausted; }
        const ids = recent.map(g => g.id);
        if (ids.length) eventStop = sdk.onSnapshot(sdk.query(collectionRef(sid, 'events'), sdk.where('groupId', 'in', ids)), es => {
          if (!valid()) return;
          local = rows(es); r.loaded.add('events'); update();
        }, failure);
        else r.loaded.add('events');
        update();
      }, failure));
    }
    let chapterTicket = 0;
    async function chooseChapter(key) {
      const gen = generation, ticket = ++chapterTicket;
      chapterKey = key; render();
      const chapter = chapters.find(c => c.id === key);
      if (!chapter) return;
      try { await ensureCatalogs([chapter], gen); if (gen === generation && ticket === chapterTicket) render(); }
      catch (_) { if (gen === generation && ticket === chapterTicket) fail(() => chooseChapter(key)); }
    }
    function select(sid) {
      if (busy || pendingAssign || pendingEdit || batch || [...resolves.values()].some(o => !o.finished)) return;
      if (sid === selected) return;
      if (!discard()) return;
      selected = sid; clearEditor(); message = ''; checked.clear(); unlocked.clear(); watchDetails(sid); render();
    }
    function toggle(item, checked) {
      if (!selected || busy || pendingAssign || pendingEdit || batch) return;
      if (!editing && checked && !multiple() && marksFor(rec(), item.gid).understood && !unlocked.has(item.gid)) return;
      const locked = editing && editProgress().find(i => i.gid === item.gid)?.done;
      if (!checked && locked) { message = '已有回報紀錄，不能移除。'; render(); return; }
      if (checked && !draft.some(i => i.gid === item.gid)) {
        if (draft.length >= 50) { message = '一組最多 50 個積木。'; render(); return; }
        draft = logic.insertGroupItem(draft, item, insertBefore);
      } else if (!checked) draft = draft.filter(i => i.gid !== item.gid);
      render();
    }
    function move(index, delta) {
      if (busy || pendingAssign || pendingEdit || batch || !draft[index + delta]) return;
      const next = [...draft]; [next[index], next[index + delta]] = [next[index + delta], next[index]];
      if (!canEdit(next)) return;
      draft = next; render();
    }
    // 拖移排序：把第 from 張卡片放到第 target 張的上方或下方（after）。
    function moveTo(from, target, after = false) {
      if (busy || pendingAssign || pendingEdit || batch) return;
      if (!Number.isInteger(from) || !draft[from] || !draft[target]) return;
      let to = target + (after ? 1 : 0); if (from < to) to--;
      if (from === to) return;
      const next = [...draft], [item] = next.splice(from, 1); next.splice(to, 0, item);
      if (!canEdit(next)) return;
      draft = next; render();
    }
    const lowerHalf = (e, li) => { const r = li.getBoundingClientRect?.(); return !!r && e.clientY > r.top + r.height / 2; };
    function dropMark(li, after) {
      doc.querySelectorAll?.('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
      if (li) li.classList?.add(after ? 'drop-after' : 'drop-before');
    }
    function endDrag() {
      dropMark(null); dragFrom = null;
      if (renderQueued) { renderQueued = false; render(); }
    }
    async function transactionGroups(tx, sid) {
      // Web SDK transactions accept document refs, not queries. Read the summary first,
      // query on every attempt, then register each document as a transaction read.
      // Every assignment also writes that summary: a concurrent insert forces a retry.
      const snap = await sdk.getDocsFromServer(collectionRef(sid, 'groups'));
      return Promise.all(snap.docs.map(async d => {
        const s = await tx.get(sdk.doc(collectionRef(sid, 'groups'), d.id));
        if (!s.exists()) throw new Error('group disappeared');
        return { ...s.data(), id: d.id };
      }));
    }
    async function readSummary(tx, sid) {
      const snap = await tx.get(studentRef(sid));
      if (snap.exists() && snap.data().version === 5) return snap.data();
      // Only new students can be initialized here. Existing histories must be migrated offline.
      const groups = await transactionGroups(tx, sid);
      if (groups.length) throw new Error('migration required');
      return logic.summaryFrom([], [], snap.exists() ? snap.data() : { createdAt: sdk.serverTimestamp() });
    }
    function cancelDialog() {
      if (modal?.type === 'batch' && batch?.every(o => ['pending', 'skipped'].includes(o.result))) batch = null;
      modal = null; render();
      doc.getElementById('assign-button')?.focus?.();
    }
    function checkStudent(sid, value) {
      if (busy || pendingAssign || pendingEdit || batch) return;
      if (editing) { if (!discard()) return; clearEditor(); }
      if (value) checked.add(sid); else checked.delete(sid);
      if (!selected) selected = sid;
      if (checked.size === 1) { selected = [...checked][0]; unlocked.clear(); }
      if (multiple()) stopDetails(); else if (selected) watchDetails(selected);
      render();
    }
    async function assign(mode) {
      if (editing || busy || batch || !selected || !draft.length || draft.length > 50) return;
      if (!pendingAssign && multiple()) { await prepareBatch(); return; }
      if (!pendingAssign && !mode && logic.summaryStatus(rec().summary).current) {
        const current = logic.summaryStatus(rec().summary).current;
        modal = { type: 'assignment', currentId: current.id, remaining: current.gids.length - current.doneGids.length };
        render(); return;
      }
      if (!pendingAssign) pendingAssign = { sid: selected, items: draft.map(i => ({ ...i })),
        unlockedGids: [...unlocked],
        mode: mode || 'append', currentId: modal?.currentId || logic.summaryStatus(rec().summary).current?.id || null,
        ref: sdk.doc(collectionRef(selected, 'groups')) };
      const op = pendingAssign, gen = generation;
      modal = null;
      busy = true; error = ''; render();
      try {
        if (win.navigator.onLine === false) throw new Error('offline');
        const result = await writeAssignment(op, gen);
        if (gen !== generation) return;
        pendingAssign = null; draft = []; unlocked.clear(); message = `已指派第 ${result.seq} 組，共 ${result.items.length} 個積木。`;
      } catch (e) {
        if (gen !== generation) return;
        if (e.missingItem) {
          pendingAssign = null;
          message = `${place(e.missingItem)}・${label(e.missingItem)}（積木 ${e.missingItem.gid}）缺少影片，整組尚未指派。請移除這個積木，或補齊影片後再按指派。`;
        } else if (e.changed) { pendingAssign = null; message = '目前組或已懂狀態已變動，請重新確認指派方式與積木鎖定。'; }
        else fail(() => assign());
      } finally { if (gen === generation) { busy = false; render(); } }
    }
    async function writeAssignment(op, gen) {
      return sdk.runTransaction(sdk.db, async tx => {
          live(gen);
          const existing = await tx.get(op.ref);
          if (existing.exists()) return existing.data();
          let summary = await readSummary(tx, op.sid);
          const current = logic.summaryStatus(summary).current;
          if (op.mode !== 'append' && current?.id !== op.currentId) { const e = new Error('changed'); e.changed = true; throw e; }
          let oldRef, old;
          if (op.mode === 'replace' && current) {
            oldRef = sdk.doc(collectionRef(op.sid, 'groups'), current.id); old = await tx.get(oldRef);
            if (!old.exists() || old.data().status !== 'assigned') throw new Error('group missing');
          }
          // Recheck multi-person skip decisions under the summary lock. If a report changed
          // the confirmation list, show a fresh list before writing that student's group.
          if (op.batch && JSON.stringify(summary.understoodGids) !== op.understoodKey) {
            const e = new Error('understanding changed'); e.changed = true; throw e;
          }
          if (!op.batch && op.items.some(i => summary.understoodGids.includes(i.gid) && !op.unlockedGids.includes(i.gid))) {
            const e = new Error('understanding changed'); e.changed = true; throw e;
          }
          const maps = new Map();
          for (const item of op.items) {
            const key = `${item.book}_${item.chapter}`;
            if (!maps.has(key)) {
              const d = await tx.get(sdk.doc(sdk.db, 'videos', key));
              maps.set(key, d.exists() ? d.data().map || {} : {});
            }
          }
          const items = op.items.map(i => {
            const youtubeId = maps.get(`${i.book}_${i.chapter}`)[String(i.gid)];
            if (typeof youtubeId !== 'string' || !youtubeId.trim()) {
              const e = new Error('missing video'); e.missingItem = i; throw e;
            }
            return { gid: i.gid, youtubeId: youtubeId.trim(), book: i.book, chapter: i.chapter };
          });
          live(gen);
          const group = { seq: logic.assignmentSeq(summary, op.mode), status: 'assigned', items,
            gids: items.map(i => i.gid), createdAt: sdk.serverTimestamp() };
          if (oldRef) {
            tx.update(oldRef, { status: 'recalled' });
            summary = { ...summary, activeGroups: summary.activeGroups.filter(g => g.id !== current.id),
              doneCount: Math.max(0, summary.doneCount - current.doneGids.length) };
          }
          tx.set(studentRef(op.sid), logic.assignedSummary(summary, { ...group, id: op.ref.id }));
          tx.set(op.ref, group); return group;
        });
    }
    async function prepareBatch() {
      if (busy || batch) return;
      const gen = generation; busy = true; render();
      try {
        const targets = await Promise.all([...checked].map(async sid => {
          const snap = previewMode ? { exists: () => true, data: () => records.get(sid).summary } : await sdk.getDocFromServer(studentRef(sid));
          live(gen); if (snap.exists() && snap.data().version !== 5) throw new Error('summary not ready');
          return { sid, name: records.get(sid).name, understoodGids: snap.exists() ? snap.data().understoodGids : [] };
        }));
        batch = logic.batchPlan(targets, draft).map(s => ({ ...s, mode: 'append', batch: true,
          understoodKey: JSON.stringify(s.understoodGids), ref: sdk.doc(collectionRef(s.sid, 'groups')), result: s.items.length ? 'pending' : 'skipped' }));
        modal = { type: 'batch' };
      } catch (_) { if (gen === generation) fail(prepareBatch); }
      finally { if (gen === generation) { busy = false; render(); } }
    }
    async function sendBatch() {
      if (busy || !batch) return;
      const gen = generation; modal = null; busy = true; render();
      for (const op of batch.filter(o => ['pending', 'failed'].includes(o.result))) {
        try {
          if (win.navigator.onLine === false) throw new Error('offline');
          await writeAssignment(op, gen); live(gen); op.result = 'success';
        } catch (e) { if (gen !== generation) return; op.result = 'failed'; op.changed = !!e.changed; }
      }
      if (gen !== generation) return;
      busy = false;
      message = batch.map(o => `${o.name}：${o.result === 'success' ? '成功' : o.result === 'skipped' ? '沒有剩餘積木，未建組' : '失敗'}`).join('；');
      if (batch.every(o => o.result !== 'failed')) { draft = []; batch = null; }
      render();
    }
    async function resolve(ask) {
      if (busy || !selected || rec()?.loaded.size !== 3) return;
      const key = selected + ':' + ask.id;
      let op = resolves.get(key);
      if (op?.finished) return;
      if (!op) { op = { sid: selected, ask, ref: sdk.doc(collectionRef(selected, 'events')) }; resolves.set(key, op); }
      const gen = generation;
      busy = true; error = ''; render();
      try {
        if (win.navigator.onLine === false) throw new Error('offline');
        await sdk.runTransaction(sdk.db, async tx => {
          live(gen);
          const summary = await tx.get(studentRef(op.sid)), existing = await tx.get(op.ref);
          if (existing.exists()) return;
          if (!summary.exists()) throw new Error('summary missing');
          const snap = await sdk.getDocsFromServer(sdk.query(collectionRef(op.sid, 'events'), sdk.where('gid', '==', ask.gid)));
          const events = await Promise.all(snap.docs.map(async d => {
            const s = await tx.get(sdk.doc(collectionRef(op.sid, 'events'), d.id));
            return { ...s.data(), id: d.id };
          }));
          // Do not accidentally close a newer question after a delayed retry.
          const s = summary.data();
          if (s.version !== 5 || s.pendingAsks[ask.gid]?.id !== ask.id) return;
          const latest = events.filter(e => e.type === 'resolve' || (e.type === 'report' && e.result !== 'again'))
            .sort((a, b) => logic.millis(b.at) - logic.millis(a.at) || b.id.localeCompare(a.id))[0];
          if (latest?.id !== ask.id) return;
          const event = { gid: ask.gid, groupId: ask.groupId, type: 'resolve', by: 'teacher' };
          live(gen);
          tx.set(op.ref, { ...event, at: sdk.serverTimestamp() });
          const pendingAsks = { ...s.pendingAsks }; delete pendingAsks[ask.gid];
          tx.update(studentRef(op.sid), { pendingAsks, askCount: Math.min(1000, Object.keys(pendingAsks).length) });
        });
        if (gen === generation) { op.finished = true; message = '已解決，學生待問清單會自動更新。'; }
      } catch (_) { if (gen === generation) fail(() => resolve(ask)); }
      finally { if (gen === generation) { busy = false; render(); } }
    }
    function editProgress() {
      if (!editing || !rec()) return [];
      const group = rec().groups.find(g => g.id === editing.id) || editing.group;
      return logic.groupEditProgress(group, rec().events, rec().summary);
    }
    function canEdit(items, announce = true) {
      if (!editing) return true;
      const result = logic.validateGroupEdit(editing.group, items, editProgress().filter(i => i.done).map(i => i.gid));
      if (!result.valid && announce) { message = result.gid ? `${label({ gid: result.gid })}已有回報紀錄，位置固定且不能移除。` : '一組須有 1～50 個不重複積木。'; render(); }
      return result.valid;
    }
    function beginEdit(group) {
      if (busy || pendingAssign || pendingEdit || batch || multiple() || group.status !== 'assigned') return;
      if (editing?.id === group.id || !discard()) return;
      group = rec().groups.find(g => g.id === group.id) || group;
      editing = { id: group.id, group, key: JSON.stringify(group.items.map(i => i.gid)) };
      draft = group.items.map(i => ({ ...metadata(i), ...i })); insertBefore = null;
      message = ''; expandEvents?.(group); render();
    }
    function endEdit() {
      if (busy || pendingEdit || !discard()) return;
      clearEditor(); render();
    }
    async function saveGroup() {
      if (busy || !editing || multiple()) return;
      // A retry reuses the fixed receipt first; the transaction revalidates the draft itself.
      if (!pendingEdit && !canEdit(draft)) return;
      if (!pendingEdit) {
        const progress = { ...editing.group, items: editProgress() };
        if (logic.reopensGroup(progress, draft) && !confirm('這組會變回未完成，學生需要回來補看。確定儲存？')) return;
        pendingEdit = { sid: selected, groupId: editing.id, items: draft.map(i => ({ ...i })),
          base: editing.group, receipt: sdk.doc(collectionRef(selected, 'groupEdits')) };
      }
      const op = pendingEdit, gen = generation; busy = true; error = ''; render();
      try {
        if (win.navigator.onLine === false) throw new Error('offline');
        await sdk.runTransaction(sdk.db, async tx => {
          live(gen);
          const receipt = await tx.get(op.receipt);
          if (receipt.exists()) return;
          const summary = await readSummary(tx, op.sid), ref = sdk.doc(collectionRef(op.sid, 'groups'), op.groupId), snap = await tx.get(ref);
          if (!snap.exists() || snap.data().status !== 'assigned') throw Object.assign(new Error('changed'), { changed: true });
          const group = { ...snap.data(), id: op.groupId };
          // Compare only group content. A concurrent report is checked below under
          // the summary lock, while another teacher's edit requires a fresh draft.
          if (JSON.stringify(group.items) !== JSON.stringify(op.base.items)) throw Object.assign(new Error('changed'), { changed: true });
          const seen = await sdk.getDocsFromServer(sdk.query(collectionRef(op.sid, 'events'), sdk.where('groupId', '==', op.groupId)));
          const events = await Promise.all(seen.docs.map(async d => {
            const e = await tx.get(sdk.doc(collectionRef(op.sid, 'events'), d.id));
            return { ...e.data(), id: d.id };
          }));
          const progress = logic.groupEditProgress(group, events, summary), done = progress.filter(i => i.done).map(i => i.gid);
          const check = logic.validateGroupEdit(group, op.items, done);
          if (!check.valid) throw Object.assign(new Error('reported'), { reportedGid: check.gid, changed: true });
          const maps = new Map();
          for (const i of op.items.filter(i => !group.items.some(old => old.gid === i.gid))) {
            const key = `${i.book}_${i.chapter}`;
            if (!maps.has(key)) { const s = await tx.get(sdk.doc(sdk.db, 'videos', key)); maps.set(key, s.exists() ? s.data().map || {} : {}); }
          }
          const items = op.items.map(i => {
            const old = group.items.find(old => old.gid === i.gid);
            const youtubeId = old?.youtubeId || maps.get(`${i.book}_${i.chapter}`)?.[i.gid];
            if (typeof youtubeId !== 'string' || !youtubeId.trim()) throw Object.assign(new Error('missing video'), { missingItem: i });
            return { gid: i.gid, youtubeId: youtubeId.trim(), book: i.book, chapter: i.chapter };
          });
          const active = summary.activeGroups.find(g => g.id === group.id);
          const next = logic.editedGroupSummary(summary, group, items, done, !!active?.started || events.length > 0);
          live(gen);
          tx.update(ref, { items, gids: items.map(i => i.gid) });
          tx.set(studentRef(op.sid), next);
          tx.set(op.receipt, { groupId: op.groupId, at: sdk.serverTimestamp() });
        });
        live(gen); clearEditor(); message = '這組已儲存，學生頁會即時更新。';
      } catch (e) {
        if (gen !== generation) return;
        if (e.changed) {
          pendingEdit = null;
          const latest = rec().groups.find(g => g.id === op.groupId);
          if (latest) editing.group = latest;
          message = e.reportedGid !== undefined ? `${label(op.items.find(i => i.gid === e.reportedGid) || op.base.items.find(i => i.gid === e.reportedGid))}剛被回報，請重新確認位置與移除操作。` : '這組已被修改或收回，請重新確認。';
        } else if (e.missingItem) { pendingEdit = null; message = `${place(e.missingItem)}・${label(e.missingItem)}缺少影片，整組未儲存。`; }
        else fail(saveGroup);
      } finally { if (gen === generation) { busy = false; render(); } }
    }
    async function changeGroup(group, action, index, delta) {
      if (action !== 'recall') {
        if (!editing) beginEdit(group);
        if (editing?.id !== group.id) return;
        if (action === 'move') move(index, delta);
        if (action === 'remove') toggle(draft[index], false);
        return;
      }
      if (busy || multiple() || pendingEdit || !confirm(`確定收回第 ${group.seq} 組？`)) return;
      const gen = generation, sid = selected; busy = true; render();
      try {
        if (win.navigator.onLine === false) throw new Error('offline');
        await sdk.runTransaction(sdk.db, async tx => {
          live(gen);
          const summary = await readSummary(tx, sid), ref = sdk.doc(collectionRef(sid, 'groups'), group.id), snap = await tx.get(ref);
          if (!snap.exists()) throw new Error('changed');
          if (snap.data().status === 'recalled') return;
          const active = summary.activeGroups.find(g => g.id === group.id);
          live(gen); tx.update(ref, { status: 'recalled' });
          tx.set(studentRef(sid), { ...summary, activeGroups: summary.activeGroups.filter(g => g.id !== group.id),
            doneCount: Math.max(0, summary.doneCount - (active ? active.doneGids.length : snap.data().items.length)) });
        });
        if (gen === generation) { if (editing?.id === group.id) clearEditor(); message = '任務組已收回。'; }
      } catch (_) { if (gen === generation) fail(() => changeGroup(group, 'recall')); }
      finally { if (gen === generation) { busy = false; render(); } }
    }
    function nameDialog(type, template) {
      modal = { type, template, name: template?.name || `第 ${metadata(draft[0])?.section || draft[0]?.section || 1} 節任務` }; render();
    }
    async function saveTemplate() {
      if (busy || !modal || !draft.length && modal.type === 'saveTemplate') return;
      const op = modal, gen = generation, name = op.name.trim();
      if (!name || name.length > 40) { message = '模板名稱需為 1～40 字。'; render(); return; }
      const first = draft[0], collection = sdk.collection(sdk.db, 'templates');
      const ref = op.ref || (op.ref = op.template ? sdk.doc(collection, op.template.id) : sdk.doc(collection));
      busy = true;
      try {
        await sdk.runTransaction(sdk.db, async tx => {
          const old = await tx.get(ref); live(gen);
          if (op.type === 'renameTemplate') {
            if (!old.exists()) throw new Error('missing');
            tx.update(ref, { name, updatedAt: sdk.serverTimestamp() });
          } else tx.set(ref, { name, book: first.book, chapter: first.chapter, section: metadata(first)?.section || first.section,
            gids: draft.map(i => i.gid), createdAt: sdk.serverTimestamp(), updatedAt: sdk.serverTimestamp() });
        });
        if (gen === generation) { modal = null; message = '模板已儲存。'; }
      } catch (_) { if (gen === generation) fail(saveTemplate); }
      finally { if (gen === generation) { busy = false; render(); } }
    }
    async function deleteTemplate(t) {
      if (busy) return;
      if (!(options.confirm || win.confirm.bind(win))(`確定刪除模板「${t.name}」？`)) return;
      const gen = generation;
      try { await sdk.deleteDoc(sdk.doc(sdk.db, 'templates', t.id)); live(gen); message = '模板已刪除。'; render(); }
      catch (_) { if (gen === generation) fail(() => deleteTemplate(t)); }
    }
    function addItems(items) {
      let skipped = 0;
      for (const i of items) {
        if (!editing && !multiple() && marksFor(rec(), i.gid).understood && !unlocked.has(i.gid)) { skipped++; continue; }
        draft = logic.insertGroupItem(draft, i, insertBefore);
      }
      message = `已加入編輯區${skipped ? `，略過 ${skipped} 個已懂積木` : ''}。`; render();
    }
    async function applyTemplate(t) {
      if (!selected || busy || pendingAssign || batch) return;
      const gen = generation;
      try {
        // Templates may span sections/chapters; locate gids using the chapter index.
        await ensureCatalogs(chapters, gen);
        const all = [...catalogs.values()].flatMap(c => c.items.map(i => ({ ...i, book: c.book, chapter: c.chapter })));
        addItems(t.gids.map(gid => all.find(i => i.gid === gid)).filter(Boolean));
        const missing = t.gids.filter(gid => !all.some(i => i.gid === gid));
        if (missing.length) { message += ` ${missing.length} 個積木已不在目錄。`; render(); }
      } catch (_) { if (gen === generation) fail(() => applyTemplate(t)); }
    }
    async function continueLast() {
      if (!selected || multiple() || busy || pendingAssign || batch) return;
      const r = rec(), last = r.groups.find(g => g.id === r.summary.lastAssignedGroupId);
      if (r.summary.lastAssignedGroupId && !last) { message = '正在讀取上一組，請稍候再接續。'; render(); return; }
      const tail = last?.items.at(-1), chapter = tail || chapters.find(c => c.id === chapterKey);
      if (!chapter) return;
      const gen = generation;
      try {
        await ensureCatalogs([chapter], gen);
        const c = catalogs.get(`${chapter.book}_${chapter.chapter}`);
        addItems(logic.continuation(c.items.map(i => ({ ...i, book: c.book, chapter: c.chapter })), last,
          (r.summary.understoodGids || []).filter(gid => !unlocked.has(gid))));
      } catch (_) { if (gen === generation) fail(continueLast); }
    }
    function viewing(i, d) {
      const aggregate = rec()?.summary.viewing?.[i.gid];
      const e = aggregate?.reportId ? aggregate : i.terminal;
      if (!e) return '－';
      const seconds = metadata(i)?.duration_s;
      return `花費 ${duration(e.spentSec || 0)}・影片 ${Number.isFinite(seconds) ? duration(seconds) : '－'}・播放 ${duration(e.playedSec || 0)}`
        + (e.rate !== 1 ? `・${e.rate} 倍速` : '') + `・再看 ${aggregate?.againCount ?? d.againCount[i.gid] ?? 0} 次`
        + (logic.shortPlayback(e, seconds) ? '・播放較短' : '');
    }
    function groupPanel(title, group, d) {
      return el('section', { class: 'group-card' }, el('h3', { text: title + (group ? `・第 ${group.seq} 組` : '') }),
        !group ? el('p', { class: 'muted', text: '目前沒有' }) : el('ol', { class: 'report-list' }, group.items.map(i => {
          const pending = d.pending.find(e => e.gid === i.gid);
          const text = i.report?.result === 'ok' ? '看懂' : i.report?.result === 'ask' ? (pending ? '待問' : '已解決')
            : i.report?.result === 'again' ? '再看一次' : i.done ? (pending ? '待問' : '已回報') : '未回報';
          return el('li', null, el('div', null, el('strong', { text: label(i) }), el('small', { text: place(i) }), el('small', { class: 'viewing', text: viewing(i, d) })),
            el('span', { class: pending ? 'badge ask' : 'badge', text }), pending ? button('已解決', () => resolve(pending), { 'aria-label': `已解決 ${label(i)} ${title}` }) : null);
        })), group ? button('收回整組', () => changeGroup(group, 'recall')) : null);
    }
    function left() {
      const students = roster.map(s => records.get(s.videoId)).filter(Boolean)
        .filter(r => filter === 'today' && !scheduleReason ? today.includes(r.videoId) : filter === 'class' ? !classFilter || r.className === classFilter : true)
        .sort((a, b) => Number(logic.summaryStatus(b.summary).waiting) - Number(logic.summaryStatus(a.summary).waiting));
      return el('aside', { class: 'column students', id: 'students-column' }, el('div', { class: 'column-title' },
        el('h2', { text: '學生' }), el('small', { text: `${roster.length} 位試用學生` })),
        el('div', { class: 'student-filters' }, ['today', 'class', 'all'].map((value, index) => button(['今天到班', '各班級', '全部'][index], () => { filter = value; render(); }, { 'aria-pressed': filter === value }))),
        filter === 'class' ? el('select', { 'aria-label': '班級', on: { change: e => { classFilter = e.target.value; render(); } } },
          el('option', { value: '', text: '各班級' }), [...new Set(roster.map(r => r.className))].map(c => el('option', { value: c, selected: classFilter === c, text: c }))) : null,
        scheduleReason ? el('p', { class: 'muted', text: '排課資料暫時讀不到，改列全部學生' }) : null,
        students.map(r => {
          const d = logic.summaryStatus(r.summary, (options.now || Date.now)());
          return el('div', { class: 'student-row' }, el('input', { type: 'checkbox', 'aria-label': `勾選 ${r.name}`, checked: checked.has(r.videoId),
            disabled: busy || !!pendingAssign || !!batch, on: { change: e => checkStudent(r.videoId, e.target.checked) } }), studentButton(r, d));
        }), !students.length ? el('p', { class: 'muted', text: '目前沒有可指派的試用學生。' }) : null);
    }
    function studentButton(r, d, watching) {
      const n = el('button', { type: 'button', class: 'student-card', disabled: busy || !!pendingAssign,
        'aria-pressed': String(selected === r.videoId), on: { click: () => select(r.videoId) } },
      el('div', { class: 'student-heading' }, el('strong', { text: r.name }), el('small', { text: r.className })),
      el('span', { class: d.waiting ? 'waiting' : 'muted', text: !r.loaded.has('summary') ? '讀取中…' : !d.known ? '進度待同步' : d.waiting ? '等待指派' : `進行到第 ${d.position} 個（共 ${d.current.gids.length} 個）` }),
      d.askCount ? el('span', { class: 'badge ask', text: `待問 ${d.askCount}` }) : null,
      d.watchingGid ? el('small', { class: 'watching', text: `正在看・${r.summary.watchingLabel || '積木 ' + d.watchingGid}` }) : null);
      return n;
    }
    function groupRow(g, d, currentId) {
      const r = rec(), position = g.items.findIndex(i => !i.done) + 1;
      const status = g.status === 'recalled' ? '已收回' : g.complete ? '已完成' : g.id === currentId ? `進行中 ${position}/${g.items.length}` : '排隊中';
      const seconds = g.items.reduce((sum, i) => sum + (metadata(i)?.duration_s || 0), 0);
      const expanded = r.expanded?.has(g.id);
      return el('section', { class: 'group-card', 'data-group': g.id },
        el('div', { class: 'group-heading' }, el('h3', { text: `第 ${g.seq} 組・${status}` }),
          el('small', { text: `${g.items.length} 個積木・影片總長 ${duration(seconds)}` })),
        button(expanded ? '收合積木' : '展開積木', () => {
          if (!r.expanded) r.expanded = new Set();
          if (expanded) r.expanded.delete(g.id); else { r.expanded.add(g.id); expandEvents?.(g); }
          render();
        }, { 'aria-expanded': !!expanded, 'aria-label': `展開第 ${g.seq} 組` }),
        g.status === 'assigned' ? button('編輯這組', () => beginEdit(g), { 'aria-label': `編輯第 ${g.seq} 組`, disabled: busy || !!pendingEdit || !!pendingAssign || !!batch }) : null,
        expanded ? el('ol', { class: 'report-list' }, g.items.map(i => {
          const pending = d.pending.find(e => e.gid === i.gid);
          return el('li', null, thumbnail(i), el('div', null, el('strong', { text: label(i) }),
            el('small', { text: place(i) }), el('small', { class: 'viewing', text: viewing(i, d) })),
            el('span', { class: pending ? 'badge ask' : 'badge', text: i.report?.result === 'again' ? '再看一次' : i.done ? pending ? '待問老師' : i.terminal?.result === 'ok' ? '看懂了' : '已回報' : '未回報' }));
        })) : null);
    }
    function middle() {
      const r = rec();
      if (!r) return el('section', { class: 'column selected', id: 'selected-column' }, el('h2', { text: '選一位學生開始' }), el('p', { class: 'muted', text: '查看回報，再從右側挑選下一組積木。' }));
      const d = state(r), total = draft.reduce((sum, i) => sum + (metadata(i)?.duration_s ?? i.duration_s ?? 0), 0);
      const missing = draft.filter(i => typeof (metadata(i)?.duration_s ?? i.duration_s) !== 'number').length;
      const currentId = logic.summaryStatus(r.summary).current?.id;
      const active = d.groups.filter(g => g.status === 'assigned' && !g.complete);
      const completed = d.groups.filter(g => g.status === 'assigned' && g.complete).sort((a, b) => b.seq - a.seq).slice(0, r.completedLimit || 3);
      const listed = logic.orderGroups([...active, ...completed, ...(showRecalled ? d.groups.filter(g => g.status === 'recalled') : [])]);
      const lockedGids = new Set(editProgress().filter(i => i.done).map(i => i.gid));
      return el('section', { class: 'column selected', id: 'selected-column' },
        editing ? el('div', { class: 'editing-banner', role: 'status' }, el('strong', { text: `正在編輯：第 ${editing.group.seq} 組` }), button('結束編輯', endEdit, { disabled: busy || !!pendingEdit })) : null,
        el('div', { class: 'column-title' }, el('h2', { text: multiple() ? '多人指派' : r.name }), el('small', { text: multiple() ? `${checked.size} 位學生` : r.className })),
        !multiple() ? [el('h2', { text: '任務組清單' }),
          button(showRecalled ? '隱藏已收回' : '顯示已收回', () => { showRecalled = !showRecalled; render(); }, { 'aria-pressed': showRecalled }),
          listed.map(g => groupRow(g, d, currentId)),
          !r.historyExhausted || d.groups.filter(g => g.status === 'assigned' && g.complete).length > (r.completedLimit || 3) ? button('顯示更早（每次 10 組）', () => historyMore?.()) : null,
          d.pending.map(e => {
            const i = d.groups.find(g => g.id === e.groupId)?.items.find(i => i.gid === e.gid) || { gid: e.gid };
            return el('div', { class: 'older-ask' }, el('div', null, el('span', { text: `${place(i)}・${label(i)}・待問` }), el('small', { class: 'viewing', text: viewing(i, d) })), button('已解決', () => resolve(e)));
          })] : null,
        el('section', { class: 'draft' }, el('div', { class: 'column-title' }, el('h3', { text: editing ? `編輯第 ${editing.group.seq} 組` : '新的一組' }), el('small', { text: `${draft.length} / 50 個` })),
          editing ? el('label', { class: 'insert-position' }, '新增積木的位置',
            el('select', { 'aria-label': '插入位置', value: insertBefore ?? '', on: { change: e => { insertBefore = e.target.value === '' ? null : Number(e.target.value); } } },
              el('option', { value: '', text: '加在最後', selected: insertBefore === null }),
              draft.map((i, n) => el('option', { value: i.gid, selected: insertBefore === i.gid, text: `插在第 ${n + 1} 個之前・${label(i)}` })))) : null,
          !draft.length ? el('p', { class: 'draft-empty', text: '從右欄勾選積木，依勾選順序加入。' }) : el('ol', { class: 'draft-list' }, draft.map((i, index) => {
            const locked = lockedGids.has(i.gid), blocked = busy || !!pendingAssign || !!pendingEdit || !!batch;
            const movable = delta => {
              if (!draft[index + delta] || locked) return false;
              const next = [...draft]; [next[index], next[index + delta]] = [next[index + delta], next[index]];
              return canEdit(next, false);
            };
            const li = el('li', { draggable: String(!blocked && !locked), class: locked ? 'is-locked' : null, on: {
              dragstart: e => { dragFrom = index; closeThumb(); e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.effectAllowed = 'move'; li.classList?.add('dragging'); },
              dragover: e => { if (dragFrom === null) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; dropMark(dragFrom === index ? null : li, lowerHalf(e, li)); },
              drop: e => { if (dragFrom === null) return; e.preventDefault(); const from = dragFrom, after = lowerHalf(e, li); endDrag(); moveTo(from, index, after); },
              dragend: endDrag } },
              thumbnail(i), el('div', null, el('strong', { text: label(i) }), el('small', { text: place(i) }),
                locked ? el('small', { class: 'reported-lock', text: '🔒 已有回報紀錄' }) : null,
                !multiple() ? el('small', { class: 'viewing', text: viewing(i, d) }) : null),
              el('div', { class: 'reorder' }, !locked ? el('span', { class: 'grip', 'aria-hidden': 'true', title: '按住卡片拖移可以調整順序', text: '⠿' }) : null, button('↑', () => move(index, -1), { id: 'up-' + index, disabled: blocked || !movable(-1), 'aria-label': `上移第 ${index + 1} 個積木` }),
                button('↓', () => move(index, 1), { id: 'down-' + index, disabled: blocked || !movable(1), 'aria-label': `下移第 ${index + 1} 個積木` }),
                button('移除', () => toggle(i, false), { disabled: blocked || locked, title: locked ? '已有回報紀錄' : '', 'aria-label': `移除第 ${index + 1} 個積木` })));
            return li;
          })),
          el('div', { class: 'assign-bar' }, el('p', { text: `影片總長 ${duration(total)}${missing ? `（${missing} 個缺長度，未計入）` : ''}` }),
            editing ? [button('儲存這組', saveGroup, { class: 'primary', disabled: busy || !draft.length }),
              button('整組收回', () => changeGroup(editing.group, 'recall'), { disabled: busy || !!pendingEdit })] : [
              button('指派', () => assign(), { id: 'assign-button', class: 'primary', disabled: busy || !draft.length || !!batch || !multiple() && !r.loaded.has('summary') }),
              button('排在後面（預排）', () => assign('append'), { disabled: busy || !draft.length || !!batch })],
            button('存成模板', () => nameDialog('saveTemplate'), { disabled: busy || !draft.length || !!pendingAssign || !!pendingEdit || !!batch }),
            batch ? el('div', null, batch.map(o => el('p', { text: `${o.name}：${o.result === 'success' ? '成功' : o.result === 'failed' ? '失敗' : o.result === 'skipped' ? '無剩餘，未建組' : '待確認'}` })),
              button('只重試失敗的學生', retryBatch, { disabled: busy }), button('結束這次多人指派', () => { batch = null; draft = []; render(); })) : null)));
    }
    async function retryBatch() {
      if (!batch || busy) return;
      // Fixed IDs remain attached even when rebuilding the failed student's confirmation.
      const gen = generation; busy = true;
      try {
        for (const op of batch.filter(o => o.result === 'failed')) {
          const existing = await sdk.getDocFromServer(op.ref); live(gen);
          if (existing.exists()) { op.result = 'success'; continue; }
          const s = await sdk.getDocFromServer(studentRef(op.sid)); live(gen);
          if (s.exists() && s.data().version !== 5) throw new Error('summary');
          const understoodGids = s.exists() ? s.data().understoodGids : [];
          const plan = logic.batchPlan([{ understoodGids }], draft)[0];
          Object.assign(op, { items: plan.items, skipped: plan.skipped, understoodKey: JSON.stringify(understoodGids), result: plan.items.length ? 'pending' : 'skipped' });
        }
        modal = { type: 'batch' };
      } catch (_) { if (gen === generation) fail(retryBatch); }
      finally { if (gen === generation) { busy = false; render(); } }
    }
    function duration(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`; }
    function right() {
      const chapter = chapters.find(c => c.id === chapterKey), catalog = catalogs.get(chapterKey), r = rec();
      const book = chapter?.book || chapters[0]?.book;
      const bookSelect = el('select', { id: 'book-select', 'aria-label': '選擇冊', on: { change: e => chooseChapter(chapters.find(c => c.book === e.target.value).id) } },
        [...new Set(chapters.map(c => c.book))].map(b => el('option', { value: b, text: logic.bookLabel(b) })));
      bookSelect.value = book;
      const chapterSelect = el('select', { id: 'chapter-select', 'aria-label': '選擇章', on: { change: e => chooseChapter(e.target.value) } },
        chapters.filter(c => c.book === book).map(c => el('option', { value: c.id, text: `第 ${c.chapter} 章` })));
      chapterSelect.value = chapterKey;
      const sections = new Map();
      (catalog?.items || []).filter(i => ['focus', 'exa'].includes(i.kind)).forEach(i => {
        if (!sections.has(i.section)) sections.set(i.section, []);
        sections.get(i.section).push({ ...i, book: catalog.book, chapter: catalog.chapter });
      });
      return el('aside', { class: 'column catalog', id: 'catalog-column' }, el('div', { class: 'column-title' }, el('h2', { text: '選積木' })),
        el('div', { class: 'catalog-selects' }, bookSelect, chapterSelect),
        button('接續上一組', continueLast, { disabled: busy || !selected || multiple() || !!pendingAssign || !!batch }),
        !catalog ? el('p', { class: 'muted', text: chapters.length ? '正在讀取目錄…' : '目前沒有目錄。' }) : null,
        [...sections].map(([section, items]) => el('section', { class: 'catalog-section', id: 'section-' + section }, el('h3', { text: `第 ${section} 節` }),
        templates.filter(t => t.book === book && t.chapter === chapter?.chapter && t.section === section).map(t => el('div', { class: 'template-row' },
          el('strong', { text: t.name }), button('套用', () => applyTemplate(t), { disabled: busy || !selected || !!batch || !!pendingAssign }),
          button('改名', () => nameDialog('renameTemplate', t)), button('刪除', () => deleteTemplate(t)))), items.map(i => {
          const marks = r && !multiple() ? marksFor(r, i.gid) : {};
          const reported = editing && editProgress().some(p => p.gid === i.gid && p.done);
          const locked = reported || !editing && marks.understood && !unlocked.has(i.gid);
          return el('div', { class: 'catalog-item' }, el('input', { id: 'pick-' + i.gid, 'aria-label': i.label, type: 'checkbox', checked: draft.some(x => x.gid === i.gid),
            disabled: !selected || busy || !!pendingAssign || !!pendingEdit || !!batch || locked, on: { change: e => toggle(i, e.target.checked) } }),
          el('span', { class: 'catalog-content' }, thumbnail(i), el('strong', { text: i.label }), el('small', { text: typeof i.duration_s === 'number' ? duration(i.duration_s) : '長度未提供' })),
          el('span', { class: 'marks' }, marks.understood ? el('small', { class: 'badge ok', text: '已懂' }) : null,
            locked && !reported ? button('解除', () => { unlocked.add(i.gid); render(); }, { disabled: busy || !!pendingAssign || !!batch, 'aria-label': `解除 ${i.label} 鎖定` }) : null,
            marks.pending ? el('small', { class: 'badge ask', text: '待問' }) : null, marks.assigned ? el('small', { class: 'badge', text: '已指派' }) : null));
        }))));
    }
    function dialog() {
      if (!modal) return null;
      const m = modal;
      return el('dialog', { id: 'assignment-dialog', 'aria-labelledby': 'dialog-title', on: { cancel: e => { e.preventDefault(); if (!busy) cancelDialog(); } } },
        el('h2', { id: 'dialog-title', text: m.type === 'assignment' ? '學生還有未完成的組' : m.type === 'batch' ? '確認多人指派' : '模板名稱' }),
        m.type === 'assignment' ? [el('p', { text: `立刻取代目前這組：剩下 ${m.remaining} 個未看的積木會收回。已回報的紀錄會保留。` }),
          button('排在後面', () => assign('append'), { id: 'dialog-append' }), button('插在最前面', () => assign('front'), { id: 'dialog-front' }), button('立刻取代目前這組', () => assign('replace'), { id: 'dialog-replace' })]
          : m.type === 'batch' ? [el('p', { text: '每位學生各自排到最後；沒有剩餘積木的學生不建立組。' }),
            el('ul', { class: 'batch-list' }, batch.map(o => el('li', null, el('strong', { text: o.name }),
              el('p', { text: o.result === 'success' ? '已成功，這次不會重複指派' : o.items.length ? `收到：${o.items.map(i => `${place(i)}・${label(i)}`).join('、')}` : '沒有剩餘積木，不建立組' }),
              el('small', { text: `因已看懂略過：${o.skipped.map(i => `${place(i)}・${label(i)}`).join('、') || '無'}` })))), button('確認指派', sendBatch, { id: 'dialog-send', class: 'primary' })]
          : [el('input', { id: 'template-name', 'aria-label': '模板名稱', value: m.name, maxlength: 40, on: { input: e => { m.name = e.target.value; } } }), button('儲存', saveTemplate, { id: 'dialog-save', class: 'primary' })],
        button('取消', () => { if (modal?.type === 'batch' && !batch.some(o => o.result === 'success' || o.result === 'failed')) batch = null; cancelDialog(); }, { id: 'dialog-cancel', disabled: busy }));
    }
    function render() {
      // 拖移中重畫會中斷拖移，延到放開後再畫。
      if (dragFrom !== null) { renderQueued = true; return; }
      if (!thumbPopup?.pinned) closeThumb();
      thumbObserver?.disconnect(); thumbNodes = [];
      const focus = doc.activeElement?.id;
      const selection = focus === 'template-name' ? [doc.activeElement.selectionStart, doc.activeElement.selectionEnd] : null;
      const scrolls = ['students-column', 'selected-column', 'catalog-column'].map(id => [id, doc.getElementById(id)?.scrollTop || 0]);
      host.replaceChildren(...[el('header', { class: 'topbar' }, el('div', null, el('a', { href: '../', text: '學生儀表板' }), el('h1', { text: '影片指派' })), token ? button('登出', signOut, { disabled: false }) : null),
        error ? el('div', { class: 'error', role: 'alert' }, el('p', { text: error }), button('再試一次', () => { const action = retry; error = ''; retry = null; render(); return action?.(); })) : null,
        message ? el('p', { class: 'notice', role: 'status', text: message }) : null,
        ready && !error ? el('div', { class: 'workspace' }, left(), middle(), right()) : null,
        dialog(),
        !token ? el('div', { class: 'login' }, el('h2', { text: '用老師帳號登入' }), el('p', { text: '選學生、挑積木，直接指派下一組。' }), el('div', { id: 'google-signin' })) : null].filter(Boolean));
      scrolls.forEach(([id, top]) => { const node = doc.getElementById(id); if (node) node.scrollTop = top; });
      if (modal) {
        const dialogNode = doc.getElementById('assignment-dialog');
        if (dialogNode && !dialogNode.open) dialogNode.showModal?.();
      }
      if (focus) {
        const target = doc.getElementById(focus); target?.focus({ preventScroll: true });
        if (selection) target?.setSelectionRange?.(...selection);
      }
      observeThumbs();
      if (!token) renderSignIn();
    }
    function renderSignIn() {
      const box = doc.getElementById('google-signin');
      if (!box) return;
      if (!win.google?.accounts) {
        if (doc.readyState === 'complete') box.replaceChildren(button('重新載入登入', () => win.location.reload()));
        return;
      }
      win.google.accounts.id.initialize({ client_id: CLIENT_ID, callback: r => load(r.credential), auto_select: false });
      win.google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', locale: 'zh-TW' });
    }
    function preview(data) {
      reset(); ready = true; roster = data.students;
      previewMode = true; filter = 'all'; templates = data.templates || [];
      Object.entries(data.catalogs).forEach(([key, value]) => catalogs.set(key, value));
      chapters = Object.entries(data.catalogs).map(([id, c]) => ({ id, book: c.book, chapter: c.chapter }));
      chapterKey = chapters[0]?.id || ''; selected = roster[0]?.videoId || null;
      roster.forEach(s => records.set(s.videoId, { ...s, summary: logic.summaryFrom(s.groups || [], s.events || [], s.summary || {}), groups: s.groups || [], events: s.events || [], loaded: new Set(['summary', 'groups', 'events']), historyExhausted: true }));
      // Read-only fixture. No login, SDK loading, or writes in preview.
      token = 'preview'; sdk = { doc: () => ({}), collection: () => ({}), runTransaction: async () => { throw new Error('preview'); } };
      draft = data.draft || []; render();
    }
    function init() {
      // Preview mode needs the same Esc / outside-click handling for pinned thumbnails.
      doc.addEventListener?.('keydown', e => { if (e.key === 'Escape') closeThumb(); });
      doc.addEventListener?.('pointerdown', e => { if (thumbPopup && !thumbPopup.contains?.(e.target) && !e.target?.closest?.('.thumb-slot')) closeThumb(); });
      if (options.preview) { preview(options.preview); return; }
      render(); win.addEventListener('load', renderSignIn, { once: true });
      win.addEventListener('pagehide', () => { reset(); if (sdk) sdk.signOut(sdk.auth).catch(() => {}); });
      win.addEventListener('beforeunload', e => { if (dirty() || busy || pendingEdit) { e.preventDefault(); e.returnValue = ''; } });
      win.setInterval(() => { if (ready && !busy) render(); }, 30000);
    }
    return { init, load, signOut, select, toggle, move, moveTo, assign, resolve, chooseChapter, preview, checkStudent, cancelDialog, beginEdit, endEdit, saveGroup,
      prepareBatch, sendBatch, retryBatch, changeGroup, applyTemplate, continueLast };
  }
  return { create };
});
