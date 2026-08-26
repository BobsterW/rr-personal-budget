CREATE TABLE master_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE categories ADD COLUMN master_category_id TEXT REFERENCES master_categories(id);

CREATE TABLE category_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL COLLATE NOCASE UNIQUE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN liquidity_class TEXT NOT NULL DEFAULT 'liquid'
  CHECK (liquidity_class IN ('fixed','liquid'));

CREATE INDEX idx_categories_master ON categories(master_category_id);
CREATE INDEX idx_category_rules_priority ON category_rules(active,priority,pattern);
