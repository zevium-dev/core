import { type } from "arktype";

const ServerEnvArk = type({});

export type ServerEnv = typeof ServerEnvArk.infer;

export const serverEnv = ServerEnvArk.assert({});
