/* ================================================================
 * BSC Ops — recipes.js
 * Recipe cards — structured ingredients + steps with SharePoint
 * version history. Legacy "Content" field is still supported for
 * recipes created before the structured format.
 *
 * Depends on:
 *   - state.js     (cache, currentUser)
 *   - constants.js (LISTS, MODAL_FOCUS_DELAY_MS)
 *   - utils.js     (escHtml, toast, openModal, closeModal, setLoading, invItemLink)
 *   - graph.js     (graph, getSiteId, addListItem, updateListItem, deleteListItem)
 * ================================================================ */

// Convert plain text with "- " bullets or numbered steps into HTML
function recipeContentToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let listType = null; // 'ul' or 'ol'
  for (const raw of lines) {
    const line = raw.trimEnd();
    const isBullet  = /^[-•]\s+/.test(line);
    const isNumered = /^\d+[\.\)]\s+/.test(line);
    if (isBullet) {
      if (listType !== 'ul') { if (listType) html += `</${listType}>`; html += '<ul>'; listType = 'ul'; }
      html += `<li>${escHtml(line.replace(/^[-•]\s+/,''))}</li>`;
    } else if (isNumered) {
      if (listType !== 'ol') { if (listType) html += `</${listType}>`; html += '<ol>'; listType = 'ol'; }
      html += `<li>${escHtml(line.replace(/^\d+[\.\)]\s+/,''))}</li>`;
    } else {
      if (listType) { html += `</${listType}>`; listType = null; }
      if (line.trim()) html += `<p>${escHtml(line)}</p>`;
      else html += '<p style="margin:4px 0;"></p>';
    }
  }
  if (listType) html += `</${listType}>`;
  return html;
}

// Populate the ingredient autocomplete datalist from all inventory caches
function populateRecipeInvDatalist() {
  const names = new Set();
  const add = (arr, ...keys) => {
    (arr||[]).forEach(item => {
      for (const k of keys) { const v = item[k]; if (v) { names.add(v); break; } }
    });
  };
  add(cache.inventory,       'ItemName', 'Title');
  add(cache.foodPars,        'Title',    'ItemName');
  add(cache.merchInventory,  'ItemName', 'Title');
  add(cache.foodInventory,   'ItemName', 'Title');
  add(cache.groceryInventory,'ItemName', 'Title');
  const dl = document.getElementById('recipe-inv-datalist');
  if (dl) dl.innerHTML = [...names].sort((a,b)=>a.localeCompare(b)).map(n=>`<option value="${escHtml(n)}">`).join('');
}

// Add a single ingredient row to the modal form
function addIngredientRow(name='', qty='', unit='') {
  const list = document.getElementById('rf-ingredients-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'recipe-ing-row-edit';
  // name input
  const nameIn = document.createElement('input');
  nameIn.setAttribute('list','recipe-inv-datalist');
  nameIn.placeholder = 'Ingredient';
  nameIn.value = name;
  nameIn.style.flex = '2';
  // qty input
  const qtyIn = document.createElement('input');
  qtyIn.type = 'text';
  qtyIn.placeholder = 'Qty';
  qtyIn.value = qty;
  qtyIn.style.width = '52px';
  qtyIn.style.textAlign = 'center';
  // unit input
  const unitIn = document.createElement('input');
  unitIn.type = 'text';
  unitIn.placeholder = 'Unit';
  unitIn.value = unit;
  unitIn.style.width = '60px';
  // remove button
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
  removeBtn.style.cssText = 'color:var(--muted);background:none;border:none;cursor:pointer;font-size:18px;line-height:1;padding:0 2px;flex-shrink:0;';
  removeBtn.onclick = () => row.remove();
  row.appendChild(nameIn);
  row.appendChild(qtyIn);
  row.appendChild(unitIn);
  row.appendChild(removeBtn);
  list.appendChild(row);
  nameIn.focus();
}

// Collect ingredient rows from the modal form
function collectIngredients() {
  const rows = document.querySelectorAll('#rf-ingredients-list .recipe-ing-row-edit');
  const result = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const name = inputs[0]?.value?.trim() || '';
    const qty  = inputs[1]?.value?.trim() || '';
    const unit = inputs[2]?.value?.trim() || '';
    if (name) result.push({ name, qty, unit });
  });
  return result;
}

// Render ingredients array as a compact table for recipe cards
function renderIngredientsHtml(ingredients) {
  if (!ingredients || !ingredients.length) return '';
  const rows = ingredients.map(ing => {
    const qtyUnit = [ing.qty, ing.unit].filter(Boolean).join(' ');
    return `<tr>
      <td>${invItemLink(ing.name)}</td>
      <td class="ing-qty">${escHtml(qtyUnit)}</td>
    </tr>`;
  }).join('');
  return `<table class="recipe-ing-table">${rows}</table>`;
}


let _recipeEditId = null;

function recipeMetaLine(r) {
  const dateStr = r._modifiedAt || r.Modified || '';
  const name = r._modifiedBy || '';
  if (!dateStr) return name ? `By ${name}` : '';
  const d = new Date(dateStr);
  const formatted = d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const diff = Math.floor((Date.now()-d)/86400000);
  const ago = diff===0?'Today':diff===1?'Yesterday':`${diff}d ago`;
  return name ? `${escHtml(ago)} · ${escHtml(formatted)} · ${escHtml(name)}` : `${escHtml(ago)} · ${escHtml(formatted)}`;
}

function renderRecipes(query='') {
  const grid = document.getElementById('recipe-grid');
  const empty = document.getElementById('recipe-empty');
  const countEl = document.getElementById('recipe-count');
  const q = (query||document.getElementById('recipe-search')?.value||'').toLowerCase();

  let rows = cache.recipes;
  if (q) rows = rows.filter(r=>[r.Title,r.Content,r.Steps,r.Notes].filter(Boolean).join(' ').toLowerCase().includes(q));
  rows = [...rows].sort((a,b) => (a.Title||'').localeCompare(b.Title||''));

  if (!rows.length) {
    grid.innerHTML=''; empty.style.display='block';
    countEl.textContent='';
    return;
  }
  empty.style.display='none';
  countEl.textContent = rows.length + ' recipe' + (rows.length!==1?'s':'');

  grid.innerHTML = rows.map(r=>{
    const meta = recipeMetaLine(r);
    const notesHtml = r.Notes ? `<div style="margin-top:8px;padding:8px 10px;background:var(--cream);border-radius:6px;font-size:11px;color:var(--muted)">${escHtml(r.Notes)}</div>` : '';

    // Parse structured ingredients (new format)
    let ingredients = [];
    if (r.Ingredients) {
      try { ingredients = JSON.parse(r.Ingredients); } catch(e) {}
    }
    const hasIngredients = ingredients.length > 0;
    const hasSteps = !!(r.Steps && r.Steps.trim());
    // Legacy content fallback for older recipes
    const hasLegacyContent = !!(r.Content && r.Content.trim() && !hasSteps && !hasIngredients);

    let bodyHtml = '';
    if (hasIngredients || hasSteps) {
      const ingHtml = hasIngredients
        ? `<div><div class="recipe-section-label">✅ Ingredients</div><hr style="border:none;border-top:1px solid var(--border);margin:4px 0 6px;">${renderIngredientsHtml(ingredients)}</div>`
        : '';
      const divider = hasIngredients && hasSteps
        ? `<hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">`
        : '';
      const stepsHtml = hasSteps
        ? `<div><div class="recipe-section-label">📋 Steps</div><div class="recipe-body">${recipeContentToHtml(r.Steps)}</div></div>`
        : '';
      bodyHtml = `<div>${ingHtml}${divider}${stepsHtml}</div>`;
    } else if (hasLegacyContent) {
      bodyHtml = `<div class="recipe-body">${recipeContentToHtml(r.Content)}</div>`;
    }

    return `<div class="recipe-card" data-gs-id="${escHtml(r.id)}" onclick="openRecipeForm('${r.id}')">
      <div class="recipe-card-title">${escHtml(r.Title||'Untitled Recipe')}</div>
      ${r.Yield ? `<div style="font-size:11px;color:var(--gold);font-weight:600;margin-top:2px;">Yields ${escHtml(r.Yield)}</div>` : ''}
      ${bodyHtml}
      ${notesHtml}
      <button class="recipe-edit-btn" onclick="event.stopPropagation();openRecipeForm('${r.id}')">✏️ Edit</button>
    </div>`;
  }).join('');
}

function filterRecipes(q) { renderRecipes(q); }

function openRecipeForm(id) {
  _recipeEditId = id || null;
  const item = id ? cache.recipes.find(r=>r.id===id) : null;
  document.getElementById('recipe-modal-title').textContent = item ? 'Edit Recipe' : 'Add Recipe';
  document.getElementById('rf-title').value = item ? (item.Title||'') : '';
  document.getElementById('rf-yield').value = item ? (item.Yield||'') : '';
  document.getElementById('rf-steps').value = item ? (item.Steps||'') : '';
  document.getElementById('rf-notes').value = item ? (item.Notes||'') : '';

  // Populate ingredient rows
  const ingList = document.getElementById('rf-ingredients-list');
  ingList.innerHTML = '';
  let ingredients = [];
  if (item?.Ingredients) {
    try { ingredients = JSON.parse(item.Ingredients); } catch(e) {}
  }
  // For legacy recipes with no structured ingredients, seed from Content if it looks ingredient-like
  ingredients.forEach(ing => addIngredientRow(ing.name||'', ing.qty||'', ing.unit||''));
  if (!ingredients.length) {
    addIngredientRow(); // start with one blank row for convenience
  }

  // Populate inventory datalist
  populateRecipeInvDatalist();

  const isEdit = !!item;
  document.getElementById('recipe-delete-btn').style.display = isEdit ? 'inline-flex' : 'none';
  document.getElementById('recipe-history-btn').style.display = isEdit ? 'inline-flex' : 'none';
  openModal('modal-recipe');
  setTimeout(()=>document.getElementById('rf-title').focus(),MODAL_FOCUS_DELAY_MS);
}

async function saveRecipeForm() {
  const title = document.getElementById('rf-title').value.trim();
  if (!title) { toast('err','Recipe name is required'); return; }
  const ingredients = collectIngredients();
  const data = {
    Title:       title,
    Yield:       document.getElementById('rf-yield').value.trim(),
    Steps:       document.getElementById('rf-steps').value,
    Notes:       document.getElementById('rf-notes').value,
    Ingredients: JSON.stringify(ingredients)
  };
  setLoading(true,'Saving recipe…');
  try {
    if (_recipeEditId) {
      await updateListItem(LISTS.recipes, _recipeEditId, data);
      const i = cache.recipes.findIndex(r=>r.id===_recipeEditId);
      if (i!==-1) cache.recipes[i] = {...cache.recipes[i], ...data, _modifiedBy: currentUser?.name||'', _modifiedAt: new Date().toISOString()};
      toast('ok','✓ Recipe updated');
    } else {
      const item = await addListItem(LISTS.recipes, data);
      cache.recipes.push({...item, ...data, _modifiedBy: currentUser?.name||'', _modifiedAt: new Date().toISOString()});
      toast('ok','✓ Recipe added');
    }
    renderRecipes();
    closeModal('modal-recipe');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

async function deleteRecipe() {
  if (!_recipeEditId) return;
  if (!confirm('Delete this recipe? This cannot be undone.')) return;
  setLoading(true,'Deleting recipe…');
  try {
    await deleteListItem(LISTS.recipes, _recipeEditId);
    cache.recipes = cache.recipes.filter(r=>r.id!==_recipeEditId);
    renderRecipes();
    closeModal('modal-recipe');
    toast('ok','✓ Recipe deleted');
  } catch(e) { toast('err','Delete failed: '+e.message); }
  finally { setLoading(false); }
}

async function loadRecipeHistory(id) {
  if (!id) return;
  const recipe = cache.recipes.find(r=>r.id===id);
  document.getElementById('recipe-history-title').textContent = `History — ${recipe?.Title||'Recipe'}`;
  setLoading(true,'Loading history…');
  try {
    const siteId = await getSiteId();
    const res = await graph('GET',`/sites/${siteId}/lists/${LISTS.recipes}/items/${id}/versions`);
    const versions = res.value || [];
    const el = document.getElementById('recipe-history-list');
    if (!versions.length) {
      el.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px;text-align:center;">No edit history found.<br><span style="font-size:11px;">History saves after each edit.</span></div>';
    } else {
      el.innerHTML = versions.map((v,i)=>{
        const d = new Date(v.lastModifiedDateTime);
        const date = d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
        const time = d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
        const by = v.lastModifiedBy?.user?.displayName || 'Unknown';
        const content = v.fields?.Content || '';
        const isCurrent = i===0;
        return `<div style="padding:16px 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div>
              <span style="font-weight:600;font-size:13px;">${by}</span>
              <span style="font-size:11px;color:var(--muted);margin-left:8px;">${date} at ${time}</span>
            </div>
            ${isCurrent
              ? '<span style="font-size:10px;padding:2px 8px;background:rgba(183,139,64,.15);color:var(--gold);border-radius:10px;font-weight:700;letter-spacing:.04em;">CURRENT</span>'
              : `<button onclick="restoreRecipeVersion('${id}','${v.id}')" style="font-size:11px;color:var(--gold);border:1.5px solid var(--gold);border-radius:6px;padding:3px 10px;background:none;cursor:pointer;font-weight:600;">↩ Restore</button>`
            }
          </div>
          ${content ? `<div style="font-size:12px;color:var(--ink);background:var(--cream);border-radius:6px;padding:10px 12px;max-height:120px;overflow:hidden;white-space:pre-wrap;line-height:1.5;">${content.slice(0,300)}${content.length>300?'\n…':''}</div>` : '<div style="font-size:11px;color:var(--muted);font-style:italic;">No content</div>'}
        </div>`;
      }).join('');
    }
    closeModal('modal-recipe');
    openModal('modal-recipe-history');
  } catch(e) { toast('err','Could not load history: '+e.message); }
  finally { setLoading(false); }
}

async function restoreRecipeVersion(itemId, versionId) {
  if (!confirm('Restore this version? The current content will be overwritten.')) return;
  setLoading(true,'Restoring version…');
  try {
    const siteId = await getSiteId();
    const ver = await graph('GET',`/sites/${siteId}/lists/${LISTS.recipes}/items/${itemId}/versions/${versionId}`);
    const f = ver.fields || {};
    const data = { Title: f.Title||'', Content: f.Content||'', Notes: f.Notes||'', Steps: f.Steps||'', Ingredients: f.Ingredients||'' };
    await updateListItem(LISTS.recipes, itemId, data);
    const i = cache.recipes.findIndex(r=>r.id===itemId);
    if (i!==-1) cache.recipes[i] = {...cache.recipes[i], ...data, _modifiedBy: currentUser?.name||'', _modifiedAt: new Date().toISOString()};
    renderRecipes();
    closeModal('modal-recipe-history');
    toast('ok','✓ Version restored');
  } catch(e) { toast('err','Restore failed: '+e.message); }
  finally { setLoading(false); }
}
