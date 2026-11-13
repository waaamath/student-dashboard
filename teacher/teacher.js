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
  async function api(token) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ idToken: token }), signal: ctrl.signal });
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
    let token, roster = [], selected = null, records = new Map(), catalogs = new Map(), chapters = [], chapterKey = '';
    let draft = [], pendingAssign = null, resolves = new Map(), busy = false, ready = false, message = '', error = '', retry;
    const rows = snap => snap.docs.map(d => ({ ...d.data(), id: d.id }));
    const rec = () => records.get(selected);
    const state = r => logic.studentStatus(r.groups, r.events, r.summary, (options.now || Date.now)());
    const metadata = i => catalogs.get(`${i.book}_${i.chapter}`)?.items.find(x => x.gid === i.gid);
    const label = i => metadata(i)?.label || '積木 ' + i.gid;
    const place = i => `${logic.bookLabel(i.book)}・第 ${i.chapter} 章`;
    const button = (text, click, props = {}) => el('button', { type: 'button', text, disabled: busy, on: { click }, ...props });
    const studentRef = sid => sdk.doc(sdk.db, 'students', sid);
    const collectionRef = (sid, name) => sdk.collection(sdk.db, 'students', sid, name);
    const live = gen => { if (gen !== generation) throw new Error('stale session'); };
    function stopListeners() { watchSerial++; unsubs.forEach(f => f()); unsubs = []; }
    function reset() {
      generation++; stopListeners(); token = null; roster = []; selected = null; records = new Map();
      catalogs = new Map(); chapters = []; chapterKey = ''; draft = []; resolves = new Map(); pendingAssign = null;
      ready = false; busy = false; message = ''; error = ''; retry = null;
    }
    function fail(action, text = '暫時無法讀寫影片任務，請檢查網路後再試一次。') {
      error = text; retry = action; render();
    }
    async function signOut() {
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
        if (chapters.length) await chooseChapter(chapters[0].id);
      } catch (_) { if (gen === generation) fail(() => load(idToken), '目前無法使用影片指派，請再試一次。'); }
    }
    async function ensureCatalogs(items, gen = generation) {
      const keys = [...new Set(items.map(i => `${i.book}_${i.chapter}`))];
      await Promise.all(keys.map(async key => {
        if (catalogs.has(key)) return;
        const d = await sdk.getDocFromServer(sdk.doc(sdk.db, 'catalog', key)); live(gen);
        if (!d.exists()) throw new Error('catalog');
        catalogs.set(key, d.data());
      }));
    }
    function watchStudents() {
      stopListeners();
      const gen = generation, watch = watchSerial;
      const valid = () => gen === generation && watch === watchSerial;
      roster.forEach(st => {
        const r = { ...st, summary: {}, groups: [], events: [], loaded: new Set() }; records.set(st.videoId, r);
        const listen = (name, ref, update) => {
          unsubs.push(sdk.onSnapshot(ref, snap => {
            if (!valid()) return;
            update(snap); r.loaded.add(name); render();
          }, () => { if (valid()) fail(() => { watchStudents(); render(); }); }));
        };
        listen('summary', studentRef(st.videoId), s => { r.summary = s.exists() ? s.data() : {}; });
        listen('events', collectionRef(st.videoId, 'events'), s => { r.events = rows(s); });
        listen('groups', collectionRef(st.videoId, 'groups'), s => {
          r.groups = rows(s);
          const refresh = () => ensureCatalogs(r.groups.flatMap(g => g.items), gen).then(() => { if (valid()) render(); })
            .catch(() => { if (valid()) fail(refresh); });
          refresh();
        });
      });
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
      if (busy || pendingAssign || [...resolves.values()].some(o => !o.finished)) return;
      if (sid === selected) return;
      if (draft.length && !(options.confirm || win.confirm.bind(win))('編輯中的積木尚未指派，切換學生會清空清單。確定切換？')) return;
      selected = sid; draft = []; message = ''; render();
    }
    function toggle(item, checked) {
      if (!selected || busy || pendingAssign) return;
      if (checked && !draft.some(i => i.gid === item.gid)) {
        if (draft.length >= 50) { message = '一組最多 50 個積木。'; render(); return; }
        draft.push({ ...item });
      } else if (!checked) draft = draft.filter(i => i.gid !== item.gid);
      render();
    }
    function move(index, delta) {
      if (busy || pendingAssign || !draft[index + delta]) return;
      [draft[index], draft[index + delta]] = [draft[index + delta], draft[index]]; render();
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
    async function assign() {
      if (busy || !selected || !draft.length || draft.length > 50 || rec()?.loaded.size !== 3) return;
      if (!pendingAssign) pendingAssign = { sid: selected, items: draft.map(i => ({ ...i })),
        ref: sdk.doc(collectionRef(selected, 'groups')) };
      const op = pendingAssign, gen = generation;
      busy = true; error = ''; render();
      try {
        if (win.navigator.onLine === false) throw new Error('offline');
        const result = await sdk.runTransaction(sdk.db, async tx => {
          live(gen);
          const summary = await tx.get(studentRef(op.sid)), existing = await tx.get(op.ref);
          if (existing.exists()) return existing.data();
          const groups = await transactionGroups(tx, op.sid);
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
          const group = { seq: Math.max(0, ...groups.map(g => g.seq)) + 1, status: 'assigned', items,
            gids: items.map(i => i.gid), createdAt: sdk.serverTimestamp() };
          // Rewriting the read summary preserves its exact fields and serializes seq allocation.
          tx.set(studentRef(op.sid), summary.exists() ? summary.data() : { createdAt: sdk.serverTimestamp() });
          tx.set(op.ref, group); return group;
        });
        if (gen !== generation) return;
        pendingAssign = null; draft = []; message = `已指派第 ${result.seq} 組，共 ${result.items.length} 個積木。`;
      } catch (e) {
        // 缺影片時交易在寫入前就中止，確定沒寫；放開鎖定讓老師改清單，不要卡在只能重試。
        if (gen !== generation) return;
        if (e.missingItem) {
          pendingAssign = null;
          message = `${place(e.missingItem)}・${label(e.missingItem)}（積木 ${e.missingItem.gid}）缺少影片，整組尚未指派。請移除這個積木，或補齊影片後再按指派。`;
        } else fail(assign);
      } finally { if (gen === generation) { busy = false; render(); } }
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
          const groups = await transactionGroups(tx, op.sid);
          const snap = await sdk.getDocsFromServer(collectionRef(op.sid, 'events'));
          const events = await Promise.all(snap.docs.map(async d => {
            const s = await tx.get(sdk.doc(collectionRef(op.sid, 'events'), d.id));
            return { ...s.data(), id: d.id };
          }));
          const d = logic.derive(logic.recentGroups(groups), events);
          // Do not accidentally close a newer question after a delayed retry.
          if (!d.pending.some(e => e.id === ask.id)) return;
          const event = { gid: ask.gid, groupId: ask.groupId, type: 'resolve', by: 'teacher' };
          live(gen);
          tx.set(op.ref, { ...event, at: sdk.serverTimestamp() });
          tx.update(studentRef(op.sid), { askCount: Math.min(1000, logic.askCountAfterResolve(groups, events, event)) });
        });
        if (gen === generation) { op.finished = true; message = '已解決，學生待問清單會自動更新。'; }
      } catch (_) { if (gen === generation) fail(() => resolve(ask)); }
      finally { if (gen === generation) { busy = false; render(); } }
    }
    function groupPanel(title, group, d) {
      return el('section', { class: 'group-card' }, el('h3', { text: title + (group ? `・第 ${group.seq} 組` : '') }),
        !group ? el('p', { class: 'muted', text: '目前沒有' }) : el('ol', { class: 'report-list' }, group.items.map(i => {
          const pending = d.pending.find(e => e.gid === i.gid);
          const text = i.report?.result === 'ok' ? '看懂' : i.report?.result === 'ask' ? (pending ? '待問' : '已解決')
            : i.report?.result === 'again' ? '再看一次' : '未回報';
          return el('li', null, el('div', null, el('strong', { text: label(i) }), el('small', { text: place(i) })),
            el('span', { class: pending ? 'badge ask' : 'badge', text }), pending ? button('已解決', () => resolve(pending), { 'aria-label': `已解決 ${label(i)} ${title}` }) : null);
        })));
    }
    function left() {
      const students = roster.map(s => records.get(s.videoId)).filter(Boolean).sort((a, b) => Number(state(b).waiting) - Number(state(a).waiting));
      return el('aside', { class: 'column students', id: 'students-column' }, el('div', { class: 'column-title' },
        el('h2', { text: '學生' }), el('small', { text: `${roster.length} 位試用學生` })),
        students.map(r => {
          const d = state(r), watching = r.groups.flatMap(g => g.items).find(i => i.gid === d.watchingGid);
          return studentButton(r, d, watching);
        }), !roster.length ? el('p', { class: 'muted', text: '目前沒有可指派的試用學生。' }) : null);
    }
    function studentButton(r, d, watching) {
      const n = el('button', { type: 'button', class: 'student-card', disabled: busy || !!pendingAssign,
        'aria-pressed': String(selected === r.videoId), on: { click: () => select(r.videoId) } },
      el('div', { class: 'student-heading' }, el('strong', { text: r.name }), el('small', { text: r.className })),
      el('span', { class: d.waiting ? 'waiting' : 'muted', text: r.loaded.size !== 3 ? '讀取中…' : d.waiting ? '等待指派' : `進行到第 ${d.position} 個（共 ${d.current.items.length} 個）` }),
      d.askCount ? el('span', { class: 'badge ask', text: `待問 ${d.askCount}` }) : null,
      watching ? el('small', { class: 'watching', text: `正在看・${label(watching)}` }) : null);
      return n;
    }
    function middle() {
      const r = rec();
      if (!r) return el('section', { class: 'column selected', id: 'selected-column' }, el('h2', { text: '選一位學生開始' }), el('p', { class: 'muted', text: '查看回報，再從右側挑選下一組積木。' }));
      const d = state(r), total = draft.reduce((sum, i) => sum + (typeof i.duration_s === 'number' ? i.duration_s : 0), 0);
      const missing = draft.filter(i => typeof i.duration_s !== 'number').length;
      const shown = new Set([d.current, d.lastCompleted].filter(Boolean).flatMap(g => g.items.map(i => i.gid)));
      return el('section', { class: 'column selected', id: 'selected-column' }, el('div', { class: 'column-title' }, el('h2', { text: r.name }), el('small', { text: r.className })),
        groupPanel('目前這組', d.current, d), groupPanel('最近完成', d.lastCompleted, d),
        d.pending.filter(e => !shown.has(e.gid)).map(e => {
          const i = d.groups.find(g => g.id === e.groupId).items.find(i => i.gid === e.gid);
          return el('p', { class: 'older-ask' }, el('span', { text: `${place(i)}・${label(i)}・待問` }), button('已解決', () => resolve(e)));
        }),
        r.groups.length > 30 ? el('p', { class: 'muted', text: '進度、回報標示與待問清單以最近 30 組推算。' }) : null,
        el('section', { class: 'draft' }, el('div', { class: 'column-title' }, el('h3', { text: '編輯下一組' }), el('small', { text: `${draft.length} / 50 個` })),
          !draft.length ? el('p', { class: 'draft-empty', text: '從右欄勾選積木，依勾選順序加入。' }) : el('ol', { class: 'draft-list' }, draft.map((i, index) => el('li', null,
            el('div', null, el('strong', { text: label(i) }), el('small', { text: place(i) })),
            el('div', { class: 'reorder' }, button('↑', () => move(index, -1), { id: 'up-' + index, disabled: busy || !!pendingAssign || index === 0, 'aria-label': `上移第 ${index + 1} 個積木` }),
              button('↓', () => move(index, 1), { id: 'down-' + index, disabled: busy || !!pendingAssign || index === draft.length - 1, 'aria-label': `下移第 ${index + 1} 個積木` }),
              button('移除', () => toggle(i, false), { disabled: busy || !!pendingAssign, 'aria-label': `移除第 ${index + 1} 個積木` }))))),
          el('div', { class: 'assign-bar' }, el('p', { text: `影片總長 ${duration(total)}${missing ? `（${missing} 個缺長度，未計入）` : ''}` }),
            button('指派', assign, { class: 'primary', disabled: busy || !draft.length || r.loaded.size !== 3 }),
            d.current ? el('small', { text: '會排在目前這組後面' }) : null)));
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
        !catalog ? el('p', { class: 'muted', text: chapters.length ? '正在讀取目錄…' : '目前沒有目錄。' }) : null,
        [...sections].map(([section, items]) => el('section', { class: 'catalog-section' }, el('h3', { text: `第 ${section} 節` }), items.map(i => {
          const marks = r ? logic.itemMarks(i.gid, r.groups, r.events) : {};
          return el('label', { class: 'catalog-item' }, el('input', { id: 'pick-' + i.gid, type: 'checkbox', checked: draft.some(x => x.gid === i.gid),
            disabled: !selected || busy || !!pendingAssign, on: { change: e => toggle(i, e.target.checked) } }),
          el('span', null, el('strong', { text: i.label }), el('small', { text: typeof i.duration_s === 'number' ? duration(i.duration_s) : '長度未提供' })),
          el('span', { class: 'marks' }, marks.understood ? el('small', { class: 'badge ok', text: '已懂' }) : null,
            marks.pending ? el('small', { class: 'badge ask', text: '待問' }) : null, marks.assigned ? el('small', { class: 'badge', text: '已指派' }) : null));
        }))));
    }
    function render() {
      const focus = doc.activeElement?.id;
      const scrolls = ['students-column', 'selected-column', 'catalog-column'].map(id => [id, doc.getElementById(id)?.scrollTop || 0]);
      host.replaceChildren(...[el('header', { class: 'topbar' }, el('div', null, el('a', { href: '../', text: '學生儀表板' }), el('h1', { text: '影片指派' })), token ? button('登出', signOut, { disabled: false }) : null),
        error ? el('div', { class: 'error', role: 'alert' }, el('p', { text: error }), button('再試一次', () => { const action = retry; error = ''; retry = null; render(); return action?.(); })) : null,
        message ? el('p', { class: 'notice', role: 'status', text: message }) : null,
        ready && !error ? el('div', { class: 'workspace' }, left(), middle(), right()) : null,
        !token ? el('div', { class: 'login' }, el('h2', { text: '用老師帳號登入' }), el('p', { text: '選學生、挑積木，直接指派下一組。' }), el('div', { id: 'google-signin' })) : null].filter(Boolean));
      scrolls.forEach(([id, top]) => { const node = doc.getElementById(id); if (node) node.scrollTop = top; });
      if (focus) doc.getElementById(focus)?.focus({ preventScroll: true });
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
      Object.entries(data.catalogs).forEach(([key, value]) => catalogs.set(key, value));
      chapters = Object.entries(data.catalogs).map(([id, c]) => ({ id, book: c.book, chapter: c.chapter }));
      chapterKey = chapters[0]?.id || ''; selected = roster[0]?.videoId || null;
      roster.forEach(s => records.set(s.videoId, { ...s, summary: s.summary || {}, groups: s.groups || [], events: s.events || [], loaded: new Set(['summary', 'groups', 'events']) }));
      // Read-only fixture. No login, SDK loading, or writes in preview.
      token = 'preview'; sdk = { doc: () => ({}), collection: () => ({}), runTransaction: async () => { throw new Error('preview'); } };
      draft = data.draft || []; render();
    }
    function init() {
      if (options.preview) { preview(options.preview); return; }
      render(); win.addEventListener('load', renderSignIn, { once: true });
      win.addEventListener('pagehide', () => { signOut(); });
      win.addEventListener('beforeunload', e => { if (draft.length || busy) { e.preventDefault(); e.returnValue = ''; } });
      win.setInterval(() => { if (ready && !busy) render(); }, 30000);
    }
    return { init, load, signOut, select, toggle, move, assign, resolve, chooseChapter, preview };
  }
  return { create };
});
