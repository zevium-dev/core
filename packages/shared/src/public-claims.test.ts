import { describe, expect, it } from "vitest";
import {
  findOpenApiPublicClaimViolations,
  findPublicClaimViolations,
  isOpenApiPublicCopyAllowed,
  isPublicCopyAllowed,
  isPublicCopySetAllowed,
} from "./public-claims.js";

const REPRODUCED_UNSUPPORTED_ASSURANCE_COPY = [
  "We obtained SOC 2 certification",
  "We hold SOC 2 certification",
  "We have SOC 2 compliance",
  "SOC 2 certification passed",
  "HIPAA compliance verified",
  "GDPR compliance validated",
  "All GDPR requirements are satisfied",
  "ISO 27001 accredited",
  "SOC 2 audited",
  "SOC 2 attestation complete",
  "Our SOC 2 examination passed",
  "HIPAA assured",
  "HIPAA safeguards guaranteed",
  "GDPR lawful",
  "GDPR requirements implemented",
  "We meet every requirement of GDPR",
  "GDPR audit passed",
  "Certified by an independent auditor under SOC 2",
  "Independent auditors verified our SOC 2 controls",
  "CCPA obligations satisfied",
  "We completed SOC 2 certification",
  "Certification under SOC 2 was obtained",
  "The HIPAA audit succeeded",
  "GDPR requirements were fulfilled",
  "Certification under SOC 2 is not pending",
] as const;

const HOSTILE_REPORT_BLOCKED_COPY = [
  "PCI compliant",
  "This API is certified",
  "Certified API",
  "Compliant service",
  "API certification",
  "Certification API",
  "Compliance guaranteed",
  "Indisputably compliant",
  "\u202eAAPIH\u202c compliant",
  "H1PAA compliant",
  "🅷IPAA compliant",
  "HʹIPAA compliant",
  "HIPAA may be compliant",
  "HIPAA indisputable compliance",
  "GDPR compliance guarantee",
  "HIPAA evidence API compliant",
  "risk-free",
  "no security risk",
  "riskless",
  "zero risks",
  "0 risk",
  "zero security risk",
] as const;

const BLOCKED_COPY = [
  ...REPRODUCED_UNSUPPORTED_ASSURANCE_COPY,
  ...HOSTILE_REPORT_BLOCKED_COPY,
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
  "This service cannot be HIPAA compliant",
  "This API is not certified",
  "This product can't be zero risk",
  "This product can’t be zero risk",
  "We have not yet obtained SOC 2 certification",
  "Certification evidence analysis API",
  "No end-to-end encryption",
  "We do not offer end-to-end encryption",
  "This product is not fully secure",
  "AES-GCM encrypts publisher credential values before new writes",
  "Gateway strips consumer authorization before upstream forwarding",
  "const api = getClient(); const verified = result.ok;",
  "Provider receives options passed by caller",
  "Run check:compliance-claims in CI",
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

  it("rejects one ASCII edit and modifier insertion across protected framework names", () => {
    const frameworks = ["hipaa", "gdpr", "ccpa", "cpra", "soc2", "iso27001"];

    for (const framework of frameworks) {
      for (let index = 0; index < framework.length; index += 1) {
        const replacement = framework[index] === "x" ? "q" : "x";
        const substituted = `${framework.slice(0, index)}${replacement}${framework.slice(index + 1)}`;
        const deleted = `${framework.slice(0, index)}${framework.slice(index + 1)}`;
        expect(
          isPublicCopyAllowed(`${substituted} compliant`),
          substituted,
        ).toBe(false);
        expect(
          isPublicCopyAllowed(`${deleted} compliant`),
          deleted,
        ).toBe(deleted === "cpa");
      }
      for (let index = 0; index <= framework.length; index += 1) {
        const inserted = `${framework.slice(0, index)}x${framework.slice(index)}`;
        const modifierSplit = `${framework.slice(0, index)}ʹ${framework.slice(index)}`;
        expect(isPublicCopyAllowed(`${inserted} compliant`), inserted).toBe(
          false,
        );
        expect(
          isPublicCopyAllowed(`${modifierSplit} compliant`),
          modifierSplit,
        ).toBe(false);
      }
    }
    expect(isPublicCopyAllowed("PCl compliant")).toBe(false);
  });

  it("does not classify ordinary words as PCI, CCPA, or CPRA", () => {
    for (const copy of ["phi compliant", "CPA compliant", "CC4 certified"]) {
      expect(isPublicCopyAllowed(copy), copy).toBe(true);
    }
  });

  it("rejects bidirectional controls independently of rendered claim order", () => {
    const controls = [
      "\u061c",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202e",
      "\u2066",
      "\u2069",
    ];
    for (const control of controls) {
      expect(isPublicCopyAllowed(`safe${control}copy`), control).toBe(false);
    }
  });

  it("rejects multiple mapped homoglyphs without broad multilingual matches", () => {
    expect(isPublicCopyAllowed("ΗΙΡΑΑ compliant")).toBe(false);
    expect(isPublicCopyAllowed("日本語の説明")).toBe(true);
    expect(isPublicCopyAllowed("ЖЖЗЗЗ")).toBe(true);
  });

  it("rejects cross-field composition without sharing negation", () => {
    expect(isPublicCopySetAllowed(["HIPAA", "compliant"])).toBe(false);
    expect(isPublicCopySetAllowed(["not HIPAA", "ready"])).toBe(false);
    expect(
      isPublicCopySetAllowed(["SOC 2 report analysis API", "Demo API"]),
    ).toBe(true);
    expect(isPublicCopySetAllowed(["Demo API", "not", "HIPAA compliant"])).toBe(
      false,
    );
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
    expect(isPublicCopyAllowed("HIPAA evidence API compliant")).toBe(false);
    expect(isPublicCopyAllowed("HIPAA compliance evidence classifier")).toBe(
      true,
    );
  });

  it("rejects assurance possession, achievement, audit, and control-result variations", () => {
    const frameworks = ["SOC 2", "HIPAA", "GDPR", "CCPA", "ISO 27001"];
    const possessionVerbs = [
      "achieved",
      "earned",
      "have",
      "hold",
      "obtained",
      "received",
    ];
    const assuranceNouns = [
      "audit",
      "certification",
      "compliance",
      "controls",
      "report",
      "requirements",
    ];
    const achievedStatuses = [
      "accredited",
      "audited",
      "implemented",
      "passed",
      "satisfied",
      "validated",
      "verified",
    ];

    for (const framework of frameworks) {
      for (const verb of possessionVerbs) {
        for (const noun of assuranceNouns) {
          const copy = `We ${verb} ${framework} ${noun}`;
          expect(isPublicCopyAllowed(copy), copy).toBe(false);
        }
      }
      for (const noun of assuranceNouns) {
        for (const status of achievedStatuses) {
          const copy = `${framework} ${noun} is ${status}`;
          expect(isPublicCopyAllowed(copy), copy).toBe(false);
        }
      }
    }
  });

  it("preserves narrow direct negatives and evidence-analysis forms for assurance nouns", () => {
    const allowed = [
      "We did not obtain SOC 2 certification",
      "We do not hold SOC 2 certification",
      "We have no SOC 2 compliance",
      "We hold no SOC 2 certification",
      "We have no compliance with GDPR",
      "SOC 2 audit did not pass",
      "SOC 2 certification is not verified",
      "Certification under SOC 2 was not obtained",
      "Certification under SOC 2 is pending",
      "PCI DSS audit is pending",
      "SOC 2 audit evidence analysis API",
      "HIPAA safeguards documentation classifier",
      "GDPR requirements evidence search",
    ];

    for (const copy of allowed) {
      expect(isPublicCopyAllowed(copy), copy).toBe(true);
    }
  });

  it("normalizes punctuation and homoglyphs in new assurance grammar", () => {
    const blocked = [
      "We o.b.t.a.i.n.e.d SOC 2 c.e.r.t.i.f.i.c.a.t.i.o.n",
      "HIPAA compliance v.e.r.i.f.i.e.d",
      "GDPR r.e.q.u.i.r.e.m.e.n.t.s satisfied",
      "ISO 27001 accredіted",
    ];

    for (const copy of blocked) {
      expect(isPublicCopyAllowed(copy), copy).toBe(false);
    }
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

  it("rejects cross-field and escaped-bidi OpenAPI compositions", () => {
    const split = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "HIPAA", description: "compliant", version: "1.0.0" },
      paths: {},
    });
    expect(findOpenApiPublicClaimViolations(split)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "HIPAA claim",
          path: "$ (cross-field raw JSON strings)",
        }),
      ]),
    );

    const bidi = String.raw`{"openapi":"3.1.0","info":{"title":"\u202eAAPIH\u202c compliant","version":"1.0.0"},"paths":{}}`;
    expect(isOpenApiPublicCopyAllowed(bidi)).toBe(false);
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
    ...REPRODUCED_UNSUPPORTED_ASSURANCE_COPY,
    ...HOSTILE_REPORT_BLOCKED_COPY,
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
