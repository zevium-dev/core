/**
 * Unsupported public assurance/security claim detection.
 *
 * Policy is deliberately lexical. Zevium has no approval state for publisher
 * assurance claims, so normalized positive claims are rejected at every public
 * boundary. Bare framework names, evidence-analysis copy, and direct negative
 * disclaimers are allowed. Ambiguous copy must be rephrased by its publisher;
 * this code does not pretend to solve arbitrary natural-language entailment.
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
  hardBreaks: boolean[];
};

type FrameworkRule = {
  label: string;
  pattern: RegExp;
};

type DirectRule = {
  label: string;
  pattern: RegExp;
  allowDirectNegation?: boolean;
};

// Common Cyrillic, Greek, and small-cap homoglyphs. NFKD separately handles
// compatibility forms such as full-width and mathematical alphanumerics.
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
  δ: "d",
  ε: "e",
  η: "h",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  ϲ: "c",
  σ: "s",
  ς: "s",
  τ: "t",
  χ: "x",
  ᴀ: "a",
  ʙ: "b",
  ᴄ: "c",
  ᴅ: "d",
  ᴇ: "e",
  ꜰ: "f",
  ɢ: "g",
  ʜ: "h",
  ɪ: "i",
  ᴊ: "j",
  ᴋ: "k",
  ʟ: "l",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
};

// Punctuation and whitespace normalize to one separator, so dotted, dashed,
// underscored, zero-width, and multiline spellings share one policy path.
const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  {
    label: "SOC 2 claim",
    pattern: /\bs\s*o\s*c\s*2(?:\s*type\s*(?:i\s*i|i|1|2))?\b/gu,
  },
  {
    label: "HIPAA claim",
    pattern: /\bh\s*i\s*p\s*a\s*a\b/gu,
  },
  {
    label: "GDPR claim",
    pattern: /\bg\s*d\s*p\s*r\b/gu,
  },
  {
    label: "CCPA claim",
    pattern: /\bc\s*c\s*p\s*a\b/gu,
  },
  {
    label: "CPRA claim",
    pattern: /\bc\s*p\s*r\s*a\b/gu,
  },
  {
    label: "PCI DSS claim",
    pattern: /\bp\s*c\s*i\s*d\s*s\s*s\b/gu,
  },
  {
    label: "ISO 27001 claim",
    pattern: /\bi\s*s\s*o(?:\s*i\s*e\s*c)?\s*2\s*7\s*0\s*0\s*1\b/gu,
  },
];

const DIRECT_RULES: readonly DirectRule[] = [
  {
    label: "security-grade superlative",
    pattern:
      /\b(?:enterprise|bank|military)\s*grade\s+(?:platform|security|secure|encryption|protection)\b/gu,
    allowDirectNegation: true,
  },
  {
    label: "absolute security claim",
    pattern:
      /\b(?:(?:fully|completely|100\s*percent)\s+secure|secure\s+against\s+(?:all|any|every)\s+breach(?:es)?)\b/gu,
    allowDirectNegation: true,
  },
  {
    label: "absolute risk claim",
    pattern:
      /\b(?:zero\s+risk|breach\s*proof|hack\s*proof|unhack(?:able)|impossible\s+to\s+breach)\b/gu,
    allowDirectNegation: true,
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
    allowDirectNegation: true,
  },
];

const POSITIVE_ASSURANCE_WORDS = new Set([
  "aligned",
  "approved",
  "certified",
  "compliant",
  "conformant",
  "eligible",
  "ready",
]);

const RELATION_WORDS = new Set([
  "already",
  "are",
  "been",
  "currently",
  "formally",
  "fully",
  "has",
  "have",
  "is",
  "not",
  "now",
  "officially",
  "remains",
  "still",
  "was",
  "were",
]);

function normalizePublicClaimText(source: string): NormalizedText {
  const chars: string[] = [];
  const originalIndexes: number[] = [];
  const hardBreaks: boolean[] = [];

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
          hardBreaks.push(false);
        }
      } else if (/^[\p{Letter}\p{Number}]$/u.test(mapped)) {
        chars.push(mapped);
        originalIndexes.push(index);
        hardBreaks.push(false);
      } else {
        chars.push(" ");
        originalIndexes.push(index);
        hardBreaks.push(/[.!?,;:]/u.test(decomposed));
      }
    }
    index += width;
  }

  const collapsed: string[] = [];
  const collapsedIndexes: number[] = [];
  const collapsedHardBreaks: boolean[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index]!;
    if (
      character === " " &&
      (collapsed.length === 0 || collapsed[collapsed.length - 1] === " ")
    ) {
      if (collapsed.length > 0 && hardBreaks[index]) {
        collapsedHardBreaks[collapsedHardBreaks.length - 1] = true;
      }
      continue;
    }
    collapsed.push(character);
    collapsedIndexes.push(originalIndexes[index]!);
    collapsedHardBreaks.push(hardBreaks[index] ?? false);
  }

  return {
    text: collapsed.join(""),
    originalIndexes: collapsedIndexes,
    hardBreaks: collapsedHardBreaks,
  };
}

function countWord(source: string, word: string): number {
  return [...source.matchAll(new RegExp(`\\b${word}\\b`, "gu"))].length;
}

/**
 * Only syntactically local negation is trusted. Odd negation means a negative
 * disclaimer; even negation means a positive assertion. Remote words such as
 * "do not deny" and "no one doubts" cannot suppress the tripwire.
 */
function hasDirectOddNegation(
  normalized: NormalizedText,
  start: number,
  relation = "",
  relationRange?: readonly [start: number, end: number],
): boolean {
  const text = normalized.text;
  const beforeOffset = Math.max(0, start - 100);
  const before = text.slice(Math.max(0, start - 100), start).trimEnd();
  const words = [...before.matchAll(/\b[a-z0-9]+\b/gu)];
  let directNegations = "";
  let directStart = start;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const match = words[index]!;
    const word = match[0];
    if (!["no", "not", "never", "without"].includes(word)) break;
    directNegations = `${word} ${directNegations}`;
    directStart = beforeOffset + (match.index ?? 0);
  }
  const verbMatch = before.match(
    /(?:^| )(?:do|does|did|will|would|can|could|is|are|was|were|has|have)\s+((?:(?:not|never)\s+)+)(?:claim|represent|state|assert|advertise|offer|provide|support|use|have)$/u,
  );
  const verbNegations = verbMatch?.[1] ?? "";
  const suffix = directNegations === "" ? verbNegations : directNegations;
  const suffixStart =
    directNegations === ""
      ? beforeOffset + (verbMatch?.index ?? before.length)
      : directStart;
  if (
    suffix !== "" &&
    normalized.hardBreaks
      .slice(suffixStart, start)
      .some((hardBreak) => hardBreak)
  ) {
    return false;
  }
  if (
    relationRange !== undefined &&
    normalized.hardBreaks
      .slice(relationRange[0], relationRange[1])
      .some((hardBreak) => hardBreak)
  ) {
    return false;
  }
  const local = `${suffix} ${relation}`;
  const negations =
    countWord(local, "not") +
    countWord(local, "never") +
    countWord(local, "no") +
    countWord(local, "without");
  return negations % 2 === 1;
}

function assuranceAfterFramework(
  text: string,
  end: number,
): { end: number; relation: string } | null {
  const tail = text.slice(end, Math.min(text.length, end + 100));
  const words = [...tail.matchAll(/\b[a-z0-9]+\b/gu)].slice(0, 7);
  const relation: string[] = [];

  for (const word of words) {
    const value = word[0];
    if (POSITIVE_ASSURANCE_WORDS.has(value)) {
      return {
        end: end + (word.index ?? 0) + value.length,
        relation: relation.join(" "),
      };
    }
    if (!RELATION_WORDS.has(value)) break;
    relation.push(value);
  }

  // A certification/compliance noun alone can describe reports or an API's
  // subject. Block it only when surrounding syntax asserts achieved status.
  const achieved = tail.match(
    /^\s+(?:certification|compliance)\s+(?:(?:is|was|has|has\s+been)\s+)?(?:active|achieved|complete|completed|confirmed|current|guaranteed|issued|obtained|valid|not\s+pending)\b/u,
  );
  if (achieved !== null) {
    return { end: end + achieved[0].length, relation: "" };
  }

  return null;
}

function hasPositiveAssuranceVerbBefore(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 120), start).trimEnd();
  const assertion = before.match(
    /(?:^| )((?:(?:do|does|did|is|are|was|were|has|have)\s+)?(?:(?:not|never)\s+)*)((?:compliant|conformant|complies?|comply|conforms?|conform|meets?|satisfies|satisfy|aligns?|aligned|certified|approved|ready))(?:\s+(?:with|to|for))?$/u,
  );
  if (assertion === null) return false;
  const negations =
    countWord(assertion[1] ?? "", "not") +
    countWord(assertion[1] ?? "", "never");
  return negations % 2 === 0;
}

function addViolation(
  violations: PublicClaimViolation[],
  normalized: NormalizedText,
  label: string,
  start: number,
  end: number,
): void {
  violations.push({
    label,
    match: normalized.text.slice(start, end).trim(),
    index: normalized.originalIndexes[start] ?? 0,
  });
}

export function findPublicClaimViolations(
  source: string,
): PublicClaimViolation[] {
  const normalized = normalizePublicClaimText(source);
  const violations: PublicClaimViolation[] = [];

  for (const framework of FRAMEWORK_RULES) {
    for (const match of normalized.text.matchAll(framework.pattern)) {
      const start = match.index ?? 0;
      const frameworkEnd = start + match[0].length;
      const assurance = assuranceAfterFramework(normalized.text, frameworkEnd);
      if (assurance !== null) {
        if (
          !hasDirectOddNegation(normalized, start, assurance.relation, [
            frameworkEnd,
            assurance.end,
          ])
        ) {
          addViolation(
            violations,
            normalized,
            framework.label,
            start,
            assurance.end,
          );
        }
        continue;
      }
      if (hasPositiveAssuranceVerbBefore(normalized.text, start)) {
        addViolation(
          violations,
          normalized,
          framework.label,
          start,
          frameworkEnd,
        );
      }
    }
  }

  for (const rule of DIRECT_RULES) {
    for (const match of normalized.text.matchAll(rule.pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (
        rule.allowDirectNegation === true &&
        hasDirectOddNegation(normalized, start)
      ) {
        continue;
      }
      addViolation(violations, normalized, rule.label, start, end);
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

function extractRawJsonStrings(
  source: string,
): Array<{ value: string; index: number }> {
  const strings: Array<{ value: string; index: number }> = [];
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] !== '"') continue;
    const start = cursor;
    cursor += 1;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (source[cursor] !== '"') continue;
      const value: unknown = JSON.parse(source.slice(start, cursor + 1));
      if (typeof value !== "string") {
        throw new Error("Valid JSON string token did not decode to text");
      }
      strings.push({ value, index: start });
      break;
    }
  }
  return strings;
}

/**
 * Raw published specs are public. Scan every object key and every string value,
 * including technical fields, paths, examples, defaults, enums, and mock data.
 * No field-level allowlist can be safe while raw documents are downloadable.
 */
export function findOpenApiPublicClaimViolations(
  specText: string,
): OpenApiPublicClaimViolation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specText) as unknown;
  } catch {
    return [
      {
        label: "invalid OpenAPI JSON",
        match: "invalid JSON",
        index: 0,
        path: "$",
      },
    ];
  }

  const violations: OpenApiPublicClaimViolation[] = [];
  const scan = (source: string, path: string): void => {
    violations.push(
      ...findPublicClaimViolations(source).map((violation) => ({
        ...violation,
        path,
      })),
    );
  };
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      scan(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      scan(key, `${childPath} (key)`);
      visit(child, childPath);
    }
  };

  visit(parsed, "$");
  const represented = new Set(
    violations.map(({ label, match }) => `${label}\u0000${match}`),
  );
  for (const token of extractRawJsonStrings(specText)) {
    for (const violation of findPublicClaimViolations(token.value)) {
      const key = `${violation.label}\u0000${violation.match}`;
      if (represented.has(key)) continue;
      represented.add(key);
      violations.push({
        ...violation,
        index: token.index,
        path: "$ (raw JSON string)",
      });
    }
  }
  return violations;
}

export function isOpenApiPublicCopyAllowed(specText: string): boolean {
  return findOpenApiPublicClaimViolations(specText).length === 0;
}
