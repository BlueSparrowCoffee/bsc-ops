/* ================================================================
 * BSC Ops — projects.js
 * Project tracker — top-level initiatives with tasks, updates, and
 * links. Card grid with status filter pills + search/filter bar;
 * click a card to open a detail page with sub-sections.
 *
 * Lists: BSC_Projects, BSC_ProjectTasks, BSC_ProjectUpdates,
 *        BSC_ProjectLinks (provisioned at PROVISION_VERSION 38)
 *
 * Permissions:
 *   - Managers/owners: create + edit anything
 *   - Baristas: read-only; see projects scoped to their location
 *
 * Depends on:
 *   state.js, constants.js, utils.js, graph.js, auth.js, settings.js
 * ================================================================ */

const PROJECT_STATUSES   = ['Planning', 'Active', 'On Hold', 'Done'];
// Planning was #9ca3af with white text — failed WCAG AA (~3.8:1). Darkened to #6b7280 (~5.0:1).
const PROJECT_STATUS_BG  = { 'Planning':'#6b7280', 'Active':'#3b82f6', 'On Hold':'#f59e0b', 'Done':'#16a34a' };
const PROJECT_HEALTH_DOT = { 'Green':'🟢', 'Yellow':'🟡', 'Red':'🔴' };
const LINK_TYPE_ICON     = { web:'🌐', doc:'📄', sheet:'📊', folder:'📁', video:'🎬', vendor:'🛒', other:'📎' };

let _projectStatusFilter = 'All';      // pill selection — All by default; user can narrow
let _projectEditId       = null;
let _projectDetailId     = null;       // null = grid view; id = detail view
let _projectLinkEditId   = null;
let _projectLinkProjId   = null;

// ── Helpers ──────────────────────────────────────────────────────
function _projTodayMidnight() {
  const d = new Date(); d.setHours(0,0,0,0); return d;
}
function _projParseDate(iso) {
  if (!iso) return null;
  const s = String(iso).split('T')[0];
  const [y,m,day] = s.split('-').map(Number);
  if (!y || !m || !day) return null;
  return new Date(y, m-1, day);
}
function _projFmtDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
function _projFmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
}
function _projParseWatchers(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}
function _projParsePinned(raw) {
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
  catch { return String(raw).split(',').map(s => s.trim()).filter(Boolean); }
}
function _projCurrentUserKey() {
  return currentUser?.username || currentUser?.name || '';
}
function _projIsArchived(p) {
  return p.Archived === 'archived' || p.Archived === true;
}
function _projShouldAutoArchive(p) {
  // Done > PROJECT_AUTO_ARCHIVE_DAYS → auto-archive (in-memory only; no SP write)
  if (p.Status !== 'Done' || _projIsArchived(p)) return false;
  const done = _projParseDate(p.DoneDate);
  if (!done) return false;
  const days = Math.floor((_projTodayMidnight() - done) / MS_PER_DAY);
  return days > PROJECT_AUTO_ARCHIVE_DAYS;
}
function _projCanEdit() {
  return typeof isManagerOrOwner === 'function' ? isManagerOrOwner() : true;
}
function _projCanSeeProject(p) {
  // Managers/owners see everything; baristas see projects scoped to their location
  if (_projCanEdit()) return true;
  if (!p.Location || p.Location === 'All') return true;
  const allowed = (typeof getAllowedLocations === 'function') ? getAllowedLocations() : [];
  return allowed.includes(p.Location);
}
function _projTaskOverdue(t) {
  if (t.Status === 'Done') return false;
  const d = _projParseDate(t.DueDate);
  return d && d < _projTodayMidnight();
}
function _projTaskDueToday(t) {
  if (t.Status === 'Done') return false;
  const d = _projParseDate(t.DueDate);
  if (!d) return false;
  const today = _projTodayMidnight();
  return d.getTime() === today.getTime();
}
function _projTasksFor(projectId) {
  return (cache.projectTasks || []).filter(t => t.ProjectId === projectId);
}
function _projUpdatesFor(projectId) {
  return (cache.projectUpdates || []).filter(u => u.ProjectId === projectId);
}
function _projLinksFor(projectId) {
  return (cache.projectLinks || []).filter(l => l.ProjectId === projectId);
}

// ── Main grid render ─────────────────────────────────────────────
function renderProjects() {
  // If we're on a detail page, render that instead
  if (_projectDetailId) { renderProjectDetail(); return; }

  const gridView   = document.getElementById('projects-grid-view');
  const detailView = document.getElementById('projects-detail-view');
  if (gridView)   gridView.style.display   = '';
  if (detailView) detailView.style.display = 'none';

  const userIsMgr = _projCanEdit();
  const newBtn = document.getElementById('proj-new-btn');
  if (newBtn) newBtn.style.display = userIsMgr ? '' : 'none';

  // Populate filter dropdowns (idempotent — only refill if empty)
  const ownerSel = document.getElementById('proj-owner-filter');
  if (ownerSel && ownerSel.options.length <= 1) {
    const owners = [...new Set((cache.projects || []).map(p => p.Owner).filter(Boolean))].sort();
    ownerSel.innerHTML = '<option value="">All owners</option>' + owners.map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
  }
  const locSel = document.getElementById('proj-loc-filter');
  if (locSel && locSel.options.length <= 1 && typeof getLocations === 'function') {
    locSel.innerHTML = '<option value="">All locations</option><option value="All">All Locations</option>' +
      getLocations().map(l => `<option value="${escHtml(l)}">${escHtml(l)}</option>`).join('');
  }
  const tagSel = document.getElementById('proj-tag-filter');
  if (tagSel && tagSel.options.length <= 1) {
    const tags = [...new Set((cache.projects || []).map(p => p.Tag).filter(Boolean))].sort();
    tagSel.innerHTML = '<option value="">All tags</option>' + tags.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
  }

  // Apply filters
  const q       = (document.getElementById('proj-search')?.value || '').toLowerCase().trim();
  const fOwner  = document.getElementById('proj-owner-filter')?.value || '';
  const fLoc    = document.getElementById('proj-loc-filter')?.value || '';
  const fTag    = document.getElementById('proj-tag-filter')?.value || '';
  const showArc = document.getElementById('proj-show-archived')?.checked || false;

  let projects = (cache.projects || []).filter(p => _projCanSeeProject(p));
  // Apply auto-archive in-memory (the SP write happens lazily next time the
  // project is touched — keeps the grid tidy without forcing a batch update)
  if (!showArc) projects = projects.filter(p => !_projIsArchived(p) && !_projShouldAutoArchive(p));

  // Status pills — always show counts including filtered-out items so the
  // user can see "30 done" even when the active grid is empty
  _renderProjectStatusPills(projects);

  if (_projectStatusFilter && _projectStatusFilter !== 'All') {
    projects = projects.filter(p => (p.Status || 'Planning') === _projectStatusFilter);
  }
  if (q)      projects = projects.filter(p => [p.Title, p.Description, p.Tag, p.Owner].filter(Boolean).join(' ').toLowerCase().includes(q));
  if (fOwner) projects = projects.filter(p => p.Owner === fOwner);
  if (fLoc)   projects = projects.filter(p => (p.Location || 'All') === fLoc);
  if (fTag)   projects = projects.filter(p => p.Tag === fTag);

  // Sort: pinned first, then by priority (High > Med > Low), then by due date asc
  const prioRank = { 'High':0, 'Medium':1, 'Low':2 };
  const userKey  = _projCurrentUserKey();
  projects.sort((a, b) => {
    const aPin = _projParsePinned(a.PinnedBy).includes(userKey) ? 0 : 1;
    const bPin = _projParsePinned(b.PinnedBy).includes(userKey) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    const ap = prioRank[a.Priority] != null ? prioRank[a.Priority] : 1;
    const bp = prioRank[b.Priority] != null ? prioRank[b.Priority] : 1;
    if (ap !== bp) return ap - bp;
    const ad = _projParseDate(a.DueDate);
    const bd = _projParseDate(b.DueDate);
    if (ad && bd) return ad - bd;
    if (ad) return -1;
    if (bd) return 1;
    return (a.Title || '').localeCompare(b.Title || '');
  });

  const grid  = document.getElementById('projects-grid');
  const empty = document.getElementById('projects-empty');
  if (!projects.length) {
    if (grid)  grid.innerHTML = '';
    if (empty) empty.style.display = '';
  } else {
    if (empty) empty.style.display = 'none';
    if (grid)  grid.innerHTML = projects.map(_projectCardHtml).join('');
  }
}

function _renderProjectStatusPills(visibleProjects) {
  const wrap = document.getElementById('proj-status-pills');
  if (!wrap) return;
  const counts = { 'All': visibleProjects.length };
  for (const s of PROJECT_STATUSES) counts[s] = 0;
  for (const p of visibleProjects) counts[p.Status || 'Planning'] = (counts[p.Status || 'Planning'] || 0) + 1;
  const pill = (key, label) => {
    const active = _projectStatusFilter === key;
    const bg     = active ? 'var(--dark-blue)' : 'var(--bg-card)';
    const color  = active ? '#fff' : 'var(--text)';
    return `<button type="button" data-key="${escHtml(key)}" onclick="setProjectStatusFilter(this.dataset.key)" style="padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:${bg};color:${color};cursor:pointer;font-size:12px;font-weight:600;">${escHtml(label)} <span style="opacity:.7;font-weight:400;">${counts[key] || 0}</span></button>`;
  };
  wrap.innerHTML = [
    pill('All', 'All'),
    ...PROJECT_STATUSES.map(s => pill(s, s))
  ].join('');
}

function setProjectStatusFilter(key) {
  _projectStatusFilter = key;
  renderProjects();
}

// ── Card HTML ────────────────────────────────────────────────────
function _projectCardHtml(p) {
  const tasks   = _projTasksFor(p.id);
  const total   = tasks.length;
  const done    = tasks.filter(t => t.Status === 'Done').length;
  const overdue = tasks.filter(_projTaskOverdue).length;
  const pct     = total ? Math.round(done / total * 100) : 0;
  const status  = p.Status || 'Planning';
  const health  = p.Health || 'Green';
  const blocker = (p.Blocker || '').trim();
  const isPinned = _projParsePinned(p.PinnedBy).includes(_projCurrentUserKey());
  const archived = _projIsArchived(p);

  // Border color: red if blocked, then health-driven, then status
  const borderColor = blocker ? 'var(--bad)'
    : health === 'Red'    ? 'var(--bad)'
    : health === 'Yellow' ? 'var(--warn)'
    : PROJECT_STATUS_BG[status] || 'var(--border)';

  const dueD = _projParseDate(p.DueDate);
  let dueLabel = '';
  if (dueD) {
    const today = _projTodayMidnight();
    const diff = Math.round((dueD - today) / 86400000);
    if (status === 'Done') dueLabel = `Due ${_projFmtDate(dueD)}`;
    else if (diff < 0)     dueLabel = `🔴 ${Math.abs(diff)}d overdue`;
    else if (diff === 0)   dueLabel = '🟡 Due today';
    else if (diff <= 7)    dueLabel = `Due in ${diff}d`;
    else                   dueLabel = `Due ${_projFmtDate(dueD)}`;
  }

  const watchers = _projParseWatchers(p.Watchers);
  const watcherChip = watchers.length ? `<span title="${escHtml(watchers.join(', '))}" style="font-size:11px;color:var(--muted);">👁 ${watchers.length}</span>` : '';
  const linksCount  = _projLinksFor(p.id).length;
  const linksChip   = linksCount ? `<span style="font-size:11px;color:var(--muted);">🔗 ${linksCount}</span>` : '';
  const updateCount = _projUpdatesFor(p.id).length;
  const updateChip  = updateCount ? `<span style="font-size:11px;color:var(--muted);">💬 ${updateCount}</span>` : '';

  return `
    <div class="card" style="padding:0;overflow:hidden;border-left:4px solid ${borderColor};${archived?'opacity:.6;':''}cursor:pointer;" onclick="openProjectDetail('${escHtml(p.id)}')">
      <div style="padding:12px 14px 10px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:14px;">${PROJECT_HEALTH_DOT[health] || '🟢'}</span>
              <div style="font-weight:700;font-size:14px;line-height:1.25;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(p.Title || 'Untitled')}</div>
              ${isPinned ? '<span title="Pinned" style="font-size:12px;">📌</span>' : ''}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;">
              <span style="font-size:11px;background:${PROJECT_STATUS_BG[status]};color:#fff;padding:2px 8px;border-radius:10px;">${escHtml(status)}</span>
              ${p.Priority ? `<span style="font-size:11px;background:var(--opal);padding:2px 8px;border-radius:10px;">${escHtml(p.Priority)}</span>` : ''}
              ${p.Tag ? `<span style="font-size:11px;background:#faf6ec;color:#b78b40;padding:2px 8px;border-radius:10px;border:1px solid #f0e3c0;">${escHtml(p.Tag)}</span>` : ''}
              ${(p.Location && p.Location !== 'All') ? `<span style="font-size:11px;color:var(--muted);">📍 ${escHtml(p.Location)}</span>` : ''}
            </div>
          </div>
        </div>
        ${blocker ? `<div style="margin-top:8px;padding:5px 10px;background:var(--bad-bg);color:var(--bad);border-radius:6px;font-size:11px;line-height:1.3;">⚠️ <b>Blocked:</b> ${escHtml(blocker.length>120 ? blocker.slice(0,120)+'…' : blocker)}</div>` : ''}
        ${total ? `
        <div style="margin-top:10px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:3px;">
            <span>${done} of ${total} tasks${overdue?` · ${overdue} overdue`:''}</span><span>${pct}%</span>
          </div>
          <div class="progress-wrap" style="height:5px;">
            <div class="progress-bar${pct===100?' complete':''}" style="width:${pct}%;transition:width .3s;"></div>
          </div>
        </div>` : ''}
      </div>
      <div style="padding:8px 14px;border-top:1px solid var(--opal);display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:var(--muted);flex-wrap:wrap;">
        <div style="display:flex;gap:10px;align-items:center;">
          ${p.Owner ? `<span>👤 ${escHtml(p.Owner)}</span>` : ''}
          ${watcherChip}
          ${linksChip}
          ${updateChip}
        </div>
        <div style="font-weight:600;${dueLabel.startsWith('🔴')?'color:var(--bad);':dueLabel.startsWith('🟡')?'color:var(--warn-text);':''}">${escHtml(dueLabel)}</div>
      </div>
    </div>`;
}

// ── Detail page ──────────────────────────────────────────────────
function openProjectDetail(projectId) {
  _projectDetailId = projectId;
  renderProjects();
}
function exitProjectDetail() {
  _projectDetailId = null;
  renderProjects();
}

function renderProjectDetail() {
  const gridView   = document.getElementById('projects-grid-view');
  const detailView = document.getElementById('projects-detail-view');
  if (!detailView) return;
  if (gridView)   gridView.style.display   = 'none';
  detailView.style.display = '';

  const p = (cache.projects || []).find(x => x.id === _projectDetailId);
  if (!p) {
    detailView.innerHTML = `<div class="card" style="padding:32px 20px;text-align:center;color:var(--muted);">
      Project not found. <button class="btn btn-outline" style="margin-left:10px;" onclick="exitProjectDetail()">← Back</button></div>`;
    return;
  }

  const userIsMgr = _projCanEdit();
  const status    = p.Status || 'Planning';
  const health    = p.Health || 'Green';
  const blocker   = (p.Blocker || '').trim();
  const watchers  = _projParseWatchers(p.Watchers);
  const userKey   = _projCurrentUserKey();
  const isPinned  = _projParsePinned(p.PinnedBy).includes(userKey);
  const archived  = _projIsArchived(p);

  const tasks    = [..._projTasksFor(p.id)].sort((a,b) => {
    if (a.Status === 'Done' && b.Status !== 'Done') return 1;
    if (b.Status === 'Done' && a.Status !== 'Done') return -1;
    const ad = _projParseDate(a.DueDate);
    const bd = _projParseDate(b.DueDate);
    if (ad && bd && ad.getTime() !== bd.getTime()) return ad - bd;
    if (ad && !bd) return -1;
    if (bd && !ad) return 1;
    const sa = parseFloat(a.SortOrder); const sb = parseFloat(b.SortOrder);
    if (!isNaN(sa) && !isNaN(sb) && sa !== sb) return sa - sb;
    return (a.TaskName || '').localeCompare(b.TaskName || '');
  });
  const updates = [..._projUpdatesFor(p.id)].sort((a,b) => new Date(b.Created || 0) - new Date(a.Created || 0));
  const links   = [..._projLinksFor(p.id)].sort((a,b) => (parseFloat(a.SortOrder)||0) - (parseFloat(b.SortOrder)||0));

  const dueD = _projParseDate(p.DueDate);
  const startD = _projParseDate(p.StartDate);

  // Status quick-switcher (manager only)
  const statusBtns = userIsMgr
    ? PROJECT_STATUSES.map(s => `<button onclick="setProjectStatus('${escHtml(p.id)}','${escHtml(s)}')" style="padding:5px 12px;border-radius:8px;border:1.5px solid ${s===status?PROJECT_STATUS_BG[s]:'var(--border)'};background:${s===status?PROJECT_STATUS_BG[s]:'var(--bg-card)'};color:${s===status?'#fff':'var(--text)'};font-size:12px;font-weight:600;cursor:pointer;">${escHtml(s)}</button>`).join(' ')
    : `<span style="font-size:12px;background:${PROJECT_STATUS_BG[status]};color:#fff;padding:4px 12px;border-radius:8px;font-weight:600;">${escHtml(status)}</span>`;

  const healthBtns = userIsMgr
    ? Object.entries(PROJECT_HEALTH_DOT).map(([k,emoji]) => `<button onclick="setProjectHealth('${escHtml(p.id)}','${k}')" title="${k}" style="padding:5px 10px;border-radius:8px;border:1.5px solid ${k===health?'var(--dark-blue)':'var(--border)'};background:${k===health?'var(--bg-card)':'var(--bg-card)'};font-size:14px;cursor:pointer;${k===health?'box-shadow:0 0 0 1px var(--dark-blue) inset;':''}">${emoji}</button>`).join(' ')
    : `<span style="font-size:18px;">${PROJECT_HEALTH_DOT[health] || '🟢'}</span>`;

  // Tasks section
  const taskRows = tasks.map(t => {
    const isDone   = t.Status === 'Done';
    const overdue  = _projTaskOverdue(t);
    const today    = _projTaskDueToday(t);
    const dD       = _projParseDate(t.DueDate);
    const dateChip = dD
      ? `<span style="font-size:11px;color:${overdue?'var(--bad)':today?'var(--warn-text)':'var(--muted)'};${overdue||today?'font-weight:600;':''}">${_projFmtDate(dD)}</span>`
      : `<span style="font-size:11px;color:var(--muted);">—</span>`;
    const dateBtn = userIsMgr
      ? `<button onclick="event.stopPropagation();editProjectTaskDate('${escHtml(t.id)}')" title="Set due date" style="background:none;border:1px dashed var(--border);border-radius:8px;padding:2px 8px;cursor:pointer;">${dateChip}</button>`
      : dateChip;
    const assigneeBtn = userIsMgr
      ? `<button onclick="event.stopPropagation();editProjectTaskAssignee('${escHtml(t.id)}')" title="Set assignee" style="background:none;border:1px dashed var(--border);border-radius:8px;padding:2px 8px;cursor:pointer;font-size:11px;color:var(--muted);">${escHtml(t.Assignee || 'Unassigned')}</button>`
      : `<span style="font-size:11px;color:var(--muted);">${escHtml(t.Assignee || 'Unassigned')}</span>`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--opal);">
      <input type="checkbox" ${isDone?'checked':''} ${userIsMgr || (t.Assignee && t.Assignee === currentUser?.name)?'':'disabled'} onchange="toggleProjectTaskDone('${escHtml(t.id)}',this.checked)">
      <span style="flex:1;font-size:13px;${isDone?'text-decoration:line-through;color:var(--muted);':''}">${escHtml(t.TaskName || '')}</span>
      ${assigneeBtn}
      ${dateBtn}
      ${userIsMgr ? `<button onclick="deleteProjectTask('${escHtml(t.id)}')" title="Remove task" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;line-height:1;padding:0 2px;">×</button>` : ''}
    </div>`;
  }).join('');

  const taskAddRow = userIsMgr ? `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px;">
      <input id="proj-new-task-name" placeholder="Add a task…" style="flex:1;min-width:160px;padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;" onkeydown="if(event.key==='Enter')addProjectTask('${escHtml(p.id)}')">
      <input id="proj-new-task-assignee" placeholder="Assignee…" style="width:140px;padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;">
      <input id="proj-new-task-date" type="date" title="Due date" style="width:140px;padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;">
      <button class="btn btn-primary" style="padding:6px 14px;font-size:13px;" onclick="addProjectTask('${escHtml(p.id)}')">+ Add Task</button>
    </div>` : '';

  // Updates feed
  const updateRows = updates.map(u => `
    <div style="padding:10px 12px;border-bottom:1px solid var(--opal);">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:11px;color:var(--muted);margin-bottom:4px;">
        <span style="font-weight:600;color:var(--text);">${escHtml(u.Author || 'Unknown')}</span>
        <span>${_projFmtDateTime(u.Created)}${userIsMgr ? ` · <button style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;" onclick="deleteProjectUpdate('${escHtml(u.id)}')">delete</button>` : ''}</span>
      </div>
      <div style="font-size:13px;line-height:1.5;white-space:pre-wrap;">${escHtml(u.Body || '')}</div>
    </div>`).join('');
  const updateAddRow = `
    <div style="padding:10px 12px;border-bottom:2px solid var(--border);">
      <textarea id="proj-new-update" rows="2" placeholder="Add an update — what changed? what's next?" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;resize:vertical;font-family:inherit;"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:6px;">
        <button class="btn btn-primary btn-sm" onclick="addProjectUpdate('${escHtml(p.id)}')">Post Update</button>
      </div>
    </div>`;

  // Links list
  const linkRows = links.map(l => {
    const icon = LINK_TYPE_ICON[l.LinkType] || '🌐';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--opal);">
      <span style="font-size:16px;flex-shrink:0;">${icon}</span>
      <a href="${escHtml(l.URL || '#')}" target="_blank" rel="noopener noreferrer" style="flex:1;font-size:13px;color:var(--dark-blue);text-decoration:none;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(l.Label || l.URL || 'Untitled link')}</a>
      ${userIsMgr ? `
        <button onclick="moveProjectLink('${escHtml(l.id)}',-1)" title="Move up" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;padding:0 4px;">↑</button>
        <button onclick="moveProjectLink('${escHtml(l.id)}',1)" title="Move down" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;padding:0 4px;">↓</button>
        <button onclick="openProjectLinkForm('${escHtml(p.id)}','${escHtml(l.id)}')" title="Edit" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:13px;padding:0 4px;">✏️</button>
        <button onclick="deleteProjectLink('${escHtml(l.id)}')" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;padding:0 4px;">×</button>
      ` : ''}
    </div>`;
  }).join('');

  detailView.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
      <button class="btn btn-outline" style="padding:6px 14px;" onclick="exitProjectDetail()">← Back</button>
      ${userIsMgr ? `<button class="btn btn-outline" style="padding:6px 14px;" onclick="openProjectForm('${escHtml(p.id)}')">✏️ Edit</button>` : ''}
      <button class="btn btn-outline" style="padding:6px 14px;${isPinned?'background:#fef3c7;':''}" onclick="toggleProjectPin('${escHtml(p.id)}')">${isPinned?'📌 Pinned':'📍 Pin'}</button>
      ${userIsMgr ? `<button class="btn btn-outline" style="padding:6px 14px;" onclick="toggleProjectArchive('${escHtml(p.id)}')">${archived?'Unarchive':'Archive'}</button>` : ''}
      ${archived ? '<span style="font-size:12px;color:var(--muted);font-style:italic;">archived</span>' : ''}
    </div>

    <div class="card" style="padding:18px 22px;margin-bottom:14px;">
      <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:240px;">
          <div style="font-size:22px;font-weight:700;line-height:1.2;margin-bottom:6px;">${escHtml(p.Title || 'Untitled')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
            ${p.Tag ? `<span style="font-size:12px;background:#faf6ec;color:#b78b40;padding:3px 10px;border-radius:10px;border:1px solid #f0e3c0;">${escHtml(p.Tag)}</span>` : ''}
            ${p.Priority ? `<span style="font-size:12px;background:var(--opal);padding:3px 10px;border-radius:10px;">${escHtml(p.Priority)} priority</span>` : ''}
            ${p.Owner ? `<span style="font-size:12px;color:var(--muted);">👤 Owner: <b style="color:var(--text);">${escHtml(p.Owner)}</b></span>` : ''}
            ${(p.Location && p.Location !== 'All') ? `<span style="font-size:12px;color:var(--muted);">📍 ${escHtml(p.Location)}</span>` : ''}
          </div>
          ${p.Description ? `<div style="font-size:13px;color:var(--text);line-height:1.5;white-space:pre-wrap;margin-bottom:10px;">${escHtml(p.Description)}</div>` : ''}
          <div style="display:flex;gap:14px;font-size:12px;color:var(--muted);flex-wrap:wrap;">
            ${startD ? `<span>Start: ${_projFmtDate(startD)}</span>` : ''}
            ${dueD ? `<span>Due: ${_projFmtDate(dueD)}</span>` : ''}
            ${p.DoneDate ? `<span>Done: ${_projFmtDate(_projParseDate(p.DoneDate))}</span>` : ''}
            ${watchers.length ? `<span title="${escHtml(watchers.join(', '))}">👁 ${watchers.length} watcher${watchers.length===1?'':'s'}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end;">
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="font-size:11px;color:var(--muted);">Health:</span> ${healthBtns}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">${statusBtns}</div>
        </div>
      </div>
      ${blocker ? `
      <div style="margin-top:14px;padding:10px 14px;background:var(--bad-bg);color:var(--bad);border-radius:8px;border-left:4px solid var(--bad);font-size:13px;line-height:1.4;">
        <div style="font-weight:700;margin-bottom:4px;">⚠️ Blocked</div>
        <div style="white-space:pre-wrap;">${escHtml(blocker)}</div>
      </div>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:1fr;gap:14px;">
      <!-- Tasks -->
      <div class="card">
        <div style="padding:14px 16px 10px;border-bottom:1px solid var(--opal);">
          <div style="font-weight:700;font-size:14px;">📋 Tasks <span style="font-weight:400;color:var(--muted);font-size:12px;">${tasks.length ? `(${tasks.filter(t=>t.Status==='Done').length}/${tasks.length})` : ''}</span></div>
        </div>
        <div style="padding:6px 16px 14px;">
          ${taskRows || `<div style="font-size:12px;color:var(--muted);padding:14px 0;text-align:center;">${userIsMgr?'No tasks yet — add one below':'No tasks yet'}</div>`}
          ${taskAddRow}
        </div>
      </div>

      <!-- Updates -->
      <div class="card">
        <div style="padding:14px 16px 10px;border-bottom:1px solid var(--opal);">
          <div style="font-weight:700;font-size:14px;">💬 Updates <span style="font-weight:400;color:var(--muted);font-size:12px;">${updates.length}</span></div>
        </div>
        ${updateAddRow}
        <div>
          ${updateRows || `<div style="font-size:12px;color:var(--muted);padding:14px 16px;text-align:center;font-style:italic;">No updates yet — post one above</div>`}
        </div>
      </div>

      <!-- Links -->
      <div class="card">
        <div style="padding:14px 16px 10px;border-bottom:1px solid var(--opal);display:flex;justify-content:space-between;align-items:center;">
          <div style="font-weight:700;font-size:14px;">🔗 Links <span style="font-weight:400;color:var(--muted);font-size:12px;">${links.length}</span></div>
          ${userIsMgr ? `<button class="btn btn-outline btn-sm" onclick="openProjectLinkForm('${escHtml(p.id)}')">+ Add Link</button>` : ''}
        </div>
        <div style="padding:6px 16px 14px;">
          ${linkRows || `<div style="font-size:12px;color:var(--muted);padding:14px 0;text-align:center;font-style:italic;">No links yet${userIsMgr?' — click + Add Link':''}</div>`}
        </div>
      </div>
    </div>`;
}

// ── Project create/edit ──────────────────────────────────────────
function openProjectForm(projectId) {
  if (!_projCanEdit()) { toast('err','Manager access required'); return; }
  _projectEditId = projectId || null;
  const p = projectId ? (cache.projects || []).find(x => x.id === projectId) : null;
  document.getElementById('proj-modal-title').textContent = p ? 'Edit Project' : 'New Project';

  document.getElementById('proj-title').value    = p?.Title || '';
  document.getElementById('proj-status').value   = p?.Status || 'Planning';
  document.getElementById('proj-priority').value = p?.Priority || 'Medium';
  document.getElementById('proj-health').value   = p?.Health || 'Green';
  document.getElementById('proj-tag').value      = p?.Tag || '';
  document.getElementById('proj-start').value    = p?.StartDate ? p.StartDate.split('T')[0] : '';
  document.getElementById('proj-due').value      = p?.DueDate   ? p.DueDate.split('T')[0]   : '';
  document.getElementById('proj-watchers').value = _projParseWatchers(p?.Watchers).join(', ');
  document.getElementById('proj-desc').value     = p?.Description || '';
  document.getElementById('proj-blocker').value  = p?.Blocker || '';

  // Owner select — staff names + current owner if not in list
  const ownerSel = document.getElementById('proj-owner');
  const staffNames = [...new Set([
    ...(cache.staff || []).map(s => s.FullName || s.Title).filter(Boolean),
    ...(p?.Owner ? [p.Owner] : [])
  ])].sort();
  ownerSel.innerHTML = '<option value="">—</option>' + staffNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  ownerSel.value = p?.Owner || '';

  // Location select
  const locSel = document.getElementById('proj-loc');
  if (typeof getLocations === 'function') {
    locSel.innerHTML = '<option value="All">All Locations</option>' + getLocations().map(l => `<option value="${escHtml(l)}">${escHtml(l)}</option>`).join('');
  }
  locSel.value = p?.Location || 'All';

  document.getElementById('proj-delete-btn').style.display = p ? '' : 'none';
  openModal('modal-project');
}

async function saveProject() {
  const name = document.getElementById('proj-title').value.trim();
  if (!name) { toast('err','Project name required'); return; }
  const startRaw = document.getElementById('proj-start').value;
  const dueRaw   = document.getElementById('proj-due').value;
  const newStatus = document.getElementById('proj-status').value;
  const watchersRaw = document.getElementById('proj-watchers').value.trim();
  const watchers    = watchersRaw ? watchersRaw.split(',').map(s=>s.trim()).filter(Boolean).join(',') : '';

  const fields = {
    Title:       name,
    Status:      newStatus,
    Priority:    document.getElementById('proj-priority').value,
    Health:      document.getElementById('proj-health').value,
    Tag:         document.getElementById('proj-tag').value,
    Owner:       document.getElementById('proj-owner').value,
    Location:    document.getElementById('proj-loc').value || 'All',
    StartDate:   startRaw ? startRaw + 'T00:00:00Z' : null,
    DueDate:     dueRaw   ? dueRaw   + 'T00:00:00Z' : null,
    Watchers:    watchers,
    Description: document.getElementById('proj-desc').value.trim(),
    Blocker:     document.getElementById('proj-blocker').value.trim()
  };

  // Auto-set / clear DoneDate when status flips
  const existing = _projectEditId ? (cache.projects || []).find(x => x.id === _projectEditId) : null;
  if (newStatus === 'Done') {
    fields.DoneDate = existing?.DoneDate || new Date().toISOString();
  } else if (existing?.Status === 'Done' && newStatus !== 'Done') {
    fields.DoneDate = null;
  }

  try {
    if (_projectEditId) {
      await updateListItem(LISTS.projects, _projectEditId, fields);
      const idx = cache.projects.findIndex(x => x.id === _projectEditId);
      if (idx !== -1) cache.projects[idx] = { ...cache.projects[idx], ...fields };
      toast('ok','✓ Project updated');
    } else {
      const item = await addListItem(LISTS.projects, fields);
      cache.projects.push(item);
      toast('ok','✓ Project created');
    }
    closeModal('modal-project');
    renderProjects();
  } catch(e) { toast('err','Save failed: '+e.message); }
}

async function deleteProject() {
  if (!_projectEditId) return;
  const p = (cache.projects || []).find(x => x.id === _projectEditId);
  if (!p) return;
  if (!await confirmModal({ title: `Delete "${p.Title}"?`, body: 'All tasks, updates, and links for this project will also be deleted.\n\nThis cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
  try {
    const siteId = await getSiteId();
    // Cascade-delete children
    const tasks = _projTasksFor(p.id);
    const updates = _projUpdatesFor(p.id);
    const links = _projLinksFor(p.id);
    for (const t of tasks)   await graph('DELETE', `/sites/${siteId}/lists/${LISTS.projectTasks}/items/${t.id}`).catch(()=>{});
    for (const u of updates) await graph('DELETE', `/sites/${siteId}/lists/${LISTS.projectUpdates}/items/${u.id}`).catch(()=>{});
    for (const l of links)   await graph('DELETE', `/sites/${siteId}/lists/${LISTS.projectLinks}/items/${l.id}`).catch(()=>{});
    cache.projectTasks   = (cache.projectTasks   || []).filter(t => t.ProjectId !== p.id);
    cache.projectUpdates = (cache.projectUpdates || []).filter(u => u.ProjectId !== p.id);
    cache.projectLinks   = (cache.projectLinks   || []).filter(l => l.ProjectId !== p.id);
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.projects}/items/${p.id}`);
    cache.projects = cache.projects.filter(x => x.id !== p.id);
    closeModal('modal-project');
    toast('ok','✓ Project deleted');
    exitProjectDetail();
  } catch(e) { toast('err','Delete failed: '+e.message); }
}

// ── Status / health / pin / archive ──────────────────────────────
async function setProjectStatus(projectId, newStatus) {
  if (!_projCanEdit()) { toast('err','Manager access required'); return; }
  const p = (cache.projects || []).find(x => x.id === projectId);
  if (!p) return;
  const fields = { Status: newStatus };
  if (newStatus === 'Done') fields.DoneDate = p.DoneDate || new Date().toISOString();
  else if (p.Status === 'Done') fields.DoneDate = null;
  try {
    await updateListItem(LISTS.projects, projectId, fields);
    Object.assign(p, fields);
    renderProjects();
    toast('ok',`✓ Status: ${newStatus}`);
  } catch(e) { toast('err','Update failed: '+e.message); }
}

async function setProjectHealth(projectId, newHealth) {
  if (!_projCanEdit()) { toast('err','Manager access required'); return; }
  const p = (cache.projects || []).find(x => x.id === projectId);
  if (!p) return;
  try {
    await updateListItem(LISTS.projects, projectId, { Health: newHealth });
    p.Health = newHealth;
    renderProjects();
  } catch(e) { toast('err','Update failed: '+e.message); }
}

async function toggleProjectPin(projectId) {
  const p = (cache.projects || []).find(x => x.id === projectId);
  if (!p) return;
  const userKey = _projCurrentUserKey();
  if (!userKey) { toast('err','Sign-in required'); return; }
  const pins = _projParsePinned(p.PinnedBy);
  const idx  = pins.indexOf(userKey);
  if (idx >= 0) pins.splice(idx, 1); else pins.push(userKey);
  // Cap at top 3 per user — drop oldest if exceeded
  // (simpler: just toggle; user manages their own pins)
  const next = JSON.stringify(pins);
  try {
    await updateListItem(LISTS.projects, projectId, { PinnedBy: next });
    p.PinnedBy = next;
    renderProjects();
    toast('ok', idx >= 0 ? 'Unpinned' : '📌 Pinned');
  } catch(e) { toast('err','Update failed: '+e.message); }
}

async function toggleProjectArchive(projectId) {
  if (!_projCanEdit()) { toast('err','Manager access required'); return; }
  const p = (cache.projects || []).find(x => x.id === projectId);
  if (!p) return;
  const next = _projIsArchived(p) ? '' : 'archived';
  try {
    await updateListItem(LISTS.projects, projectId, { Archived: next });
    p.Archived = next;
    renderProjects();
    toast('ok', next ? '📁 Archived' : 'Unarchived');
  } catch(e) { toast('err','Update failed: '+e.message); }
}

// ── Tasks ────────────────────────────────────────────────────────
async function addProjectTask(projectId) {
  if (!_projCanEdit()) return;
  const nameEl = document.getElementById('proj-new-task-name');
  const asnEl  = document.getElementById('proj-new-task-assignee');
  const dateEl = document.getElementById('proj-new-task-date');
  const name = (nameEl?.value || '').trim();
  if (!name) { toast('err','Task name required'); return; }
  const fields = {
    Title:    name,
    ProjectId: projectId,
    TaskName: name,
    Assignee: (asnEl?.value || '').trim(),
    Status:   'Open',
    DueDate:  dateEl?.value ? dateEl.value + 'T00:00:00Z' : null,
    SortOrder: (_projTasksFor(projectId).length || 0)
  };
  try {
    const item = await addListItem(LISTS.projectTasks, fields);
    cache.projectTasks.push(item);
    if (nameEl) nameEl.value = '';
    if (asnEl)  asnEl.value  = '';
    if (dateEl) dateEl.value = '';
    renderProjects();
  } catch(e) { toast('err','Add task failed: '+e.message); }
}

async function toggleProjectTaskDone(taskId, isDone) {
  const t = (cache.projectTasks || []).find(x => x.id === taskId);
  if (!t) return;
  // Manager OR assigned user can check off
  if (!_projCanEdit() && t.Assignee !== currentUser?.name) { toast('err','Only manager or assignee can update'); return; }
  try {
    await updateListItem(LISTS.projectTasks, taskId, { Status: isDone ? 'Done' : 'Open' });
    t.Status = isDone ? 'Done' : 'Open';
    renderProjects();
  } catch(e) { toast('err','Update failed: '+e.message); }
}

async function editProjectTaskDate(taskId) {
  if (!_projCanEdit()) return;
  const t = (cache.projectTasks || []).find(x => x.id === taskId);
  if (!t) return;
  const current = t.DueDate ? String(t.DueDate).split('T')[0] : '';
  const res = await pickDate(current, 'Task due date');
  if (!res.ok) return;
  const trimmed = res.value;
  let dueIso = null;
  if (trimmed) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) { toast('err','Invalid date'); return; }
    dueIso = trimmed + 'T00:00:00Z';
  }
  try {
    await updateListItem(LISTS.projectTasks, taskId, { DueDate: dueIso });
    t.DueDate = dueIso;
    renderProjects();
  } catch(e) { toast('err','Update failed: '+e.message); }
}

async function editProjectTaskAssignee(taskId) {
  if (!_projCanEdit()) return;
  const t = (cache.projectTasks || []).find(x => x.id === taskId);
  if (!t) return;
  const res = await pickText(t.Assignee || '', 'Assignee', 'Name (blank to unassign)');
  if (!res.ok) return;
  try {
    await updateListItem(LISTS.projectTasks, taskId, { Assignee: res.value });
    t.Assignee = res.value;
    renderProjects();
  } catch(e) { toast('err','Update failed: '+e.message); }
}

async function deleteProjectTask(taskId) {
  if (!_projCanEdit()) return;
  if (!await confirmModal({ title: 'Delete this task?', confirmLabel: 'Delete', danger: true })) return;
  try {
    const siteId = await getSiteId();
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.projectTasks}/items/${taskId}`);
    cache.projectTasks = (cache.projectTasks || []).filter(t => t.id !== taskId);
    renderProjects();
  } catch(e) { toast('err','Delete failed: '+e.message); }
}

// ── Updates ──────────────────────────────────────────────────────
async function addProjectUpdate(projectId) {
  const ta = document.getElementById('proj-new-update');
  const body = (ta?.value || '').trim();
  if (!body) { toast('err','Type something first'); return; }
  const fields = {
    Title:     body.slice(0, 60),  // human-readable label in SP
    ProjectId: projectId,
    Author:    currentUser?.name || currentUser?.username || 'Unknown',
    Body:      body
  };
  try {
    const item = await addListItem(LISTS.projectUpdates, fields);
    cache.projectUpdates.push(item);
    if (ta) ta.value = '';
    renderProjects();
    toast('ok','✓ Update posted');
  } catch(e) { toast('err','Post failed: '+e.message); }
}

async function deleteProjectUpdate(updateId) {
  if (!_projCanEdit()) return;
  if (!await confirmModal({ title: 'Delete this update?', confirmLabel: 'Delete', danger: true })) return;
  try {
    const siteId = await getSiteId();
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.projectUpdates}/items/${updateId}`);
    cache.projectUpdates = (cache.projectUpdates || []).filter(u => u.id !== updateId);
    renderProjects();
  } catch(e) { toast('err','Delete failed: '+e.message); }
}

// ── Links ────────────────────────────────────────────────────────
function openProjectLinkForm(projectId, linkId) {
  if (!_projCanEdit()) return;
  _projectLinkProjId = projectId;
  _projectLinkEditId = linkId || null;
  const l = linkId ? (cache.projectLinks || []).find(x => x.id === linkId) : null;
  document.getElementById('proj-link-title').textContent = l ? 'Edit Link' : 'Add Link';
  document.getElementById('proj-link-label').value = l?.Label || '';
  document.getElementById('proj-link-url').value   = l?.URL || '';
  document.getElementById('proj-link-type').value  = l?.LinkType || 'web';
  openModal('modal-project-link');
}

async function saveProjectLink() {
  const label = document.getElementById('proj-link-label').value.trim();
  const url   = document.getElementById('proj-link-url').value.trim();
  if (!label || !url) { toast('err','Label and URL required'); return; }
  // Lightweight URL validation
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url) && !url.startsWith('/')) {
    if (!await confirmModal({ title: 'Save anyway?', body: 'That doesn\'t look like a URL.', confirmLabel: 'Save' })) return;
  }
  const fields = {
    Title:     label,
    ProjectId: _projectLinkProjId,
    Label:     label,
    URL:       url,
    LinkType:  document.getElementById('proj-link-type').value
  };
  try {
    if (_projectLinkEditId) {
      await updateListItem(LISTS.projectLinks, _projectLinkEditId, fields);
      const idx = cache.projectLinks.findIndex(x => x.id === _projectLinkEditId);
      if (idx !== -1) cache.projectLinks[idx] = { ...cache.projectLinks[idx], ...fields };
    } else {
      fields.SortOrder = (_projLinksFor(_projectLinkProjId).length || 0);
      const item = await addListItem(LISTS.projectLinks, fields);
      cache.projectLinks.push(item);
    }
    closeModal('modal-project-link');
    renderProjects();
  } catch(e) { toast('err','Save failed: '+e.message); }
}

async function moveProjectLink(linkId, dir) {
  if (!_projCanEdit()) return;
  const l = (cache.projectLinks || []).find(x => x.id === linkId);
  if (!l) return;
  const siblings = [..._projLinksFor(l.ProjectId)].sort((a,b) => (parseFloat(a.SortOrder)||0) - (parseFloat(b.SortOrder)||0));
  const idx = siblings.findIndex(x => x.id === linkId);
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= siblings.length) return;
  const other = siblings[swapIdx];
  const aOrder = parseFloat(l.SortOrder) || 0;
  const bOrder = parseFloat(other.SortOrder) || 0;
  try {
    await updateListItem(LISTS.projectLinks, l.id,     { SortOrder: bOrder });
    await updateListItem(LISTS.projectLinks, other.id, { SortOrder: aOrder });
    l.SortOrder = bOrder;
    other.SortOrder = aOrder;
    renderProjects();
  } catch(e) { toast('err','Reorder failed: '+e.message); }
}

async function deleteProjectLink(linkId) {
  if (!_projCanEdit()) return;
  if (!await confirmModal({ title: 'Remove this link?', confirmLabel: 'Remove', danger: true })) return;
  try {
    const siteId = await getSiteId();
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.projectLinks}/items/${linkId}`);
    cache.projectLinks = (cache.projectLinks || []).filter(l => l.id !== linkId);
    renderProjects();
  } catch(e) { toast('err','Delete failed: '+e.message); }
}
