import z, { uuidv4 } from "zod";
import { client } from "~/db";
import { serverEnv } from "~/env/server";

import { protectedProcedure, publicProcedure, router } from "~/server/trpc";

// Schema for embedding record (no DB logic here)
export const embeddingSchema = z.object({
  id: z.string(),
  embedding: z.array(z.number()),
  modelName: z.string(),
  createdAt: z.date(),
  modifiedAt: z.date(),
});

export const embeddingRouter = router({
  // Create an embedding from input text
  create: publicProcedure
    .meta({ route: { path: "/embedding/create", summary: "Create embedding for given text" } })
    .input(
      z.object({
        text: z.string().min(1, "Text is required"),
        // optional: allow overriding model
        modelName: z.string().optional(),
      }),
    )
    .mutation(async ({input}) => {
      // Intentionally no DB or external call logic per instructions.
      // You can implement calling the embedding provider and persistence here.
      console.log("Entry")
      async function query( data : string) {
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
        const result = await response.json() as { data: { embedding: number[] } };
        console.log(result);
        return result.data.embedding;
      }
      
      const embedding = await query(input.text)
      //const embedding = await client.execute(sql`INSERT INTO embedding (text, embedding, model_name) VALUES (${input.text}, ${input.embedding}, ${input.modelName})`);
      const statement = "INSERT INTO embeddings (id,embedding,model,created_at,modified_at) VALUES (?,?,?,?,?)";
      
      const result = await client.execute(statement, [crypto.randomUUID().toString() ,new Float32Array(embedding).buffer as ArrayBuffer, input.modelName ?? "default", new Date(), new Date()]);
      
      return {
        embedding: {
          id: result.rows[0].id,
          embedding: result.rows[0].embedding,
          modelName: result.rows[0].model,
          createdAt: result.rows[0].created_at,
          modifiedAt: result.rows[0].modified_at,
        },
        success: true,
      };
    }),

  // Search embeddings by text (DB/vector logic to be implemented by you)
  search: protectedProcedure
    .meta({ route: { path: "/embedding/search", summary: "Search embeddings by text query" } })
    .input(
      z.object({
        text: z.string().min(1, "Text is required"),
        // optional pagination / topK
        topK: z.number().int().positive().max(100).default(10).optional(),
        modelName: z.string().optional(),
      }),
    )
    .output(
      z.object({
        results: z.array(
          z.object({
            record: embeddingSchema,
            score: z.number(),
          }),
        ),
        success: z.boolean(),
      }),
    )
    .query(async ({ ctx , input }) => {
      // Intentionally no DB or vector search logic per instructions.
      void ctx;
      void input;

      throw new Error("Not implemented: add embedding search logic");
    }),
});

export type Embedding = z.infer<typeof embeddingSchema>;


