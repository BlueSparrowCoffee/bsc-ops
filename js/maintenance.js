/* ================================================================
 * BSC Ops — maintenance.js
 * Maintenance schedule page — recurring equipment tasks plus
 * completion log.
 *
 * Contents:
 *   - Status helpers: calcNextDue, getMaintStatus, maintStatusBadge
 *   - Tab switch + main render: switchMaintTab, renderMaintSchedule
 *   - Task form: _maintTaskEditId, openMaintTaskForm,
 *     saveMaintTaskForm, deleteMaintTask
 *   - Completion flow: _maintCompleteId, openCompleteTask,
 *     graphUploadAttachment, saveCompleteTask
 *   - Log render: renderMaintLog
 *   - Dashboard badge: updateMaintDashboard (called by dashboard.js
 *     via renderAll and by renderMaintSchedule on every render)
 *   - checkMaintNotifications — daily Slack alert for overdue / due-soon
 *
 * Depends on:
 *   state.js     — cache
 *   constants.js — LISTS, MODAL_FOCUS_DELAY_MS
 *   utils.js     — escHtml, toast, openModal, closeModal, setLoading
 *   graph.js     — addListItem, updateListItem, deleteListItem,
 *                  getSiteId
 *   auth.js      — getToken
 *   tags.js      — tagEditorHTML, initTagEditor, getTagEditorValue,
 *                  renderTagPills
 *   slack.js     — sendSlackAlert (still in index.html)
 *   staff.js     — populateStaffSelects (still in index.html)
 * ================================================================ */

// ── Status helpers ────────────────────────────────────────────────
// Numeric recurrence (in days) matches checklist style. Legacy tasks with only
// a Frequency string fall back to the old Monthly/Quarterly/Annually mapping.
function maintTaskDays(task) {
  if (!task) return 0;
  const raw = task.RecurEveryDays;
  if (raw != null && raw !== '') {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  // Legacy fallback
  if (task.Frequency === 'Monthly')   return 30;
  if (task.Frequency === 'Quarterly') return 90;
  if (task.Frequency === 'Annually')  return 365;
  return 0;
}
function maintRecurLabel(task) {
  const d = maintTaskDays(task);
  if (!d) return 'No recurrence';
  if (d === 1)  return 'Every day';
  if (d === 7)  return 'Every week';
  if (d === 14) return 'Every 2 weeks';
  if (d === 30) return 'Every month';
  if (d === 90) return 'Every quarter';
  if (d === 365) return 'Every year';
  return `Every ${d} days`;
}
function calcNextDue(daysOrFreq, fromDate) {
  const d = new Date(fromDate || new Date());
  // Accept either a numeric day count (new) or the legacy Frequency string
  let days = 0;
  if (typeof daysOrFreq === 'number') days = daysOrFreq;
  else if (typeof daysOrFreq === 'string') {
    if (daysOrFreq === 'Monthly')        days = 30;
    else if (daysOrFreq === 'Quarterly') days = 90;
    else if (daysOrFreq === 'Annually')  days = 365;
    else days = parseInt(daysOrFreq, 10) || 0;
  }
  if (days > 0) d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function getMaintStatus(item) {
  if(!item.NextDue) return 'upcoming';
  const days=Math.floor((new Date(item.NextDue)-new Date())/86400000);
  if(days<0)  return 'overdue';
  if(days<=7) return 'due-soon';
  return 'upcoming';
}
function maintStatusBadge(status, nextDue) {
  const d=nextDue?new Date(nextDue).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—';
  if(status==='overdue')  return `<span class="maint-badge maint-overdue">🔴 Past Due — ${d}</span>`;
  if(status==='due-soon') return `<span class="maint-badge maint-due-soon">🟡 Due Soon — ${d}</span>`;
  return `<span class="maint-badge maint-upcoming">🟢 Due ${d}</span>`;
}

// ── Tab switch + main render ──────────────────────────────────────
function switchMaintTab(tab,btn) {
  // Only toggle the top-level Maintenance tabs; narrow selector so we don't
  // clobber nested Active/Archived chips inside the Contacts panel.
  document.querySelectorAll('#maint-main-tabs > .tab-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  else document.getElementById('maint-tab-'+tab)?.classList.add('active');
  document.getElementById('maint-schedule-panel').style.display=tab==='schedule'?'':'none';
  document.getElementById('maint-log-panel').style.display     =tab==='log'     ?'':'none';
  document.getElementById('maint-contacts-panel').style.display=tab==='contacts'?'':'none';
  if(tab==='log')      renderMaintLog();
  if(tab==='contacts') renderMaintContacts();
}
function renderMaintSchedule() {
  const grid=document.getElementById('maint-schedule-grid');
  const empty=document.getElementById('maint-sched-empty');
  const countEl=document.getElementById('maint-sched-count');
  if(!grid) return;
  const locF  =document.getElementById('maint-filter-loc')?.value   ||'';
  const equipF=document.getElementById('maint-filter-equip')?.value ||'';
  const statF =document.getElementById('maint-filter-status')?.value||'';
  let rows=[...cache.maintSchedule];
  if(locF)   rows=rows.filter(r=>r.Location===locF);
  if(equipF) rows=rows.filter(r=>r.Equipment===equipF);
  if(statF)  rows=rows.filter(r=>getMaintStatus(r)===statF);
  const ord={overdue:0,'due-soon':1,upcoming:2};
  rows.sort((a,b)=>ord[getMaintStatus(a)]-ord[getMaintStatus(b)]);
  if(!rows.length){grid.innerHTML='';if(empty)empty.style.display='block';if(countEl)countEl.textContent='';updateMaintDashboard();return;}
  if(empty) empty.style.display='none';
  if(countEl) countEl.textContent=rows.length+' task'+(rows.length!==1?'s':'');
  grid.innerHTML=rows.map(r=>{
    const status=getMaintStatus(r);
    return `<div class="maint-card ${status}" data-gs-id="${escHtml(r.id)}" onclick="openMaintTaskForm('${r.id}')">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div style="font-weight:700;font-size:14px;">${escHtml(r.Title||'Unnamed Task')}</div>
        ${maintStatusBadge(status,r.NextDue)}
      </div>
      <div style="font-size:12px;color:var(--muted);">${escHtml(r.Equipment||'')}${r.Location?' · '+escHtml(r.Location):''}</div>
      ${r.AssignedTo?`<div style="font-size:12px;">👤 ${escHtml(r.AssignedTo)}</div>`:''}
      ${maintTaskDays(r)?`<div style="font-size:12px;color:var(--muted);">🔁 ${escHtml(maintRecurLabel(r))}</div>`:''}
      ${r.Description?`<div style="font-size:12px;color:var(--muted);margin-top:4px;border-top:1px solid var(--border);padding-top:6px;">${escHtml(r.Description)}</div>`:''}
      ${r.Tags?renderTagPills(r.Tags):''}
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-primary" style="flex:1;padding:6px 8px;font-size:12px;" onclick="event.stopPropagation();openCompleteTask('${r.id}')">✓ Complete</button>
        <button class="recipe-edit-btn" onclick="event.stopPropagation();openMaintTaskForm('${r.id}')">✏️ Edit</button>
      </div>
    </div>`;
  }).join('');
  updateMaintDashboard();
}

// ── Task form ─────────────────────────────────────────────────────
let _maintTaskEditId=null;
function openMaintTaskForm(id) {
  _maintTaskEditId=id||null;
  const t=id?cache.maintSchedule.find(x=>x.id===id):null;
  document.getElementById('maint-task-modal-title').textContent=t?'Edit Task':'Add Maintenance Task';
  document.getElementById('mt-title').value      =t?.Title      ||'';
  // Numeric recurrence (days). For legacy records without RecurEveryDays,
  // map the old Frequency string to a day count so the field is never blank
  // when the user is editing a preexisting task.
  document.getElementById('mt-recur-days').value = t ? (maintTaskDays(t) || '') : '30';
  document.getElementById('mt-nextdue').value    =t?.NextDue    ||'';
  document.getElementById('mt-description').value=t?.Description||'';
  populateStaffSelects();
  document.getElementById('mt-equipment').value =t?.Equipment  ||'';
  document.getElementById('mt-assigned').value  =t?.AssignedTo ||'';
  document.getElementById('mt-location').value  =t?.Location   ||'';
  document.getElementById('maint-task-delete-btn').style.display=t?'inline-flex':'none';
  document.getElementById('maint-task-tags-editor').innerHTML = tagEditorHTML('maint-task');
  initTagEditor('maint-task', t?.Tags||'');
  openModal('modal-maint-task');
  setTimeout(()=>document.getElementById('mt-title').focus(),MODAL_FOCUS_DELAY_MS);
}
async function saveMaintTaskForm() {
  const title=document.getElementById('mt-title').value.trim();
  if(!title){toast('err','Task name is required');return;}
  const equip=document.getElementById('mt-equipment').value;
  if(!equip){toast('err','Equipment is required');return;}
  const recurRaw = document.getElementById('mt-recur-days').value;
  const recurDays = recurRaw === '' ? 0 : Math.max(0, parseInt(recurRaw, 10) || 0);
  const data={Title:title,Equipment:equip,
    RecurEveryDays: recurDays,
    // Keep Frequency column populated for legacy readers; map back from days
    // (custom cadences stay as "Every N days" strings so they round-trip OK).
    Frequency: recurDays === 30 ? 'Monthly' : recurDays === 90 ? 'Quarterly' : recurDays === 365 ? 'Annually' : recurDays ? ('Every '+recurDays+' days') : '',
    AssignedTo:document.getElementById('mt-assigned').value,Location:document.getElementById('mt-location').value,
    NextDue:document.getElementById('mt-nextdue').value,Description:document.getElementById('mt-description').value,
    Tags:getTagEditorValue('maint-task')||null};
  setLoading(true,'Saving…');
  try {
    if(_maintTaskEditId){
      await updateListItem(LISTS.maintSchedule,_maintTaskEditId,data);
      const i=cache.maintSchedule.findIndex(x=>x.id===_maintTaskEditId);
      if(i!==-1) cache.maintSchedule[i]={...cache.maintSchedule[i],...data};
      toast('ok','✓ Task updated');
    } else {
      const item=await addListItem(LISTS.maintSchedule,data);
      cache.maintSchedule.push(item);
      toast('ok','✓ Task added');
    }
    renderMaintSchedule(); closeModal('modal-maint-task');
  } catch(e){toast('err','Save failed: '+e.message);}
  finally{setLoading(false);}
}
async function deleteMaintTask() {
  if(!_maintTaskEditId) return;
  const t=cache.maintSchedule.find(x=>x.id===_maintTaskEditId);
  if (!await confirmModal({ title: `Delete "${t?.Title}"?`, confirmLabel: 'Delete', danger: true })) return;
  setLoading(true,'Deleting…');
  try {
    await deleteListItem(LISTS.maintSchedule,_maintTaskEditId);
    cache.maintSchedule=cache.maintSchedule.filter(x=>x.id!==_maintTaskEditId);
    renderMaintSchedule(); closeModal('modal-maint-task'); toast('ok','✓ Deleted');
  } catch(e){toast('err','Delete failed: '+e.message);}
  finally{setLoading(false);}
}

// ── Completion flow ───────────────────────────────────────────────
let _maintCompleteId=null;
function openCompleteTask(id) {
  _maintCompleteId=id;
  const t=cache.maintSchedule.find(x=>x.id===id);
  document.getElementById('maint-complete-title').textContent=`Complete: ${t?.Title||'Task'}`;
  document.getElementById('maint-complete-info').innerHTML=
    `<strong>${t?.Equipment||''}</strong>${t?.Location?' · '+t.Location:''}<br>`+
    (t?.Description?`<span style="color:var(--muted);font-size:12px;">${t.Description}</span>`:'');
  document.getElementById('mc-notes').value='';
  document.getElementById('mc-photo').value='';
  populateStaffSelects();
  document.getElementById('mc-completed-by').value='';
  openModal('modal-maint-complete');
}
async function graphUploadAttachment(listName,itemId,file) {
  const siteId=await getSiteId();
  const token=await getToken();
  const res=await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listName}/items/${itemId}/attachments`,
    {method:'POST',headers:{'Authorization':'Bearer '+token,
      'Content-Disposition':`attachment; filename="${file.name}"`,
      'Content-Type':file.type||'image/jpeg'},body:file});
  if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e?.error?.message||'Upload failed');}
  return res.json().catch(()=>({}));
}
async function saveCompleteTask() {
  const by=document.getElementById('mc-completed-by').value;
  if(!by){toast('err','Please select who completed this task');return;}
  const t=cache.maintSchedule.find(x=>x.id===_maintCompleteId);
  if(!t) return;
  const today=new Date().toISOString().split('T')[0];
  const nextDue=calcNextDue(maintTaskDays(t) || 30, today);
  const logData={Title:`${t.Equipment||t.Title} — ${today}`,ScheduleId:_maintCompleteId,
    Equipment:t.Equipment||'',TaskName:t.Title||'',CompletedBy:by,
    CompletedDate:today,Location:t.Location||'',
    Notes:document.getElementById('mc-notes').value,PhotoName:''};
  setLoading(true,'Saving completion…');
  try {
    // PR 14e — route through safeAddListItem so offline maintenance-log writes queue.
    const _writer = (typeof safeAddListItem === 'function') ? safeAddListItem : addListItem;
    const logItem=await _writer(LISTS.maintLog,logData,{ kind:'maintLog', label:`${logData.Service||'log'} @ ${logData.Location||''}` });
    cache.maintLog.push(logItem);
    const photoFile=document.getElementById('mc-photo').files[0];
    if(photoFile){
      try {
        await graphUploadAttachment(LISTS.maintLog,logItem.id,photoFile);
        await updateListItem(LISTS.maintLog,logItem.id,{PhotoName:photoFile.name});
        logItem.PhotoName=photoFile.name;
      } catch(e){toast('err','Photo upload failed (log saved): '+e.message);}
    }
    await updateListItem(LISTS.maintSchedule,_maintCompleteId,{NextDue:nextDue});
    const si=cache.maintSchedule.findIndex(x=>x.id===_maintCompleteId);
    if(si!==-1) cache.maintSchedule[si].NextDue=nextDue;
    renderMaintSchedule();
    closeModal('modal-maint-complete');
    toast('ok',`✓ Completed! Next due: ${new Date(nextDue).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`);
  } catch(e){toast('err','Save failed: '+e.message);}
  finally{setLoading(false);}
}

// ── Log render ────────────────────────────────────────────────────
function renderMaintLog() {
  const tbody=document.getElementById('maint-log-body');
  const thead=document.getElementById('maint-log-thead');
  const empty=document.getElementById('maint-log-empty');
  const countEl=document.getElementById('maint-log-count');
  if(!tbody) return;
  const equipF=document.getElementById('maint-log-filter-equip')?.value||'';
  let rows=[...cache.maintLog].sort((a,b)=>new Date(b.CompletedDate)-new Date(a.CompletedDate));
  if(equipF) rows=rows.filter(r=>r.Equipment===equipF);
  if(!rows.length){thead.innerHTML='';tbody.innerHTML='';if(empty)empty.style.display='block';if(countEl)countEl.textContent='';return;}
  if(empty) empty.style.display='none';
  if(countEl) countEl.textContent=rows.length+' record'+(rows.length!==1?'s':'');
  thead.innerHTML='<tr><th>Date</th><th>Task</th><th>Equipment</th><th>Location</th><th>Completed By</th><th>Notes</th><th>Photo</th></tr>';
  tbody.innerHTML=rows.map(r=>{
    const d=r.CompletedDate?new Date(r.CompletedDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—';
    return `<tr>
      <td style="white-space:nowrap">${d}</td>
      <td>${escHtml(r.TaskName||r.Title||'—')}</td>
      <td>${escHtml(r.Equipment||'—')}</td>
      <td>${escHtml(r.Location||'—')}</td>
      <td>${escHtml(r.CompletedBy||'—')}</td>
      <td style="max-width:200px;white-space:pre-wrap;">${escHtml(r.Notes||'—')}</td>
      <td>${r.PhotoName?`<span style="font-size:11px;color:var(--gold);">📷 ${escHtml(r.PhotoName)}</span>`:'—'}</td>
    </tr>`;
  }).join('');
}

// ── Dashboard integration + daily Slack notification ──────────────
function updateMaintDashboard() {
  const overdue=cache.maintSchedule.filter(t=>getMaintStatus(t)==='overdue');
  const dueSoon=cache.maintSchedule.filter(t=>getMaintStatus(t)==='due-soon');
  const total=overdue.length+dueSoon.length;
  const dEl=document.getElementById('d-maint'); if(dEl) dEl.textContent=total||'✓';
  const sc=document.getElementById('d-maint-stat'); if(sc) sc.classList.toggle('alert',total>0);
  const badge=document.getElementById('badge-maint'); if(badge) badge.style.display=total>0?'inline':'none';
  const el=document.getElementById('dash-maint-alerts'); if(!el) return;
  if(!total){el.innerHTML='<div style="font-size:13px;color:var(--green);">✓ All maintenance up to date</div>';return;}
  el.innerHTML=[
    ...overdue.map(t=>`<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;"><span class="maint-badge maint-overdue" style="flex-shrink:0;font-size:9px;">PAST DUE</span><span>${escHtml(t.Title)} · ${escHtml(t.Equipment||'')}</span></div>`),
    ...dueSoon.map(t=>`<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;"><span class="maint-badge maint-due-soon" style="flex-shrink:0;font-size:9px;">DUE SOON</span><span>${escHtml(t.Title)} · ${escHtml(t.Equipment||'')}</span></div>`)
  ].join('');
}
async function checkMaintNotifications() {
  const today=new Date().toDateString();
  if(localStorage.getItem('lastMaintNotif')===today) return;
  if(!cache.maintSchedule.length) return;
  const overdue=cache.maintSchedule.filter(t=>getMaintStatus(t)==='overdue');
  const dueSoon=cache.maintSchedule.filter(t=>getMaintStatus(t)==='due-soon');
  if(overdue.length) await sendSlackAlert(`🔴 *${overdue.length} maintenance task${overdue.length>1?'s':''} PAST DUE at Blue Sparrow Coffee:*\n${overdue.map(t=>`• ${t.Title} — ${t.Equipment||''}${t.Location?' ('+t.Location+')':''}`).join('\n')}`, 'maint_overdue');
  if(dueSoon.length) await sendSlackAlert(`🟡 *${dueSoon.length} maintenance task${dueSoon.length>1?'s':''} due within 7 days:*\n${dueSoon.map(t=>`• ${t.Title} — ${t.Equipment||''}${t.NextDue?' · Due '+new Date(t.NextDue).toLocaleDateString('en-US',{month:'short',day:'numeric'}):''}`).join('\n')}`, 'maint_due_soon');
  localStorage.setItem('lastMaintNotif',today);
}
