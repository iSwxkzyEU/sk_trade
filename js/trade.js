// ============================================
// Logique de Trade entre joueurs
// ============================================

// Remplit le select des villages source pour le trade (mes villages)
async function populateTradeVillages() {
  const select = document.getElementById('trade-village-select');
  if (!select) return;

  const { data: villages } = await db
    .from('villages')
    .select('*')
    .eq('player_id', currentPlayerId)
    .order('id');

  select.innerHTML = '';
  if (villages) {
    villages.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      select.appendChild(opt);
    });
  }
}

// Remplit le select des villages destination (villages de l'autre joueur)
async function populateTradeDestVillages() {
  const select = document.getElementById('trade-dest-village-select');
  if (!select) return;

  const otherPlayer = players.find(p => p.id !== currentPlayerId);
  if (!otherPlayer) return;

  const { data: villages } = await db
    .from('villages')
    .select('*')
    .eq('player_id', otherPlayer.id)
    .order('id');

  select.innerHTML = '';
  if (villages) {
    villages.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      select.appendChild(opt);
    });
  }
}

// Envoie des ressources d'un joueur a un autre
// Retire du village source, ajoute au village destination choisi
async function executeTrade(fromPlayerId, toPlayerId, fromVillageId, toVillageId, banquetType, amount) {
  // 1. Enregistrer le trade dans l'historique
  const { error: tradeError } = await db
    .from('trades')
    .insert({
      from_player_id: fromPlayerId,
      to_player_id: toPlayerId,
      banquet_type: banquetType,
      amount: amount
    });

  if (tradeError) {
    console.error('Erreur trade:', tradeError);
    return false;
  }

  // 2. Retirer du stock de l'envoyeur (village source)
  const { data: fromStock } = await db
    .from('stocks')
    .select('*')
    .eq('village_id', fromVillageId)
    .eq('banquet_type', banquetType)
    .single();

  if (fromStock) {
    const { data: fromProd } = await db
      .from('production')
      .select('daily_amount')
      .eq('village_id', fromVillageId)
      .eq('banquet_type', banquetType)
      .single();

    const fromDaily = fromProd ? fromProd.daily_amount : 0;
    const fromMultiplier = await getActiveMultiplier(fromPlayerId, banquetType);
    const fromCurrent = calculateCurrentStock(fromStock, fromDaily, fromMultiplier);
    await snapshotStock(fromVillageId, banquetType, Math.max(0, fromCurrent - amount));
  }

  // 3. Ajouter au stock du destinataire (village choisi)
  const { data: toStock } = await db
    .from('stocks')
    .select('*')
    .eq('village_id', toVillageId)
    .eq('banquet_type', banquetType)
    .single();

  if (toStock) {
    const { data: toProd } = await db
      .from('production')
      .select('daily_amount')
      .eq('village_id', toVillageId)
      .eq('banquet_type', banquetType)
      .single();

    const toDaily = toProd ? toProd.daily_amount : 0;
    const toMultiplier = await getActiveMultiplier(toPlayerId, banquetType);
    const toCurrent = calculateCurrentStock(toStock, toDaily, toMultiplier);
    await snapshotStock(toVillageId, banquetType, toCurrent + amount);
  } else {
    await snapshotStock(toVillageId, banquetType, amount);
  }

  return true;
}

// Recupere l'historique recent des trades
async function getTradeHistory(limit = 20) {
  const { data } = await db
    .from('trades')
    .select(`
      id,
      banquet_type,
      amount,
      created_at,
      from_player:players!trades_from_player_id_fkey(name),
      to_player:players!trades_to_player_id_fkey(name)
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  return data || [];
}
