export const solveCap = async (): Promise<string> => {
  const Cap = (await import("cap-widget")).default;
  const cap = new Cap({ apiEndpoint: "/api/cap/" });
  const { token } = await cap.solve();
  return token;
};
