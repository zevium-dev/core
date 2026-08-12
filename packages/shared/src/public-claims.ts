/**
 * Unsupported public assurance/security claim detection.
 *
 * Policy: publisher-controlled public copy is rejected automatically. Zevium
 * has no human-review approval state, so callers must fail closed instead of
 * recording a fictional review. Narrow implementation facts and explicit
 * negative/absence statements remain allowed.
 */

export type PublicClaimViolation = {
  label: string;
  match: string;
  index: number;
};

export type OpenApiPublicClaimViolation = PublicClaimViolation & {
  path: string;
};

type NormalizedText = {
  text: string;
  originalIndexes: number[];
};

type ClaimRule = {
  label: string;
  pattern: RegExp;
  allowNegativeContext?: boolean;
};

// Common Cyrillic/Greek homoglyphs used to evade Latin policy terms. NFKD
// below handles compatibility forms such as full-width and mathematical text.
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  с: "c",
  е: "e",
  н: "h",
  і: "i",
  ј: "j",
  к: "k",
  м: "m",
  о: "o",
  р: "p",
  ѕ: "s",
  т: "t",
  х: "x",
  у: "y",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  σ: "s",
  ς: "s",
  τ: "t",
  χ: "x",
};

const CLAIM_RULES: readonly ClaimRule[] = [
  {
    label: "SOC 2 claim",
    pattern: /\b(?:soc|s o c)\s*2(?:\s*type\s*(?:i{1,2}|1|2))?\b/gu,
    allowNegativeContext: true,
  },
  {
    label: "HIPAA claim",
    pattern:
      /\b(?:hipaa|h i p a a)\s*(?:compliant|compliance|certified|eligible|ready)\b/gu,
  },
  {
    label: "privacy-law compliance claim",
    pattern:
      /\b(?:(?:gdpr|ccpa|cpra)\s*(?:aligned|approved|certified|compliance|compliant|ready)|(?:meets?|satisfy|satisfies|complies)\s+(?:with\s+)?(?:all\s+)?(?:gdpr|ccpa|cpra)(?:\s+(?:requirements?|standards?))?)\b/gu,
  },
  {
    label: "PCI claim",
    pattern: /\b(?:pci|p c i)\s*(?:dss|d s s)\b/gu,
    allowNegativeContext: true,
  },
  {
    label: "ISO 27001 claim",
    pattern:
      /\biso\s*(?:iec\s*)?27001\s*(?:aligned|approved|certified|compliance|compliant|ready)\b/gu,
  },
  {
    label: "security-grade superlative",
    pattern:
      /\b(?:enterprise|bank|military)\s*grade\s+(?:platform|security|secure|encryption|protection)\b/gu,
  },
  {
    label: "absolute security claim",
    pattern:
      /\b(?:(?:fully|completely|100\s*percent)\s+secure|secure\s+against\s+(?:all|any|every)\s+breach(?:es)?)\b/gu,
  },
  {
    label: "absolute risk claim",
    pattern:
      /\b(?:zero\s+risk|breach\s*proof|hack\s*proof|unhackable|impossible\s+to\s+breach)\b/gu,
  },
  {
    label: "absolute privacy claim",
    pattern:
      /\b(?:(?:we\s+)?(?:never|do\s+not|don\s+t)\s+(?:collect|retain|share|store)\s+(?:any\s+|your\s+)?(?:data|personal\s+(?:data|information))|no\s+(?:personal\s+)?data\s+(?:is\s+)?(?:collected|retained|shared|stored)|zero\s+data\s+retention|we\s+store\s+none\s+of\s+your\s+data)\b/gu,
  },
  {
    label: "broad encryption claim",
    pattern:
      /\b(?:end\s*to\s*end\s+encrypt(?:ed|ion)|(?:all|customer|your)\s+(?:data|information)\s+(?:is|are)\s+encrypted\s+at\s+rest|(?:all\s+)?(?:data|information)\s+is\s+always\s+encrypted)\b/gu,
  },
];

function normalizePublicClaimText(source: string): NormalizedText {
  const chars: string[] = [];
  const originalIndexes: number[] = [];

  for (let index = 0; index < source.length;) {
    const point = source.codePointAt(index);
    if (point === undefined) break;
    const raw = String.fromCodePoint(point);
    const width = raw.length;

    for (const decomposed of raw.normalize("NFKD")) {
      if (/\p{Mark}|\p{Format}/u.test(decomposed)) continue;
      const lower = decomposed.toLowerCase();
      const mapped = CONFUSABLES[lower] ?? lower;
      if (mapped === "%") {
        for (const character of " percent ") {
          chars.push(character);
          originalIndexes.push(index);
        }
      } else if (/[\p{Letter}\p{Number}]/u.test(mapped)) {
        chars.push(mapped);
        originalIndexes.push(index);
      } else {
        chars.push(" ");
        originalIndexes.push(index);
      }
    }
    index += width;
  }

  const collapsed: string[] = [];
  const collapsedIndexes: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index]!;
    if (
      character === " " &&
      (collapsed.length === 0 || collapsed[collapsed.length - 1] === " ")
    ) {
      continue;
    }
    collapsed.push(character);
    collapsedIndexes.push(originalIndexes[index]!);
  }

  return { text: collapsed.join(""), originalIndexes: collapsedIndexes };
}

function hasNegativeContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 90), start);
  const after = text.slice(end, Math.min(text.length, end + 90));
  const negativeBefore =
    /(?:^|\s)(?:no|not|without|lack|lacks|lacking|never|cannot|can t|do not|does not|has no|have no)\s+(?:\w+\s+){0,6}$/u;
  const negativeAfter =
    /^(?:\s+\w+){0,6}\s+(?:absent|unavailable|missing|not|prohibited|forbidden|unsupported|unissued)\b/u;
  return negativeBefore.test(before) || negativeAfter.test(after);
}

export function findPublicClaimViolations(
  source: string,
): PublicClaimViolation[] {
  const normalized = normalizePublicClaimText(source);
  const violations: PublicClaimViolation[] = [];

  for (const rule of CLAIM_RULES) {
    for (const match of normalized.text.matchAll(rule.pattern)) {
      const normalizedIndex = match.index ?? 0;
      const normalizedEnd = normalizedIndex + match[0].length;
      if (
        rule.allowNegativeContext === true &&
        hasNegativeContext(normalized.text, normalizedIndex, normalizedEnd)
      ) {
        continue;
      }
      violations.push({
        label: rule.label,
        match: match[0],
        index: normalized.originalIndexes[normalizedIndex] ?? 0,
      });
    }
  }

  return violations.sort((a, b) => a.index - b.index);
}

export function isPublicCopyAllowed(source: string): boolean {
  return findPublicClaimViolations(source).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OPENAPI_COPY_KEYS = new Set(["title", "summary", "description"]);

/**
 * Scan OpenAPI fields that become catalogue, generated docs, discovery, mock,
 * or MCP copy. URLs, operation IDs, property names, and example payload values
 * are not marketing copy and are intentionally excluded.
 */
export function findOpenApiPublicClaimViolations(
  specText: string,
): OpenApiPublicClaimViolation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specText) as unknown;
  } catch {
    return [];
  }

  const violations: OpenApiPublicClaimViolation[] = [];
  const visit = (
    value: unknown,
    path: string,
    key: string | undefined,
  ): void => {
    if (typeof value === "string") {
      const topLevelTagName =
        key === "name" && /^\$\.tags\[\d+\]\.name$/u.test(path);
      if (
        key !== undefined &&
        (OPENAPI_COPY_KEYS.has(key) || topLevelTagName)
      ) {
        violations.push(
          ...findPublicClaimViolations(value).map((violation) => ({
            ...violation,
            path,
          })),
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      if (key === "tags") {
        value.forEach((item, index) => {
          if (typeof item === "string") {
            violations.push(
              ...findPublicClaimViolations(item).map((violation) => ({
                ...violation,
                path: `${path}[${index}]`,
              })),
            );
          } else {
            visit(item, `${path}[${index}]`, key);
          }
        });
        return;
      }
      value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
      return;
    }
    if (!isRecord(value)) return;
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, `${path}.${childKey}`, childKey);
    }
  };

  visit(parsed, "$", undefined);
  return violations;
}

export function isOpenApiPublicCopyAllowed(specText: string): boolean {
  return findOpenApiPublicClaimViolations(specText).length === 0;
}
