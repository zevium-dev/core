import { createFileRoute } from '@tanstack/react-router'
import { createProjectEmbedding } from '~/lib/server/embeddings';

  
export const Route = createFileRoute('/api/embedding/')({
  server: {
    handlers: {
    POST : async ({ request }) => {
      const input = await request.json() as { text: string; modelName?: string; projectId: string };

      const result = await createProjectEmbedding(input.projectId, input.text, input.modelName);
      return Response.json(result);
    },
  },
},
});
