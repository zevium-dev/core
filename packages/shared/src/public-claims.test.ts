import { describe, expect, it } from "vitest";
import {
  findOpenApiPublicClaimViolations,
  findPublicClaimViolations,
  isPublicCopyAllowed,
} from "./public-claims.js";

const ADVERSARIAL_CLAIMS = [
  "SOC.2 certified",
  "S.O.C. 2",
  "SOC_2",
  "SOC‑2",
  "SOC​2",
  "HIPAA\nready",
  "H.I.P.A.A. ready",
  "GDPR\ncompliant",
  "GDPR: compliant",
  "complies with GDPR",
  "ISO/IEC 27001 certified",
  "P.C.I. DSS",
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
];

describe("public claim policy", () => {
  it.each(ADVERSARIAL_CLAIMS)("rejects adversarial form: %s", (claim) => {
    expect(findPublicClaimViolations(claim)).not.toEqual([]);
  });

  it("normalizes compatibility characters and Cyrillic/Greek homoglyphs", () => {
    expect(isPublicCopyAllowed("ＳＯＣ２ certified")).toBe(false);
    expect(isPublicCopyAllowed("ЅΟС​2 certified")).toBe(false);
  });

  it("allows narrow controls, negative statements, and technical phrases", () => {
    for (const copy of [
      "AES-GCM encrypts publisher credential values before new writes.",
      "Gateway strips consumer authorization before upstream forwarding.",
      "We do not have a SOC 2 report.",
      "PCI DSS is not claimed or approved.",
      "HIPAA use is prohibited.",
      "GDPR applicability requires counsel review.",
      "Encryption at rest applies only to publisher credential values.",
    ]) {
      expect(findPublicClaimViolations(copy), copy).toEqual([]);
    }
  });

  it("scans OpenAPI-derived public copy but not technical keys or examples", () => {
    const spec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Weather API", description: "SOC​2 certified" },
      tags: [
        {
          name: "SOC_2",
          description: "forecast data",
        },
      ],
      paths: {
        "/reports": {
          get: {
            operationId: "get_soc2_report",
            summary: "fully-secure results",
            tags: ["bank-grade encryption"],
            responses: {
              200: {
                content: {
                  "application/json": {
                    example: { status: "SOC2" },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      findOpenApiPublicClaimViolations(spec).map(({ path }) => path),
    ).toEqual(
      expect.arrayContaining([
        "$.info.description",
        "$.tags[0].name",
        "$.paths./reports.get.summary",
        "$.paths./reports.get.tags[0]",
      ]),
    );
    expect(findOpenApiPublicClaimViolations(spec)).toHaveLength(4);
  });
});
