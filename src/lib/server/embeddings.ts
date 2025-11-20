import { createId } from "@paralleldrive/cuid2";
import { createServerOnlyFn } from "@tanstack/react-start";

import { db } from "~/db";
import { serverEnv } from "~/env/server";

export const EMBEDDING_MODEL = "models/gemini-embedding-001";
export const EMBEDDING_DIMENSION = 768;

export const getEmbeddings = createServerOnlyFn(
  async (data: { input: string }): Promise<Array<number>> => {
    console.log("Getting embeddings for", data.input, "with model", EMBEDDING_MODEL);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${EMBEDDING_MODEL}:embedContent`,
      {
        body: JSON.stringify({
          content: {
            parts: [
              {
                text: data.input,
              },
            ],
          },
          model: EMBEDDING_MODEL,
          output_dimensionality: EMBEDDING_DIMENSION,
        }),
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": serverEnv.GEMINI_API_KEY,
        },
        method: "POST",
      },
    );
    console.log("Response", response);
    const result = (await response.json()) as { embedding: { values: Array<number> } };
    const embeddingData = result.embedding;
    if (!embeddingData) {
      throw new Error("No embedding data returned from API");
    }
    return embeddingData.values;
  },
);

export const createProjectEmbedding = createServerOnlyFn(
  async (projectId: string, text: string) => {
    console.log(
      "Creating project embedding for project",
      projectId,
      "with text",
      text,
      "and model",
      EMBEDDING_MODEL,
    );
    const embedding = await getEmbeddings({ input: text });
    console.log("Embedding", embedding);
    const statement =
      "INSERT INTO project_embeddings (id,project_id,text,embedding,created_at,updated_at) VALUES (?,?,?,vector32(?),?,?)";
    const result = await db.$client.execute(statement, [
      createId(),
      projectId,
      text,
      JSON.stringify(embedding),
      new Date(),
      new Date(),
    ]);
    return result;
  },
);

export const search_embeddings = async (data: {
  text: string;
  topK: number;
}) => {
  const { text, topK = 3 } = data;
  const embedding = await getEmbeddings({ input: text });
  console.log("Embedding", embedding);
  // Perform vector similarity search
  //Get the project id , text and schema by joining with openapi schema table with openapi version table to get the schema for the project.
  const sql = `SELECT pe.project_id, pe.text, osv.schema FROM (SELECT pe.id, pe.text, pe.project_id FROM vector_top_k('project_embeddings_idx', vector32(?), ?) AS v JOIN project_embeddings AS pe ON pe.rowid = v.id) as pe JOIN openapi_schema AS os ON os.project_id = pe.project_id JOIN openapi_schema_version AS osv ON osv.openapi_schema_id = os.id`;

  const result = await db.$client.execute(sql, [JSON.stringify(embedding), topK]);
  const searchResults: Array<SearchResult> = result.rows.map((row) => ({
    project_id: row.project_id as string,
    schema: row.schema as string,
    text: row.text as string,
  }));

  return searchResults;
};

export type SearchResult = {
  project_id: string;
  text: string;
  schema: string;
};
