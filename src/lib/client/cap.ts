import type { Cap as CapType } from "cap-widget";

export const solveCap = async (): Promise<string> => {
  const Cap = (await import("cap-widget")).default as typeof CapType;
  const cap = new Cap({ apiEndpoint: "/api/cap/" });
  const { token } = await cap.solve();
  return token;
};
