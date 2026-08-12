import { test } from "vitest";

export { test as verify } from "vitest";

export let assignedVerify;
assignedVerify = test;

export const wrapped = { verify: test };
