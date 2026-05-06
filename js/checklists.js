/* ================================================================
 * BSC Ops — checklists.js
 * Recurring task checklists (BSC_ChecklistGroups + BSC_Checklists +
 * BSC_ChecklistProgress + BSC_ChecklistCompletions).
 *
 * Role model: managers/owners see every group and can create tasks;
 * baristas only see Barista/All groups at their allowed locations
 * and submit "Suggested" tasks that managers review.
 *
 * Contents:
 *   - getGroupDueStatus — recurrence-aware due/overdue badge
 *   - renderChecklists / renderChecklistCard / renderLegacyTasksCard
 *   - toggleCheck (per-task) / markGroupComplete (per-group)
 *   - addTaskInline / deleteChecklistTask
 *   - openChecklistGroupForm / saveChecklistGroup / deleteChecklistGroup
 *   - openSuggestTask / saveSuggestedTask
 *   - toggleSuggestionsPanel / renderSuggestions
 *   - approveTask / dismissSuggestedTask
 *   - updateDashChecklist (dashboard badge)
 *
 * Depends on:
 *   state.js     — cache, currentUser, currentLocation
 *   constants.js — LISTS
 *   utils.js     — escHtml, toast, openModal, closeModal
 *   graph.js     — graph, getSiteId, addListItem, updateListItem
 *   auth.js      — isManagerOrOwner
 *   settings.js  — getLocations, getAllowedLocations
 * ================================================================ */

let _clGroupEditId = null;

// ── Multi-day plan helpers ────────────────────────────────────────
// A group is a "multi-day plan" if it has an EndDate set. Such groups
// have per-task due dates (Checklists.DueDate) and no group-level
// recurrence — each task is independently due/overdue/done.
function _isMultidayPlan(group) {
  return !!(group && group.EndDate);
}
function _todayMidnight() {
  const d = new Date(); d.setHours(0,0,0,0); return d;
}
function _parseDateOnly(iso) {
  if (!iso) return null;
  const s = String(iso).split('T')[0];
  const [y, m, day] = s.split('-').map(Number);
  if (!y || !m || !day) return null;
  return new Date(y, m - 1, day);
}
function _fmtShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
// Per-task due status for multi-day plans.
function getTaskDueStatus(task) {
  const isDone = !!cache.clProgress[task.id];
  const due    = _parseDateOnly(task.DueDate);
  if (isDone) {
    return { status:'done', badge:`<span style="font-size:11px;background:var(--good-bg);color:var(--good);padding:2px 8px;border-radius:10px;">✓ Done</span>` };
  }
  if (!due) {
    return { status:'undated', badge:`<span style="font-size:11px;background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:10px;">Undated</span>` };
  }
  const today = _todayMidnight();
  const diff  = Math.round((due - today) / 86400000);
  if (diff < 0)  return { status:'overdue', badge:`<span style="font-size:11px;background:var(--bad-bg);color:var(--bad);padding:2px 8px;border-radius:10px;">Overdue ${Math.abs(diff)}d</span>` };
  if (diff === 0) return { status:'due',     badge:`<span style="font-size:11px;background:var(--warn-bg);color:var(--warn-text);padding:2px 8px;border-radius:10px;">Due Today</span>` };
  if (diff <= 3)  return { status:'soon',    badge:`<span style="font-size:11px;background:var(--warn-bg);color:var(--warn-text);padding:2px 8px;border-radius:10px;">Due in ${diff}d</span>` };
  return { status:'ok', badge:`<span style="font-size:11px;background:var(--good-bg);color:var(--good);padding:2px 8px;border-radius:10px;">Due in ${diff}d</span>` };
}
// Group-level summary for multi-day plans.
function getPlanSummary(group, tasks) {
  const total = tasks.length;
  if (!total) return { status:'none', badge:`<span style="font-size:11px;color:var(--muted);">No tasks yet</span>` };
  let done = 0, overdue = 0;
  for (const t of tasks) {
    const s = getTaskDueStatus(t);
    if (s.status === 'done') done++;
    else if (s.status === 'overdue') overdue++;
  }
  if (done === total) return { status:'ok', badge:`<span style="font-size:11px;background:var(--good-bg);color:var(--good);padding:2px 8px;border-radius:10px;">All done!</span>` };
  if (overdue) return { status:'overdue', badge:`<span style="font-size:11px;background:var(--bad-bg);color:var(--bad);padding:2px 8px;border-radius:10px;">${overdue} overdue · ${done}/${total} done</span>` };
  return { status:'ok', badge:`<span style="font-size:11px;background:var(--warn-bg);color:var(--warn-text);padding:2px 8px;border-radius:10px;">${done}/${total} done</span>` };
}
// Sort comparator for multi-day plan tasks: DueDate ASC (undated last),
// then SortOrder, then alphabetical.
function _multidayTaskSort(a, b) {
  const da = _parseDateOnly(a.DueDate);
  const db = _parseDateOnly(b.DueDate);
  if (da && db) {
    if (da.getTime() !== db.getTime()) return da - db;
  } else if (da) return -1;
  else if (db) return 1;
  const sa = parseFloat(a.SortOrder); const sb = parseFloat(b.SortOrder);
  if (!isNaN(sa) && !isNaN(sb) && sa !== sb) return sa - sb;
  return (a.TaskName || '').localeCompare(b.TaskName || '');
}

// ── Due-status helper ─────────────────────────────────────────────
function getGroupDueStatus(group) {
  const days = parseFloat(group.RecurEveryDays) || 0;
  if (!days) return { status:'none', badge:'' };
  const loc = currentLocation === 'all' ? null : currentLocation;
  const completions = cache.clCompletions
    .filter(c => c.GroupId === group.id && (!loc || !c.Location || c.Location === 'All' || c.Location === loc))
    .sort((a,b) => new Date(b.CompletedDate||0) - new Date(a.CompletedDate||0));
  if (!completions.length) {
    return { status:'overdue', badge:`<span style="font-size:11px;background:var(--bad-bg);color:var(--bad);padding:2px 8px;border-radius:10px;">Never done</span>` };
  }
  const daysSince = Math.floor((Date.now() - new Date(completions[0].CompletedDate)) / 86400000);
  const rem = days - daysSince;
  if (rem < 0)      return { status:'overdue', badge:`<span style="font-size:11px;background:var(--bad-bg);color:var(--bad);padding:2px 8px;border-radius:10px;">Overdue ${Math.abs(rem)}d</span>` };
  if (rem === 0)    return { status:'due',     badge:`<span style="font-size:11px;background:var(--warn-bg);color:var(--warn-text);padding:2px 8px;border-radius:10px;">Due Today</span>` };
  return { status:'ok', badge:`<span style="font-size:11px;background:var(--good-bg);color:var(--good);padding:2px 8px;border-radius:10px;">Due in ${rem}d</span>` };
}

// ── Render all groups ─────────────────────────────────────────────
function renderChecklists() {
  const userIsMgr = isManagerOrOwner();
  const roleFilter = document.getElementById('cl-role-filter')?.value || '';
  // Location filter now comes from the top-bar button (currentLocation) —
  // 'all' shows every group; a specific location shows groups scoped to
  // that location plus groups with Location='All'.
  const locFilter  = (currentLocation === 'all') ? '' : currentLocation;

  // Manager-only controls
  const newBtn = document.getElementById('cl-new-btn');
  const sugWrap = document.getElementById('cl-suggestions-btn-wrap');
  if (newBtn) newBtn.style.display = userIsMgr ? '' : 'none';
  if (sugWrap) sugWrap.style.display = userIsMgr ? '' : 'none';

  // Also populate create-group location select
  const grpLocSel = document.getElementById('cl-group-loc');
  if (grpLocSel && grpLocSel.options.length <= 1) {
    grpLocSel.innerHTML = '<option value="All">All Locations</option>' +
      getLocations().map(l=>`<option value="${escHtml(l)}">${escHtml(l)}</option>`).join('');
  }

  // Pending suggestions badge
  const pending = cache.checklists.filter(t => t.Status === 'Suggested');
  const badge = document.getElementById('cl-suggestions-badge');
  if (badge) { badge.textContent = pending.length || ''; badge.style.display = pending.length ? '' : 'none'; }

  // Filter groups
  let groups = cache.clGroups;
  if (!userIsMgr) {
    // Baristas only see Barista/All role groups at their location
    groups = groups.filter(g => !g.Role || g.Role === 'Barista' || g.Role === 'All');
    const allowed = getAllowedLocations();
    if (allowed.length < getLocations().length) {
      groups = groups.filter(g => !g.Location || g.Location === 'All' || allowed.includes(g.Location));
    }
    // Also honor the top-bar location button for baristas
    if (locFilter) groups = groups.filter(g => !g.Location || g.Location === 'All' || g.Location === locFilter);
  } else {
    if (roleFilter) groups = groups.filter(g => g.Role === roleFilter || g.Role === 'All');
    if (locFilter)  groups = groups.filter(g => !g.Location || g.Location === 'All' || g.Location === locFilter);
  }
  groups = [...groups].sort((a,b) => (a.Title||'').localeCompare(b.Title||''));

  const container = document.getElementById('cl-groups-container');
  const emptyEl   = document.getElementById('cl-groups-empty');

  // Legacy ungrouped tasks (old data without GroupId)
  const ungrouped = cache.checklists.filter(t => !t.GroupId && t.Status !== 'Suggested');

  if (!groups.length && !ungrouped.length) {
    container.innerHTML = ''; emptyEl.style.display = '';
  } else {
    emptyEl.style.display = 'none';
    container.innerHTML = groups.map(g => renderChecklistCard(g, userIsMgr)).join('');
    if (ungrouped.length && userIsMgr) {
      container.innerHTML += renderLegacyTasksCard(ungrouped);
    }
  }

  updateDashChecklist();
  if (userIsMgr) renderSuggestions();
}

// ── Single card ──────────────────────────────────────────────────
function renderChecklistCard(group, userIsMgr) {
  const gid   = group.id;
  const isMultiday = _isMultidayPlan(group);
  let tasks = cache.checklists.filter(t => t.GroupId === gid && t.Status !== 'Suggested');
  if (isMultiday) tasks = [...tasks].sort(_multidayTaskSort);
  const done  = tasks.filter(t => cache.clProgress[t.id]).length;
  const pct   = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  const due   = isMultiday ? getPlanSummary(group, tasks) : getGroupDueStatus(group);

  const borderColor = due.status === 'overdue' ? 'var(--bad)' : due.status === 'due' ? 'var(--warn)' : 'var(--border)';
  const roleBadge   = group.Role === 'Manager' ? '#3b82f6' : group.Role === 'Barista' ? 'var(--teal)' : '#9ca3af';

  let cadenceLabel;
  if (isMultiday) {
    const sd = _parseDateOnly(group.StartDate);
    const ed = _parseDateOnly(group.EndDate);
    cadenceLabel = `📅 ${sd ? _fmtShortDate(sd) : '?'} – ${ed ? _fmtShortDate(ed) : '?'}`;
  } else {
    const days = parseFloat(group.RecurEveryDays) || 0;
    cadenceLabel = '🔄 ' + (days ? `Every ${days} day${days!==1?'s':''}${group.RecurTime ? ' · '+group.RecurTime : ''}` : 'No recurrence');
  }

  const taskRows = tasks.map(t => {
    const isDone = !!cache.clProgress[t.id];
    let dueChip = '';
    if (isMultiday) {
      const ts = getTaskDueStatus(t);
      const ddate = _parseDateOnly(t.DueDate);
      const dateLabel = ddate ? _fmtShortDate(ddate) : 'Set date';
      dueChip = userIsMgr
        ? `<button onclick="editTaskDueDate('${t.id}')" title="Click to change due date" style="background:none;border:1px dashed var(--border);border-radius:8px;padding:2px 8px;font-size:11px;color:var(--muted);cursor:pointer;flex-shrink:0;">${escHtml(dateLabel)}</button>`
        : `<span style="font-size:11px;color:var(--muted);flex-shrink:0;">${escHtml(ddate ? dateLabel : '—')}</span>`;
      dueChip += ts.badge;
    }
    return `<div class="checklist-item${isDone?' done':''}" id="cli-${t.id}" style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--opal);">
      <input type="checkbox" id="chk-${t.id}" ${isDone?'checked':''}
        onchange="toggleCheck('${t.id}',this.checked,'${gid}')">
      <label for="chk-${t.id}" style="flex:1;cursor:pointer;font-size:13px;${isDone?'text-decoration:line-through;color:var(--muted);':''}">${escHtml(t.TaskName||'')}</label>
      ${dueChip}
      ${t.Notes ? `<span title="${escHtml(t.Notes)}" style="font-size:12px;cursor:help;flex-shrink:0;">ℹ️</span>` : ''}
      ${userIsMgr ? `<button onclick="deleteChecklistTask('${t.id}','${gid}')" title="Remove task" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;line-height:1;padding:0 2px;flex-shrink:0;">×</button>` : ''}
    </div>`;
  }).join('');

  const dateInput = isMultiday
    ? `<input id="cl-new-due-${gid}" type="date" title="Due date (optional)" style="width:130px;padding:5px 8px;border:1.5px solid var(--border);border-radius:8px;font-size:12px;">`
    : '';
  const footerBtn = userIsMgr
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:1;">
        <input id="cl-new-task-${gid}" placeholder="Add a task…"
          style="flex:1;min-width:130px;padding:5px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:12px;"
          onkeydown="if(event.key==='Enter')addTaskInline('${gid}')">
        <input id="cl-new-notes-${gid}" placeholder="Notes…"
          style="width:90px;padding:5px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:12px;">
        ${dateInput}
        <button onclick="addTaskInline('${gid}')"
          style="padding:5px 12px;background:var(--gold);color:#fff;border:none;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;">+ Add</button>
      </div>`
    : `<button onclick="openSuggestTask('${gid}','${escHtml(group.Title||'')}')"
        style="padding:5px 12px;background:none;border:1.5px solid var(--border);border-radius:8px;font-size:12px;cursor:pointer;">💡 Suggest Task</button>`;

  const completeBtn = (!isMultiday && tasks.length)
    ? `<button onclick="markGroupComplete('${gid}','${escHtml(group.Title||'')}')"
        style="padding:5px 12px;background:var(--good);color:#fff;border:none;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;">✅ Mark All Done</button>`
    : '';

  return `
    <div class="card" data-gs-id="${escHtml(gid)}" style="padding:0;overflow:hidden;border-left:4px solid ${borderColor};">
      <div style="padding:14px 16px 10px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div style="flex:1;">
            <div style="font-weight:700;font-size:14px;">${escHtml(group.Title||'Untitled')}</div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;">
              <span style="font-size:11px;background:${roleBadge};color:#fff;padding:2px 8px;border-radius:10px;">${escHtml(group.Role||'All')}</span>
              <span style="font-size:11px;background:var(--opal);padding:2px 8px;border-radius:10px;">📍 ${escHtml(group.Location||'All Locations')}</span>
              <span style="font-size:11px;color:var(--muted);">${escHtml(cadenceLabel)}</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
            ${due.badge}
            ${userIsMgr ? `<button onclick="openChecklistGroupForm('${gid}')" title="Edit checklist" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:15px;padding:2px 4px;">✏️</button>` : ''}
          </div>
        </div>
        ${tasks.length ? `
        <div style="margin-top:10px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:3px;">
            <span>${done} of ${tasks.length} tasks done</span><span>${pct}%</span>
          </div>
          <div class="progress-wrap" style="height:5px;">
            <div class="progress-bar${pct===100?' complete':''}" style="width:${pct}%;transition:width .3s;"></div>
          </div>
        </div>` : ''}
      </div>
      <div style="padding:0 16px 8px;" id="cl-tasks-${gid}">
        ${taskRows || `<div style="font-size:12px;color:var(--muted);padding:10px 0;text-align:center;">${userIsMgr?'No tasks yet — add one below':'No tasks yet'}</div>`}
      </div>
      <div style="padding:8px 16px 14px;border-top:1px solid var(--opal);display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        ${footerBtn}
        ${completeBtn}
      </div>
    </div>`;
}

function renderLegacyTasksCard(tasks) {
  const rows = tasks.map(t => `
    <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--opal);font-size:13px;">
      <span style="flex:1;">${escHtml(t.TaskName||'')}</span>
      <span class="text-hint">${escHtml(t.Frequency||'')} · ${escHtml(t.Type||'')}</span>
      <button onclick="deleteChecklistTask('${t.id}',null)" title="Delete" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;">×</button>
    </div>`).join('');
  return `
    <div class="card" style="grid-column:1/-1;border-left:4px solid #9ca3af;padding:0;overflow:hidden;">
      <div style="padding:14px 16px 8px;font-weight:700;font-size:13px;color:var(--muted);">⚠️ Legacy Tasks (no checklist group) — delete or migrate these</div>
      <div style="padding:0 16px 14px;">${rows}</div>
    </div>`;
}

// ── Rebuild cache.clProgress map from cache.clProgressRows ───────
// Builds a taskId → { by, date, spId } map from the raw SP rows, filtering
// out records that pre-date the task's group's most recent completion
// (so every group "reset" via markGroupComplete starts a clean cycle).
// Called on initial load and after any batch delete of progress rows.
function rebuildClProgressMap() {
  const map = {};
  // Precompute latest completion date per group for recurrence-aware filter
  const latestByGroup = {};
  (cache.clCompletions || []).forEach(c => {
    if (!c.GroupId) return;
    const d = new Date(c.CompletedDate || 0).getTime();
    if (!latestByGroup[c.GroupId] || d > latestByGroup[c.GroupId]) latestByGroup[c.GroupId] = d;
  });
  // Sort rows newest-first so the surviving map entry is the most recent
  const rows = [...(cache.clProgressRows || [])].sort((a,b) =>
    new Date(b.CompletedDate || 0) - new Date(a.CompletedDate || 0));
  for (const r of rows) {
    if (!r.TaskId) continue;
    if (map[r.TaskId]) continue; // already seen a newer one
    // Find the task's group and skip rows older than the group's last completion
    const task = (cache.checklists || []).find(t => String(t.id) === String(r.TaskId));
    if (task && task.GroupId) {
      const cutoff = latestByGroup[task.GroupId] || 0;
      if (cutoff && new Date(r.CompletedDate || 0).getTime() <= cutoff) continue;
    }
    map[r.TaskId] = {
      by: r.CompletedBy || '',
      date: new Date(r.CompletedDate || Date.now()),
      spId: r.id
    };
  }
  cache.clProgress = map;
}

// ── Toggle task checkbox ─────────────────────────────────────────
async function toggleCheck(taskId, checked, groupId) {
  // Optimistic UI update
  const el = document.getElementById('cli-'+taskId);
  if (el) el.classList.toggle('done', checked);
  const lbl = el?.querySelector('label');
  if (lbl) { lbl.style.textDecoration = checked ? 'line-through' : ''; lbl.style.color = checked ? 'var(--muted)' : ''; }

  const prev = cache.clProgress[taskId];
  if (checked) {
    // Mark in-memory immediately so progress bar math works before SP round-trip
    cache.clProgress[taskId] = { by: currentUser?.name||'', date: new Date(), spId: prev?.spId || null };
  } else {
    delete cache.clProgress[taskId];
  }

  // Persist to SharePoint
  try {
    if (checked) {
      // Only create a new SP row if we don't already have one for this task
      if (!prev?.spId) {
        const rec = await addListItem(LISTS.clProgress, {
          TaskId: taskId,
          CompletedBy: currentUser?.name||currentUser?.username||'',
          CompletedDate: new Date().toISOString(),
          Location: currentLocation==='all'?'All':currentLocation
        });
        cache.clProgressRows.push(rec);
        cache.clProgress[taskId] = { by: rec.CompletedBy||'', date: new Date(rec.CompletedDate||Date.now()), spId: rec.id };
      }
    } else if (prev?.spId) {
      // Delete the SP row so the uncheck persists across reloads
      await deleteListItem(LISTS.clProgress, prev.spId);
      cache.clProgressRows = cache.clProgressRows.filter(r => String(r.id) !== String(prev.spId));
    }
  } catch(e) {
    // Revert optimistic UI if save failed
    if (checked) delete cache.clProgress[taskId];
    else if (prev) cache.clProgress[taskId] = prev;
    if (el) el.classList.toggle('done', !checked);
    const cb = document.getElementById('chk-'+taskId);
    if (cb) cb.checked = !checked;
    if (lbl) { lbl.style.textDecoration = !checked ? 'line-through' : ''; lbl.style.color = !checked ? 'var(--muted)' : ''; }
    toast('err', 'Save failed: ' + e.message);
    return;
  }

  // Update progress bar on the card
  if (groupId) {
    const tasks = cache.checklists.filter(t => t.GroupId === groupId && t.Status !== 'Suggested');
    const done  = tasks.filter(t => cache.clProgress[t.id]).length;
    const pct   = tasks.length ? Math.round(done/tasks.length*100) : 0;
    const bar = document.querySelector(`#cl-tasks-${groupId}`)?.closest('.card')?.querySelector('.progress-bar');
    if (bar) { bar.style.width = pct+'%'; bar.classList.toggle('complete', pct===100); }
    const labels = document.querySelectorAll(`#cl-tasks-${groupId}`);
    labels.forEach(wrap => {
      const progDiv = wrap.closest('.card')?.querySelectorAll('.progress-wrap + div, .progress-wrap ~ *');
    });
    // Re-render just the progress text
    const card = document.getElementById(`cl-tasks-${groupId}`)?.closest('.card');
    if (card) {
      const spans = card.querySelectorAll('.progress-wrap');
      if (spans.length) {
        const prev = spans[0].previousElementSibling;
        if (prev) {
          const labels2 = prev.querySelectorAll('span');
          if (labels2[0]) labels2[0].textContent = `${done} of ${tasks.length} tasks done`;
          if (labels2[1]) labels2[1].textContent = pct+'%';
        }
      }
    }
  }
  updateDashChecklist();
}

// ── Mark entire group complete ───────────────────────────────────
async function markGroupComplete(groupId, groupName) {
  const tasks = cache.checklists.filter(t => t.GroupId === groupId && t.Status !== 'Suggested');
  try {
    const now = new Date().toISOString();
    const loc = currentLocation === 'all' ? 'All' : currentLocation;
    // Fill in progress records for any still-unchecked tasks
    for (const t of tasks) {
      if (!cache.clProgress[t.id]) {
        try {
          const rec = await addListItem(LISTS.clProgress, {
            TaskId: t.id, CompletedBy: currentUser?.name||currentUser?.username||'',
            CompletedDate: now, Location: loc
          });
          cache.clProgressRows.push(rec);
          cache.clProgress[t.id] = { by: rec.CompletedBy||'', date: new Date(rec.CompletedDate||now), spId: rec.id };
        } catch(e) { console.warn('[cl] progress write failed:', e.message); }
      }
    }
    // Save group completion record for recurrence tracking
    const rec = await addListItem(LISTS.clCompletions, {
      Title: groupName + ' — ' + now.slice(0,10),
      GroupId: groupId, GroupName: groupName,
      Location: loc,
      CompletedBy: currentUser?.name||currentUser?.username||'',
      CompletedDate: now
    });
    cache.clCompletions.push(rec);
    // Clear the now-stale progress rows for this group's tasks so the next
    // recurrence cycle starts with a clean slate. Fire-and-forget — if some
    // deletes fail, rebuildClProgressMap() will still filter them out on
    // next load because they're older than the new completion timestamp.
    const taskIds = new Set(tasks.map(t => String(t.id)));
    const rowsToDelete = cache.clProgressRows.filter(r => taskIds.has(String(r.TaskId)));
    cache.clProgressRows = cache.clProgressRows.filter(r => !taskIds.has(String(r.TaskId)));
    tasks.forEach(t => { delete cache.clProgress[t.id]; });
    for (const row of rowsToDelete) {
      deleteListItem(LISTS.clProgress, row.id).catch(()=>{});
    }
    toast('ok', `✅ "${groupName}" marked complete`);
    renderChecklists();
  } catch(e) { toast('err', 'Error: '+e.message); }
}

// ── Add task inline (manager) ────────────────────────────────────
async function addTaskInline(groupId) {
  const nameEl  = document.getElementById(`cl-new-task-${groupId}`);
  const notesEl = document.getElementById(`cl-new-notes-${groupId}`);
  const dueEl   = document.getElementById(`cl-new-due-${groupId}`);
  const name = (nameEl?.value||'').trim();
  if (!name) { toast('err','Task name required'); return; }
  try {
    const grp = cache.clGroups.find(g => g.id === groupId);
    const fields = {
      Title: name, TaskName: name,
      GroupId: groupId,
      Notes: notesEl?.value || '',
      Status: 'Active',
      Location: grp?.Location || 'All',
      AssignedRole: grp?.Role || 'All'
    };
    const dueRaw = (dueEl?.value || '').trim();
    if (dueRaw) {
      fields.DueDate = dueRaw + 'T00:00:00Z';
      // Soft warning if outside the plan's Start/End range
      const sd = _parseDateOnly(grp?.StartDate);
      const ed = _parseDateOnly(grp?.EndDate);
      const d  = _parseDateOnly(dueRaw);
      if (d && ((sd && d < sd) || (ed && d > ed))) {
        if (!await confirmModal({ title: 'Save anyway?', body: 'Due date is outside the plan range.', confirmLabel: 'Save' })) return;
      }
    }
    const item = await addListItem(LISTS.checklists, fields);
    cache.checklists.push(item);
    if (nameEl)  nameEl.value  = '';
    if (notesEl) notesEl.value = '';
    if (dueEl)   dueEl.value   = '';
    renderChecklists();
  } catch(e) { toast('err', 'Failed to add task: '+e.message); }
}

// ── Edit a task's DueDate inline (manager-only, multi-day plans) ──
async function editTaskDueDate(taskId) {
  const t = cache.checklists.find(x => x.id === taskId);
  if (!t) return;
  const current = t.DueDate ? String(t.DueDate).split('T')[0] : '';
  const res = await pickDate(current, 'Task due date');
  if (!res.ok) return;
  const trimmed = res.value;
  let dueIso = null;
  if (trimmed) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) { toast('err','Invalid date'); return; }
    dueIso = trimmed + 'T00:00:00Z';
    // Soft warning if outside plan range
    const grp = cache.clGroups.find(g => g.id === t.GroupId);
    const sd = _parseDateOnly(grp?.StartDate);
    const ed = _parseDateOnly(grp?.EndDate);
    const d  = _parseDateOnly(trimmed);
    if (d && ((sd && d < sd) || (ed && d > ed))) {
      if (!await confirmModal({ title: 'Save anyway?', body: 'Due date is outside the plan range.', confirmLabel: 'Save' })) return;
    }
  }
  try {
    await updateListItem(LISTS.checklists, taskId, { DueDate: dueIso });
    t.DueDate = dueIso;
    renderChecklists();
    toast('ok','✓ Due date updated');
  } catch(e) { toast('err', 'Update failed: '+e.message); }
}

// ── Delete a task ────────────────────────────────────────────────
async function deleteChecklistTask(taskId, groupId) {
  if (!await confirmModal({ title: 'Delete this task?', confirmLabel: 'Delete', danger: true })) return;
  try {
    const siteId = await getSiteId();
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.checklists}/items/${taskId}`);
    cache.checklists = cache.checklists.filter(t => t.id !== taskId);
    renderChecklists();
  } catch(e) { toast('err', 'Delete failed: '+e.message); }
}

// ── Create / Edit checklist group ────────────────────────────────
function onClPlanTypeChange() {
  const type = document.querySelector('input[name="cl-plan-type"]:checked')?.value || 'recurring';
  const isMulti = type === 'multiday';
  const recurWrap = document.getElementById('cl-group-recur-wrap');
  const timeWrap  = document.getElementById('cl-group-time-wrap');
  const endWrap   = document.getElementById('cl-group-end-wrap');
  if (recurWrap) recurWrap.style.display = isMulti ? 'none' : '';
  if (timeWrap)  timeWrap.style.display  = isMulti ? 'none' : '';
  if (endWrap)   endWrap.style.display   = isMulti ? '' : 'none';
}

function openChecklistGroupForm(groupId) {
  _clGroupEditId = groupId;
  const grp = groupId ? cache.clGroups.find(g => g.id === groupId) : null;
  const isMulti = _isMultidayPlan(grp);
  document.getElementById('cl-group-modal-title').textContent = grp ? 'Edit Checklist' : 'New Checklist';
  document.getElementById('cl-group-name').value   = grp?.Title || '';
  document.getElementById('cl-group-role').value   = grp?.Role  || 'All';
  document.getElementById('cl-group-loc').value    = grp?.Location || 'All';
  document.getElementById('cl-group-start').value  = grp?.StartDate ? grp.StartDate.split('T')[0] : '';
  document.getElementById('cl-group-recur').value  = grp?.RecurEveryDays != null ? grp.RecurEveryDays : '';
  document.getElementById('cl-group-time').value   = grp?.RecurTime || '';
  document.getElementById('cl-group-end').value    = grp?.EndDate ? grp.EndDate.split('T')[0] : '';
  document.getElementById('cl-group-desc').value   = grp?.Description || '';
  // Plan-type radio
  document.querySelectorAll('input[name="cl-plan-type"]').forEach(r => {
    r.checked = (r.value === (isMulti ? 'multiday' : 'recurring'));
  });
  onClPlanTypeChange();
  document.getElementById('cl-group-delete-btn').style.display = grp ? '' : 'none';
  openModal('modal-cl-group');
}

async function saveChecklistGroup() {
  const name = document.getElementById('cl-group-name').value.trim();
  if (!name) { toast('err','Checklist name required'); return; }
  const planType = document.querySelector('input[name="cl-plan-type"]:checked')?.value || 'recurring';
  const isMulti  = planType === 'multiday';
  const startRaw = document.getElementById('cl-group-start').value;
  const endRaw   = document.getElementById('cl-group-end').value;
  if (isMulti && (!startRaw || !endRaw)) { toast('err','Multi-day plans need both Start and End dates'); return; }
  if (isMulti && startRaw && endRaw && startRaw > endRaw) { toast('err','End date must be on or after Start date'); return; }
  const fields = {
    Title:         name,
    Role:          document.getElementById('cl-group-role').value,
    Location:      document.getElementById('cl-group-loc').value,
    StartDate:     startRaw ? startRaw + 'T00:00:00Z' : null,
    EndDate:       isMulti && endRaw ? endRaw + 'T00:00:00Z' : null,
    RecurEveryDays: isMulti ? 0 : (parseFloat(document.getElementById('cl-group-recur').value) || 0),
    RecurTime:     isMulti ? '' : document.getElementById('cl-group-time').value.trim(),
    Description:   document.getElementById('cl-group-desc').value.trim()
  };
  if (!fields.StartDate) delete fields.StartDate;
  if (!fields.EndDate)   fields.EndDate = null;  // explicit null clears the field on edit
  try {
    if (_clGroupEditId) {
      await updateListItem(LISTS.clGroups, _clGroupEditId, fields);
      const idx = cache.clGroups.findIndex(g => g.id === _clGroupEditId);
      if (idx !== -1) cache.clGroups[idx] = { ...cache.clGroups[idx], ...fields };
      toast('ok', '✓ Checklist updated');
    } else {
      const item = await addListItem(LISTS.clGroups, fields);
      cache.clGroups.push(item);
      toast('ok', '✓ Checklist created');
    }
    closeModal('modal-cl-group');
    renderChecklists();
  } catch(e) { toast('err', 'Save failed: '+e.message); }
}

async function deleteChecklistGroup() {
  const grp = cache.clGroups.find(g => g.id === _clGroupEditId);
  if (!grp) return;
  if (!await confirmModal({ title: `Delete "${grp.Title}"?`, body: 'This deletes the checklist and all its tasks.\n\nThis cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
  try {
    const siteId = await getSiteId();
    // Delete all tasks in the group
    const tasks = cache.checklists.filter(t => t.GroupId === _clGroupEditId);
    for (const t of tasks) {
      await graph('DELETE', `/sites/${siteId}/lists/${LISTS.checklists}/items/${t.id}`).catch(()=>{});
    }
    cache.checklists = cache.checklists.filter(t => t.GroupId !== _clGroupEditId);
    // Delete the group
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.clGroups}/items/${_clGroupEditId}`);
    cache.clGroups = cache.clGroups.filter(g => g.id !== _clGroupEditId);
    closeModal('modal-cl-group');
    toast('ok', '✓ Checklist deleted');
    renderChecklists();
  } catch(e) { toast('err', 'Delete failed: '+e.message); }
}

// ── Suggestions (barista → manager) ──────────────────────────────
function openSuggestTask(groupId, groupName) {
  document.getElementById('cl-suggest-group-id').value   = groupId;
  document.getElementById('cl-suggest-group-name').value = groupName;
  document.getElementById('cl-suggest-name').value  = '';
  document.getElementById('cl-suggest-notes').value = '';
  openModal('modal-cl-suggest');
}

async function saveSuggestedTask() {
  const name = document.getElementById('cl-suggest-name').value.trim();
  if (!name) { toast('err','Task name required'); return; }
  const groupId   = document.getElementById('cl-suggest-group-id').value;
  const groupName = document.getElementById('cl-suggest-group-name').value;
  try {
    const item = await addListItem(LISTS.checklists, {
      Title:        name, TaskName: name,
      GroupId:      groupId,
      Notes:        document.getElementById('cl-suggest-notes').value,
      Status:       'Suggested',
      SuggestedBy:  currentUser?.name || currentUser?.username || ''
    });
    cache.checklists.push(item);
    closeModal('modal-cl-suggest');
    toast('ok', '✓ Suggestion submitted — a manager will review it');
  } catch(e) { toast('err', 'Submit failed: '+e.message); }
}

function toggleSuggestionsPanel() {
  const panel = document.getElementById('cl-suggestions-panel');
  if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
  renderSuggestions();
}

function renderSuggestions() {
  const list  = document.getElementById('cl-suggestions-list');
  const empty = document.getElementById('cl-suggestions-empty');
  if (!list) return;
  const pending = cache.checklists.filter(t => t.Status === 'Suggested');
  if (!pending.length) { list.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  list.innerHTML = pending.map(t => {
    const grp = cache.clGroups.find(g => g.id === t.GroupId);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0c040;flex-wrap:wrap;">
      <div style="flex:1;min-width:160px;">
        <div style="font-weight:600;font-size:13px;">${escHtml(t.TaskName||'')}</div>
        <div style="font-size:11px;color:var(--muted);">In: ${escHtml(grp?.Title||t.GroupId||'Unknown')} · By: ${escHtml(t.SuggestedBy||'')}</div>
        ${t.Notes ? `<div style="font-size:11px;color:var(--warn-text);margin-top:2px;">"${escHtml(t.Notes)}"</div>` : ''}
      </div>
      <button onclick="approveTask('${t.id}')"
        style="padding:4px 12px;background:var(--good);color:#fff;border:none;border-radius:8px;font-size:12px;cursor:pointer;">✓ Approve</button>
      <button onclick="dismissSuggestedTask('${t.id}')"
        style="padding:4px 12px;background:none;border:1.5px solid var(--bad);color:var(--bad);border-radius:8px;font-size:12px;cursor:pointer;">✗ Dismiss</button>
    </div>`;
  }).join('');
}

async function approveTask(taskId) {
  try {
    await updateListItem(LISTS.checklists, taskId, { Status: 'Active' });
    const t = cache.checklists.find(t => t.id === taskId);
    if (t) t.Status = 'Active';
    toast('ok', '✓ Task approved');
    renderSuggestions();
    renderChecklists();
  } catch(e) { toast('err', 'Approve failed: '+e.message); }
}

async function dismissSuggestedTask(taskId) {
  if (!await confirmModal({ title: 'Dismiss this suggestion?', confirmLabel: 'Dismiss' })) return;
  try {
    const siteId = await getSiteId();
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.checklists}/items/${taskId}`);
    cache.checklists = cache.checklists.filter(t => t.id !== taskId);
    toast('ok', 'Suggestion dismissed');
    renderSuggestions();
    renderChecklists();
  } catch(e) { toast('err', 'Error: '+e.message); }
}

// ── Dashboard widget ─────────────────────────────────────────────
function updateDashChecklist() {
  const allTasks = cache.checklists.filter(t => t.Status !== 'Suggested' && t.GroupId);
  const done     = allTasks.filter(t => cache.clProgress[t.id]).length;
  // Count overdue tasks in multi-day plans (DueDate < today, not done)
  const multidayGroupIds = new Set(
    (cache.clGroups || []).filter(g => g.EndDate).map(g => g.id)
  );
  const today = _todayMidnight();
  let overdue = 0;
  for (const t of allTasks) {
    if (!multidayGroupIds.has(t.GroupId)) continue;
    if (cache.clProgress[t.id]) continue;
    const d = _parseDateOnly(t.DueDate);
    if (d && d < today) overdue++;
  }
  const el = document.getElementById('d-checklist');
  if (el) el.textContent = overdue ? `${done}/${allTasks.length} · ${overdue}⚠` : `${done}/${allTasks.length}`;
}
