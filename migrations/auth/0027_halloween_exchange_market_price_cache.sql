PRAGMA foreign_keys = ON;

-- Public Torn item-market average prices are global data, shared across members.
-- Cache by item ID so opening Halloween stats does not repeatedly request the
-- same globally cached market selection.
CREATE TABLE IF NOT EXISTS halloween_exchange_market_price_cache (
  item_id TEXT PRIMARY KEY,
  item_name TEXT NOT NULL,
  average_price REAL,
  market_cache_timestamp INTEGER,
  fetched_at INTEGER,
  attempted_at INTEGER NOT NULL
);
