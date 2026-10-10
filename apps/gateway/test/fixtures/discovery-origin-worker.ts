import worker, { __setTestPipelineDeps } from "../../src/index";
import { FixtureCatalogueSource } from "../../src/catalogue-source";
import { FixtureKeyVerifier } from "../../src/key-verifier";
import { FixtureSpecSource } from "../../src/spec-source";

export { WalletDO } from "../../src/index";

const specs = new FixtureSpecSource();
specs.set("test-publisher", "test-api", {
  specVersionId: "test-version",
  projectId: "test-project",
  organizationId: "test-org",
  clerkOrgId: "test-clerk-org",
  version: "1.0.0",
  visibility: "public",
  spec: JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Origin test", version: "1.0.0" },
    servers: [{ url: "https://upstream.invalid" }],
    paths: { "/ping": { get: { "x-zevium-cost": 1 } } },
  }),
});
__setTestPipelineDeps({
  keyVerifier: new FixtureKeyVerifier(),
  specSource: specs,
  publicSpecSource: specs,
  catalogueSource: new FixtureCatalogueSource([
    {
      name: "Origin test",
      slug: "test-api",
      publisherHandle: "test-publisher",
      orgName: "Test publisher",
      description: undefined,
      tags: [],
      publishedAt: 1,
    },
  ]),
});

export default worker;
