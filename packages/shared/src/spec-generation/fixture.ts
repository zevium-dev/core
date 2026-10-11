/** Representative immutable contract used by shared and CLI golden tests. */
export const representativeSpec = {
  openapi: "3.1.0",
  info: { title: "Pet service", version: "publisher-label" },
  servers: [{ url: "https://private-upstream.invalid" }],
  components: {
    parameters: {
      limit: {
        name: "limit",
        in: "query",
        schema: { type: "integer", default: 10, minimum: 1 },
      },
    },
    schemas: {
      "Pet/Name": { type: "string", enum: ["cat", "dog"] },
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          name: { $ref: "#/components/schemas/Pet~1Name" },
          kind: { oneOf: [{ const: "young" }, { const: "old" }] },
          size: { type: ["integer", "null"], minimum: 0 },
        },
      },
    },
  },
  paths: {
    "/pets/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/limit" },
      ],
      get: {
        operationId: "getPet",
        summary: "Read pet",
        "x-zevium-cost": 3,
        "x-zevium-free-tier": 2,
        responses: {
          "200": {
            description: "Pet found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 5 },
          },
          {
            name: "tags",
            in: "query",
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "x-region",
            in: "header",
            schema: { type: "string", enum: ["eu", "us"] },
          },
        ],
      },
      post: {
        operationId: "getPet",
        summary: "Replace pet",
        "x-zevium-cost": 0,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
      },
    },
    "/hidden": {
      get: {
        summary: "HIDDEN_SENTINEL",
        requestBody: { $ref: "https://never-fetch.invalid" },
      },
    },
    "/ping": { get: { "x-zevium-cost": 0 } },
  },
};
