'use strict';

// 練習獸畫面。XP、等級、測驗計分與孵化結果都由後端決定，這裡只顯示與送出選擇。
// 練習獸名字是使用者輸入：一律走 el() 的 textContent，不當 HTML。
// 用到 app.js 的 el、formatTime、formatDate（呼叫時才用，載入順序不受影響）。

const Pet = (() => {
  const NAME_MAX = 10;
  const ERRORS = {
    network: '連不上伺服器，請確認網路後再試一次。',
    busy: '現在比較忙，請稍後再按一次。',
    server_error: '系統暫時有問題，請稍後再按一次。',
    game_disabled: '練習獸暫停中。',
    game_unavailable: '練習獸暫時讀不到，請稍後再試。',
    read_only: '只有學生本人可以操作。',
    not_available: '目前還沒開放練習獸。',
    bad_answers: '有題目還沒回答。',
    bad_request: '請重新整理頁面後再試一次。',
    request_conflict: '請再按一次。',
    not_hatched: '還沒孵化，請重新整理頁面。',
    name_empty: '請輸入名字。',
    name_too_long: `名字最多 ${NAME_MAX} 個字。`,
    name_invalid: '名字只能用文字、數字、空白和 - _ ・，而且要用文字或數字開頭。',
  };

  const CHECK_GAP_MS = 20000;   // 回到頁面時，距上次檢查超過這麼久才再查（後端也有冷卻）

  let opts = null;   // { call(body) → Promise, rerender(), onLoaded(), onExpired(), isShowing() }
  let data = { status: 'idle', games: [], awardedAt: null };
  // 即時檢查剛交的作業：checking 進行中；gain＝剛拿到的獎勵（顯示用）；note＝按鈕按下後的結果文字
  let live = { checking: false, lastAt: 0, gain: null, note: '' };
  let flow = null;   // 正在進行的孵化／命名：{ slot, step, qi, answers, pending, error, draft, busy }
  let focusNext = false;   // 換步驟後把焦點移到新內容（螢幕閱讀器與鍵盤使用者）

  /** 畫面重畫的入口：需要時順便移焦點。 */
  function redraw(moveFocus) {
    if (moveFocus) focusNext = true;
    opts.rerender();
  }

  function afterRender() {
    if (!focusNext) return;
    focusNext = false;
    const target = document.querySelector('#app [data-focus]');
    if (target) target.focus({ preventScroll: true });
  }

  function init(o) {
    opts = o;
    document.addEventListener('visibilitychange', () => {   // 去 Classroom 交完作業切回來，就自動再查一次
      if (document.visibilityState === 'visible' && Date.now() - live.lastAt > CHECK_GAP_MS) check(false);
    });
  }

  function reset() {
    data = { status: 'idle', games: [], awardedAt: null };
    live = { checking: false, lastAt: 0, gain: null, note: '' };
    flow = null;
  }

  function cancelFlow() { flow = null; }

  async function send(body) {
    try {
      return await opts.call(body);
    } catch (e) {
      return { ok: false, code: 'network' };
    }
  }

  /** 作業資料顯示後才在背景讀；失敗只是不顯示練習獸，作業頁照常。 */
  async function load() {
    data.status = 'loading';
    const res = await send({ action: 'game.get' });
    if (res.ok) data = { status: res.enabled ? 'ready' : 'off', games: res.games || [], awardedAt: res.awardedAt || null };
    else data.status = res.code === 'invalid_token' ? 'expired' : 'error';
    opts.onLoaded();
    check(false);
  }

  /** 查學生本人在 Classroom 剛交的作業，有新的就立刻加 XP。manual＝按了按鈕（要顯示結果）。 */
  async function check(manual) {
    const mine = data.status === 'ready' && data.games.find((g) => g.canAct);
    if (!mine || live.checking) return;
    live.checking = true;
    live.note = '';
    if (manual) showChange();
    const before = mine.level;
    const res = await send({ action: 'game.check' });
    live.checking = false;
    live.lastAt = Date.now();
    if (data.status !== 'ready') return;   // 中途登出
    if (res.ok && res.added && res.added.length) {
      if (res.game) replaceGame(res.game);
      const total = res.added.reduce((s, a) => s + (Number(a.xp) || 0), 0);
      live.gain = { slot: mine.slot, total, items: res.added, levelUp: res.game && res.game.level > before ? res.game.level : null };
    } else if (res.code === 'invalid_token') {
      opts.onExpired();
      return;
    } else if (manual) {
      live.note = res.ok ? (res.checked ? '沒有找到新繳交的作業。剛交的話等幾秒再按一次。' : '剛剛才檢查過，稍等一下再按。') : errorText(res.code);
    }
    showChange();
  }

  /** 正在看練習獸、沒有在孵化或取名時才重畫，不打斷操作。 */
  function showChange() {
    if (!flow && opts.isShowing && opts.isShowing()) opts.rerender();
  }

  function gameFor(index, student) {
    if (data.status !== 'ready' || !student) return null;
    return data.games.find((g) => g.slot === index && g.name === student.name) || null;
  }

  function hasTab(index, student) { return !!gameFor(index, student); }

  function replaceGame(game) {
    data.games = data.games.map((g) => (g.slot === game.slot ? game : g));
  }

  function newRequestId() {
    if (window.crypto && crypto.randomUUID) return 'r-' + crypto.randomUUID();
    let s = 'r-' + Date.now().toString(36);
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  function errorText(code) { return ERRORS[code] || ERRORS.server_error; }

  /* ---------- 素材 ---------- */

  function assets() {
    const A = window.PET_ASSETS;
    if (A && A.stage && Array.isArray(A.items)) return A;
    return { stage: { width: 240, height: 240 }, items: [], species: {}, missing: { src: '', alt: '練習獸' } };
  }

  function pickAsset(species, stage, state) {
    const A = assets();
    const find = (sp, st) => A.items.find((i) => i.species === sp && i.stage === stage && i.state === st);
    return find(species, state) || find(species, '*') || find('*', state) || find('*', '*') || A.missing;
  }

  function speciesLabel(species) {
    const s = assets().species || {};
    return (s[species] && s[species].label) || '';
  }

  /** 角色顯示框：比例固定、文字在框外，正式素材換上來不會影響排版。 */
  function artNode(species, stage, state, motion) {
    const A = assets(), item = pickAsset(species, stage, state);
    const box = el('div', { class: 'pet-stage ' + (motion || ''), role: 'img', 'aria-label': item.alt || '練習獸' });
    box.style.maxWidth = `${A.stage.width}px`;
    box.style.aspectRatio = `${A.stage.width} / ${A.stage.height}`;
    const fallback = () => el('div', { class: 'pet-fallback', text: '圖片暫時無法顯示' });
    if (!item.src) {
      box.append(fallback());
      return box;
    }
    const img = el('img', { src: new URL(item.src, A.base || location.href).href, alt: '', draggable: 'false', decoding: 'async' });
    img.style.width = `${(typeof item.scale === 'number' ? item.scale : 0.8) * 100}%`;
    img.style.bottom = `${(typeof item.offsetY === 'number' ? item.offsetY : 0) * 100}%`;
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    box.append(img);
    return box;
  }

  /* ---------- 畫面 ---------- */

  function updatedNote(g) {
    const last = data.awardedAt ? `最後全面更新 ${formatTime(data.awardedAt)}。` : '';
    if (!g.canAct) return el('p', { class: 'pet-note', text: `學生繳交作業後依題數獲得 XP：學生打開這頁時立刻更新，其他時候約一小時更新一次。${last}` });
    return el('section', { class: 'pet-check' },
      el('p', { class: 'pet-note', text: `在 Classroom 繳交作業後回到這頁，就會依題數加 XP（紙本作業約一小時更新）。${last}` }),
      el('button', { class: 'pet-link', text: live.checking ? '檢查中…' : '我剛交了作業', disabled: live.checking ? '' : null,
        on: { click: () => check(true) } }),
      live.note ? el('p', { class: 'pet-note', role: 'status', text: live.note }) : null);
  }

  /** 剛拿到的獎勵。 */
  function gainNode(g) {
    const gain = live.gain;
    if (!gain || gain.slot !== g.slot) return null;
    return el('section', { class: 'pet-gain', role: 'status' },
      el('b', { text: `+${gain.total} XP` }),
      el('span', { text: gain.items.length === 1 ? `剛交的「${gain.items[0].title || '作業'}」` : `剛交的 ${gain.items.length} 份作業` }),
      gain.levelUp ? el('span', { class: 'pet-levelup', text: `升到 Lv.${gain.levelUp}！` }) : null);
  }

  function levelNode(g) {
    const span = g.nextLevelXp === null ? 1 : g.nextLevelXp - g.levelFloorXp;
    const into = g.nextLevelXp === null ? 1 : g.xp - g.levelFloorXp;
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(1, into / span)) * 100}%`;
    return el('section', { class: 'pet-level' },
      el('div', { class: 'pet-level-row' },
        el('b', { text: `Lv.${g.level}` }),
        el('span', { text: `累積 ${g.xp} XP` })),
      el('div', {
        class: 'pet-bar', role: 'progressbar', 'aria-label': '升級進度',
        'aria-valuemin': '0', 'aria-valuemax': String(span), 'aria-valuenow': String(Math.max(0, Math.min(span, into))),
      }, fill),
      el('p', { class: 'pet-next', text: g.nextLevelXp === null ? '已經是目前最高等級。' : `再 ${g.nextLevelXp - g.xp} XP 升到 Lv.${g.level + 1}` }),
      g.levelIsTest ? el('p', { class: 'pet-note', text: '等級表還在測試，之後可能調整。' }) : null);
  }

  function recentNode(g) {
    if (!g.recent.length) return [el('h3', { class: 'pet-recent-title', text: '最近獲得' }), el('p', { class: 'empty', text: '還沒有獎勵紀錄。交作業就會累積 XP。' })];
    return [el('h3', { class: 'pet-recent-title', text: '最近獲得' }), el('ul', { class: 'list pet-recent' }, g.recent.map((r) => el('li', { class: 'item' },
      el('div', { class: 'item-body' },
        el('span', { class: 'item-title', text: r.title || '作業' }),
        el('span', { class: 'item-meta', text: [r.type === 'correction' ? '題數更正' : (r.count !== null ? `${r.count} 題` : ''),
          r.at ? formatDate(r.at) : ''].filter(Boolean).join('・') })),
      el('span', { class: 'pet-xp' + (r.xp < 0 ? ' minus' : ''), text: `${r.xp > 0 ? '+' : ''}${r.xp} XP` }))))];
  }

  function eggView(g, st) {
    return [
      artNode(null, 'egg', 'idle', 'is-egg'),
      gainNode(g),
      el('section', { class: 'pet-info' },
        el('h2', { text: g.canAct ? '你的練習獸還在蛋裡' : `${st.name} 的練習獸還在蛋裡`, tabindex: '-1', 'data-focus': '' }),
        el('p', { text: `目前已累積 ${g.xp} XP，孵化後會一起算進去。` }),
        g.canAct ? el('p', { text: `回答 ${g.quiz ? g.quiz.questions.length : 5} 個小問題，看看會孵出哪一種練習獸。` })
          : el('p', { text: '學生本人登入後才能孵化，這裡只能查看。' }),
        g.canAct && g.quiz ? el('button', { class: 'primary', text: '開始孵化', on: { click: () => startQuiz(g) } }) : null),
      updatedNote(g),
    ];
  }

  function mainView(g, st) {
    return [
      artNode(g.speciesId, g.stage, g.visualState, live.gain && live.gain.slot === g.slot ? 'is-happy' : g.visualState === 'happy' ? 'is-happy' : 'is-idle'),
      gainNode(g),
      el('section', { class: 'pet-info' },
        el('h2', { class: 'pet-name', text: g.petName || (g.canAct ? '還沒取名字' : `${st.name} 的練習獸`), tabindex: '-1', 'data-focus': '' }),
        speciesLabel(g.speciesId) ? el('p', { class: 'pet-species', text: speciesLabel(g.speciesId) }) : null,
        g.canAct ? el('button', { class: g.petName ? 'pet-link' : 'primary', text: g.petName ? '改名字' : '幫牠取名字',
          on: { click: () => startNaming(g) } }) : null),
      levelNode(g),
      ...recentNode(g),
      updatedNote(g),
    ];
  }

  function startQuiz(g) {
    flow = { slot: g.slot, step: 'quiz', qi: 0, answers: {}, pending: null, error: '', quiz: g.quiz };
    redraw(true);
  }

  function startNaming(g) {
    flow = { slot: g.slot, step: 'naming', pending: null, error: '', draft: g.petName || '', rename: !!g.petName };
    redraw(true);
  }

  function quizView() {
    const q = flow.quiz.questions[flow.qi], total = flow.quiz.questions.length;
    return [
      el('p', { class: 'pet-progress', text: `第 ${flow.qi + 1}／${total} 題` }),
      el('h2', { text: q.text, tabindex: '-1', 'data-focus': '' }),
      el('div', { class: 'pet-options', role: 'group', 'aria-label': q.text }, q.options.map((o) => el('button', {
        'aria-pressed': String(flow.answers[q.id] === o.id), text: o.text,
        on: { click: () => {
          if (flow.answers[q.id] !== o.id) flow.pending = null;   // 答案變了就是新的請求
          flow.answers[q.id] = o.id;
          flow.qi += 1;
          if (flow.qi >= total) flow.step = 'confirm';
          redraw(true);
        } },
      }))),
      el('div', { class: 'pet-actions' },
        el('button', { text: flow.qi ? '上一題' : '先不要', on: { click: () => {
          if (flow.qi) flow.qi -= 1; else flow = null;
          redraw(true);
        } } })),
    ];
  }

  function confirmView() {
    return [
      artNode(null, 'egg', 'idle', flow.busy ? 'is-hatching' : 'is-egg'),
      el('section', { class: 'pet-info' },
        el('h2', { text: flow.busy ? '孵化中…' : '都回答完了！', tabindex: '-1', 'data-focus': '' }),
        el('p', { text: flow.busy ? '請稍等，不要關掉頁面。' : '孵化之後就不能重來，確定的話就按孵化。' }),
        flow.error ? el('p', { class: 'pet-error', role: 'alert', text: flow.error }) : null,
        el('div', { class: 'pet-actions' },
          el('button', { class: 'primary', text: flow.error ? '再試一次' : '孵化', disabled: flow.busy ? '' : null, on: { click: hatch } }),
          flow.busy ? null : el('button', { text: '重新作答', on: { click: () => { flow.qi = 0; flow.step = 'quiz'; flow.error = ''; opts.rerender(); } } }))),
    ];
  }

  async function hatch() {
    if (flow.busy) return;
    const f = flow;
    if (!f.pending) f.pending = { requestId: newRequestId() };   // 同一組答案重試沿用同一個 ID
    f.busy = true; f.error = '';
    opts.rerender();
    const res = await send({ action: 'game.hatch', requestId: f.pending.requestId, answers: f.answers });
    f.busy = false;
    if (flow !== f) return;   // 中途切換了學生或畫面
    if (res.ok) {
      replaceGame(res.game);
      flow = { slot: res.game.slot, step: 'naming', pending: null, error: '', draft: '', justHatched: true };
      focusNext = true;
    } else if (res.code === 'invalid_token') {
      opts.onExpired();
      return;
    } else {
      if (res.code === 'request_conflict') f.pending = null;
      f.error = errorText(res.code);
    }
    opts.rerender();
  }

  function namingView(g) {
    const counter = el('span', { class: 'pet-counter', 'aria-live': 'polite' });
    const input = el('input', {
      type: 'text', id: 'pet-name-input', maxlength: String(NAME_MAX * 2), autocomplete: 'off', enterkeyhint: 'done',
      'aria-describedby': 'pet-name-hint', 'data-focus': '',
    });
    input.value = flow.draft;
    const count = () => { counter.textContent = `${Array.from(input.value.trim()).length}／${NAME_MAX}`; };
    input.addEventListener('input', () => {
      if (input.value !== flow.draft) flow.pending = null;   // 名字改了就是新的請求
      flow.draft = input.value;
      count();
    });
    count();
    const form = el('form', { class: 'pet-form', on: { submit: (e) => { e.preventDefault(); saveName(); } } },
      el('label', { for: 'pet-name-input', text: '練習獸的名字' }),
      input,
      el('p', { class: 'pet-hint', id: 'pet-name-hint' }, `最多 ${NAME_MAX} 個字，之後還可以改。`, counter),
      flow.error ? el('p', { class: 'pet-error', role: 'alert', text: flow.error }) : null,
      el('div', { class: 'pet-actions' },
        el('button', { class: 'primary', type: 'submit', text: flow.busy ? '儲存中…' : '取名', disabled: flow.busy ? '' : null }),
        flow.busy ? null : el('button', { type: 'button', text: flow.rename ? '取消' : '之後再取', on: { click: () => { flow = null; opts.rerender(); } } })));
    return [
      artNode(g.speciesId, g.stage, 'happy', flow.justHatched ? 'is-reveal' : 'is-idle'),
      el('section', { class: 'pet-info' },
        el('h2', { text: flow.justHatched ? '孵化成功！' : '改名字' }),
        speciesLabel(g.speciesId) ? el('p', { class: 'pet-species', text: speciesLabel(g.speciesId) } ) : null,
        flow.justHatched ? el('p', { text: '幫牠取個名字吧。' }) : null,
        form),
    ];
  }

  async function saveName() {
    if (flow.busy) return;
    const f = flow, name = f.draft.replace(/[\s　]+/g, ' ').trim();
    if (!name) { f.error = ERRORS.name_empty; opts.rerender(); return; }
    if (Array.from(name).length > NAME_MAX) { f.error = ERRORS.name_too_long; opts.rerender(); return; }
    if (!f.pending) f.pending = { requestId: newRequestId() };
    f.busy = true; f.error = '';
    opts.rerender();
    const res = await send({ action: 'game.name', requestId: f.pending.requestId, name });
    f.busy = false;
    if (flow !== f) return;
    if (res.ok) {
      replaceGame(res.game);
      flow = null;
      focusNext = true;
    } else if (res.code === 'invalid_token') {
      opts.onExpired();
      return;
    } else {
      if (res.code === 'request_conflict') f.pending = null;
      f.error = errorText(res.code);
    }
    opts.rerender();
  }

  /** 練習獸分頁的內容。index＝dashboard.students 的位置。 */
  function section(index, st) {
    const g = gameFor(index, st);
    if (!g) return [el('p', { class: 'empty', text: data.status === 'loading' ? '讀取中…' : '目前沒有練習獸資料。' })];
    if (flow && flow.slot === g.slot && g.canAct) {
      if (flow.step === 'quiz') return quizView();
      if (flow.step === 'confirm') return confirmView();
      if (flow.step === 'naming' && g.hatched) return namingView(g);
      flow = null;
    }
    return g.hatched ? mainView(g, st) : eggView(g, st);
  }

  return { init, reset, load, hasTab, section, cancelFlow, afterRender, status: () => data.status };
})();
