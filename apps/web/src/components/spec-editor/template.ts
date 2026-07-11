export const OPENAPI_TEMPLATE = `{
  "openapi": "3.1.0",
  "info": {
    "title": "My API",
    "version": "0.1.0"
  },
  "servers": [
    {
      "url": "https://api.example.com"
    }
  ],
  "paths": {
    "/health": {
      "get": {
        "summary": "Health check",
        "x-zevium-cost": 1
      }
    }
  }
}
`;
