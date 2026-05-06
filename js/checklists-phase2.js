/* ================================================================
 * BSC Ops — checklists-phase2.js (PRs 16-24 of design refresh)
 *
 * Reusable building blocks for the Checklists Phase 2 redesign.
 * These ship as standalone components — the existing checklists
 * page (js/checklists.js) is unchanged. Subsequent sessions wire
 * these into the lane-based run UI when the team is ready to
 * migrate.
 *
 * What's here:
 *   - SignaturePad     — HTML5 canvas signature capture (PR 21)
 *   - mountRangeBar    — health-code numeric input + range bar
 *                        with green/gold/red zones (PR 20)
 *   - mountPhotoGrid   — photo evidence grid with file picker
 *                        (PR 19; upload endpoint stubbed)
 *
 * Each helper returns a small controller with read/clear/destroy
 * methods so the consuming UI can manage state without poking the
 * DOM directly.
 *
 * Photo upload: posts to /api/upload-photo (not yet implemented).
 * Until that Function exists, mountPhotoGrid stores the file name
 * + a local data URL so the user can see a thumbnail; the
 * controller exposes the staged files so the consumer can decide
 * whether to send them now or stash them for later.
 * ================================================================ */

// ── SignaturePad (PR 21) ────────────────────────────────────────
// Mounts a touch + mouse signature canvas inside the given host.
// Returns { isEmpty(), clear(), toDataURL(), destroy() }.
function mountSignaturePad(host, opts = {}) {
  if (!host) return null;
  const w = opts.width  || host.clientWidth  || 320;
  const h = opts.height || 120;
  host.innerHTML = `
    <canvas class="sig-canvas" width="${w}" height="${h}"
            style="display:block;width:100%;max-width:${w}px;height:${h}px;background:#ffffff;border:1px solid var(--border-2);border-radius:7px;touch-action:none;cursor:crosshair;"></canvas>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
      <span class="sig-hint" style="font-size:11px;color:var(--muted);flex:1;">Sign with finger or mouse</span>
      <button type="button" class="btn btn-sm sig-clear">Clear</button>
    </div>`;
  const canvas = host.querySelector('.sig-canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#023d4a';
  let drawing = false, hasInk = false, last = null;

  const _xy = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (canvas.width / r.width),
             y: (t.clientY - r.top)  * (canvas.height / r.height) };
  };
  const _down = (e) => { e.preventDefault(); drawing = true; last = _xy(e); };
  const _move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = _xy(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    hasInk = true;
  };
  const _up = () => { drawing = false; last = null; };

  canvas.addEventListener('mousedown', _down);
  canvas.addEventListener('mousemove', _move);
  window.addEventListener('mouseup', _up);
  canvas.addEventListener('touchstart', _down, { passive: false });
  canvas.addEventListener('touchmove',  _move, { passive: false });
  canvas.addEventListener('touchend',   _up);

  host.querySelector('.sig-clear').onclick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
  };

  return {
    isEmpty: () => !hasInk,
    clear: () => host.querySelector('.sig-clear').click(),
    toDataURL: () => hasInk ? canvas.toDataURL('image/png') : null,
    destroy: () => {
      window.removeEventListener('mouseup', _up);
      host.innerHTML = '';
    }
  };
}

// ── Range bar (PR 20) ───────────────────────────────────────────
// Health-code numeric input with a colored zone bar showing where
// the entered value falls. zones is an array of [min, max, color]
// tuples; outside any zone draws gray. Returns { value(), set(v),
// destroy() }.
function mountRangeBar(host, opts = {}) {
  if (!host) return null;
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const zones = opts.zones || [[min, max, 'var(--green)']];
  const initial = opts.initial ?? '';
  const unit = opts.unit ? ` <span style="font-size:11px;color:var(--muted);font-weight:500;">${opts.unit}</span>` : '';

  // Build the colored bar via gradient-stop math.
  const span = max - min;
  let stops = [];
  let cursor = min;
  for (const [a, b, color] of zones) {
    const sa = Math.max(min, a);
    const sb = Math.min(max, b);
    if (sa > cursor) {
      stops.push(`#e6e0d4 ${((cursor - min) / span) * 100}%`);
      stops.push(`#e6e0d4 ${((sa     - min) / span) * 100}%`);
    }
    stops.push(`${color} ${((sa - min) / span) * 100}%`);
    stops.push(`${color} ${((sb - min) / span) * 100}%`);
    cursor = sb;
  }
  if (cursor < max) {
    stops.push(`#e6e0d4 ${((cursor - min) / span) * 100}%`);
    stops.push(`#e6e0d4 100%`);
  }
  const gradient = `linear-gradient(90deg, ${stops.join(', ')})`;

  host.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;">
      <input type="number" class="rb-input" min="${min}" max="${max}" step="${opts.step ?? 1}" value="${initial}"
             placeholder="${opts.placeholder ?? '—'}"
             style="width:90px;padding:8px 10px;border:1px solid var(--border-2);border-radius:7px;font-family:var(--mono);font-size:18px;font-weight:600;color:var(--ink);text-align:center;background:linear-gradient(180deg,#ffffff,#fbf8f1);box-shadow:inset 0 1px 1px rgba(2,61,74,0.05);outline:none;">
      <span style="font-size:14px;color:var(--ink);">${unit}</span>
    </div>
    <div class="rb-bar" style="position:relative;margin-top:14px;height:10px;border-radius:999px;background:${gradient};box-shadow:inset 0 1px 1px rgba(14,53,64,.12);border:1px solid var(--border);">
      <div class="rb-needle" style="position:absolute;top:-5px;width:2px;height:20px;background:var(--ink);border-radius:2px;left:0%;transform:translateX(-50%);display:none;"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:4px;">
      <span>${min}${opts.unit ? ' ' + opts.unit : ''}</span>
      <span>${max}${opts.unit ? ' ' + opts.unit : ''}</span>
    </div>`;
  const input  = host.querySelector('.rb-input');
  const needle = host.querySelector('.rb-needle');

  const _refresh = () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) { needle.style.display = 'none'; return; }
    const clamped = Math.max(min, Math.min(max, v));
    const pct = ((clamped - min) / span) * 100;
    needle.style.left = pct + '%';
    needle.style.display = '';
  };
  input.addEventListener('input', _refresh);
  if (initial !== '') _refresh();

  return {
    value: () => {
      const v = parseFloat(input.value);
      return Number.isFinite(v) ? v : null;
    },
    set: (v) => { input.value = v; _refresh(); },
    destroy: () => { host.innerHTML = ''; }
  };
}

// ── Photo grid (PR 19) ──────────────────────────────────────────
// File-picker grid for photo evidence. Stages files locally as
// data URLs (so user sees thumbnails immediately) and exposes a
// .uploadAll(runId, taskId) method that POSTs each to
// /api/upload-photo. Until that endpoint exists, uploadAll will
// fail; the consumer can either retry later or ship without
// photos.
function mountPhotoGrid(host, opts = {}) {
  if (!host) return null;
  const max = opts.max ?? 6;
  let files = []; // [{ id, name, dataUrl, file }]

  const _render = () => {
    const tiles = files.map(f => `
      <div class="pg-tile" data-id="${f.id}" style="position:relative;width:84px;height:84px;border-radius:7px;border:1px solid var(--border-2);background:#fff center/cover no-repeat url('${f.dataUrl}');box-shadow:var(--sh-card);">
        <button type="button" class="pg-remove" data-id="${f.id}" aria-label="Remove"
                style="position:absolute;top:3px;right:3px;width:20px;height:20px;border-radius:50%;background:rgba(2,61,74,0.85);color:#fff;border:none;font-size:14px;line-height:1;cursor:pointer;">×</button>
      </div>`).join('');
    const addTile = files.length < max ? `
      <label class="pg-add" style="width:84px;height:84px;border-radius:7px;border:1px dashed var(--border-3);background:linear-gradient(180deg,#ffffff,#f5f0e2);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);font-size:24px;">
        +<input type="file" accept="image/*" capture="environment" style="display:none" class="pg-file">
      </label>` : '';
    host.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;">${tiles}${addTile}</div>`;
    const fileInput = host.querySelector('.pg-file');
    if (fileInput) fileInput.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        files.push({ id: 'p' + Date.now(), name: file.name, dataUrl: ev.target.result, file });
        _render();
      };
      reader.readAsDataURL(file);
    };
    host.querySelectorAll('.pg-remove').forEach(btn => {
      btn.onclick = () => { files = files.filter(f => f.id !== btn.dataset.id); _render(); };
    });
  };
  _render();

  return {
    files: () => files.slice(),
    isEmpty: () => files.length === 0,
    clear: () => { files = []; _render(); },
    // Best-effort upload to /api/upload-photo (not yet implemented).
    // Returns Promise<string[]> of stored URLs; resolves to data URLs
    // as a fallback when the endpoint is missing so callers can still
    // store something.
    async uploadAll(runId, taskId) {
      const urls = [];
      // Pull a Graph token so the Function (which validates AAD bearer)
      // accepts the request. Falls back to anonymous if getToken isn't
      // available — Function will respond 401 in that case and the
      // catch below stores the data URL fallback.
      let token = null;
      if (typeof getToken === 'function') {
        try { token = await getToken(); } catch {}
      }
      for (const f of files) {
        try {
          const fd = new FormData();
          fd.append('file', f.file);
          fd.append('runId', runId || '');
          fd.append('taskId', taskId || '');
          const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
          const resp = await fetch('/api/upload-photo', { method: 'POST', headers, body: fd });
          if (!resp.ok) throw new Error('upload failed: ' + resp.status);
          const { url } = await resp.json();
          urls.push(url);
        } catch (e) {
          // Endpoint missing or upload failed — fall back to the data
          // URL so the caller at least has a reference. Callers should
          // check whether the URL starts with "data:" and decide.
          urls.push(f.dataUrl);
        }
      }
      return urls;
    },
    destroy: () => { host.innerHTML = ''; files = []; }
  };
}
