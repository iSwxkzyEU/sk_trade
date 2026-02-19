// ============================================
// Logique de Trade entre joueurs
// ============================================

// Envoie des ressources d'un joueur a un autre
// Met a jour les stocks du destinataire instantanement
async function executeTrade(fromPlayerId, toPlayerId, banquetType, amount) {
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

  // 2. Recuperer tous les villages du destinataire pour repartir le stock
  // On ajoute au premier village qui a de la production pour ce type
  // ou au premier village tout court
  const { data: toVillages } = await db
    .from('villages')
    .select('id')
    .eq('player_id', toPlayerId)
    .order('id')
    .limit(1);

  if (toVillages && toVillages.length > 0) {
    const targetVillageId = toVillages[0].id;

    // Recuperer le stock actuel
    const { data: currentStock } = await db
      .from('stocks')
      .select('*')
      .eq('village_id', targetVillageId)
      .eq('banquet_type', banquetType)
      .single();

    if (currentStock) {
      // Calculer le stock actuel avec la production ecoulee
      const { data: prod } = await db
        .from('production')
        .select('daily_amount')
        .eq('village_id', targetVillageId)
        .eq('banquet_type', banquetType)
        .single();

      const dailyAmount = prod ? prod.daily_amount : 0;
      const multiplier = await getActiveMultiplier(toPlayerId, banquetType);
      const calculatedStock = calculateCurrentStock(currentStock, dailyAmount, multiplier);

      // Ajouter le trade au stock
      await snapshotStock(targetVillageId, banquetType, calculatedStock + amount);
    } else {
      // Pas de stock existant, creer
      await snapshotStock(targetVillageId, banquetType, amount);
    }
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
