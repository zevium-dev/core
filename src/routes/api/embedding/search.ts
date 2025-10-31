import { createFileRoute } from '@tanstack/react-router'
import { client } from '~/db';
import { serverEnv } from '~/env/server';
import { getEmbeddings, search_embeddings } from '~/lib/server/embeddings';
import { TRPCProvider } from '~/lib/trpc';

export const Route = createFileRoute('/api/embedding/search')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        console.log("GET");
        const input = await request.json() as { text: string, modelName?: string, topK?: number };
        const results = await search_embeddings({text: input.text, modelName: input.modelName ?? "Qwen/Qwen3-Embedding-8B", topK: input.topK ?? 3 });
        console.log("Results", results);
        return Response.json(results);
      },
    },
  },
});
