import { createId } from "@paralleldrive/cuid2";
import { createServerOnlyFn } from "@tanstack/react-start";

import { client } from "~/db";
import { serverEnv } from "~/env/server";

export const getEmbeddings = createServerOnlyFn(
  async (data: { input: string; model: string }): Promise<Array<number>> => {
    console.log("Getting embeddings for", data.input, "with model", data.model);
    const response = await fetch("https://router.huggingface.co/nebius/v1/embeddings", {
      body: JSON.stringify(data),
      headers: {
        Authorization: `Bearer ${serverEnv.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    console.log("Response", response);
    const result = (await response.json()) as { data: Array<{ embedding: Array<number> }> };
    const embeddingData = result.data.at(0);
    if (!embeddingData) {
      throw new Error("No embedding data returned from API");
    }
    return embeddingData.embedding;
  },
);

export const createProjectEmbedding = createServerOnlyFn(
  async (projectId: string, text: string, modelName = "Qwen/Qwen3-Embedding-8B") => {
    console.log("Creating project embedding for project", projectId, "with text", text, "and model", modelName);
    const embeddingInput: { input: string; model: string } = {
      input: text,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      model: modelName,
    };
    const embedding = await getEmbeddings(embeddingInput);
    console.log("Embedding", embedding);
    const statement =
      "INSERT INTO project_embeddings (id,project_id,text,embedding,model,created_at,updated_at) VALUES (?,?,?,vector32(?),?,?,?)";
    const result = await client.execute(statement, [
      createId(),
      projectId,
      text,
      JSON.stringify(embedding),
      modelName,
      new Date(),
      new Date(),
    ]);
    return result;
  },
);

export const search_embeddings = async (data: { modelName: string; text: string; topK: number }) => {
  const { modelName, text, topK = 3 } = data;
  const embedding = await getEmbeddings({ input: text, model: modelName });
  console.log("Embedding", embedding);
  // Perform vector similarity search
  //Get the project id , text and schema by joining with openapi schema table with openapi version table to get the schema for the project.
  const sql = `SELECT pe.project_id, pe.text, osv.schema FROM (SELECT pe.id, pe.text, pe.project_id FROM vector_top_k('project_embeddings_idx', vector32(?), ?) AS v JOIN project_embeddings AS pe ON pe.rowid = v.id) as pe JOIN openapi_schema AS os ON os.project_id = pe.project_id JOIN openapi_schema_version AS osv ON osv.openapi_schema_id = os.id`;

  const result = await client.execute({
    args: [JSON.stringify(embedding), topK],
    sql,
  });
  return result.rows;
};
