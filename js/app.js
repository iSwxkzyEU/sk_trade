// ============================================
// App principale - Stronghold Tracker
// ============================================

let currentPlayerId = null;
let players = [];
let refreshInterval = null;

// ---- INIT ----

async function init() {
  const { data } = await db.from('players').select('*').order('id');
  players = data || [];

  if (players.length === 0) return;

  renderPlayerTabs();
  switchPlayer(players[0].id);
  startAutoRefresh();
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

  // Update tab styling
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.playerId) === playerId);
  });

  const player = players.find(p => p.id === playerId);
  document.getElementById('player-name').textContent = player.name;
  document.getElementById('capacity-display').textContent = player.stock_capacity;
  document.getElementById('capacity-input').value = player.stock_capacity;

  await refreshDashboard();
}

// ---- DASHBOARD REFRESH ----

async function refreshDashboard() {
  await Promise.all([
    renderVillages(),
    renderCards(),
    renderTradeHistory()
  ]);
}

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    if (currentPlayerId) renderVillages();
  }, UPDATE_INTERVAL_MS);
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

  // Recuperer production et stocks
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
      currentStock = Math.min(currentStock, capacity); // Cap a la capacite
    }

    const percent = capacity > 0 ? Math.min(100, (currentStock / capacity) * 100) : 0;
    const isNearCap = percent >= 90;

    html += `
      <div class="banquet-row ${isNearCap ? 'near-cap' : ''}">
        <div class="banquet-type">${type}</div>
        <div class="banquet-prod">
          <input type="number" class="input-sm" value="${dailyAmount}" min="0"
            onchange="updateProduction(${village.id}, '${type}', this.value)" title="Production/jour">
          <span class="prod-label">/j</span>
          ${multiplier > 1 ? `<span class="multiplier-badge">x${multiplier}</span>` : ''}
          ${multiplier > 1 ? `<span class="effective-prod">(${effectiveDaily}/j)</span>` : ''}
        </div>
        <div class="banquet-stock">
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

  // Snapshot le stock actuel avant de changer la production
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

  // Mettre a jour la production
  await db
    .from('production')
    .upsert({
      village_id: villageId,
      banquet_type: banquetType,
      daily_amount: dailyAmount
    }, { onConflict: 'village_id,banquet_type' });
}

// ---- MANUAL STOCK EDIT ----

function promptManualStock(villageId, banquetType, currentValue) {
  const newValue = prompt(`Stock ${banquetType} — nouvelle valeur :`, currentValue);
  if (newValue !== null && newValue !== '') {
    const val = parseInt(newValue);
    if (!isNaN(val) && val >= 0) {
      setManualStock(villageId, banquetType, val).then(() => renderVillages());
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

  // Initialiser les stocks et la production
  await initVillageStocks(data.id);
  await initVillageProduction(data.id);

  input.value = '';
  await renderVillages();
}

async function deleteVillage(villageId, villageName) {
  if (!confirm(`Supprimer le village "${villageName}" et toutes ses donnees ?`)) return;
  await db.from('villages').delete().eq('id', villageId);
  await renderVillages();
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

  if (activeCards.length === 0) {
    container.innerHTML = '<p class="empty-msg">Aucune carte active.</p>';
    return;
  }

  activeCards.forEach(card => {
    const div = document.createElement('div');
    div.className = 'card-item';

    const remaining = new Date(card.expires_at) - new Date();
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);

    div.innerHTML = `
      <span class="card-type">${card.banquet_type}</span>
      <span class="card-multiplier">x${card.multiplier}</span>
      <span class="card-timer ${remaining < 3600000 ? 'timer-warning' : ''}">${hours}h${String(minutes).padStart(2, '0')}</span>
      <button class="btn btn-ghost btn-sm" onclick="removeCard(${card.id})">X</button>
    `;
    container.appendChild(div);
  });
}

async function activateCard() {
  const type = document.getElementById('card-type-select').value;
  const multiplier = parseInt(document.getElementById('card-multiplier-select').value);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000); // +12h

  // Snapshot tous les stocks du joueur pour ce type avant d'activer la carte
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

        const oldMultiplier = await getActiveMultiplier(currentPlayerId, type);
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

async function removeCard(cardId) {
  await db.from('cards').delete().eq('id', cardId);
  await Promise.all([renderCards(), renderVillages()]);
}

// ---- TRADE ----

async function sendTrade() {
  const type = document.getElementById('trade-type-select').value;
  const amount = parseInt(document.getElementById('trade-amount').value);

  if (!amount || amount <= 0) return;

  const otherPlayer = players.find(p => p.id !== currentPlayerId);
  if (!otherPlayer) return;

  const success = await executeTrade(currentPlayerId, otherPlayer.id, type, amount);
  if (success) {
    document.getElementById('trade-amount').value = '';
    await renderTradeHistory();
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

function setupRealtimeSubscriptions() {
  db.channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stocks' }, () => {
      renderVillages();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, () => {
      renderCards();
      renderVillages();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trades' }, () => {
      renderTradeHistory();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'villages' }, () => {
      renderVillages();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production' }, () => {
      renderVillages();
    })
    .subscribe();
}

// ---- CARD TIMER REFRESH ----

setInterval(() => {
  if (currentPlayerId) renderCards();
}, 60000); // Refresh timers toutes les minutes

// ---- START ----

document.addEventListener('DOMContentLoaded', init);
