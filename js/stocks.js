// ============================================
// Calcul temps reel des stocks
// ============================================

const BANQUET_TYPES = ['Gibier', 'Chaise', 'Vaisselle', 'Tunique', 'Vin', 'Sel', 'Epices', 'Soie'];
const UPDATE_INTERVAL_MS = 10000; // Refresh affichage toutes les 10s

let stockTimers = {};

// Calcule le stock actuel en fonction du temps ecoule et de la production
function calculateCurrentStock(stockRow, dailyAmount, cardMultiplier) {
  const now = new Date();
  const lastUpdated = new Date(stockRow.last_updated);
  const elapsedMs = now - lastUpdated;
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

  const produced = dailyAmount * cardMultiplier * elapsedDays;
  return stockRow.amount + produced;
}

// Recupere le multiplicateur actif pour un joueur et un type
async function getActiveMultiplier(playerId, banquetType) {
  const now = new Date().toISOString();
  const { data } = await db
    .from('cards')
    .select('multiplier')
    .eq('player_id', playerId)
    .eq('banquet_type', banquetType)
    .gt('expires_at', now)
    .order('activated_at', { ascending: false })
    .limit(1);

  return data && data.length > 0 ? data[0].multiplier : 1;
}

// Recupere toutes les cartes actives d'un joueur
async function getActiveCards(playerId) {
  const now = new Date().toISOString();
  const { data } = await db
    .from('cards')
    .select('*')
    .eq('player_id', playerId)
    .gt('expires_at', now)
    .order('banquet_type');

  return data || [];
}

// Snapshot le stock en base (sauvegarde le calcul courant)
async function snapshotStock(villageId, banquetType, currentAmount) {
  await db
    .from('stocks')
    .upsert({
      village_id: villageId,
      banquet_type: banquetType,
      amount: Math.max(0, currentAmount),
      last_updated: new Date().toISOString()
    }, { onConflict: 'village_id,banquet_type' });
}

// Remet les stocks d'un village a 0 (banquet)
async function resetVillageStocks(villageId) {
  const now = new Date().toISOString();
  for (const type of BANQUET_TYPES) {
    await db
      .from('stocks')
      .upsert({
        village_id: villageId,
        banquet_type: type,
        amount: 0,
        last_updated: now
      }, { onConflict: 'village_id,banquet_type' });
  }
}

// Met a jour manuellement un stock
async function setManualStock(villageId, banquetType, newAmount) {
  await db
    .from('stocks')
    .upsert({
      village_id: villageId,
      banquet_type: banquetType,
      amount: Math.max(0, newAmount),
      last_updated: new Date().toISOString()
    }, { onConflict: 'village_id,banquet_type' });
}

// Initialise les stocks pour un village (toutes les lignes a 0)
async function initVillageStocks(villageId) {
  const now = new Date().toISOString();
  for (const type of BANQUET_TYPES) {
    await db
      .from('stocks')
      .upsert({
        village_id: villageId,
        banquet_type: type,
        amount: 0,
        last_updated: now
      }, { onConflict: 'village_id,banquet_type' });
  }
}

// Initialise la production pour un village (toutes les lignes a 0)
async function initVillageProduction(villageId) {
  for (const type of BANQUET_TYPES) {
    await db
      .from('production')
      .upsert({
        village_id: villageId,
        banquet_type: type,
        daily_amount: 0
      }, { onConflict: 'village_id,banquet_type' });
  }
}
