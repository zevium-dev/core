export * from "./cn";
export * from "./seo";
export * from "./time";
export * from "./titlecase";

export const dedupeArray = <T>(arr: Array<T>): Array<T> => {
  return Array.from(new Set(arr));
};
