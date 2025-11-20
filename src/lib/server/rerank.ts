import { serverEnv } from "~/env/server";

export const RERANK_MODEL = "rerank-v3.5";

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
  if (!apiKey) {
    return null;
  }

  const res = await fetch("https://api.cohere.com/v1/rerank", {
    body: JSON.stringify({
      documents,
      model: RERANK_MODEL,
      query,
      top_n: topN,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!res.ok) {
    throw new Error(`Cohere rerank failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    results: Array<{ index: number; relevance_score: number }>;
  };
  return data.results;
}
