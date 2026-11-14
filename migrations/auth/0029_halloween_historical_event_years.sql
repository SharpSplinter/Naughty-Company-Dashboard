PRAGMA foreign_keys = ON;

-- Torn's Trick or Treat event uses the October 25–November 1 calendar window.
-- Each member saves their own exact TCT start time before collecting that year.
-- Existing event windows are preserved by INSERT OR IGNORE.
INSERT OR IGNORE INTO halloween_event_windows
  (event_year, start_at, end_at, historical_collection_enabled, live_collection_enabled, created_at, updated_at)
VALUES
  (2021, '2021-10-25T12:00:00.000Z', '2021-11-01T12:00:00.000Z', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (2022, '2022-10-25T12:00:00.000Z', '2022-11-01T12:00:00.000Z', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (2023, '2023-10-25T12:00:00.000Z', '2023-11-01T12:00:00.000Z', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (2024, '2024-10-25T12:00:00.000Z', '2024-11-01T12:00:00.000Z', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (2025, '2025-10-25T12:00:00.000Z', '2025-11-01T12:00:00.000Z', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
