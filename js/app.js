// ============================================
// App principale - Stronghold Tracker
// ============================================

let currentPlayerId = null;
let players = [];
let cachedData = {}; // Cache local : { villageId: { productions, stocks } }
let stockTickInterval = null;
let localChangeInProgress = false; // Bloque les refreshes realtime pendant une modif locale

// ---- INIT ----

async function init() {
  const { data } = await db.from('players').select('*').order('id');
  players = data || [];

  if (players.length === 0) return;

  renderPlayerTabs();
  switchPlayer(players[0].id);
  setupRealtimeSubscriptions();
}

// ---- PLAYER TABS ----

function renderPlayerTabs() {
  const tabsContainer = document.getElementById('player-tabs');
  tabsContainer.innerHTML = '';
  players.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.playerId = p.id;
    btn.textContent = p.name;
    btn.onclick = () => switchPlayer(p.id);
    tabsContainer.appendChild(btn);
  });
}

async function switchPlayer(playerId) {
  currentPlayerId = playerId;
  cachedData = {}; // Clear cache au changement de joueur

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.playerId) === playerId);
  });

  const player = players.find(p => p.id === playerId);
  document.getElementById('player-name').textContent = player.name;
  document.getElementById('capacity-display').textContent = player.stock_capacity;
  document.getElementById('capacity-input').value = player.stock_capacity;

  await refreshDashboard();
  startStockTick();
}

// ---- DASHBOARD REFRESH ----

async function refreshDashboard() {
  await Promise.all([
    renderVillages(),
    renderCards(),
    renderTradeHistory(),
    populateTradeVillages(),
    populateTradeDestVillages(),
    renderKPIs()
  ]);
}

// Tick leger : met a jour uniquement les chiffres de stock (pas de rebuild DOM)
function startStockTick() {
  if (stockTickInterval) clearInterval(stockTickInterval);
  stockTickInterval = setInterval(tickStockDisplay, UPDATE_INTERVAL_MS);
}

function tickStockDisplay() {
  const player = players.find(p => p.id === currentPlayerId);
  if (!player) return;

  const elements = document.querySelectorAll('[data-stock-key]');
  elements.forEach(el => {
    const key = el.dataset.stockKey;
    const cached = cachedData[key];
    if (!cached) return;

    const currentStock = Math.min(
      calculateCurrentStock(cached.stock, cached.dailyAmount, cached.multiplier),
      player.stock_capacity
    );
    const percent = player.stock_capacity > 0 ? Math.min(100, (currentStock / player.stock_capacity) * 100) : 0;
    const isNearCap = percent >= 90;

    // Mettre a jour le texte
    const valueEl = el.querySelector('.stock-value');
    if (valueEl) {
      valueEl.textContent = `${Math.floor(currentStock)} / ${player.stock_capacity}`;
      valueEl.onclick = () => promptManualStock(cached.villageId, cached.banquetType, Math.floor(currentStock));
    }

    // Mettre a jour la barre
    const fillEl = el.querySelector('.progress-fill');
    if (fillEl) {
      fillEl.style.width = percent + '%';
      fillEl.classList.toggle('progress-danger', isNearCap);
    }

    // Mettre a jour la ligne
    const rowEl = el.closest('.banquet-row');
    if (rowEl) {
      rowEl.classList.toggle('near-cap', isNearCap);
    }
  });
}

// ---- VILLAGES ----

async function renderVillages() {
  const player = players.find(p => p.id === currentPlayerId);
  if (!player) return;

  const { data: villages } = await db
    .from('villages')
    .select('*')
    .eq('player_id', currentPlayerId)
    .order('id');

  const container = document.getElementById('villages-container');
  container.innerHTML = '';

  if (!villages || villages.length === 0) {
    container.innerHTML = '<p class="empty-msg">Aucun village. Ajoute-en un ci-dessous.</p>';
    return;
  }

  for (const village of villages) {
    const card = await createVillageCard(village, player.stock_capacity);
    container.appendChild(card);
  }
}

async function createVillageCard(village, capacity) {
  const card = document.createElement('div');
  card.className = 'village-card';

  const [prodResult, stockResult] = await Promise.all([
    db.from('production').select('*').eq('village_id', village.id),
    db.from('stocks').select('*').eq('village_id', village.id)
  ]);

  const productions = prodResult.data || [];
  const stocks = stockResult.data || [];

  let html = `
    <div class="village-header">
      <h3>${village.name}</h3>
      <div class="village-actions">
        <button class="btn btn-danger btn-sm" onclick="banquet(${village.id})">Banquet</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteVillage(${village.id}, '${village.name}')">Suppr.</button>
      </div>
    </div>
    <div class="banquet-grid">
  `;

  for (const type of BANQUET_TYPES) {
    const prod = productions.find(p => p.banquet_type === type);
    const stock = stocks.find(s => s.banquet_type === type);
    const dailyAmount = prod ? prod.daily_amount : 0;
    const multiplier = await getActiveMultiplier(currentPlayerId, type);
    const effectiveDaily = dailyAmount * multiplier;

    let currentStock = 0;
    if (stock) {
      currentStock = calculateCurrentStock(stock, dailyAmount, multiplier);
      currentStock = Math.min(currentStock, capacity);
    }

    const percent = capacity > 0 ? Math.min(100, (currentStock / capacity) * 100) : 0;
    const isNearCap = percent >= 90;
    const stockKey = `${village.id}-${type}`;

    // Cache pour le tick
    cachedData[stockKey] = {
      stock: stock || { amount: 0, last_updated: new Date().toISOString() },
      dailyAmount,
      multiplier,
      villageId: village.id,
      banquetType: type
    };

    const sousCarteToggle = multiplier > 1 ? `
          <label class="sous-carte-toggle" title="Cocher si la valeur saisie est deja multipliee par la carte">
            <input type="checkbox" class="sous-carte-cb" onchange="toggleSousCarte(${village.id}, '${type}', ${multiplier}, this)">
            <span class="sous-carte-label">sous carte</span>
          </label>` : '';

    html += `
      <div class="banquet-row ${isNearCap ? 'near-cap' : ''}">
        <div class="banquet-type">${type}</div>
        <div class="banquet-prod">
          <input type="number" class="input-sm prod-input" id="prod-${village.id}-${type.replace(/\s/g,'')}" value="${dailyAmount}" min="0"
            onblur="updateProduction(${village.id}, '${type}', this.value)" title="Production/jour (base)">
          <span class="prod-label">/j</span>
          ${multiplier > 1 ? `<span class="multiplier-badge">x${multiplier}</span>` : ''}
          ${multiplier > 1 ? `<span class="effective-prod">(${effectiveDaily}/j)</span>` : ''}
          ${sousCarteToggle}
        </div>
        <div class="banquet-stock" data-stock-key="${stockKey}">
          <div class="progress-bar">
            <div class="progress-fill ${isNearCap ? 'progress-danger' : ''}" style="width: ${percent}%"></div>
          </div>
          <span class="stock-value" onclick="promptManualStock(${village.id}, '${type}', ${Math.floor(currentStock)})"
            title="Cliquer pour modifier manuellement">${Math.floor(currentStock)} / ${capacity}</span>
        </div>
      </div>
    `;
  }

  html += '</div>';
  card.innerHTML = html;
  return card;
}

// ---- PRODUCTION ----

async function updateProduction(villageId, banquetType, value) {
  const dailyAmount = parseInt(value) || 0;

  // Verifier si la valeur a vraiment change
  const stockKey = `${villageId}-${banquetType}`;
  if (cachedData[stockKey] && cachedData[stockKey].dailyAmount === dailyAmount) return;

  localChangeInProgress = true;

  const { data: stock } = await db
    .from('stocks')
    .select('*')
    .eq('village_id', villageId)
    .eq('banquet_type', banquetType)
    .single();

  if (stock) {
    const { data: prod } = await db
      .from('production')
      .select('daily_amount')
      .eq('village_id', villageId)
      .eq('banquet_type', banquetType)
      .single();

    const oldDaily = prod ? prod.daily_amount : 0;
    const multiplier = await getActiveMultiplier(currentPlayerId, banquetType);
    const currentAmount = calculateCurrentStock(stock, oldDaily, multiplier);
    await snapshotStock(villageId, banquetType, currentAmount);
  }

  await db
    .from('production')
    .upsert({
      village_id: villageId,
      banquet_type: banquetType,
      daily_amount: dailyAmount
    }, { onConflict: 'village_id,banquet_type' });

  // Mettre a jour le cache local sans re-render
  if (cachedData[stockKey]) {
    cachedData[stockKey].dailyAmount = dailyAmount;
  }

  // Debloquer apres un delai
  setTimeout(() => { localChangeInProgress = false; }, 3000);
}

// ---- PRODUCTION SOUS CARTE ----
// Quand l'utilisateur coche "sous carte", la valeur saisie est divisee par le multiplicateur
// pour stocker la production de base. Quand la carte expire, la prod reste correcte.

async function toggleSousCarte(villageId, banquetType, multiplier, checkbox) {
  const inputId = `prod-${villageId}-${banquetType.replace(/\s/g,'')}`;
  const input = document.getElementById(inputId);
  if (!input) return;

  const currentValue = parseInt(input.value) || 0;

  if (checkbox.checked) {
    // La valeur saisie est deja multipliee -> calculer la base
    const baseValue = Math.round(currentValue / multiplier);
    input.value = baseValue;
    await updateProduction(villageId, banquetType, baseValue);
  }
  // Si decoche, on ne fait rien (la valeur dans l'input est deja la base)
}

// ---- MANUAL STOCK EDIT ----

function promptManualStock(villageId, banquetType, currentValue) {
  const newValue = prompt(`Stock ${banquetType} — nouvelle valeur :`, currentValue);
  if (newValue !== null && newValue !== '') {
    const val = parseInt(newValue);
    if (!isNaN(val) && val >= 0) {
      localChangeInProgress = true;
      setManualStock(villageId, banquetType, val).then(() => {
        renderVillages();
        setTimeout(() => { localChangeInProgress = false; }, 3000);
      });
    }
  }
}

// ---- BANQUET (reset village) ----

async function banquet(villageId) {
  if (!confirm('Remettre tous les stocks de ce village a 0 ?')) return;
  await resetVillageStocks(villageId);
  await renderVillages();
}

// ---- ADD / DELETE VILLAGE ----

async function addVillage() {
  const input = document.getElementById('new-village-name');
  const name = input.value.trim();
  if (!name) return;

  const { data, error } = await db
    .from('villages')
    .insert({ player_id: currentPlayerId, name: name })
    .select()
    .single();

  if (error) {
    alert('Erreur: ' + error.message);
    return;
  }

  await initVillageStocks(data.id);
  await initVillageProduction(data.id);

  input.value = '';
  await Promise.all([renderVillages(), populateTradeVillages(), populateTradeDestVillages()]);
}

async function deleteVillage(villageId, villageName) {
  if (!confirm(`Supprimer le village "${villageName}" et toutes ses donnees ?`)) return;
  await db.from('villages').delete().eq('id', villageId);
  await Promise.all([renderVillages(), populateTradeVillages(), populateTradeDestVillages()]);
}

// ---- CAPACITY ----

async function updateCapacity() {
  const input = document.getElementById('capacity-input');
  const newCap = parseInt(input.value);
  if (isNaN(newCap) || newCap <= 0) return;

  await db
    .from('players')
    .update({ stock_capacity: newCap })
    .eq('id', currentPlayerId);

  const player = players.find(p => p.id === currentPlayerId);
  if (player) player.stock_capacity = newCap;

  document.getElementById('capacity-display').textContent = newCap;
  await renderVillages();
}

// ---- CARDS ----

async function renderCards() {
  const activeCards = await getActiveCards(currentPlayerId);
  const container = document.getElementById('cards-container');
  container.innerHTML = '';

  for (const type of BANQUET_TYPES) {
    const active = activeCards.find(c => c.banquet_type === type);
    const div = document.createElement('div');
    div.className = 'card-type-row' + (active ? ' card-active' : '');

    let timerHtml = '';
    if (active) {
      const remaining = new Date(active.expires_at) - new Date();
      const hours = Math.floor(remaining / 3600000);
      const minutes = Math.floor((remaining % 3600000) / 60000);
      const isWarning = remaining < 3600000;
      timerHtml = `<span class="card-timer ${isWarning ? 'timer-warning' : ''}" onclick="editCardTimer(${active.id}, '${active.expires_at}')" title="Cliquer pour modifier">${hours}h${String(minutes).padStart(2, '0')}</span>`;
    }

    div.innerHTML = `
      <span class="card-type-name">${type}</span>
      <div class="card-multipliers">
        ${[3, 5, 10].map(m => `
          <button class="card-mult-btn ${active && active.multiplier === m ? 'card-mult-active' : ''}"
            onclick="activateCard('${type}', ${m})">${active && active.multiplier === m ? 'x' + m : 'x' + m}</button>
        `).join('')}
      </div>
      ${timerHtml}
      ${active ? `<button class="card-remove-btn" onclick="removeCard(${active.id})">X</button>` : ''}
    `;
    container.appendChild(div);
  }
}

async function activateCard(type, multiplier) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const existing = await getActiveCards(currentPlayerId);
  const old = existing.find(c => c.banquet_type === type);
  if (old) {
    await db.from('cards').delete().eq('id', old.id);
  }

  const { data: villages } = await db
    .from('villages')
    .select('id')
    .eq('player_id', currentPlayerId);

  if (villages) {
    for (const v of villages) {
      const { data: stock } = await db
        .from('stocks')
        .select('*')
        .eq('village_id', v.id)
        .eq('banquet_type', type)
        .single();

      if (stock) {
        const { data: prod } = await db
          .from('production')
          .select('daily_amount')
          .eq('village_id', v.id)
          .eq('banquet_type', type)
          .single();

        const oldMultiplier = old ? old.multiplier : 1;
        const dailyAmount = prod ? prod.daily_amount : 0;
        const currentAmount = calculateCurrentStock(stock, dailyAmount, oldMultiplier);
        await snapshotStock(v.id, type, currentAmount);
      }
    }
  }

  await db.from('cards').insert({
    player_id: currentPlayerId,
    banquet_type: type,
    multiplier: multiplier,
    activated_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  });

  await Promise.all([renderCards(), renderVillages()]);
}

async function editCardTimer(cardId, currentExpires) {
  const remaining = new Date(currentExpires) - new Date();
  const currentHours = Math.max(0, remaining / 3600000).toFixed(1);
  const input = prompt(`Temps restant (en heures) :`, currentHours);
  if (input === null || input === '') return;

  const hours = parseFloat(input);
  if (isNaN(hours) || hours < 0) return;

  const newExpires = new Date(Date.now() + hours * 3600000).toISOString();
  await db.from('cards').update({ expires_at: newExpires }).eq('id', cardId);
  await Promise.all([renderCards(), renderVillages()]);
}

async function removeCard(cardId) {
  await db.from('cards').delete().eq('id', cardId);
  await Promise.all([renderCards(), renderVillages()]);
}

// ---- TRADE ----

async function sendTrade() {
  const fromVillageId = parseInt(document.getElementById('trade-village-select').value);
  const toVillageId = parseInt(document.getElementById('trade-dest-village-select').value);
  const type = document.getElementById('trade-type-select').value;
  const amount = parseInt(document.getElementById('trade-amount').value);

  if (!fromVillageId || !toVillageId || !amount || amount <= 0) return;

  const otherPlayer = players.find(p => p.id !== currentPlayerId);
  if (!otherPlayer) return;

  const success = await executeTrade(currentPlayerId, otherPlayer.id, fromVillageId, toVillageId, type, amount);
  if (success) {
    document.getElementById('trade-amount').value = '0';
    document.getElementById('trade-slider').value = '0';
    document.getElementById('trade-slider-value').textContent = '0';
    await Promise.all([renderVillages(), renderTradeHistory()]);
  }
}

async function renderTradeHistory() {
  const trades = await getTradeHistory();
  const container = document.getElementById('trade-history');
  container.innerHTML = '';

  if (trades.length === 0) {
    container.innerHTML = '<p class="empty-msg">Aucun trade recent.</p>';
    return;
  }

  trades.forEach(t => {
    const div = document.createElement('div');
    div.className = 'trade-item';
    const time = new Date(t.created_at).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    div.innerHTML = `
      <span class="trade-time">${time}</span>
      <span class="trade-detail">
        <strong>${t.from_player.name}</strong> → <strong>${t.to_player.name}</strong>
      </span>
      <span class="trade-resource">${t.amount} ${t.banquet_type}</span>
    `;
    container.appendChild(div);
  });
}

// ---- REALTIME SUBSCRIPTIONS ----

let realtimeDebounce = null;

function setupRealtimeSubscriptions() {
  db.channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stocks' }, () => {
      debouncedRefresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, () => {
      renderCards();
      debouncedRefresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trades' }, () => {
      renderTradeHistory();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'villages' }, () => {
      debouncedRefresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production' }, () => {
      debouncedRefresh();
    })
    .subscribe();
}

// Debounce pour eviter les re-renders en cascade
function debouncedRefresh() {
  if (localChangeInProgress) return; // Ignorer les echos de nos propres changements
  if (realtimeDebounce) clearTimeout(realtimeDebounce);
  realtimeDebounce = setTimeout(() => {
    if (!localChangeInProgress) renderVillages();
  }, 2000);
}

// ---- CARD TIMER REFRESH ----

setInterval(() => {
  if (currentPlayerId) renderCards();
}, 60000);

// ---- KPIs ----

async function renderKPIs() {
  const container = document.getElementById('kpi-container');
  container.innerHTML = '';

  const { data: villages } = await db
    .from('villages')
    .select('id')
    .eq('player_id', currentPlayerId);

  if (!villages || villages.length === 0) return;

  const villageIds = villages.map(v => v.id);

  const { data: productions } = await db
    .from('production')
    .select('village_id, banquet_type, daily_amount')
    .in('village_id', villageIds);

  const prods = productions || [];

  for (const type of BANQUET_TYPES) {
    const multiplier = await getActiveMultiplier(currentPlayerId, type);
    const totalDaily = prods
      .filter(p => p.banquet_type === type)
      .reduce((sum, p) => sum + p.daily_amount, 0);

    const perHour = Math.round((totalDaily * multiplier) / 24);

    const div = document.createElement('div');
    div.className = 'kpi-card';
    div.innerHTML = `
      <span class="kpi-value">${perHour}</span>
      <span class="kpi-label">${type}/h</span>
      ${multiplier > 1 ? `<span class="kpi-mult">x${multiplier}</span>` : ''}
    `;
    container.appendChild(div);
  }
}

// ---- COLLAPSIBLE SECTIONS ----

function toggleSection(headerEl) {
  const body = headerEl.nextElementSibling;
  const icon = headerEl.querySelector('.collapse-icon');
  const isCollapsed = body.classList.contains('collapsed');

  body.classList.toggle('collapsed');
  headerEl.classList.toggle('open');
  icon.textContent = isCollapsed ? '−' : '+';
}

// ---- START ----

document.addEventListener('DOMContentLoaded', init);
