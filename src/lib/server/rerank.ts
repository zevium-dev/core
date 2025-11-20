import { serverEnv } from "~/env/server";

export async function rerankWithCohere({
  query,
  documents,
  topN,
}: {
  query: string;
  documents: string[];
  topN: number;
}) {
  const apiKey = serverEnv.COHERE_API_KEY;
  if (!apiKey) return null;

  const res = await fetch("https://api.cohere.com/v1/rerank", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
      body: JSON.stringify({
        query,
        documents,
        top_n: topN,
        model: "rerank-v3.5",
      }),
  });

  if (!res.ok) {
    throw new Error(`Cohere rerank failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    results: Array<{ index: number; relevance_score: number }>;
  };
  return data.results;
}
