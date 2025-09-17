import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "better-auth/client/plugins"
export const auth = createAuthClient({
    plugins: [apiKeyClient() ]
});
