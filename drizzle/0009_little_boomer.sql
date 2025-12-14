CREATE TABLE IF NOT EXISTS project_embeddings (
  id TEXT PRIMARY KEY NOT NULL,
  project_id text UNIQUE NOT NULL,
  text TEXT,
  embedding F32_BLOB(768),
  created_at INTEGER  NOT NULL,
  updated_at INTEGER  NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
