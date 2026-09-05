-- Per-user presentation preferences follow the same tenant boundary as budgets.
CREATE TABLE website_preferences (
  user_id TEXT PRIMARY KEY,
  highlight_color TEXT NOT NULL DEFAULT '#185b45',
  background_color TEXT NOT NULL DEFAULT '#f5f2e9',
  card_color TEXT NOT NULL DEFAULT '#fffdf7',
  text_color TEXT NOT NULL DEFAULT '#16211d',
  positive_color TEXT NOT NULL DEFAULT '#185b45',
  negative_color TEXT NOT NULL DEFAULT '#a33b32',
  chart_accent_color TEXT NOT NULL DEFAULT '#16211d',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
