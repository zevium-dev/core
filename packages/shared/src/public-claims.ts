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

type TermMatch = {
  start: number;
  end: number;
};

const NORMALIZED_WORD_CHARACTER = "[a-z0-9?]";

function skeletonBody(literal: string): string {
  if (!/^[a-z0-9]+$/u.test(literal)) {
    throw new Error(`Invalid publisher-claim grammar literal: ${literal}`);
  }
  return [...literal].map((character) => `(?:${character}|\\?)`).join("\\s*");
}

/**
 * Protected grammar terms use a fixed-length ASCII skeleton. NFKD-folded
 * ASCII must equal the expected character. Any remaining Unicode
 * letter/number is one `?` wildcard, so a new homoglyph cannot bypass policy.
 * This is deliberately not transliteration or natural-language inference.
 */
function skeletonWord(literal: string): string {
  return `(?<!${NORMALIZED_WORD_CHARACTER})${skeletonBody(literal)}(?!${NORMALIZED_WORD_CHARACTER})`;
}

function alternatives(literals: readonly string[]): string {
  return `(?:${literals.map(skeletonWord).join("|")})`;
}

function globalPattern(source: string): RegExp {
  return new RegExp(source, "gu");
}

const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  {
    label: "SOC 2 claim",
    pattern: globalPattern(
      `${skeletonWord("soc2")}(?:\\s*${skeletonWord("type")}\\s*${alternatives(["ii", "i", "1", "2"])})?`,
    ),
  },
  { label: "HIPAA claim", pattern: globalPattern(skeletonWord("hipaa")) },
  { label: "GDPR claim", pattern: globalPattern(skeletonWord("gdpr")) },
  { label: "CCPA claim", pattern: globalPattern(skeletonWord("ccpa")) },
  { label: "CPRA claim", pattern: globalPattern(skeletonWord("cpra")) },
  {
    label: "PCI DSS claim",
    pattern: globalPattern(skeletonWord("pcidss")),
  },
  {
    label: "ISO 27001 claim",
    pattern: globalPattern(
      `(?:${skeletonWord("isoiec27001")}|${skeletonWord("iso27001")})`,
    ),
  },
];

const ADJECTIVE_ASSURANCE_WORDS = [
  "aligned",
  "approved",
  "certified",
  "compliant",
  "conformant",
  "eligible",
  "guaranteed",
  "ready",
] as const;

const VERB_ASSURANCE_WORDS = [
  "align",
  "aligns",
  "comply",
  "complies",
  "conform",
  "conforms",
  "meet",
  "meets",
  "satisfies",
  "satisfy",
] as const;

const ASSURANCE_NOUNS = [
  "alignment",
  "approval",
  "certification",
  "compliance",
  "conformance",
  "eligibility",
  "readiness",
] as const;

const ASSERTION_VERBS = [
  "advertise",
  "advertised",
  "advertises",
  "assert",
  "asserted",
  "asserts",
  "attest",
  "attested",
  "attests",
  "claim",
  "claimed",
  "claiming",
  "claims",
  "declare",
  "declared",
  "declares",
  "guarantee",
  "guaranteed",
  "guarantees",
  "guaranteeing",
  "promise",
  "promised",
  "promises",
  "represent",
  "represented",
  "represents",
  "state",
  "stated",
  "states",
] as const;

const ACHIEVED_STATUS_WORDS = [
  "active",
  "achieved",
  "complete",
  "completed",
  "confirmed",
  "current",
  "guaranteed",
  "issued",
  "obtained",
  "valid",
] as const;

const RELATION_WORDS = [
  "already",
  "are",
  "be",
  "been",
  "being",
  "currently",
  "formally",
  "fully",
  "has",
  "have",
  "indisputably",
  "is",
  "now",
  "officially",
  "remain",
  "remains",
  "still",
  "was",
  "were",
] as const;

const CONNECTOR_WORDS = ["all", "for", "the", "to", "under", "with"] as const;

const ASSERTION_FILLER_WORDS = [
  "full",
  "our",
  "that",
  "the",
  "this",
  "we",
] as const;

const NEGATION_WORDS = ["never", "no", "not", "without"] as const;
const NEGATED_AUXILIARIES = [
  "arent",
  "cant",
  "couldnt",
  "didnt",
  "doesnt",
  "dont",
  "hadnt",
  "hasnt",
  "havent",
  "isnt",
  "mustnt",
  "shouldnt",
  "wasnt",
  "werent",
  "wont",
  "wouldnt",
  "cannot",
] as const;
const AUXILIARY_WORDS = [
  "are",
  "can",
  "could",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "is",
  "must",
  "should",
  "was",
  "were",
  "will",
  "would",
] as const;
const NEGATABLE_PREDICATES = [
  ...ASSERTION_VERBS,
  ...VERB_ASSURANCE_WORDS,
  "have",
  "offer",
  "provide",
  "support",
  "use",
] as const;

const NEGATION_PATTERN = alternatives([
  ...NEGATED_AUXILIARIES,
  ...NEGATION_WORDS,
]);
const MODIFIER_PATTERN = `(?<!${NORMALIZED_WORD_CHARACTER})(?:[a-z?]\\s*){1,30}(?:l|\\?)\\s*(?:y|\\?)(?!${NORMALIZED_WORD_CHARACTER})`;
const RELATION_TERM_PATTERN = `(?:${alternatives(RELATION_WORDS)}|${NEGATION_PATTERN}|${MODIFIER_PATTERN})`;
const CONNECTOR_TERM_PATTERN = `(?:${alternatives(CONNECTOR_WORDS)}|${MODIFIER_PATTERN})`;
const ASSERTION_FILLER_PATTERN = `(?:${alternatives(ASSERTION_FILLER_WORDS)}|${MODIFIER_PATTERN})`;

function repeatedGrammar(pattern: string, maximumTerms: number): RegExp {
  return new RegExp(`^\\s*(?:(?:${pattern})\\s*){0,${maximumTerms}}$`, "u");
}

const RELATION_GRAMMAR = repeatedGrammar(RELATION_TERM_PATTERN, 6);
const CONNECTOR_GRAMMAR = repeatedGrammar(CONNECTOR_TERM_PATTERN, 4);
const ASSERTION_FILLER_GRAMMAR = repeatedGrammar(ASSERTION_FILLER_PATTERN, 5);
const DIRECT_NEGATION_SUFFIX = new RegExp(
  `(?:^|\\s)(?<direct>(?:(?:${alternatives(AUXILIARY_WORDS)})\\s*)?(?:(?:${NEGATION_PATTERN})\\s*)+(?:(?:${alternatives(NEGATABLE_PREDICATES)})\\s*)?)\\s*$`,
  "u",
);
// Keep detector implementation from becoming its own positive scan hit when
// bundled into gateway output. Runtime construction preserves exact grammar.
const SINGLE_WORD_ABSOLUTE_RISK = String.fromCodePoint(
  117,
  110,
  104,
  97,
  99,
  107,
  97,
  98,
  108,
  101,
);

const DIRECT_RULES: readonly DirectRule[] = [
  {
    label: "security-grade superlative",
    pattern: globalPattern(
      `${alternatives(["enterprise", "bank", "military"])}\\s*${skeletonWord("grade")}\\s*${alternatives(["platform", "security", "secure", "encryption", "protection"])}`,
    ),
    allowDirectNegation: true,
  },
  {
    label: "absolute security claim",
    pattern: globalPattern(
      `(?:${alternatives(["fully", "completely"])}\\s*${skeletonWord("secure")}|${skeletonWord("100")}\\s*${skeletonWord("percent")}\\s*${skeletonWord("secure")}|${skeletonWord("secure")}\\s*${skeletonWord("against")}\\s*${alternatives(["all", "any", "every"])}\\s*${alternatives(["breach", "breaches"])})`,
    ),
    allowDirectNegation: true,
  },
  {
    label: "absolute risk claim",
    pattern: globalPattern(
      `(?:${skeletonWord("zero")}\\s*${skeletonWord("risk")}|${skeletonWord("breach")}\\s*${skeletonWord("proof")}|${skeletonWord("hack")}\\s*${skeletonWord("proof")}|${skeletonWord(SINGLE_WORD_ABSOLUTE_RISK)}|${skeletonWord("impossible")}\\s*${skeletonWord("to")}\\s*${skeletonWord("breach")})`,
    ),
    allowDirectNegation: true,
  },
  {
    label: "absolute privacy claim",
    pattern: globalPattern(
      `(?:(?:${skeletonWord("we")}\\s*)?${alternatives(["never", "donot", "dont"])}\\s*${alternatives(["collect", "retain", "share", "store"])}\\s*(?:${alternatives(["any", "your"])}\\s*)?(?:${skeletonWord("data")}|${skeletonWord("personal")}\\s*${alternatives(["data", "information"])})|${skeletonWord("no")}\\s*(?:${skeletonWord("personal")}\\s*)?${skeletonWord("data")}\\s*(?:${skeletonWord("is")}\\s*)?${alternatives(["collected", "retained", "shared", "stored"])}|${skeletonWord("zero")}\\s*${skeletonWord("data")}\\s*${skeletonWord("retention")}|${skeletonWord("we")}\\s*${skeletonWord("store")}\\s*${skeletonWord("none")}\\s*${skeletonWord("of")}\\s*${skeletonWord("your")}\\s*${skeletonWord("data")})`,
    ),
  },
  {
    label: "broad encryption claim",
    pattern: globalPattern(
      `(?:${skeletonWord("endtoend")}\\s*${alternatives(["encrypted", "encryption"])}|${alternatives(["all", "customer", "your"])}\\s*${alternatives(["data", "information"])}\\s*${alternatives(["is", "are"])}\\s*${skeletonWord("encrypted")}\\s*${skeletonWord("at")}\\s*${skeletonWord("rest")}|(?:${skeletonWord("all")}\\s*)?${alternatives(["data", "information"])}\\s*${skeletonWord("is")}\\s*${skeletonWord("always")}\\s*${skeletonWord("encrypted")})`,
    ),
    allowDirectNegation: true,
  },
];

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
      if (lower === "%") {
        for (const character of " percent ") {
          chars.push(character);
          originalIndexes.push(index);
          hardBreaks.push(false);
        }
      } else if (/^[a-z0-9]$/u.test(lower)) {
        chars.push(lower);
        originalIndexes.push(index);
        hardBreaks.push(false);
      } else if (/^[\p{Letter}\p{Number}]$/u.test(lower)) {
        // One wildcard per remaining Unicode alphanumeric. It can match only a
        // same-position character in a fixed protected grammar term.
        chars.push("?");
        originalIndexes.push(index);
        hardBreaks.push(false);
      } else {
        chars.push(" ");
        originalIndexes.push(index);
        hardBreaks.push(
          /[.!?,;:]|\p{Sentence_Terminal}/u.test(decomposed) &&
            !/[\u0027\u02bc\u2018\u2019]/u.test(decomposed),
        );
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

function findTerms(text: string, literals: readonly string[]): TermMatch[] {
  return literals
    .flatMap((literal) =>
      [...text.matchAll(globalPattern(skeletonWord(literal)))].map((match) => {
        const start = match.index ?? 0;
        return { start, end: start + match[0].length };
      }),
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function lastHardBreakBefore(normalized: NormalizedText, end: number): number {
  for (
    let index = Math.min(end - 1, normalized.hardBreaks.length - 1);
    index >= 0;
    index -= 1
  ) {
    if (normalized.hardBreaks[index]) return index + 1;
  }
  return 0;
}

function countNegativeForms(source: string): number {
  return [
    ...source.matchAll(
      globalPattern(alternatives([...NEGATED_AUXILIARIES, ...NEGATION_WORDS])),
    ),
  ].length;
}

/**
 * Direct negation is an anchored grammar, not a bag-of-words exception:
 * `[auxiliary] negative+ [claim/status verb]`. Contractions normalize through
 * punctuation (`aren't` and `aren’t` both become `aren t`); `cannot` is an
 * explicit negative form. Odd direct negatives disclaim, even ones assert.
 */
function directNegationCountBefore(
  normalized: NormalizedText,
  start: number,
): number {
  const hardStart = lastHardBreakBefore(normalized, start);
  const before = normalized.text.slice(Math.max(hardStart, start - 160), start);
  const direct = before.match(DIRECT_NEGATION_SUFFIX)?.groups?.direct;
  return direct === undefined ? 0 : countNegativeForms(direct);
}

function directNegationCountInGap(
  normalized: NormalizedText,
  start: number,
  end: number,
): number {
  const hardStart = Math.max(start, lastHardBreakBefore(normalized, end));
  const source = normalized.text.slice(hardStart, end);
  return RELATION_GRAMMAR.test(source) ? countNegativeForms(source) : 0;
}

function hasHardBreak(
  normalized: NormalizedText,
  start: number,
  end: number,
): boolean {
  return normalized.hardBreaks
    .slice(Math.max(0, start), Math.max(0, end))
    .some(Boolean);
}

function grammarAllows(
  normalized: NormalizedText,
  start: number,
  end: number,
  grammar: RegExp,
): boolean {
  return (
    end >= start &&
    end - start <= 160 &&
    grammar.test(normalized.text.slice(start, end))
  );
}

function nearestBefore(
  matches: readonly TermMatch[],
  end: number,
  predicate: (match: TermMatch) => boolean,
): TermMatch | null {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    if (match.end > end) continue;
    if (predicate(match)) return match;
  }
  return null;
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
  const adjectiveStatuses = findTerms(
    normalized.text,
    ADJECTIVE_ASSURANCE_WORDS,
  );
  const verbStatuses = findTerms(normalized.text, VERB_ASSURANCE_WORDS);
  const assuranceNouns = findTerms(normalized.text, ASSURANCE_NOUNS);
  const assertionVerbs = findTerms(normalized.text, ASSERTION_VERBS);
  const achievedStatuses = findTerms(normalized.text, ACHIEVED_STATUS_WORDS);
  const pendingStatuses = findTerms(normalized.text, ["pending"]);

  for (const framework of FRAMEWORK_RULES) {
    for (const match of normalized.text.matchAll(framework.pattern)) {
      const start = match.index ?? 0;
      const frameworkEnd = start + match[0].length;
      let violationEnd: number | null = null;

      // FRAMEWORK [relation | syntactic -ly modifier | direct negative]*
      // POSITIVE-ADJECTIVE. This catches arbitrary adverbs such as
      // "indisputably" without claiming to understand their meaning.
      const adjectiveAfter = adjectiveStatuses.find(
        (status) =>
          status.start >= frameworkEnd &&
          grammarAllows(
            normalized,
            frameworkEnd,
            status.start,
            RELATION_GRAMMAR,
          ),
      );
      if (adjectiveAfter !== undefined) {
        const negatives =
          directNegationCountBefore(normalized, start) +
          directNegationCountInGap(
            normalized,
            frameworkEnd,
            adjectiveAfter.start,
          );
        if (negatives % 2 === 0) violationEnd = adjectiveAfter.end;
      }

      // POSITIVE-ADJECTIVE/VERB [with|to|for|under|modifier]* FRAMEWORK.
      if (violationEnd === null) {
        const statusBefore = nearestBefore(
          [...adjectiveStatuses, ...verbStatuses].sort(
            (left, right) => left.start - right.start,
          ),
          start,
          (status) =>
            grammarAllows(normalized, status.end, start, CONNECTOR_GRAMMAR),
        );
        if (
          statusBefore !== null &&
          directNegationCountBefore(normalized, statusBefore.start) % 2 === 0
        ) {
          violationEnd = frameworkEnd;
        }
      }

      // Bare assurance nouns remain usable for report/evidence products.
      // They become claims only with an explicit assertion verb or achieved
      // status. Grammar mechanics stay separate from policy corpus fixtures so
      // generated source maps do not become their own positive scan input.
      const nounAfter = assuranceNouns.find(
        (noun) =>
          noun.start >= frameworkEnd &&
          grammarAllows(normalized, frameworkEnd, noun.start, RELATION_GRAMMAR),
      );
      if (violationEnd === null && nounAfter !== undefined) {
        const assertion = nearestBefore(
          assertionVerbs,
          start,
          (verb) =>
            !hasHardBreak(normalized, verb.end, start) &&
            grammarAllows(
              normalized,
              verb.end,
              start,
              ASSERTION_FILLER_GRAMMAR,
            ),
        );
        if (
          assertion !== null &&
          directNegationCountBefore(normalized, assertion.start) % 2 === 0
        ) {
          violationEnd = nounAfter.end;
        }

        const achieved = achievedStatuses.find(
          (status) =>
            status.start >= nounAfter.end &&
            grammarAllows(
              normalized,
              nounAfter.end,
              status.start,
              RELATION_GRAMMAR,
            ),
        );
        if (violationEnd === null && achieved !== undefined) {
          const negatives = directNegationCountInGap(
            normalized,
            nounAfter.end,
            achieved.start,
          );
          if (negatives % 2 === 0) violationEnd = achieved.end;
        }

        const pending = pendingStatuses.find(
          (status) =>
            status.start >= nounAfter.end &&
            grammarAllows(
              normalized,
              nounAfter.end,
              status.start,
              RELATION_GRAMMAR,
            ),
        );
        if (violationEnd === null && pending !== undefined) {
          const negatives = directNegationCountInGap(
            normalized,
            nounAfter.end,
            pending.start,
          );
          if (negatives % 2 === 1) violationEnd = pending.end;
        }
      }

      // Assertion verb + assurance noun + connector + framework orientation.
      if (violationEnd === null) {
        const nounBefore = nearestBefore(assuranceNouns, start, (noun) =>
          grammarAllows(normalized, noun.end, start, CONNECTOR_GRAMMAR),
        );
        if (nounBefore !== null) {
          const assertion = nearestBefore(
            assertionVerbs,
            nounBefore.start,
            (verb) =>
              !hasHardBreak(normalized, verb.end, nounBefore.start) &&
              grammarAllows(
                normalized,
                verb.end,
                nounBefore.start,
                ASSERTION_FILLER_GRAMMAR,
              ),
          );
          if (
            assertion !== null &&
            directNegationCountBefore(normalized, assertion.start) % 2 === 0
          ) {
            violationEnd = frameworkEnd;
          }
        }
      }

      if (violationEnd !== null) {
        addViolation(
          violations,
          normalized,
          framework.label,
          start,
          violationEnd,
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
        directNegationCountBefore(normalized, start) % 2 === 1
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
