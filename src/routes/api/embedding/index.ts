import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { client } from '~/db';
import { serverEnv } from '~/env/server';
import { getEmbeddings } from '~/lib/server/embeddings';
import { TRPCProvider } from '~/lib/trpc';


  
export const Route = createFileRoute('/api/embedding/')({
  server: {
    handlers: {
    POST : async ({ request }) => {
      const input = await request.json() as { text: string, modelName?: string };

      // Intentionally no DB or external call logic per instructions.
      // You can implement calling the embedding provider and persistence here.
      console.log("Entry")
      console.log(input);

      const embedding = await getEmbeddings({ input: input.text, model: input.modelName ?? "Qwen/Qwen3-Embedding-8B" })
      console.log("Embedding")
      console.log(embedding);
      console.log(embedding.length);
      //const embedding = await client.execute(sql`INSERT INTO embedding (text, embedding, model_name) VALUES (${input.text}, ${input.embedding}, ${input.modelName})`);
      const statement = "INSERT INTO project_embeddings (id,text,embedding,model,created_at,updated_at) VALUES (?,?,vector32(?),?,?,?)";

      const result = await client.execute(statement, [crypto.randomUUID().toString(), input.text, JSON.stringify(embedding), input.modelName ?? "default", new Date(), new Date()]);

      return Response.json(result);
    },
  },
},
});
