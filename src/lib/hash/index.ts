export const hashString = async (input: string): Promise<string> => {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
};
