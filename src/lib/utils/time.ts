export const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const formatDate = (date: Date | number | string): string => {
  const d = new Date(date);
  return d.toUTCString().replace(/GMT$/, "UTC");
};
