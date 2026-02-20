-- ============================================
-- Stronghold Tracker - Schema SQL Supabase
-- A executer dans : Supabase > SQL Editor
-- ============================================

-- Table des joueurs
CREATE TABLE players (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  stock_capacity INTEGER NOT NULL DEFAULT 2700,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table des villages
CREATE TABLE villages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Production par village et type de banquet
CREATE TABLE production (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  village_id BIGINT NOT NULL REFERENCES villages(id) ON DELETE CASCADE,
  banquet_type TEXT NOT NULL CHECK (banquet_type IN ('Gibier','Tunique','Vaisselle','Chaise','Sel','Epices','Soie','Vin')),
  daily_amount INTEGER NOT NULL DEFAULT 0,
  UNIQUE(village_id, banquet_type)
);

-- Stocks par village et type de banquet
CREATE TABLE stocks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  village_id BIGINT NOT NULL REFERENCES villages(id) ON DELETE CASCADE,
  banquet_type TEXT NOT NULL CHECK (banquet_type IN ('Gibier','Tunique','Vaisselle','Chaise','Sel','Epices','Soie','Vin')),
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(village_id, banquet_type)
);

-- Cartes multiplicatrices (globales par joueur et type)
CREATE TABLE cards (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  banquet_type TEXT NOT NULL CHECK (banquet_type IN ('Gibier','Tunique','Vaisselle','Chaise','Sel','Epices','Soie','Vin')),
  multiplier INTEGER NOT NULL CHECK (multiplier IN (3, 5, 10)),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Historique des trades
CREATE TABLE trades (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_player_id BIGINT NOT NULL REFERENCES players(id),
  to_player_id BIGINT NOT NULL REFERENCES players(id),
  banquet_type TEXT NOT NULL CHECK (banquet_type IN ('Gibier','Tunique','Vaisselle','Chaise','Sel','Epices','Soie','Vin')),
  amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour les performances
CREATE INDEX idx_villages_player ON villages(player_id);
CREATE INDEX idx_production_village ON production(village_id);
CREATE INDEX idx_stocks_village ON stocks(village_id);
CREATE INDEX idx_cards_player ON cards(player_id);
CREATE INDEX idx_cards_expires ON cards(expires_at);
CREATE INDEX idx_trades_created ON trades(created_at DESC);

-- Desactiver RLS pour simplifier (app de confiance entre 2 joueurs)
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE villages ENABLE ROW LEVEL SECURITY;
ALTER TABLE production ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

-- Policies permissives (acces total avec anon key)
CREATE POLICY "Allow all" ON players FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON villages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON production FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON stocks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON cards FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON trades FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- Seed data : creation des 2 joueurs
-- ============================================
INSERT INTO players (name, stock_capacity) VALUES ('Roger', 2700);
INSERT INTO players (name, stock_capacity) VALUES ('Warlock', 2700);

-- Realtime : activer les subscriptions sur les tables
ALTER PUBLICATION supabase_realtime ADD TABLE stocks;
ALTER PUBLICATION supabase_realtime ADD TABLE cards;
ALTER PUBLICATION supabase_realtime ADD TABLE trades;
ALTER PUBLICATION supabase_realtime ADD TABLE villages;
ALTER PUBLICATION supabase_realtime ADD TABLE production;
