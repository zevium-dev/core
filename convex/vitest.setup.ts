// Deterministic test-only control-plane -> gateway transport key. Production
// must inject an independently generated keyring through Convex environment.
process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING = JSON.stringify({
  current: "test-v1",
  keys: { "test-v1": "42".repeat(32) },
});

// Deterministic test-only credential encryption keyring for
// upstream-credential and webhook-secret sealing. Production injects an
// independently generated keyring through Convex environment.
process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
  current: "test-v1",
  keys: { "test-v1": "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=" },
});
