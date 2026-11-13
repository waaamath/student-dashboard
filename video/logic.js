/* Shared pure logic: browser global and CommonJS. No Firebase or DOM. */
(function (root, factory) {
  const logic = factory();
  if (typeof module === 'object' && module.exports) module.exports = logic;
  else root.VideoLogic = logic;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function millis(at) {
    if (at && typeof at.toMillis === 'function') return at.toMillis();
    if (at && typeof at.seconds === 'number') return at.seconds * 1000 + (at.nanoseconds || 0) / 1e6;
    return typeof at === 'number' ? at : 0;
  }
  const orderGroups = groups => [...groups].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const recentGroups = groups => orderGroups(groups).slice(-30);
  function derive(groups, events) {
    const ordered = orderGroups(groups);
    const byGroup = new Map(ordered.map(g => [g.id, g]));
    const reports = new Map(), latest = new Map(), resolves = new Map(), again = new Map(), finished = new Set();
    const key = (groupId, gid) => JSON.stringify([groupId, gid]);
    [...events].sort((a, b) => millis(a.at) - millis(b.at) || String(a.id || '').localeCompare(String(b.id || ''))).forEach(e => {
      const g = byGroup.get(e.groupId);
      if (!g || !g.items.some(i => i.gid === e.gid)) return;
      if (e.type === 'report' && ['ok', 'again', 'ask'].includes(e.result)) {
        reports.set(key(e.groupId, e.gid), e);
        // 回報過看懂或待問就算完成；之後重看時按「再看一次」不會把進度退回去。
        if (e.result !== 'again') finished.add(key(e.groupId, e.gid));
        latest.set(e.gid, e);
        if (e.result === 'again') again.set(e.gid, (again.get(e.gid) || 0) + 1);
        // An ask after a resolution reopens the question, including equal timestamps.
        resolves.delete(e.gid);
      } else if (e.type === 'resolve' && e.by === 'teacher') resolves.set(e.gid, e);
    });
    const progress = ordered.map(group => {
      const items = group.items.map(item => {
        const report = reports.get(key(group.id, item.gid));
        return { ...item, report, done: finished.has(key(group.id, item.gid)) };
      });
      return { ...group, items, doneCount: items.filter(i => i.done).length,
        complete: items.every(i => i.done), completedAt: Math.max(0, ...items.map(i => millis(i.report && i.report.at))) };
    });
    const assigned = progress.filter(g => g.status === 'assigned');
    const current = assigned.find(g => !g.complete) || null;
    const completed = assigned.filter(g => g.complete).sort((a, b) => b.completedAt - a.completedAt || b.seq - a.seq);
    const pending = [...latest.values()].filter(e => e.result === 'ask' && !resolves.has(e.gid));
    return { groups: progress, current, lastCompleted: completed[0] || null, pending,
      doneCount: assigned.reduce((n, g) => n + g.doneCount, 0), askCount: pending.length,
      againCount: Object.fromEntries(again), waiting: !current };
  }
  function studentStatus(groups, events, summary = {}, now = Date.now()) {
    const d = derive(recentGroups(groups), events);
    const age = now - millis(summary.watchingAt);
    return { ...d, position: d.current ? d.current.items.findIndex(i => !i.done) + 1 : 0,
      watchingGid: typeof summary.watchingGid === 'number' && age >= 0 && age < 600000 ? summary.watchingGid : null };
  }
  function itemMarks(gid, groups, events) {
    const d = derive(recentGroups(groups), events);
    const reports = d.groups.flatMap(g => g.items.filter(i => i.gid === gid && i.report).map(i => i.report))
      .sort((a, b) => millis(b.at) - millis(a.at) || String(b.id).localeCompare(String(a.id)));
    return { understood: reports[0]?.result === 'ok', pending: d.pending.some(e => e.gid === gid),
      assigned: d.groups.some(g => g.status === 'assigned' && !g.complete && g.items.some(i => i.gid === gid)) };
  }
  function askCountAfterResolve(groups, events, event) {
    // Place the pending resolve after the observed events, including equal timestamps.
    const at = Math.max(Date.now(), ...events.map(e => millis(e.at))) + 1;
    return derive(recentGroups(groups), [...events, { ...event, at }]).askCount;
  }
  function bookLabel(book) {
    const m = /^(re|j)?sb(\d+)(B?)$/.exec(book || '');
    return !m ? book || '其他' : m[1] === 're' ? `學測複習講義part${m[2]}${m[3]}`
      : `${m[1] === 'j' ? '國中' : ''}第${m[2]}冊${m[3]}`;
  }
  return { derive, millis, orderGroups, recentGroups, studentStatus, itemMarks, askCountAfterResolve, bookLabel };
});
