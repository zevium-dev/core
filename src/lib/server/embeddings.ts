import { createServerOnlyFn , createServerFn } from "@tanstack/react-start";
import { client } from "~/db";
import { serverEnv } from "~/env/server";

export const getEmbeddings = createServerOnlyFn(async (data: { input: string, model: string }) => {
  console.log("Getting embeddings for", data.input, "with model", data.model);
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
  console.log("Response", response);
  const result = await response.json() as { data: { embedding: number[] }[] };
  return result.data[0].embedding;
});

export const createProjectEmbedding = createServerOnlyFn(async (projectId : string, text: string, modelName = "Qwen/Qwen3-Embedding-8B") => {
  console.log("Creating project embedding for project", projectId, "with text", text, "and model", modelName);
  const embedding = await getEmbeddings({ 
    input: text, 
    model: modelName 
  });
  console.log("Embedding", embedding);
  const statement = "INSERT INTO project_embeddings (id,project_id,text,embedding,model,created_at,updated_at) VALUES (?,?,?,vector32(?),?,?,?)";
  try {
  const result = await client.execute(statement, [
    crypto.randomUUID().toString(),
    projectId,
    text,
    JSON.stringify(embedding),
    modelName,
      new Date(),
      new Date()
    ]);
    return result;
  } catch (error) {
    throw error;
  }
  
});

export const search_embeddings = async (data: { text: string, modelName: string, topK: number }) => {
  const { text, modelName, topK = 3 } = data
  const embedding = await getEmbeddings({ input: text, model: modelName })
  console.log("Embedding", embedding);
  // Perform vector similarity search
  //Get the project id , text and schema by joining with openapi schema table with openapi version table to get the schema for the project.
  const sql = `SELECT pe.project_id, pe.text, osv.schema FROM (SELECT pe.id, pe.text, pe.project_id FROM vector_top_k('project_embeddings_idx', vector32(?), ?) AS v JOIN project_embeddings AS pe ON pe.rowid = v.id) as pe JOIN openapi_schema AS os ON os.project_id = pe.project_id JOIN openapi_schema_version AS osv ON osv.openapi_schema_id = os.id`;

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