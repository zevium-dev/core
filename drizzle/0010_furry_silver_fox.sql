CREATE INDEX project_embeddings_idx ON project_embeddings(libsql_vector_idx(embedding));
