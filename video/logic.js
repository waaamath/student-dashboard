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
  const recentGroups = groups => orderGroups(groups).slice(-10);
  // Input is one derived group's progress. Completed items stay replayable even
  // when a teacher inserts an unfinished item before them.
  function itemAccess(group) {
    const current = group.items.findIndex(i => !i.done);
    return group.items.map((item, index) => ({ ...item,
      access: item.done ? 'done' : index === current ? 'current' : 'locked' }));
  }
  function groupEditProgress(group, events, summary) {
    const active = summary?.activeGroups?.find(g => g.id === group.id);
    const done = new Set(active?.doneGids || []);
    events.filter(e => e.groupId === group.id && e.type === 'report' && ['ok', 'ask'].includes(e.result))
      .forEach(e => done.add(e.gid));
    // For a v5 assigned group, absence from activeGroups means fully completed.
    if (summary?.version === 5 && group.status === 'assigned' && !active) group.items.forEach(i => done.add(i.gid));
    return group.items.map(i => ({ ...i, done: done.has(i.gid) }));
  }
  function validateGroupEdit(group, items, doneGids) {
    const gids = items.map(i => i.gid), done = new Set(doneGids), retained = new Set(gids);
    if (!gids.length || gids.length > 50 || new Set(gids).size !== gids.length) return { valid: false, reason: 'size' };
    for (const gid of done) {
      if (!retained.has(gid)) return { valid: false, reason: 'reported', gid };
      // New insertions and removals of unreported items naturally shift indices.
      // Existing surviving items may not cross a reported item's anchor.
      const oldBefore = group.items.slice(0, group.items.findIndex(i => i.gid === gid)).filter(i => retained.has(i.gid)).map(i => i.gid);
      const oldGids = new Set(group.items.map(i => i.gid));
      const newBefore = items.slice(0, gids.indexOf(gid)).filter(i => oldGids.has(i.gid)).map(i => i.gid);
      if (oldBefore.length !== newBefore.length || oldBefore.some(i => !newBefore.includes(i))) return { valid: false, reason: 'reported', gid };
    }
    return { valid: true };
  }
  function insertGroupItem(items, item, beforeGid = null) {
    if (items.length >= 50 || items.some(i => i.gid === item.gid)) return [...items];
    const index = items.findIndex(i => i.gid === beforeGid), result = [...items];
    result.splice(index < 0 ? items.length : index, 0, { ...item }); return result;
  }
  function editedGroupSummary(summary, group, items, doneGids, started) {
    const gids = items.map(i => i.gid), done = gids.filter(gid => doneGids.includes(gid));
    const activeGroups = summary.activeGroups.filter(g => g.id !== group.id);
    if (group.status === 'assigned' && done.length < gids.length) activeGroups.push({ id: group.id, seq: group.seq, gids, doneGids: done, started });
    return { ...summary, activeGroups };
  }
  const reopensGroup = (group, items) => group.items.every(i => i.done) && items.some(i => !group.items.some(old => old.gid === i.gid && old.done));
  function derive(groups, events, summary) {
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
        if (e.result !== 'again') latest.set(e.gid, e);
        if (e.result === 'again') again.set(e.gid, (again.get(e.gid) || 0) + 1);
        // An ask after a resolution reopens the question, including equal timestamps.
        if (e.result !== 'again') resolves.delete(e.gid);
      } else if (e.type === 'resolve' && e.by === 'teacher') resolves.set(e.gid, e);
    });
    const progress = ordered.map(group => {
      const active = summary?.version === 5 ? summary.activeGroups.find(g => g.id === group.id) : undefined;
      const items = group.items.map(item => {
        const report = reports.get(key(group.id, item.gid));
        const terminal = [...events].filter(e => e.groupId === group.id && e.gid === item.gid && e.type === 'report' && ['ok', 'ask'].includes(e.result))
          .sort((a, b) => millis(b.at) - millis(a.at) || String(b.id).localeCompare(String(a.id)))[0];
        return { ...item, report, terminal, done: summary?.version === 5 && group.status === 'assigned'
          ? !active || active.doneGids.includes(item.gid) : finished.has(key(group.id, item.gid)) };
      });
      return { ...group, items, doneCount: items.filter(i => i.done).length,
        complete: items.every(i => i.done), completedAt: Math.max(0, ...items.map(i => millis(i.report && i.report.at))) };
    });
    const assigned = progress.filter(g => g.status === 'assigned');
    const current = assigned.find(g => !g.complete) || null;
    const completed = assigned.filter(g => g.complete).sort((a, b) => b.completedAt - a.completedAt || b.seq - a.seq);
    const pending = summary?.version === 5 ? Object.values(summary.pendingAsks).map(a => events.find(e => e.id === a.id) || a)
      : [...latest.values()].filter(e => e.result === 'ask' && !resolves.has(e.gid));
    return { groups: progress, current, lastCompleted: completed[0] || null, pending,
      doneCount: assigned.reduce((n, g) => n + g.doneCount, 0), askCount: pending.length,
      againCount: Object.fromEntries(again), waiting: !current };
  }
  // The summary is the serialization point for every writer. It includes ALL unfinished
  // groups, even those outside the ten-group history window. No client clock decides progress.
  function summaryFrom(groups, events, previous = {}) {
    const d = derive(groups, events);
    const valid = e => groups.some(g => g.id === e.groupId && g.items.some(i => i.gid === e.gid));
    const latest = [...events].filter(e => valid(e) && e.type === 'report' && ['ok', 'ask'].includes(e.result))
      .sort((a, b) => millis(a.at) - millis(b.at) || String(a.id).localeCompare(String(b.id)));
    const understood = new Set();
    latest.forEach(e => e.result === 'ok' ? understood.add(e.gid) : understood.delete(e.gid));
    const last = [...groups].sort((a, b) => millis(b.createdAt) - millis(a.createdAt) || b.seq - a.seq)[0];
    const viewing = {};
    [...events].sort((a, b) => millis(a.at) - millis(b.at) || String(a.id).localeCompare(String(b.id))).forEach(e => {
      if (e.type !== 'report' || !groups.some(g => g.id === e.groupId && g.items.some(i => i.gid === e.gid))) return;
      const old = viewing[e.gid] || { againCount: 0 };
      viewing[e.gid] = e.result === 'again' ? { ...old, againCount: Math.min(10000, old.againCount + 1) }
        : { againCount: old.againCount, reportId: e.id, spentSec: e.spentSec || 0, playedSec: e.playedSec || 0, rate: e.rate || 1 };
    });
    return { ...previous, version: 5, maxSeq: Math.max(0, ...groups.map(g => g.seq)), minSeq: groups.length ? Math.min(...groups.map(g => g.seq)) : null,
      activeGroups: d.groups.filter(g => g.status === 'assigned' && !g.complete).map(g => ({ id: g.id, seq: g.seq,
        gids: g.items.map(i => i.gid), doneGids: g.items.filter(i => i.done).map(i => i.gid), started: events.some(e => e.groupId === g.id) })),
      understoodGids: [...understood], viewing, pendingAsks: Object.fromEntries(d.pending.map(e => [e.gid, { id: e.id, gid: e.gid, groupId: e.groupId }])),
      doneCount: Math.min(1000, d.doneCount), askCount: Math.min(1000, d.askCount), lastAssignedGroupId: last?.id || null };
  }
  function summaryStatus(s = {}, now = Date.now()) {
    const current = s.version === 5 ? orderGroups(s.activeGroups)[0] : null;
    const age = now - millis(s.watchingAt);
    return { known: s.version === 5, waiting: s.version === 5 && !current, current,
      position: current ? current.gids.findIndex(gid => !current.doneGids.includes(gid)) + 1 : 0,
      askCount: s.askCount || 0, watchingGid: age >= 0 && age < 600000 ? s.watchingGid : null };
  }
  function assignmentSeq(summary, mode) {
    const current = summaryStatus(summary).current;
    if (!current || mode === 'append') return summary.maxSeq + 1;
    if (mode === 'replace') return current.seq;
    if (mode === 'front') {
      const base = Math.min(current.seq, summary.minSeq ?? current.seq), seq = base - 0.5;
      if (!Number.isFinite(seq) || seq >= base) throw new Error('sequence exhausted');
      return seq;
    }
    throw new Error('unknown assignment mode');
  }
  function assignedSummary(summary, group) {
    return { ...summary, maxSeq: Math.max(summary.maxSeq, group.seq), minSeq: summary.minSeq == null ? group.seq : Math.min(summary.minSeq, group.seq), lastAssignedGroupId: group.id,
      activeGroups: [...summary.activeGroups, { id: group.id, seq: group.seq, gids: group.gids, doneGids: [], started: false }] };
  }
  function reportSummary(summary, event) {
    const s = { ...summary, activeGroups: summary.activeGroups.map(g => ({ ...g, doneGids: [...g.doneGids] })),
      understoodGids: [...summary.understoodGids], viewing: { ...(summary.viewing || {}) }, pendingAsks: { ...summary.pendingAsks } };
    const g = s.activeGroups.find(g => g.id === event.groupId);
    if (g) {
      g.started = true;
      if (event.type === 'report' && event.result !== 'again' && !g.doneGids.includes(event.gid)) {
        g.doneGids.push(event.gid); s.doneCount = Math.min(1000, s.doneCount + 1);
      }
      s.activeGroups = s.activeGroups.filter(g => g.doneGids.length < g.gids.length);
    }
    if (event.type === 'report' && event.result !== 'again') {
      s.understoodGids = s.understoodGids.filter(gid => gid !== event.gid);
      if (event.result === 'ok') s.understoodGids.push(event.gid);
      if (event.result === 'ask') s.pendingAsks[event.gid] = { id: event.id, gid: event.gid, groupId: event.groupId };
      else delete s.pendingAsks[event.gid];
    }
    if (event.type === 'report') {
      const old = s.viewing[event.gid] || { againCount: 0 };
      s.viewing[event.gid] = event.result === 'again' ? { ...old, againCount: Math.min(10000, old.againCount + 1) }
        : { againCount: old.againCount, reportId: event.id, spentSec: event.spentSec, playedSec: event.playedSec, rate: event.rate };
    }
    s.askCount = Math.min(1000, Object.keys(s.pendingAsks).length);
    return s;
  }
  function batchPlan(students, items) {
    return students.map(s => ({ ...s, items: items.filter(i => !s.understoodGids.includes(i.gid)),
      skipped: items.filter(i => s.understoodGids.includes(i.gid)) }));
  }
  function continuation(catalog, last, understood = []) {
    const items = catalog.filter(i => ['focus', 'exa'].includes(i.kind));
    const tail = last?.items.at(-1), index = tail ? items.findIndex(i => i.gid === tail.gid) : -1;
    if (tail && index < 0) return [];
    return items.slice(index + 1).filter(i => !understood.includes(i.gid)).slice(0, last?.items.length || 5);
  }
  const shortPlayback = (report, seconds) => !!report && Number.isFinite(seconds) && seconds > 0
    && report.playedSec < seconds / (report.rate || 1) / 2;
  function studentStatus(groups, events, summary = {}, now = Date.now()) {
    const d = derive(recentGroups(groups), events);
    const age = now - millis(summary.watchingAt);
    return { ...d, position: d.current ? d.current.items.findIndex(i => !i.done) + 1 : 0,
      watchingGid: typeof summary.watchingGid === 'number' && age >= 0 && age < 600000 ? summary.watchingGid : null };
  }
  function itemMarks(gid, groups, events) {
    const d = derive(recentGroups(groups), events);
    const reports = d.groups.flatMap(g => g.items.filter(i => i.gid === gid && i.terminal).map(i => i.terminal))
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
  return { derive, itemAccess, groupEditProgress, validateGroupEdit, insertGroupItem, editedGroupSummary, reopensGroup, millis, orderGroups, recentGroups, studentStatus, itemMarks, askCountAfterResolve, bookLabel,
    summaryFrom, summaryStatus, assignmentSeq, assignedSummary, reportSummary, batchPlan, continuation, shortPlayback };
});
