'use strict';

// 這兩個值都是公開資訊，資料的把關在後端（token 驗證 + 名冊）。
const CLIENT_ID = '863861496583-i8ttdlflo03fscvcbvdc3hibqds4v7rn.apps.googleusercontent.com';
const API_URL = 'https://script.google.com/macros/s/AKfycbxvwBJFQMB-fsjs4Nbw1HhQVZVgcFqIWjOTiYAt04A-rviphe3xK7MmKCwluvJ8pAkv/exec';

const DEFAULT_NAME = '學習進度';
const NEW_LAYOUT_FOR_ALL = true;
// 作業與錯題改讀 Firestore（規格書 §11）。false＝完全是原本的行為；true＝所有人；
// 'device'＝只有開過一次 ?dash=1 的瀏覽器（測試手機用，?dash=0 取消），其他裝置照舊、不載入 Firebase。
const DASH_FROM_FIRESTORE = true;   // 2026-11-21 測試手機驗收通過後全開
const DASH_DEVICE_KEY = 'dashFromFirestore';

const app = document.getElementById('app');
let idToken = null;    // 只放記憶體，關掉頁面就沒了
let dashboard = null;
let selected = 0;      // 老師在學生清單時為 null
let teacherFilter = { q: '', cls: '' };
let view = 'home';
let wrongPeriod = null;

/** 建立元素；文字一律走 textContent，作業標題不會被當成 HTML。 */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.entries(props || {}).forEach(([k, v]) => {
    if (v === null || v === undefined) return;   // 選用屬性（例如 disabled）不給就不設
    if (k === 'on') Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
    else if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  });
  children.flat().forEach((c) => c && node.append(c));
  return node;
}

let bottomNext = false;   // renderDashboard 在 show() 前設定；其他畫面一律沒有底部列

function show(...nodes) {
  setBottomLayout(bottomNext);
  bottomNext = false;
  app.replaceChildren(...nodes.filter(Boolean));
  window.scrollTo(0, 0);
}

function message(title, lines, actions) {
  show(el('div', { class: 'message' },
    el('h1', { text: title }),
    (lines || []).map((t) => el('p', { text: t })),
    actions || []));
}

/* ---------- LINE 等 App 內建瀏覽器 ---------- */

// LINE 認得這個參數，會改用外部瀏覽器開啟。其他 App 內建瀏覽器則顯示提示。
function inAppBrowser() {
  const ua = navigator.userAgent;
  if (/\bLine\//i.test(ua)) {
    const url = new URL(location.href);
    if (url.searchParams.get('openExternalBrowser') !== '1') {
      url.searchParams.set('openExternalBrowser', '1');
      location.replace(url.href);
      return 'redirecting';
    }
    return 'blocked';
  }
  return /FBAN|FBAV|FB_IAB|Instagram|MicroMessenger/i.test(ua) ? 'blocked' : 'ok';
}

function showInAppNotice() {
  const url = location.origin + location.pathname;
  const status = el('p', { text: '' });
  message('請改用 Safari 或 Chrome 開啟', [
    'Google 不允許在 App 內建的瀏覽器登入。請複製網址，貼到 Safari 或 Chrome。',
    url,
  ], [
    el('button', {
      class: 'primary', text: '複製網址',
      on: { click: async () => {
        try {
          await navigator.clipboard.writeText(url);
          status.textContent = '已複製。';
        } catch (e) {
          status.textContent = '無法自動複製，請長按上面的網址。';
        }
      } },
    }),
    status,
  ]);
}

/* ---------- 登入 ---------- */

/** 瀏覽器分頁與加入主畫面時預設帶入的名稱。 */
function setPageName(name) {
  document.title = name;
  document.querySelector('meta[name="apple-mobile-web-app-title"]').content = name;
}

function showLogin(note) {
  stopDash();
  idToken = null;
  dashboard = null;
  if (hasPet()) Pet.reset();
  if (typeof Video !== 'undefined') Video.reset();
  setPageName(DEFAULT_NAME);
  selected = 0;
  teacherFilter = { q: '', cls: '' };
  view = 'work';
  const box = el('div', { class: 'signin' });
  show(el('div', { class: 'message login' },
    el('h1', { text: DEFAULT_NAME }),
    el('p', { text: '看看進度，整理錯題，一步步累積進步。' }),
    el('p', { text: '查看 Classroom 作業的繳交狀態。學生請用加入 Classroom 的 Gmail 登入，家長請用登記給老師的 Gmail 登入。' }),
    note ? el('p', { text: note }) : null,
    box));
  if (!CLIENT_ID) {
    box.textContent = '系統尚未完成設定。';
    return;
  }
  renderSignIn(box);
}

/** 頁面先出來，Google 的登入程式載入後再放按鈕。load 事件之後還沒有才算失敗。 */
function renderSignIn(box) {
  if (!window.google || !google.accounts) {
    if (document.readyState === 'complete') {
      box.textContent = '無法載入 Google 登入，請確認網路後重新整理。';
    } else {
      box.textContent = '正在準備登入按鈕…';
      window.addEventListener('load', () => { if (box.isConnected) renderSignIn(box); }, { once: true });
    }
    return;
  }
  box.textContent = '';
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: false });
  google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-TW', width: 280 });
}

function signOut() {
  if (typeof Video !== 'undefined') Video.signOut().catch(() => {});
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  showLogin('已登出。如果這是共用裝置，也請到系統設定移除自己的 Google 帳號。');
}

function onCredential(response) {
  idToken = response.credential;
  load();
}

/* ---------- 讀資料 ---------- */

/** 練習獸的請求（作業資料仍走 load）。30 秒沒回應就當網路失敗，前端可以用同一個 request ID 安全重試。 */
async function apiCall(body) {
  if (window.GAME_PREVIEW) return window.GAME_PREVIEW.call(body);   // tests/preview.html 用
  const ctrl = window.AbortController ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ idToken }, body)),
      signal: ctrl ? ctrl.signal : undefined,
    });
    return await r.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** pet/pet.js 沒載入（或被擋）時，儀表板照常，只是沒有練習獸。 */
function hasPet() {
  return typeof Pet !== 'undefined';
}

/* ---------- Firestore 作業與錯題：純函式（規格書 §11；tests/run.js 擷取這一段測試） ---------- */

/** 同後端 byUrgent_：有截止日的在前、由急到緩；沒有截止日的在後、指派越久越前面。 */
function dashUrgent(a, b) {
  if ((a.dueMs === null) !== (b.dueMs === null)) return a.dueMs === null ? 1 : -1;
  if (a.dueMs !== null) return a.dueMs - b.dueMs;
  const x = a.assignedMs === null ? Infinity : a.assignedMs, y = b.assignedMs === null ? Infinity : b.assignedMs;
  return x === y ? 0 : (x < y ? -1 : 1);
}

/** 錯題文件的原字串照 API 的規則解析；沒有、壞掉都是 null。 */
function dashParseWrong(doc) {
  if (!doc || typeof doc.data !== 'string') return null;
  try {
    return JSON.parse(doc.data);
  } catch (e) {
    return null;
  }
}

/**
 * 作業文件 → 與 API 相同形狀的學生資料。家長拿不到作業連結；old 的影片與錯題欄位原樣保留
 * （監聽更新只換作業，不在中途開關影片）。
 */
function dashWithWork(old, work) {
  const items = (Array.isArray(work.items) ? work.items : []).map((it) => (old.relation === 'parent' ? Object.assign({}, it, { link: '' }) : it));
  const next = { name: String(work.name || ''), className: String(work.className || ''), relation: old.relation,
    pending: items.filter((i) => i.status !== '已繳').sort(dashUrgent), all: items };
  ['videoId', 'video', 'wrong'].forEach((k) => { if (Object.prototype.hasOwnProperty.call(old, k)) next[k] = old[k]; });
  return next;
}

/** 通行證上的一位學生 → 學生資料；影片欄位比照 API：本人 video、家長 videoId（只有試用學生）。 */
function dashStudentView(en) {
  const base = { relation: en.relation };
  if (en.relation === 'parent' && en.work.video === true) base.videoId = en.sid;
  if (en.relation === 'self' && en.work.video === true) base.video = true;
  base.wrong = dashParseWrong(en.wrong);
  return dashWithWork(base, en.work);
}

/** 全部文件 → 與 API 相同的回傳。自訂首頁名稱只給本人；錯題更新時間取最後一位有錯題的學生（同 API）。 */
function dashFromDocs(entries, meta) {
  let wrongUpdatedAt = null;
  const students = entries.map((en) => {
    const view = dashStudentView(en);
    if (view.wrong && en.wrong.updatedMs) wrongUpdatedAt = Number(en.wrong.updatedMs);
    return view;
  });
  const self = entries.filter((en) => en.relation === 'self')[0];
  return { ok: true, role: 'member', homeTitle: self ? String(self.work.homeTitle || '') : '',
    syncedAt: meta && typeof meta.syncedAt === 'number' ? meta.syncedAt : null,
    wrongUpdatedAt, students, source: 'firestore' };
}

/** 通行證 → [{ sid, relation }]，本人在前；ID 不合格的略過。 */
function dashEntries(access) {
  const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id && id.indexOf('/') < 0) : []);
  return ids(access.dashSelf).map((sid) => ({ sid, relation: 'self' }))
    .concat(ids(access.dashParent).map((sid) => ({ sid, relation: 'parent' })));
}

/** Apps Script 回來後要不要改用它的結果：老師、或可看的學生（身分＋姓名，不看順序）不同。 */
function dashNeedsApi(shown, res) {
  if (res.role !== 'member') return true;
  const key = (d) => d.students.map((s) => s.relation + '|' + s.name).sort().join('\n');
  return key(shown) !== key(res);
}

/* ---------- Firestore 作業與錯題：讀取與監聽 ---------- */

let dashGen = 0;      // 換帳號、登出、改用 Apps Script 結果時加一；舊的回呼一律不更新畫面
let dashLive = null;  // Firestore 畫出來的畫面才有：{ s, entries, sid（正在監聽的學生）, stop }

function dashEnabled() {
  if (window.DASH_PREVIEW) return true;   // tests/preview.html 用
  if (typeof Video === 'undefined' || !Video.firestore) return false;
  if (DASH_FROM_FIRESTORE === true) return true;
  if (DASH_FROM_FIRESTORE !== 'device') return false;
  try {
    return localStorage.getItem(DASH_DEVICE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

/** ?dash=1 開、?dash=0 關，記在這個瀏覽器；處理完把參數從網址拿掉。 */
function applyDashSwitch() {
  const url = new URL(location.href), value = url.searchParams.get('dash');
  if (value !== '1' && value !== '0') return;
  try {
    if (value === '1') localStorage.setItem(DASH_DEVICE_KEY, '1');
    else localStorage.removeItem(DASH_DEVICE_KEY);
  } catch (e) { /* 無痕模式等存不了：維持原本的行為 */ }
  url.searchParams.delete('dash');
  history.replaceState(null, '', url.href);
}

function stopDash() {
  dashGen++;
  if (dashLive && dashLive.stop) dashLive.stop();
  dashLive = null;
}

/** 讀通行證、meta/dash 與每位學生的兩份文件。任何一步失敗、缺文件、老師都回傳 null，等 Apps Script。 */
async function readDash(token, gen) {
  const live = () => gen === dashGen;
  try {
    const fb = window.DASH_PREVIEW ? await window.DASH_PREVIEW.firebase() : await Video.firestore(token, live);
    if (!fb || !live()) return null;
    const s = fb.s;
    const access = await s.getDocFromServer(s.doc(s.db, 'access', fb.sub));
    if (!access.exists() || access.data().teacher === true) return null;   // 老師不在本階段範圍
    const entries = dashEntries(access.data());
    if (!entries.length) return null;
    const read = (...path) => s.getDocFromServer(s.doc(s.db, ...path));
    const [meta, ...docs] = await Promise.all([read('meta', 'dash')].concat(...entries.map((en) => [
      read('students', en.sid, 'dash', 'work'), read('students', en.sid, 'dash', 'wrong')])));
    if (!meta.exists() || docs.some((d) => !d.exists())) return null;   // 還沒同步過的學生：整個走 Apps Script
    entries.forEach((en, i) => { en.work = docs[2 * i].data(); en.wrong = docs[2 * i + 1].data(); });
    return live() ? { s, entries, meta: meta.data() } : null;
  } catch (e) {
    return null;   // 沒有通行證、連線問題：不顯示錯誤
  }
}

/** 監聽目前選到的學生的作業文件；換孩子時取消舊的。只有 Firestore 畫出來的畫面才監聽。 */
function listenDash() {
  if (!dashLive || !dashboard || dashboard.source !== 'firestore' || selected === null) return;
  const en = dashLive.entries[selected];
  if (!en || dashLive.sid === en.sid) return;
  if (dashLive.stop) dashLive.stop();
  const gen = dashGen, s = dashLive.s, sid = en.sid;
  const live = () => gen === dashGen && !!dashLive && dashLive.sid === sid;
  dashLive.sid = sid;
  dashLive.stop = null;
  dashLive.stop = s.onSnapshot(s.doc(s.db, 'students', sid, 'dash', 'work'), (snap) => {
    if (!live() || !snap.exists()) return;   // 文件被刪（停用、太大）：維持畫面，下次登入走 Apps Script
    applyDashWork(sid, snap.data());
  }, () => {
    if (!live()) return;
    dashLive.stop = null;   // 失敗不顯示錯誤，維持目前畫面；換孩子或回到頁面時再試
    dashLive.sid = null;
  });
}

/** 停止監聽但不換世代：頁面離開（含 bfcache）時用，回來後下一次畫面更新會重新監聽。 */
function pauseDash() {
  if (dashLive && dashLive.stop) dashLive.stop();
  if (dashLive) { dashLive.stop = null; dashLive.sid = null; }
}

/** 監聽到新的作業文件：內容有變才更新；只在首頁、作業頁重畫（保留捲動位置），其他頁下次切過去就是新的。 */
function applyDashWork(sid, work) {
  const i = dashLive.entries.findIndex((en) => en.sid === sid);
  const old = dashboard.students[i];
  if (i < 0 || !old) return;
  const next = dashWithWork(old, work);
  const title = old.relation === 'self' ? String(work.homeTitle || '') : dashboard.homeTitle;
  if (JSON.stringify(next) === JSON.stringify(old) && title === dashboard.homeTitle) return;
  dashLive.entries[i].work = work;
  dashboard.students[i] = next;
  dashboard.homeTitle = title;
  setPageName(memberName());
  if (selected !== i || (view !== 'home' && view !== 'work')) return;
  const y = window.scrollY;
  renderDashboard();
  window.scrollTo(0, y);
}

let lastDashRefresh = -Infinity;

function refreshDash() {
  if (!idToken || !dashLive || !dashLive.stop || !dashboard || dashboard.source !== 'firestore' ||
      dashboard.students[selected]?.relation !== 'self') return;
  const now = Date.now();
  if (now - lastDashRefresh < 60000) return;
  lastDashRefresh = now;
  void callApi(idToken, 'dash.refresh').catch(() => {});
}

async function callApi(token, action) {
  if (window.DASH_PREVIEW) return window.DASH_PREVIEW.api(action);
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 不觸發 CORS 預檢，Apps Script 不支援
    body: JSON.stringify({ idToken: token, action }),
  });
  return r.json();
}

/**
 * 登入後兩條路同時走（規格書 §11）：Firestore 讀到先畫；Apps Script 照舊在背景呼叫（發／續通行證）。
 * Apps Script 回來後：老師或學生名單不同就改用它；拒絕就清掉畫面並登出；其餘不重畫。
 */
async function load() {
  stopDash();
  const gen = dashGen, token = idToken;
  let fsDrawn = false;
  message('讀取中…', ['第一次開啟可能要等幾秒。']);
  // Apps Script 成功回來會呼叫 stopDash 換世代，之後才到的 Firestore 結果自然不會蓋過去。
  const fast = dashEnabled() ? readDash(token, gen).then((got) => {
    if (!got || gen !== dashGen) return;
    dashLive = { s: got.s, entries: got.entries, sid: null, stop: null };
    fsDrawn = true;
    openDashboard(dashFromDocs(got.entries, got.meta));
    refreshDash();
  }) : Promise.resolve();
  let res = null;
  try {
    res = await callApi(token);
  } catch (e) {
    res = null;   // 連不上
  }
  if (gen !== dashGen) return;   // 已登出或重新登入
  if (res && res.ok) {
    if (fsDrawn && !dashNeedsApi(dashboard, res)) return;   // 同一批學生：不重畫，避免跳動；監聽照舊
    stopDash();
    openDashboard(res);
    return;
  }
  if (res && (res.code === 'not_enrolled' || res.code === 'invalid_token' || res.code === 'not_configured')) {
    stopDash();   // 拒絕：清掉畫面並登出 Firebase
    dashboard = null;
    if (dashEnabled() && typeof Video !== 'undefined') Video.signOut().catch(() => {});
    if (res.code === 'not_enrolled') showNotEnrolled(res.email);
    else showLogin(res.code === 'invalid_token' ? '登入已過期，請重新登入。' : '系統尚未完成設定，請聯絡老師。');
    return;
  }
  // 連不上或暫時錯誤：Firestore 已經（或等一下）畫出來就維持，否則照原本顯示重試。
  if (!fsDrawn) await fast;
  if (gen !== dashGen || fsDrawn) return;
  showRetry(res ? '系統暫時無法讀取資料，請稍後再試。' : '連不上伺服器，請確認網路後再試一次。');
}

function showRetry(text) {
  message('讀取失敗', [text], [
    el('button', { class: 'primary', text: '再試一次', on: { click: load } }),
    ' ',
    el('button', { text: '重新登入', on: { click: () => showLogin() } }),
  ]);
}

function showNotEnrolled(email) {
  message('此帳號尚未開通', [
    '目前登入的帳號是 ' + email + '。',
    '如果裝置上有多個 Google 帳號，請換成加入 Classroom 或登記給老師的帳號。還是無法進入，請聯絡老師。',
  ], [el('button', { class: 'primary', text: '換帳號登入', on: { click: signOut } })]);
}

/* ---------- 畫面 ---------- */

const TPE_DATE = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

function formatTime(ms) {
  const p = {};
  TPE_DATE.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return `${p.month}/${p.day}（${p.weekday.replace('週', '')}）${p.hour}:${p.minute}`;
}

function formatDate(ms) {
  const p = {};
  TPE_DATE.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return `${p.month}/${p.day}`;
}

function itemNode(item) {
  const title = item.link
    ? el('a', { class: 'item-title', href: item.link, target: '_blank', rel: 'noopener', text: item.title })
    : el('span', { class: 'item-title', text: item.title });
  const due = item.dueMs !== null ? '截止 ' + formatTime(item.dueMs)
    : item.assignedMs !== null ? '指派 ' + formatDate(item.assignedMs) : '沒有截止時間';
  return el('li', { class: 'item' },
    el('div', { class: 'item-body' }, title,
      el('span', { class: 'item-meta', text: due }),
      // 題數未知（null）就不顯示，不顯示成 0 題
      el('span', { class: 'item-meta', text: item.course + (typeof item.questionCount === 'number' ? '・' + item.questionCount + '題' : '') })),
    el('span', { class: 'badge badge-' + item.status, text: item.status }));
}

function listOrEmpty(items, emptyText) {
  return items.length ? el('ul', { class: 'list' }, items.map(itemNode)) : el('p', { class: 'empty', text: emptyText });
}

function summaryText(st) {
  if (!st.all.length) return '目前沒有作業紀錄';
  if (!st.pending.length) return '作業都交了';
  return `未繳 ${st.pending.length} 份`;
}

/** 學生可在名冊設定自己的名稱；後端只回給本人，家長拿到空字串。 */
function memberName() {
  return dashboard.homeTitle || DEFAULT_NAME;
}

function topbar() {
  return el('div', { class: 'topbar' },
    el('h1', { text: dashboard.role === 'teacher' ? '學生儀表板（老師）' : memberName() }),
    el('button', { text: '登出', on: { click: signOut } }));
}

function footerNode() {
  return el('footer', null,
    el('p', { text: (dashboard.syncedAt ? `資料更新於 ${formatTime(dashboard.syncedAt)}，每小時更新一次。` : '資料尚未同步。')
      + (dashboard.source === 'firestore' && DASH_FROM_FIRESTORE === 'device' ? '（Firestore）' : '') }),   // 試用期間辨認資料來源
    el('details', null,
      el('summary', { text: '把這個頁面加到手機主畫面' }),
      el('p', { text: 'iPhone：用 Safari 開啟，按分享，選「加入主畫面」。' }),
      el('p', { text: 'Android：用 Chrome 開啟，按右上角選單，選「加到主畫面」。' })));
}

function openDashboard(data) {
  dashboard = data;
  view = 'home';
  selected = data.role === 'teacher' ? null : 0;
  if (data.role !== 'teacher') setPageName(memberName());
  if (typeof Video !== 'undefined') {
    if (data.students.some(st => st.video === true)) Video.load(idToken);
    else Video.reset();
  }
  renderDashboard();
  if (hasPet()) {
    Pet.reset();
    Pet.load();   // 背景讀，不拖慢作業頁
  }
}

/** 練習獸讀完或 XP 變了：只換分頁按鈕與首頁小卡，不重畫整頁（不跳回頂端、輸入框不失焦）。 */
function refreshTabs() {
  if (!dashboard || selected === null) return;
  const bottom = useNewLayout();
  const old = app.querySelector(bottom ? '.bottom-tabs' : '.view-tabs');
  if (old) old.replaceWith(bottom ? bottomTabs() : viewTabs());
  const slot = app.querySelector('.home-pet-slot');
  if (slot) fillHomePet(slot, dashboard.students[selected] || dashboard.students[0]);
  const videoSlot = app.querySelector('.home-video-slot');
  if (videoSlot) fillHomeVideo(videoSlot, dashboard.students[selected] || dashboard.students[0]);
}

function videoTab() {
  return typeof Video !== 'undefined' && dashboard && selected !== null && Video.hasTab(dashboard.students[selected]);
}

function fillHomeVideo(slot, st) {
  const card = typeof Video !== 'undefined' && Video.hasTab(st)
    ? Video.homeCard(() => { view = 'video'; renderDashboard(); })
    : typeof Video !== 'undefined' ? Video.parentCard(st) : null;
  slot.replaceChildren(...(card ? [card] : []));
}

/** 首頁練習獸小卡；沒有練習獸分頁（未開放、讀不到、讀取中）就是空的。 */
function fillHomePet(slot, st) {
  const hadFocus = slot.contains(document.activeElement);
  const card = hasPet() ? Pet.homeCard(selected, st, () => { view = 'pet'; renderDashboard(); }) : null;
  slot.replaceChildren(...(card ? [card] : []));
  if (hadFocus && card) card.focus({ preventScroll: true });
}

function petTab() {
  return hasPet() && dashboard && selected !== null && Pet.hasTab(selected, dashboard.students[selected]);
}

/** 新配置只開給學生本人；網址開關只由本機預覽頁提供。 */
function useNewLayout() {
  if (!dashboard || selected === null || dashboard.role === 'teacher') return false;
  const st = dashboard.students[selected] || dashboard.students[0];
  return !!st && st.relation === 'self' && (NEW_LAYOUT_FOR_ALL || videoTab()
    || !!(window.DASHBOARD_PREVIEW && window.DASHBOARD_LAYOUT_PREVIEW));
}

/** 只有新版啟用安全區；其他身分的 viewport 與原版完全相同。 */
function setBottomLayout(on) {
  const wasOn = app.classList.contains('student-bottom-layout');
  app.classList.toggle('student-bottom-layout', on);
  if (wasOn === on) return;
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) viewport.content = on ? viewport.content + ', viewport-fit=cover'
    : viewport.content.replace(', viewport-fit=cover', '');
}

/* 老師：學生清單。只重畫結果區，打字時輸入框不會失去焦點。 */
function studentRow(st, index) {
  const state = !st.all.length ? '沒有作業紀錄'
    : !st.pending.length ? '都交了'
      : `未繳 ${st.pending.length}`;
  return el('li', null, el('button', {
    class: 'student-row',
    on: { click: () => { selected = index; view = 'home'; wrongPeriod = null; if (hasPet()) Pet.cancelFlow(); renderDashboard(); } },
  },
  el('span', { class: 'student-name', text: st.name }),
  el('span', { class: 'student-class', text: st.className }),
  el('span', { class: 'student-state', text: state })));
}

function renderTeacherList() {
  const count = el('p', { class: 'result-count', role: 'status' });
  const results = el('div');
  const update = () => {
    const q = teacherFilter.q.trim();
    const hits = dashboard.students
      .map((st, i) => ({ st, i }))
      .filter(({ st }) => (!q || st.name.includes(q)) && (!teacherFilter.cls || st.className === teacherFilter.cls));
    count.textContent = `共 ${dashboard.students.length} 位學生，顯示 ${hits.length} 位`;
    results.replaceChildren(hits.length
      ? el('ul', { class: 'list' }, hits.map(({ st, i }) => studentRow(st, i)))
      : el('p', { class: 'empty', text: '找不到符合的學生。' }));
  };
  const search = el('input', {
    type: 'search', 'aria-label': '搜尋學生姓名', placeholder: '搜尋姓名',
    on: { input: (e) => { teacherFilter.q = e.target.value; update(); } },
  });
  search.value = teacherFilter.q;
  const classes = [...new Set(dashboard.students.map((s) => s.className).filter(Boolean))].sort();
  const classSelect = el('select', {
    'aria-label': '依班級篩選',
    on: { change: (e) => { teacherFilter.cls = e.target.value; update(); } },
  },
  el('option', { value: '', text: '全部班級' }),
  classes.map((c) => el('option', { value: c, text: c })));
  classSelect.value = teacherFilter.cls;
  update();
    show(topbar(), dashboard.role === 'teacher' ? el('p', null, el('a', { href: 'teacher/', text: '影片指派' })) : null,
      el('div', { class: 'filters' }, search, classSelect), count, results, footerNode());
}

/* 錯題分頁 */
function shortDate(text) {
  const m = /^\d{4}-(\d{1,2})-(\d{1,2})/.exec(text || '');
  return m ? `${Number(m[1])}/${Number(m[2])}` : '';
}

function statTile(value, label) {
  return el('div', { class: 'tile' }, el('b', { text: value }), el('small', { text: label }));
}

function paperDetail(p) {
  const total = p.ok + p.bad;
  return `${shortDate(p.date)} ${p.name}：答對 ${p.ok} 題，答錯 ${p.bad} 題（${Math.round(p.ok / total * 100)}%）`;
}

function paperChart(papers) {
  const CHART_PX = 118;
  const max = Math.max(...papers.map((p) => p.ok + p.bad));
  const detail = el('p', { class: 'chart-detail', role: 'status' });
  const select = (index) => {
    detail.textContent = paperDetail(papers[index]);
    [...bars.children].forEach((b, i) => {
      b.classList.toggle('selected', i === index);
      b.setAttribute('aria-pressed', String(i === index));
    });
  };
  const bars = el('div', { class: 'chart-bars' }, papers.map((p, i) => {
    const bad = el('i', { class: 'mark-bad' });
    bad.style.height = `${p.bad / max * CHART_PX}px`;
    const ok = el('i', { class: 'mark-ok' });
    ok.style.height = `${p.ok / max * CHART_PX}px`;
    return el('button', {
      class: 'chart-col', 'aria-label': paperDetail(p),
      on: { click: () => select(i), mouseenter: () => select(i) },
    }, bad, ok);
  }));
  const chart = el('div', null,
    el('div', { class: 'chart-legend' },
      el('span', null, el('i', { class: 'swatch mark-ok' }), '答對'),
      el('span', null, el('i', { class: 'swatch mark-bad' }), '答錯')),
    bars,
    el('div', { class: 'chart-axis' }, papers.map((p) => el('span', { text: shortDate(p.date) }))),
    detail,
    el('details', null,
      el('summary', { text: '看每張卷的數字' }),
      el('ul', { class: 'paper-table' }, [...papers].reverse().map((p) => el('li', null,
        el('span', { text: `${shortDate(p.date)} ${p.name}` }),
        el('span', { class: 'nums', text: `對 ${p.ok}・錯 ${p.bad}` }))))));
  select(papers.length - 1);
  return chart;
}

function wrongItemNode(item) {
  const marks = item.seq.map((ok) => el('span', {
    class: 'attempt ' + (ok ? 'mark-ok' : 'mark-bad'), 'aria-label': ok ? '答對' : '答錯', text: ok ? '○' : '×',
  }));
  const where = `${item.paper} 第 ${item.pos} 題`;
  const title = item.lecture || where;
  const meta = (item.lecture ? [where, shortDate(item.date)] : [item.source, shortDate(item.date)]).filter(Boolean).join('・');
  const urgent = item.note.startsWith('反覆錯');
  return el('li', { class: 'item wrong-item' },
    el('span', { class: 'item-title', text: title }),
    el('span', { class: 'item-meta', text: meta }),
    el('div', { class: 'attempts' }, marks,
      el('span', { class: 'attempt-note' + (urgent ? ' urgent' : ''), text: item.note })));
}

/** 依冊、章分組；冊與章都由小到大，查不到的排最後。章預設收合，先看題數。 */
function wrongGroups(items) {
  const books = new Map();
  items.forEach((item) => {
    const book = item.book || '其他';
    if (!books.has(book)) books.set(book, new Map());
    const chapters = books.get(book);
    const chapter = item.chapter === null || item.chapter === undefined ? null : item.chapter;
    if (!chapters.has(chapter)) chapters.set(chapter, []);
    chapters.get(chapter).push(item);
  });
  const nodes = [];
  [...books.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true })).forEach((book) => {
    const chapters = books.get(book);
    const total = [...chapters.values()].reduce((sum, list) => sum + list.length, 0);
    nodes.push(el('h3', { text: `${book}・${total} 題` }));
    [...chapters.keys()].sort((a, b) => (a === null) - (b === null) || a - b).forEach((chapter) => {
      // 依講義順序；沒有講解編號的排最後
      const orderOf = (i) => (i.order === null || i.order === undefined ? Infinity : i.order);
      const list = [...chapters.get(chapter)].sort((a, b) => (orderOf(a) === orderOf(b) ? 0 : orderOf(a) - orderOf(b)));
      const open = list.filter((i) => i.active).length;
      nodes.push(el('details', { class: 'chapter-group' },
        el('summary', null,
          el('span', { class: 'chapter-name', text: chapter === null ? '未分類' : `第 ${chapter} 章` }),
          el('span', { class: 'chapter-count', text: open ? `${list.length} 題・未過關 ${open}` : `${list.length} 題・都過關了` })),
        el('ul', { class: 'list' }, list.map(wrongItemNode))));
    });
  });
  return nodes;
}

function wrongSection(st) {
  const original = st.wrong;
  const periods = original && original.periods;
  const chosen = periods && wrongPeriod !== 'all' && (periods.find(p => p.id === wrongPeriod) || periods.find(p => p.start <= new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) && p.end >= new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })));
  const w = chosen ? chosen.data : original;
  const picker = periods ? el('select', { 'aria-label': '月考區間', on: { change: e => { wrongPeriod = e.target.value; renderDashboard(); } } },
    el('option', { value: 'all', text: '全部歷史紀錄' }), periods.map(p => el('option', { value: p.id, text: `${p.name}（${p.start}～${p.end}）` }))) : null;
  if (picker) picker.value = chosen ? chosen.id : 'all';
  if (!w || (!w.papers.length && !w.recent.length)) {
    return [picker, el('p', { class: 'empty wrong-empty', text: '還沒有錯題紀錄。' })];
  }
  const retests = w.reOk + w.reBad;
  const latest = w.papers[w.papers.length - 1];
  return [
    picker,
    el('div', { class: 'tiles' },
      statTile(String(w.active), '題還沒訂正回來'),
      statTile(retests ? `${Math.round(w.reOk / retests * 100)}%` : '－', retests ? '錯題再考答對率' : '還沒有再考紀錄'),
      latest ? statTile(`${latest.ok}/${latest.ok + latest.bad}`, '最近一張卷') : null),
    el('h2', { text: '每張卷的答對與答錯' }),
    w.papers.length ? paperChart(w.papers) : el('p', { class: 'empty', text: '還沒有卷子紀錄。' }),
    el('h2', { text: `所有錯題（${w.recent.length}）` }),
    ...(w.recent.length ? wrongGroups(w.recent) : [el('p', { class: 'empty', text: '目前沒有錯題。' })]),
    dashboard.wrongUpdatedAt ? el('p', { class: 'result-count wrong-updated', text: `錯題資料更新於 ${formatTime(dashboard.wrongUpdatedAt)}。` }) : null,
  ];
}

function viewTabs() {
  const tab = (key, label) => el('button', {
    'aria-pressed': String(view === key), text: label,
    on: { click: () => { view = key; renderDashboard(); } },
  });
  return el('div', { class: videoTab() ? 'view-tabs video-tabs' : 'view-tabs', role: 'group', 'aria-label': '選擇內容' },
    tab('home', '首頁'), videoTab() ? tab('video', '影片') : null, tab('work', '作業'), tab('wrong', '錯題'), petTab() ? tab('pet', '練習獸') : null);
}

function bottomTabs() {
  const paths = {
    home: 'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9',
    video: 'M4 4h16v16H4zM10 8l6 4-6 4z',
    work: 'M8 5H5v16h14V5h-3M8 3h8v4H8zM8 12h8M8 16h6',
    wrong: 'M4 3h12l4 4v14H4zM15 3v5h5M9 12l6 6M15 12l-6 6',
    pet: 'M8 10 5 5l-2 8c0 5 4 8 9 8s9-3 9-8l-2-8-3 5M8 14h.01M16 14h.01M10 17q2 2 4 0',
  };
  const tab = (key, label) => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    Object.entries({ viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })
      .forEach(([name, value]) => icon.setAttribute(name, value));
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[key]);
    icon.append(path);
    return el('button', { type: 'button', 'aria-current': view === key ? 'page' : null,
      on: { click: () => { view = key; renderDashboard(); } } }, icon, el('span', { text: label }));
  };
  return el('nav', { class: 'bottom-tabs', 'aria-label': '選擇內容' },
    tab('home', '首頁'), videoTab() ? tab('video', '影片') : null,
    tab('work', '作業'), tab('wrong', '錯題'), petTab() ? tab('pet', '練習獸') : null);
}

function homeSection(st) {
  const w = st.wrong;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const period = w && w.periods && w.periods.find(p => p.start <= today && today <= p.end);
  const scoped = w && w.periods;
  const count = period ? period.data.active : scoped ? '－' : w ? w.active : '－';
  const card = (key, title, value, caption) => el('button', { class: 'home-card', on: { click: () => { view = key; wrongPeriod = null; renderDashboard(); } } },
    el('span', { text: title }), el('strong', { text: value }), el('small', { text: caption + ' ›' }));
  if (useNewLayout()) {
    const videoSlot = el('div', { class: 'home-video-slot home-cards' });
    fillHomeVideo(videoSlot, st);
    const petSlot = el('div', { class: 'home-pet-slot' });
    fillHomePet(petSlot, st);
    const periodNote = period ? `${period.name} · ${period.start}～${period.end} · 查看本區間錯題`
      : scoped ? '目前沒有可用的月考區間 · 查看歷史錯題' : '查看錯題整理';
    return [videoTab() ? videoSlot : null,
      el('div', { class: 'home-cards' },
        card('work', '未繳作業', `${st.pending.length} 份`, '查看作業進度'),
        card('wrong', '尚未過關', `${count} 題`, periodNote)), petSlot];
  }
  return [
    el('section', { class: 'home-intro' }, el('h2', { text: '看看目前的學習進度' }),
      el('p', { text: period ? `${period.name} · ${period.start}～${period.end}` : scoped ? '目前沒有可用的月考區間' : '作業與錯題整理' })),
    el('div', { class: 'home-cards' },
      card('work', '未繳作業', `${st.pending.length} 份`, '查看作業進度'),
      card('wrong', '尚未過關', `${count} 題`, period ? '查看本區間錯題' : scoped ? '查看歷史錯題' : '查看錯題整理')),
    ...(videoTab() || (typeof Video !== 'undefined' && Video.hasParentCard(st))
      ? [(() => { const slot = el('div', { class: 'home-video-slot home-cards' }); fillHomeVideo(slot, st); return slot; })()] : []),
    (() => { const slot = el('div', { class: 'home-pet-slot' }); fillHomePet(slot, st); return slot; })(),
    el('h2', { text: '現在先處理' }),
    listOrEmpty(st.pending.slice(0, 3), '目前沒有未繳作業。'),
  ];
}

function workSection(st) {
  return [
    el('p', { class: 'summary', text: summaryText(st) }),
    el('h2', { text: `未繳作業（${st.pending.length}）` }),
    listOrEmpty(st.pending, '目前沒有未繳作業。'),
    el('h2', { text: `全部作業（${st.all.length}）` }),
    listOrEmpty(st.all, '還沒有派發的作業。'),
  ];
}

function renderDashboard() {
  if (selected === null) {
    renderTeacherList();
    return;
  }
  const st = dashboard.students[selected] || dashboard.students[0];
  listenDash();   // Firestore 畫面：監聽選到的學生（換孩子就換監聽）
  if (typeof Video !== 'undefined') Video.selectParent(idToken, dashboard.role === 'teacher' ? null : st);
  const bottom = useNewLayout();
  if (view === 'pet' && !petTab()) view = 'home';   // 換了沒開放的孩子
  if (view === 'video' && !videoTab()) view = 'home';
  if (typeof Video !== 'undefined' && view !== 'video') Video.afterRender(false);
  bottomNext = bottom;
  show(
    topbar(),
    dashboard.role === 'teacher'
      ? el('div', { class: 'back' }, el('button', { text: '回學生清單', on: { click: () => { selected = null; renderDashboard(); } } }))
      : null,
    dashboard.role !== 'teacher' && dashboard.students.length > 1
      ? el('div', { class: 'chooser', role: 'group', 'aria-label': '選擇孩子' },
        dashboard.students.map((s, i) => el('button', {
          'aria-pressed': String(s === st), text: s.name,
          on: { click: () => { selected = i; view = 'home'; wrongPeriod = null; if (hasPet()) Pet.cancelFlow(); renderDashboard(); } },
        })))
      : null,
    el('p', { class: 'who' }, st.name, st.className ? el('span', { text: st.className }) : null),
    bottom ? null : viewTabs(),
    ...(view === 'home' ? homeSection(st) : view === 'wrong' ? wrongSection(st) : view === 'video' ? Video.section() : view === 'pet' ? Pet.section(selected, st) : workSection(st)),
    footerNode(), bottom ? bottomTabs() : null);
  if (view === 'pet') Pet.afterRender();
  if (view === 'video') Video.afterRender(true);
}

/* ---------- 啟動 ---------- */

if (typeof Video !== 'undefined') Video.init({ changed: refreshTabs });

if (hasPet()) {
  Pet.init({
    call: apiCall,
    rerender: () => { if (dashboard && selected !== null) renderDashboard(); },
    onLoaded: refreshTabs,
    onChanged: refreshTabs,
    onExpired: () => showLogin('登入已過期，請重新登入。'),
    isShowing: () => !!dashboard && selected !== null && view === 'pet',
  });
}

// 離開頁面（含進入 bfcache）停止監聽；回來時重新監聽。換帳號、登出另由 stopDash 處理。
window.addEventListener('pagehide', pauseDash);
window.addEventListener('pageshow', (e) => { if (e.persisted) listenDash(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshDash();
});

if (window.DASH_PREVIEW) {   // tests/preview.html 的 ?dashfs=：虛構的 Firestore 與 Apps Script
  idToken = 'preview-token';
  load();
} else if (window.DASHBOARD_PREVIEW) {   // tests/preview.html 用，正式頁面不會有
  openDashboard(window.DASHBOARD_PREVIEW);
} else {
  applyDashSwitch();
  const browser = inAppBrowser();
  if (browser === 'blocked') showInAppNotice();
  else if (browser === 'ok') {
    showLogin();
    fetch(API_URL).catch(() => {});   // 趁使用者按登入前先喚醒後端，失敗不影響登入
  }
}
