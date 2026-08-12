import { describe, expect, it } from "vitest";
import {
  findOpenApiPublicClaimViolations,
  findPublicClaimViolations,
  isOpenApiPublicCopyAllowed,
  isPublicCopyAllowed,
} from "./public-claims.js";

const BLOCKED_COPY = [
  "SOC.2 certified",
  "S.O.C. 2 certified",
  "SOC_2 Type II certified",
  "SOC‑2 approved",
  "SOC​2 ready",
  "HIPAA\nready",
  "H.I.P.A.A. compliant",
  "GDPR\ncompliant",
  "G.D.P.R: compliant",
  "G D P R compliant",
  "complies with GDPR",
  "We are compliant with GDPR",
  "Certified for HIPAA",
  "C.C.P.A compliant",
  "C C P A compliant",
  "CPRA aligned",
  "I.S.O/IEC 27001 certified",
  "I S O 27001 certified",
  "P.C.I. D.S.S approved",
  "ΗΙΡΑΑ compliant",
  "ɢ.ᴅ.ᴘ.ʀ compliant",
  "HıPAA ready",
  "ԌDPR compliant",
  "НІРАА compliant",
  "GDРR compliant",
  "We guarantee GDPR compliance",
  "We guarantee compliance with GDPR",
  "HIPAA indisputably compliant",
  "GDPR compliance is indisputably valid",
  "not not HIPAA compliant",
  "We do not deny that we are SOC 2 certified",
  "No one doubts we are SOC 2 certified",
  "SOC 2 certification is not pending",
  "Not. HIPAA compliant",
  "SOC 2 is not. certified",
  "We do not claim. GDPR compliant",
  "enterprise-grade platform",
  "bank grade encryption",
  "fully-secure",
  "zero-risk",
  "secure against every breach",
  "zero data retention",
  "we store none of your data",
  "all information is encrypted at rest",
  "data is always encrypted",
  "end-to-end encryption",
] as const;

const ALLOWED_COPY = [
  "SOC 2 report analysis API",
  "Analyzes PCI DSS reports and supporting documentation",
  "HIPAA compliance evidence classifier",
  "GDPR applicability requires counsel review",
  "ISO 27001 documentation search",
  "We are not HIPAA compliant",
  "Not GDPR compliant",
  "Not G.D.P.R compliant",
  "This service is not ISO 27001 certified",
  "This service does not comply with CCPA",
  "This service is not compliant with GDPR",
  "This service is not certified for HIPAA",
  "We do not claim HIPAA compliance",
  "We cannot claim HIPAA compliant",
  "We can't claim HIPAA compliant",
  "We can’t claim HIPAA compliant",
  "We aren't HIPAA compliant",
  "We aren’t HIPAA compliant",
  "HIPAA isn't compliant",
  "HIPAA isn’t compliant",
  "We cannot guarantee GDPR compliance",
  "We don’t guarantee GDPR compliance",
  "This service cannot comply with GDPR",
  "This service can’t comply with GDPR",
  "PCI DSS certification is pending",
  "No end-to-end encryption",
  "We do not offer end-to-end encryption",
  "This product is not fully secure",
  "AES-GCM encrypts publisher credential values before new writes",
  "Gateway strips consumer authorization before upstream forwarding",
] as const;

describe("public claim policy", () => {
  it.each(BLOCKED_COPY)("rejects normalized positive claim: %s", (copy) => {
    expect(findPublicClaimViolations(copy)).not.toEqual([]);
  });

  it.each(ALLOWED_COPY)(
    "allows evidence copy or direct disclaimer: %s",
    (copy) => {
      expect(findPublicClaimViolations(copy)).toEqual([]);
    },
  );

  it("keeps remote and double negation from changing positive semantics", () => {
    expect(isPublicCopyAllowed("We are not not HIPAA compliant")).toBe(false);
    expect(
      isPublicCopyAllowed("We do not deny that this complies with GDPR"),
    ).toBe(false);
    expect(isPublicCopyAllowed("No one doubts it is SOC 2 certified")).toBe(
      false,
    );
    expect(isPublicCopyAllowed("We cannot not claim HIPAA compliant")).toBe(
      false,
    );
  });

  it("fails closed for every one-code-point Unicode substitution in protected terms", () => {
    const unicodeLetters = ["ı", "Ԍ", "Н", "І", "Р", "А", "Α", "Ρ"];
    const protectedTerms = [
      ["HIPAA", " ready"],
      ["GDPR", " compliant"],
      ["compliant", " with GDPR"],
      ["certified", " for HIPAA"],
    ] as const;

    for (const [term, suffix] of protectedTerms) {
      for (let index = 0; index < term.length; index += 1) {
        for (const substitution of unicodeLetters) {
          const copy = `${term.slice(0, index)}${substitution}${term.slice(index + 1)}${suffix}`;
          expect(isPublicCopyAllowed(copy), copy).toBe(false);
        }
      }
    }
  });

  it("folds compatibility text and punctuation at every protected-word seam", () => {
    const separators = [".", "-", "_", "/", "\u200b", "\n"];
    for (const separator of separators) {
      expect(
        isPublicCopyAllowed(
          `H${separator}I${separator}P${separator}A${separator}A compliant`,
        ),
        separator,
      ).toBe(false);
      expect(
        isPublicCopyAllowed(
          `HIPAA c${separator}o${separator}m${separator}p${separator}l${separator}i${separator}a${separator}n${separator}t`,
        ),
        separator,
      ).toBe(false);
    }
    expect(isPublicCopyAllowed("ＨＩＰＡＡ compliant")).toBe(false);
    expect(isPublicCopyAllowed("HÍPAA compliant")).toBe(false);
  });

  it("uses bounded syntax for arbitrary adverbs without treating prose as NLP", () => {
    expect(isPublicCopyAllowed("HIPAA demonstrably compliant")).toBe(false);
    expect(isPublicCopyAllowed("HIPAA cryptographically compliant")).toBe(
      false,
    );
    expect(isPublicCopyAllowed("HIPAA evidence API compliant")).toBe(true);
    expect(isPublicCopyAllowed("HIPAA compliance evidence classifier")).toBe(
      true,
    );
  });

  it("fails closed when OpenAPI JSON is malformed", () => {
    expect(isOpenApiPublicCopyAllowed("{not-json")).toBe(false);
    expect(findOpenApiPublicClaimViolations("{not-json")).toEqual([
      {
        label: "invalid OpenAPI JSON",
        match: "invalid JSON",
        index: 0,
        path: "$",
      },
    ]);
  });

  it("scans shadowed duplicate-key strings and decoded escapes in raw JSON", () => {
    const spec = String.raw`{"openapi":"3.1.0","info":{"description":"H\u0049PAA ready","description":"safe","version":"1.0.0"},"paths":{}}`;
    expect(findOpenApiPublicClaimViolations(spec)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "HIPAA claim",
          path: "$ (raw JSON string)",
        }),
      ]),
    );
  });

  it("scans every publisher string in raw public OpenAPI", () => {
    const claim = "SOC.2 certified";
    const spec = JSON.stringify({
      openapi: "3.1.0",
      info: {
        title: "Reports API",
        version: claim,
        description: `Nested\n${claim}`,
      },
      tags: [{ name: claim, description: claim }],
      externalDocs: { description: claim },
      paths: {
        "/SOC.2-certified": {
          parameters: [
            {
              name: claim,
              in: "query",
              description: claim,
              example: claim,
              schema: {
                title: claim,
                default: claim,
                enum: [claim],
                const: claim,
                pattern: claim,
                examples: [claim],
              },
            },
          ],
          get: {
            operationId: "HIPAA_ready",
            summary: claim,
            description: claim,
            tags: [claim],
            responses: {
              200: {
                description: claim,
                content: {
                  "application/json": {
                    example: { nested: { body: claim } },
                  },
                },
              },
            },
          },
        },
      },
    });

    const paths = findOpenApiPublicClaimViolations(spec).map(
      (violation) => violation.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "$.info.version",
        "$.info.description",
        "$.tags[0].name",
        "$.tags[0].description",
        "$.externalDocs.description",
        "$.paths./SOC.2-certified (key)",
        "$.paths./SOC.2-certified.parameters[0].name",
        "$.paths./SOC.2-certified.parameters[0].description",
        "$.paths./SOC.2-certified.parameters[0].example",
        "$.paths./SOC.2-certified.parameters[0].schema.title",
        "$.paths./SOC.2-certified.parameters[0].schema.default",
        "$.paths./SOC.2-certified.parameters[0].schema.enum[0]",
        "$.paths./SOC.2-certified.parameters[0].schema.const",
        "$.paths./SOC.2-certified.parameters[0].schema.pattern",
        "$.paths./SOC.2-certified.parameters[0].schema.examples[0]",
        "$.paths./SOC.2-certified.get.operationId",
        "$.paths./SOC.2-certified.get.summary",
        "$.paths./SOC.2-certified.get.description",
        "$.paths./SOC.2-certified.get.tags[0]",
        "$.paths./SOC.2-certified.get.responses.200.description",
        "$.paths./SOC.2-certified.get.responses.200.content.application/json.example.nested.body",
      ]),
    );
  });

  it.each([
    "We guarantee GDPR compliance",
    "HIPAA indisputably compliant",
    "HıPAA ready",
    "ԌDPR compliant",
  ])(
    "rejects adversarial copy in OpenAPI values and object keys: %s",
    (claim) => {
      const pathKey = `/${claim}`;
      const spec = JSON.stringify({
        openapi: "3.1.0",
        info: {
          title: "Boundary probe",
          version: "1.0.0",
          description: claim,
        },
        paths: {
          [pathKey]: {
            get: {
              responses: { 200: { description: "ok" } },
            },
          },
        },
      });

      expect(findOpenApiPublicClaimViolations(spec)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.info.description" }),
          expect.objectContaining({ path: `$.paths.${pathKey} (key)` }),
        ]),
      );
    },
  );
});
