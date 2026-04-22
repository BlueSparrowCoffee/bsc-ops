/* ================================================================
 * BSC Ops — slack.js
 * Slack webhook + notification-rules system. SharePoint is the source
 * of truth (BSC_Settings) so pause/resume is shared across devices;
 * localStorage is a per-device fallback.
 *
 * Contents:
 *   - getNotifRules / saveNotifRules / isNotifEnabled
 *   - getSlackWebhook / sendSlackAlert
 *   - renderSlackSettings — populates the Settings → Slack card
 *   - toggleGlobalSlackPause / saveSlackChannel / saveSlackWebhook /
 *     toggleWebhookVis
 *   - renderNotifRules — rule-list table
 *   - toggleNotifRule / deleteNotifRule / pauseAllNotifs /
 *     resumeAllNotifs
 *   - openAddNotifForm / closeAddNotifForm / saveNewNotif
 *
 * Depends on:
 *   state.js     — cache.settingsItems
 *   constants.js — CFG, DEFAULT_NOTIF_RULES
 *   utils.js     — escHtml, toast
 *   settings.js  — getSetting, saveSetting
 * ================================================================ */

function getNotifRules() {
  // SharePoint is the source of truth (shared across all devices/browsers)
  const spSaved = getSetting('notification_rules');
  if (spSaved) { try { return JSON.parse(spSaved); } catch {} }
  // Fall back to localStorage for this device
  try { return JSON.parse(localStorage.getItem('bsc_notifications')) || DEFAULT_NOTIF_RULES; }
  catch { return DEFAULT_NOTIF_RULES; }
}

function saveNotifRules(rules) {
  localStorage.setItem('bsc_notifications', JSON.stringify(rules));
  // Persist to SharePoint so pause/resume survives page reloads and other devices
  const json = JSON.stringify(rules);
  saveSetting('notification_rules', json).then(() => {
    const i = cache.settingsItems.findIndex(s => s.Title === 'notification_rules');
    if (i !== -1) cache.settingsItems[i].Value = json;
    else cache.settingsItems.push({ Title: 'notification_rules', Value: json });
  }).catch(() => {}); // fire-and-forget, localStorage copy still works
}

function isNotifEnabled(type) {
  const rules = getNotifRules();
  const rule = rules.find(r=>r.type===type);
  return rule ? rule.enabled : true;
}

function getSlackWebhook() {
  return getSetting('slack_webhook') || CFG.slack;
}

async function sendSlackAlert(text, type=null) {
  // Global kill switch — overrides all individual rules
  if (getSetting('slack_paused') === '1') return;
  if (type && !isNotifEnabled(type)) return;
  const webhook = getSlackWebhook();
  if (!webhook || webhook.includes('PLACEHOLDER')) return;
  const channel = getSetting('slack_channel') || '#bsc_ops';
  try {
    await fetch(webhook, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text, channel })
    });
  } catch(e) { console.warn('Slack alert failed',e); }
}

function renderSlackSettings() {
  const input  = document.getElementById('slack-webhook-input');
  const status = document.getElementById('slack-webhook-status');
  const spVal  = getSetting('slack_webhook');
  if (spVal) {
    input.value = spVal;
    status.innerHTML = '<span style="color:var(--green)">✓ Saved in SharePoint — shared across all devices</span>';
  } else if (CFG.slack && !CFG.slack.includes('PLACEHOLDER')) {
    input.value = CFG.slack;
    status.innerHTML = '<span style="color:var(--muted)">Using deploy-time webhook (not shared). Save above to share with all users.</span>';
  } else {
    status.innerHTML = '<span style="color:var(--orange)">⚠ No webhook configured — enter URL above and save</span>';
  }
  // Global pause state
  const paused = getSetting('slack_paused') === '1';
  const pauseBtn = document.getElementById('slack-global-pause-btn');
  const pauseBanner = document.getElementById('slack-paused-banner');
  if (pauseBtn) {
    pauseBtn.textContent = paused ? '▶ Resume All' : '⏸ Pause All';
    pauseBtn.style.borderColor = paused ? 'var(--green)' : '';
    pauseBtn.style.color = paused ? 'var(--green)' : '';
  }
  if (pauseBanner) pauseBanner.style.display = paused ? '' : 'none';
  // Channel
  const chanInput  = document.getElementById('slack-channel-input');
  const chanStatus = document.getElementById('slack-channel-status');
  if (chanInput) {
    const savedChan = getSetting('slack_channel');
    chanInput.value = savedChan || '#bsc_ops';
    if (savedChan) chanStatus.innerHTML = '<span style="color:var(--green)">✓ Channel saved</span>';
  }
  renderNotifRules();
}

async function toggleGlobalSlackPause() {
  const current = getSetting('slack_paused') === '1';
  const newVal = current ? '' : '1';
  await saveSetting('slack_paused', newVal);
  const i = cache.settingsItems.findIndex(s => s.Title === 'slack_paused');
  if (i !== -1) cache.settingsItems[i].Value = newVal;
  else cache.settingsItems.push({ Title: 'slack_paused', Value: newVal });
  renderSlackSettings();
  toast('ok', newVal === '1' ? '⏸ All Slack notifications paused' : '▶ Slack notifications resumed');
}

async function saveSlackChannel() {
  const val = (document.getElementById('slack-channel-input')?.value || '').trim() || '#bsc_ops';
  await saveSetting('slack_channel', val);
  const i = cache.settingsItems.findIndex(s => s.Title === 'slack_channel');
  if (i !== -1) cache.settingsItems[i].Value = val;
  else cache.settingsItems.push({ Title: 'slack_channel', Value: val });
  document.getElementById('slack-channel-status').innerHTML = '<span style="color:var(--green)">✓ Channel saved</span>';
  toast('ok','✓ Slack channel saved: ' + val);
}

function renderNotifRules() {
  const rules = getNotifRules();
  const el = document.getElementById('notif-rules-list');
  if (!rules.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:12px 0">No notification rules. Add one below.</div>';
    return;
  }
  el.innerHTML = rules.map(r=>`
    <div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--opal);flex-wrap:wrap">
      <div style="width:10px;height:10px;border-radius:50%;background:${r.enabled?'var(--green)':'#ccc'};flex-shrink:0"></div>
      <div style="flex:1;min-width:160px">
        <div style="font-size:13px;font-weight:600">${escHtml(r.name)}</div>
        <div style="font-size:11px;color:var(--muted)">${escHtml(r.description||'')}</div>
      </div>
      <span class="badge ${r.enabled?'badge-green':'badge-orange'}" style="font-size:11px">${r.enabled?'Active':'Paused'}</span>
      <button class="btn btn-outline" style="font-size:12px;padding:5px 12px" data-id="${escHtml(r.id)}" onclick="toggleNotifRule(this.dataset.id)">
        ${r.enabled?'⏸ Pause':'▶ Resume'}
      </button>
      <button class="btn btn-outline" style="font-size:12px;padding:5px 10px;color:var(--red);border-color:var(--red)" data-id="${escHtml(r.id)}" onclick="deleteNotifRule(this.dataset.id)">✕</button>
    </div>`).join('');
}

async function saveSlackWebhook() {
  const val = document.getElementById('slack-webhook-input').value.trim();
  if (!val) { toast('err','Enter a webhook URL'); return; }
  const btn = document.querySelector('[onclick="saveSlackWebhook()"]');
  if (btn) { btn.disabled=true; btn.textContent='Saving…'; }
  try {
    await saveSetting('slack_webhook', val);
    document.getElementById('slack-webhook-status').innerHTML =
      '<span style="color:var(--green)">✓ Saved in SharePoint — shared across all devices</span>';
    toast('ok','✓ Webhook saved to SharePoint');
  } catch(e) {
    toast('err','Save failed: '+e.message);
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='Save'; }
  }
}

function toggleWebhookVis() {
  const input = document.getElementById('slack-webhook-input');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function toggleNotifRule(id) {
  const rules = getNotifRules();
  const rule = rules.find(r=>r.id===id);
  if (rule) rule.enabled = !rule.enabled;
  saveNotifRules(rules);
  renderNotifRules();
}

function deleteNotifRule(id) {
  const rules = getNotifRules().filter(r=>r.id!==id);
  saveNotifRules(rules);
  renderNotifRules();
}

function pauseAllNotifs() {
  const rules = getNotifRules().map(r=>({...r,enabled:false}));
  saveNotifRules(rules);
  renderNotifRules();
  toast('ok','⏸ All notifications paused');
}

function resumeAllNotifs() {
  const rules = getNotifRules().map(r=>({...r,enabled:true}));
  saveNotifRules(rules);
  renderNotifRules();
  toast('ok','▶ All notifications resumed');
}

function openAddNotifForm() {
  document.getElementById('add-notif-form').style.display='block';
  document.getElementById('new-notif-name').value='';
  document.getElementById('new-notif-desc').value='';
}

function closeAddNotifForm() {
  document.getElementById('add-notif-form').style.display='none';
}

function saveNewNotif() {
  const name = document.getElementById('new-notif-name').value.trim();
  if (!name) { toast('err','Name is required'); return; }
  const type = document.getElementById('new-notif-type').value;
  const desc = document.getElementById('new-notif-desc').value.trim();
  const rules = getNotifRules();
  rules.push({ id: 'notif_'+Date.now(), name, type, description: desc, enabled: true });
  saveNotifRules(rules);
  renderNotifRules();
  closeAddNotifForm();
  toast('ok','✓ Notification rule added');
}
