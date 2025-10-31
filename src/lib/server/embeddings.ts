import { createServerOnlyFn , createServerFn } from "@tanstack/react-start";
import { client } from "~/db";
import { serverEnv } from "~/env/server";

export const getEmbeddings = createServerOnlyFn(async (data: { input: string, model: string }) => {
  const response = await fetch(
    "https://router.huggingface.co/nebius/v1/embeddings",
    {
      headers: {
        Authorization: `Bearer ${serverEnv.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify(data),
    }
  );
  const result = await response.json() as { data: { embedding: number[] }[] };
  return result.data[0].embedding;
});

export const search_embeddings = async (data: { text: string, modelName: string, topK: number }) => {
  const { text, modelName, topK = 3 } = data
  const embedding = await getEmbeddings({ input: text, model: modelName })
  console.log("Embedding", embedding);
  // Perform vector similarity search
  const sql = `SELECT pe.id, pe.text FROM vector_top_k('project_embeddings_idx', vector32(?), ?) AS v JOIN project_embeddings AS pe ON pe.rowid = v.id`;
  //         const sql = `
  // SELECT *
  // FROM vector_top_k('project_embeddings_idx', vector32(?), ?)
  // `;

  try {
    const result = await client.execute({
      sql,
      args: [JSON.stringify(embedding), topK],
    });
    return result.rows;
  } catch (error) {
    throw error;
  }
};