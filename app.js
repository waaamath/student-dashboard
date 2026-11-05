'use strict';

// 這兩個值都是公開資訊，資料的把關在後端（token 驗證 + 名冊）。
const CLIENT_ID = '863861496583-i8ttdlflo03fscvcbvdc3hibqds4v7rn.apps.googleusercontent.com';
const API_URL = 'https://script.google.com/macros/s/AKfycbxvwBJFQMB-fsjs4Nbw1HhQVZVgcFqIWjOTiYAt04A-rviphe3xK7MmKCwluvJ8pAkv/exec';

const app = document.getElementById('app');
let idToken = null;    // 只放記憶體，關掉頁面就沒了
let dashboard = null;
let selected = 0;      // 老師在學生清單時為 null
let teacherFilter = { q: '', cls: '' };
let view = 'work';     // 'work' 作業、'wrong' 錯題

/** 建立元素；文字一律走 textContent，作業標題不會被當成 HTML。 */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.entries(props || {}).forEach(([k, v]) => {
    if (k === 'on') Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
    else if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  });
  children.flat().forEach((c) => c && node.append(c));
  return node;
}

function show(...nodes) {
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

function showLogin(note) {
  idToken = null;
  dashboard = null;
  selected = 0;
  teacherFilter = { q: '', cls: '' };
  view = 'work';
  const box = el('div', { class: 'signin' });
  show(el('div', { class: 'message login' },
    el('h1', { text: '我的學習小站' }),
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
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  showLogin('已登出。如果這是共用裝置，也請到系統設定移除自己的 Google 帳號。');
}

function onCredential(response) {
  idToken = response.credential;
  load();
}

/* ---------- 讀資料 ---------- */

async function load() {
  message('讀取中…', ['第一次開啟可能要等幾秒。']);
  let res;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 不觸發 CORS 預檢，Apps Script 不支援
      body: JSON.stringify({ idToken }),
    });
    res = await r.json();
  } catch (e) {
    showRetry('連不上伺服器，請確認網路後再試一次。');
    return;
  }
  if (res.ok) {
    openDashboard(res);
  } else if (res.code === 'not_enrolled') {
    showNotEnrolled(res.email);
  } else if (res.code === 'invalid_token') {
    showLogin('登入已過期，請重新登入。');
  } else if (res.code === 'not_configured') {
    showLogin('系統尚未完成設定，請聯絡老師。');
  } else {
    showRetry('系統暫時無法讀取資料，請稍後再試。');
  }
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
      el('span', { class: 'item-meta', text: item.course })),
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

function topbar() {
  return el('div', { class: 'topbar' },
    el('h1', { text: dashboard.role === 'teacher' ? '學生儀表板（老師）' : '我的學習小站' }),
    el('button', { text: '登出', on: { click: signOut } }));
}

function footerNode() {
  return el('footer', null,
    el('p', { text: dashboard.syncedAt ? `資料更新於 ${formatTime(dashboard.syncedAt)}，每小時更新一次。` : '資料尚未同步。' }),
    el('details', null,
      el('summary', { text: '把這個頁面加到手機主畫面' }),
      el('p', { text: 'iPhone：用 Safari 開啟，按分享，選「加入主畫面」。' }),
      el('p', { text: 'Android：用 Chrome 開啟，按右上角選單，選「加到主畫面」。' })));
}

function openDashboard(data) {
  dashboard = data;
  selected = data.role === 'teacher' ? null : 0;
  renderDashboard();
}

/* 老師：學生清單。只重畫結果區，打字時輸入框不會失去焦點。 */
function studentRow(st, index) {
  const state = !st.all.length ? '沒有作業紀錄'
    : !st.pending.length ? '都交了'
      : `未繳 ${st.pending.length}`;
  return el('li', null, el('button', {
    class: 'student-row',
    on: { click: () => { selected = index; renderDashboard(); } },
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
  show(topbar(), el('div', { class: 'filters' }, search, classSelect), count, results, footerNode());
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
  const w = st.wrong;
  if (!w || (!w.papers.length && !w.recent.length)) {
    return [el('p', { class: 'empty wrong-empty', text: '還沒有錯題紀錄。' })];
  }
  const retests = w.reOk + w.reBad;
  const latest = w.papers[w.papers.length - 1];
  return [
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
  return el('div', { class: 'view-tabs', role: 'group', 'aria-label': '選擇內容' }, tab('work', '作業'), tab('wrong', '錯題'));
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
  show(
    topbar(),
    dashboard.role === 'teacher'
      ? el('div', { class: 'back' }, el('button', { text: '回學生清單', on: { click: () => { selected = null; renderDashboard(); } } }))
      : null,
    dashboard.role !== 'teacher' && dashboard.students.length > 1
      ? el('div', { class: 'chooser', role: 'group', 'aria-label': '選擇孩子' },
        dashboard.students.map((s, i) => el('button', {
          'aria-pressed': String(s === st), text: s.name,
          on: { click: () => { selected = i; renderDashboard(); } },
        })))
      : null,
    el('p', { class: 'who' }, st.name, st.className ? el('span', { text: st.className }) : null),
    viewTabs(),
    ...(view === 'wrong' ? wrongSection(st) : workSection(st)),
    footerNode());
}

/* ---------- 啟動 ---------- */

if (window.DASHBOARD_PREVIEW) {   // tests/preview.html 用，正式頁面不會有
  openDashboard(window.DASHBOARD_PREVIEW);
} else {
  const browser = inAppBrowser();
  if (browser === 'blocked') showInAppNotice();
  else if (browser === 'ok') {
    showLogin();
    fetch(API_URL).catch(() => {});   // 趁使用者按登入前先喚醒後端，失敗不影響登入
  }
}
