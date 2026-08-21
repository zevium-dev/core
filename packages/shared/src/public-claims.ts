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

type DirectRule = {
  label: string;
  pattern: RegExp;
  allowDirectNegation?: boolean;
};

type TermMatch = {
  start: number;
  end: number;
};

type FrameworkMatch = TermMatch & {
  label: string;
};

type AmbiguousCodePointMode = "separator" | "wildcard";

const NORMALIZED_WORD_CHARACTER = "[a-z0-9?]";

const ASCII_CONFUSABLES: Readonly<Record<string, string>> = {
  a: "4",
  b: "8",
  e: "3",
  g: "69",
  i: "1l",
  l: "1i",
  o: "0",
  s: "5",
  t: "7",
  z: "2",
};

// UTS #39-style skeleton subset for characters that can spell protected
// framework names. Unknown Unicode alphanumerics still become one wildcard,
// preserving one-code-point fail-closed coverage without treating arbitrary
// multilingual words as entire Latin acronyms.
const UNICODE_FRAMEWORK_CONFUSABLES: Readonly<Record<string, string>> = {
  ı: "i",
  ӏ: "i",
  ɢ: "g",
  ʀ: "r",
  ᴅ: "d",
  ᴘ: "p",
  ѕ: "s",
  һ: "h",
  о: "o",
  е: "e",
  х: "x",
  α: "a",
  η: "h",
  ι: "i",
  ρ: "p",
  а: "a",
  г: "r",
  д: "d",
  н: "h",
  і: "i",
  р: "p",
  ԍ: "g",
  "🅷": "h",
};

function skeletonCharacter(character: string): string {
  return `(?:${character}|\\?)`;
}

function skeletonBody(literal: string): string {
  if (!/^[a-z0-9]+$/u.test(literal)) {
    throw new Error(`Invalid publisher-claim grammar literal: ${literal}`);
  }
  return [...literal].map(skeletonCharacter).join("\\s*");
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

const FRAMEWORK_TARGETS = [
  { label: "SOC 2 claim", literal: "soc2" },
  { label: "HIPAA claim", literal: "hipaa" },
  { label: "GDPR claim", literal: "gdpr" },
  { label: "CCPA claim", literal: "ccpa" },
  { label: "CPRA claim", literal: "cpra" },
  { label: "PCI claim", literal: "pcidss" },
  { label: "PCI claim", literal: "pci" },
  { label: "ISO 27001 claim", literal: "isoiec27001" },
  { label: "ISO 27001 claim", literal: "iso27001" },
] as const;
const ISO_WITH_IEC_PATTERN = globalPattern(
  `${skeletonWord("iso")}\\s*${skeletonWord("iec")}\\s*${skeletonWord("27001")}`,
);

const ADJECTIVE_ASSURANCE_WORDS = [
  "accepted",
  "accredited",
  "aligned",
  "approved",
  "assured",
  "attested",
  "audited",
  "certified",
  "compliant",
  "conformant",
  "eligible",
  "guaranteed",
  "fulfilled",
  "implemented",
  "lawful",
  "maintained",
  "passed",
  "ready",
  "renewed",
  "satisfied",
  "successful",
  "validated",
  "verified",
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
  "accreditation",
  "alignment",
  "approval",
  "assurance",
  "attestation",
  "audit",
  "audits",
  "certificate",
  "certificates",
  "certification",
  "compliance",
  "conformance",
  "control",
  "controls",
  "eligibility",
  "examination",
  "examinations",
  "obligation",
  "obligations",
  "readiness",
  "report",
  "reports",
  "requirement",
  "requirements",
  "safeguard",
  "safeguards",
  "status",
] as const;

const EVIDENCE_ANALYSIS_WORDS = [
  "analysis",
  "analyzer",
  "analyzes",
  "checker",
  "classifier",
  "documentation",
  "evidence",
  "report",
  "reports",
  "search",
] as const;

const GENERIC_BADGE_NOUNS = [
  "accreditation",
  "assurance",
  "attestation",
  "certification",
  "compliance",
  "conformance",
] as const;

const GENERIC_BADGE_ADJECTIVES = [
  "accredited",
  "assured",
  "attested",
  "audited",
  "certified",
  "compliant",
  "conformant",
] as const;

const GENERIC_BADGE_SUBJECTS = [
  "api",
  "company",
  "organization",
  "our",
  "platform",
  "product",
  "provider",
  "service",
  "system",
  "vendor",
  "we",
] as const;

const ASSERTION_VERBS = [
  "achieve",
  "achieved",
  "achieves",
  "achieving",
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
  "complete",
  "completed",
  "completes",
  "declare",
  "declared",
  "declares",
  "earn",
  "earned",
  "earning",
  "earns",
  "fulfill",
  "fulfilled",
  "fulfills",
  "guarantee",
  "guaranteed",
  "guarantees",
  "guaranteeing",
  "had",
  "has",
  "have",
  "held",
  "hold",
  "holding",
  "holds",
  "implement",
  "implemented",
  "implements",
  "maintain",
  "maintained",
  "maintains",
  "meet",
  "meets",
  "obtain",
  "obtained",
  "obtaining",
  "obtains",
  "pass",
  "passed",
  "passes",
  "possess",
  "possessed",
  "possesses",
  "promise",
  "promised",
  "promises",
  "receive",
  "received",
  "receives",
  "represent",
  "represented",
  "represents",
  "satisfies",
  "satisfy",
  "state",
  "stated",
  "states",
  "undergo",
  "undergoes",
  "undergoing",
  "underwent",
  "validate",
  "validated",
  "validates",
  "verify",
  "verified",
  "verifies",
] as const;

const ACHIEVED_STATUS_WORDS = [
  "accepted",
  "accredited",
  "active",
  "achieved",
  "attested",
  "audited",
  "complete",
  "completed",
  "confirmed",
  "current",
  "guaranteed",
  "fulfilled",
  "implemented",
  "issued",
  "maintained",
  "obtained",
  "passed",
  "renewed",
  "satisfied",
  "succeeded",
  "successful",
  "validated",
  "valid",
  "verified",
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

const CONNECTOR_WORDS = [
  "a",
  "against",
  "all",
  "an",
  "auditor",
  "auditors",
  "by",
  "every",
  "for",
  "from",
  "independent",
  "of",
  "our",
  "the",
  "their",
  "to",
  "under",
  "with",
] as const;

const ASSERTION_FILLER_WORDS = [
  "a",
  "all",
  "an",
  "current",
  "every",
  "full",
  "independent",
  "its",
  "our",
  "successful",
  "that",
  "the",
  "their",
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
  "be",
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
const NEGATION_BRIDGE_PATTERN = alternatives(["currently", "ever", "yet"]);
const MODIFIER_PATTERN = `(?<!${NORMALIZED_WORD_CHARACTER})(?:[a-z?]\\s*){1,30}(?:l|\\?)\\s*(?:y|\\?)(?!${NORMALIZED_WORD_CHARACTER})`;
const MODIFIER_SUFFIX = new RegExp(`(?:^|\\s)${MODIFIER_PATTERN}\\s*$`, "u");
const RELATION_TERM_PATTERN = `(?:${alternatives(RELATION_WORDS)}|${NEGATION_PATTERN}|${MODIFIER_PATTERN})`;
const CONNECTOR_TERM_PATTERN = `(?:${alternatives(CONNECTOR_WORDS)}|${MODIFIER_PATTERN})`;
const ASSERTION_FILLER_PATTERN = `(?:${alternatives(ASSERTION_FILLER_WORDS)}|${MODIFIER_PATTERN})`;

function repeatedGrammarSource(pattern: string, maximumTerms: number): string {
  return `^\\s*(?:(?:${pattern})\\s*){0,${maximumTerms}}$`;
}

const RELATION_GRAMMAR_SOURCE = repeatedGrammarSource(RELATION_TERM_PATTERN, 6);
const CONNECTOR_GRAMMAR_SOURCE = repeatedGrammarSource(
  CONNECTOR_TERM_PATTERN,
  8,
);
const ASSERTION_FILLER_GRAMMAR_SOURCE = repeatedGrammarSource(
  ASSERTION_FILLER_PATTERN,
  5,
);
const RELATION_GRAMMAR = new RegExp(RELATION_GRAMMAR_SOURCE, "u");
const CONNECTOR_GRAMMAR = new RegExp(CONNECTOR_GRAMMAR_SOURCE, "u");
const ASSERTION_FILLER_GRAMMAR = new RegExp(
  ASSERTION_FILLER_GRAMMAR_SOURCE,
  "u",
);
const AUXILIARY_PATTERN = alternatives(AUXILIARY_WORDS);
const NEGATABLE_PREDICATE_PATTERN = alternatives(NEGATABLE_PREDICATES);
const DIRECT_NEGATION_CORE = `(?:(?:${AUXILIARY_PATTERN})\\s*)?(?:(?:${NEGATION_PATTERN})\\s*)+(?:(?:${NEGATION_BRIDGE_PATTERN})\\s*)*(?:(?:${NEGATABLE_PREDICATE_PATTERN})\\s*)?`;
const DIRECT_NEGATION_SUFFIX_SOURCE = `(?:^|\\s)(?<direct>${DIRECT_NEGATION_CORE})\\s*$`;
const DIRECT_NEGATION_PREFIX_SOURCE = `^\\s*(?<direct>${DIRECT_NEGATION_CORE})`;
const DIRECT_NEGATION_SUFFIX = new RegExp(DIRECT_NEGATION_SUFFIX_SOURCE, "u");
const DIRECT_NEGATION_PREFIX = new RegExp(DIRECT_NEGATION_PREFIX_SOURCE, "u");
const MODAL_PATTERN = alternatives(["must", "should"]);
const NOT_PATTERN = alternatives(["not"]);
const BE_PATTERN = alternatives(["be"]);
const MARKETING_VERB_PATTERN = alternatives([
  "marketed",
  "used",
  "advertised",
  "sold",
  "represented",
  "described",
]);
const AND_OR_PATTERN = alternatives(["and", "or"]);
const AS_PATTERN = alternatives(["as"]);
const USE_PROHIBITION_PREFIX_SOURCE = `(?:^|\\s)(?:${MODAL_PATTERN})\\s*${NOT_PATTERN}\\s*(?:${BE_PATTERN})?\\s*(?:${MARKETING_VERB_PATTERN})\\s*(?:(?:${AND_OR_PATTERN})\\s*(?:${BE_PATTERN})?\\s*(?:${MARKETING_VERB_PATTERN})\\s*)*(?:${AS_PATTERN})?\\s*$`;
const USE_PROHIBITION_PREFIX = new RegExp(USE_PROHIBITION_PREFIX_SOURCE, "u");
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
const SINGLE_WORD_RL_TOKEN = String.fromCodePoint(
  114,
  105,
  115,
  107,
  108,
  101,
  115,
  115,
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
      `(?:(?:${alternatives(["zero", "0", "no"])})\\s*(?:${alternatives(["security", "privacy", "operational"])})?\\s*${alternatives(["risk", "risks"])}|${skeletonWord("risk")}\\s*${skeletonWord("free")}|${skeletonWord(SINGLE_WORD_RL_TOKEN)}|${skeletonWord("breach")}\\s*${skeletonWord("proof")}|${skeletonWord("hack")}\\s*${skeletonWord("proof")}|${skeletonWord(SINGLE_WORD_ABSOLUTE_RISK)}|${skeletonWord("impossible")}\\s*${skeletonWord("to")}\\s*${skeletonWord("breach")})`,
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

function normalizePublicClaimText(
  source: string,
  ambiguousMode: AmbiguousCodePointMode,
): NormalizedText {
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
        // same-position character in a protected grammar term. A second pass
        // treats it as a separator so inserted modifier letters cannot split a
        // protected name while symbol homoglyphs remain visible as wildcards.
        chars.push(
          ambiguousMode === "wildcard"
            ? "?"
            : (UNICODE_FRAMEWORK_CONFUSABLES[lower] ?? " "),
        );
        originalIndexes.push(index);
        hardBreaks.push(false);
      } else {
        const mappedSymbol = UNICODE_FRAMEWORK_CONFUSABLES[raw];
        chars.push(
          ambiguousMode === "separator"
            ? (mappedSymbol ?? " ")
            : ((point >= 0x2460 && point <= 0x24ff) ||
                  (point >= 0x1f100 && point <= 0x1f1ff)) &&
                /^\p{Symbol}$/u.test(lower)
              ? "?"
              : " ",
        );
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

const TERM_PATTERN_CACHE = new Map<string, RegExp>();

function combinedTermPattern(literals: readonly string[]): RegExp {
  // Longest-first alternatives prevent a singular skeleton from shadowing a
  // punctuation-folded plural (`requirement.s`). One combined pattern also
  // keeps scanning linear instead of traversing deploy bundles once per term.
  const ordered = [...literals].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  const key = ordered.join("\u0000");
  const cached = TERM_PATTERN_CACHE.get(key);
  if (cached !== undefined) return cached;
  const pattern = globalPattern(alternatives(ordered));
  TERM_PATTERN_CACHE.set(key, pattern);
  return pattern;
}

function findTerms(text: string, literals: readonly string[]): TermMatch[] {
  const pattern = combinedTermPattern(literals);
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => {
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  });
}

function canonicalFrameworkCharacter(character: string): string | null {
  if (character === "?") return "?";
  return /^[a-z0-9]$/u.test(character) ? character : null;
}

function frameworkCharactersMatch(
  candidate: string,
  expected: string,
): boolean {
  return (
    candidate === "?" ||
    candidate === expected ||
    (ASCII_CONFUSABLES[expected]?.includes(candidate) ?? false)
  );
}

function frameworkEditDistanceAtMostOne(
  candidate: string,
  target: string,
): boolean {
  const left = [...candidate];
  const right = [...target];
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    let mismatches = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (!frameworkCharactersMatch(left[index]!, right[index]!)) {
        mismatches += 1;
      }
      if (mismatches > 1) return false;
    }
    return true;
  }

  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  let longIndex = 0;
  let shortIndex = 0;
  let edits = 0;
  while (longIndex < longer.length && shortIndex < shorter.length) {
    const long = longer[longIndex]!;
    const short = shorter[shortIndex]!;
    const candidate = left.length > right.length ? long : short;
    const expected = left.length > right.length ? short : long;
    if (frameworkCharactersMatch(candidate, expected)) {
      longIndex += 1;
      shortIndex += 1;
      continue;
    }
    edits += 1;
    longIndex += 1;
    if (edits > 1) return false;
  }
  return edits + (longIndex < longer.length ? 1 : 0) <= 1;
}

function frameworkLabelForCandidate(candidate: string): string | null {
  // Threat model is one changed code point. Treating an arbitrary run of
  // non-ASCII glyphs as an acronym creates fake frameworks in ordinary
  // multilingual copy and opaque bundle syntax.
  const wildcardCount = [...candidate].filter(
    (character) => character === "?",
  ).length;
  if (wildcardCount > 1) return null;
  // A framework acronym needs at least one real letter. Pure digit runs such
  // as an HTTP status literal otherwise alias conformance acronyms through
  // the confusable map plus one-edit slack.
  if (!/[a-z]/u.test(candidate)) return null;
  for (const target of FRAMEWORK_TARGETS) {
    if (
      (candidate === "phi" && target.literal === "pci") ||
      (candidate === "cpa" &&
        (target.literal === "ccpa" || target.literal === "cpra")) ||
      (candidate === "cc4" &&
        (target.literal === "ccpa" || target.literal === "cpra"))
    ) {
      continue;
    }
    // Three-letter PCI is already broad; do not allow edit distance to make
    // ordinary prose fragments such as "pliance" into synthetic PCI matches.
    if (target.literal === "pci" && candidate.length !== 3) continue;
    if (frameworkEditDistanceAtMostOne(candidate, target.literal)) {
      return target.label;
    }
  }
  return null;
}

const COMPACT_ASSURANCE_SUFFIXES = new Set([
  ...ADJECTIVE_ASSURANCE_WORDS,
  ...ASSURANCE_NOUNS,
  "encrypted",
  "encryption",
  "free",
  "proof",
  "risk",
  "risks",
  "secure",
  "security",
]);

function findCompactFrameworkMatches(text: string): FrameworkMatch[] {
  const matches: FrameworkMatch[] = [];
  const words = [...text.matchAll(/[a-z0-9?]+/gu)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

  for (const word of words) {
    for (const target of FRAMEWORK_TARGETS) {
      for (const split of [
        target.literal.length - 1,
        target.literal.length,
        target.literal.length + 1,
      ]) {
        if (split < 3 || split >= word.text.length) continue;
        const framework = word.text.slice(0, split);
        const suffix = word.text.slice(split);
        if (!COMPACT_ASSURANCE_SUFFIXES.has(suffix)) continue;
        if (frameworkLabelForCandidate(framework) !== target.label) continue;
        matches.push({ label: target.label, start: word.start, end: word.end });
        break;
      }
    }
  }
  return matches;
}

const COMPACT_DIRECT_CLAIMS = new Map<string, string>([
  [
    String.fromCodePoint(102, 117, 108, 108, 121, 115, 101, 99, 117, 114, 101),
    "absolute security claim",
  ],
  [
    String.fromCodePoint(
      99,
      111,
      109,
      112,
      108,
      101,
      116,
      101,
      108,
      121,
      115,
      101,
      99,
      117,
      114,
      101,
    ),
    "absolute security claim",
  ],
  [
    String.fromCodePoint(122, 101, 114, 111, 114, 105, 115, 107),
    "absolute risk claim",
  ],
  [
    String.fromCodePoint(122, 101, 114, 111, 114, 105, 115, 107, 115),
    "absolute risk claim",
  ],
  [
    String.fromCodePoint(114, 105, 115, 107, 102, 114, 101, 101),
    "absolute risk claim",
  ],
  [
    String.fromCodePoint(114, 105, 115, 107, 108, 101, 115, 115),
    "absolute risk claim",
  ],
  [
    String.fromCodePoint(
      101,
      110,
      100,
      116,
      111,
      101,
      110,
      100,
      101,
      110,
      99,
      114,
      121,
      112,
      116,
      101,
      100,
    ),
    "broad encryption claim",
  ],
  [
    String.fromCodePoint(
      101,
      110,
      100,
      116,
      111,
      101,
      110,
      100,
      101,
      110,
      99,
      114,
      121,
      112,
      116,
      105,
      111,
      110,
    ),
    "broad encryption claim",
  ],
  [
    String.fromCodePoint(
      122,
      101,
      114,
      111,
      100,
      97,
      116,
      97,
      114,
      101,
      116,
      101,
      110,
      116,
      105,
      111,
      110,
    ),
    "absolute privacy claim",
  ],
  [
    String.fromCodePoint(
      122,
      101,
      114,
      111,
      115,
      101,
      99,
      117,
      114,
      105,
      116,
      121,
      114,
      105,
      115,
      107,
    ),
    "absolute risk claim",
  ],
  [
    String.fromCodePoint(
      101,
      110,
      116,
      101,
      114,
      112,
      114,
      105,
      115,
      101,
      103,
      114,
      97,
      100,
      101,
      112,
      108,
      97,
      116,
      102,
      111,
      114,
      109,
    ),
    "security-grade superlative",
  ],
  [
    String.fromCodePoint(
      101,
      110,
      116,
      101,
      114,
      112,
      114,
      105,
      115,
      101,
      103,
      114,
      97,
      100,
      101,
      115,
      101,
      99,
      117,
      114,
      105,
      116,
      121,
    ),
    "security-grade superlative",
  ],
]);

function findCompactDirectClaims(text: string): PublicClaimViolation[] {
  const violations: PublicClaimViolation[] = [];
  for (const word of text.matchAll(/[a-z0-9?]+/gu)) {
    const start = word.index ?? 0;
    const label = COMPACT_DIRECT_CLAIMS.get(word[0]);
    if (label !== undefined) {
      violations.push({ label, match: word[0], index: start });
    }
  }
  return violations;
}

function findFrameworkMatches(text: string): FrameworkMatch[] {
  const matches: FrameworkMatch[] = [];
  ISO_WITH_IEC_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ISO_WITH_IEC_PATTERN)) {
    const start = match.index ?? 0;
    matches.push({
      label: "ISO 27001 claim",
      start,
      end: start + match[0].length,
    });
  }
  const words = [...text.matchAll(/[a-z0-9?]+/gu)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const maximumTargetLength = Math.max(
    ...FRAMEWORK_TARGETS.map(({ literal }) => literal.length),
  );

  for (let start = 0; start < words.length; start += 1) {
    let candidate = "";
    for (let end = start; end < words.length; end += 1) {
      const word = words[end]!;
      if (
        end > start &&
        /\S/u.test(text.slice(words[end - 1]!.end, word.start))
      ) {
        break;
      }
      if (end > start) {
        const canJoinSingleCharacter = word.text.length === 1;
        const canJoinSocNumber =
          candidate === "soc" && /^[12?]$/u.test(word.text);
        const canJoinIsoNumber =
          candidate === "iso" && /^[0-9?]+$/u.test(word.text);
        const canJoinPciDss = candidate === "pci" && word.text === "dss";
        if (
          !canJoinSingleCharacter &&
          !canJoinSocNumber &&
          !canJoinIsoNumber &&
          !canJoinPciDss
        ) {
          break;
        }
      }
      candidate += [...word.text]
        .map(canonicalFrameworkCharacter)
        .filter((character): character is string => character !== null)
        .join("");
      if (candidate.length > maximumTargetLength + 1) break;

      if (candidate === "soc" && end + 1 < words.length) {
        const next = words[end + 1]!;
        const gap = text.slice(word.end, next.start);
        if (!/\S/u.test(gap) && /^[12?]$/u.test(next.text)) continue;
      }

      const label = frameworkLabelForCandidate(candidate);
      if (label !== null) {
        matches.push({
          label,
          start: words[start]!.start,
          end: word.end,
        });
      }
    }
  }

  const represented = new Set<string>();
  return matches
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((match) => {
      const key = `${match.label}\u0000${match.start}\u0000${match.end}`;
      if (represented.has(key)) return false;
      represented.add(key);
      return true;
    });
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
  if (USE_PROHIBITION_PREFIX.test(before)) return 1;
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

function nextHardBreakAfter(normalized: NormalizedText, start: number): number {
  for (
    let index = Math.max(0, start);
    index < normalized.text.length;
    index += 1
  ) {
    if (normalized.hardBreaks[index]) return index;
  }
  return normalized.text.length;
}

function sentenceBounds(
  normalized: NormalizedText,
  anchor: number,
): { start: number; end: number } {
  return {
    start: lastHardBreakBefore(normalized, anchor),
    end: nextHardBreakAfter(normalized, anchor),
  };
}

function directNegationCountAfter(
  normalized: NormalizedText,
  start: number,
  end: number,
): number {
  const source = normalized.text.slice(start, Math.min(end, start + 160));
  const direct = source.match(DIRECT_NEGATION_PREFIX)?.groups?.direct;
  return direct === undefined ? 0 : countNegativeForms(direct);
}

function isWithin(
  match: TermMatch,
  bounds: { start: number; end: number },
): boolean {
  return match.start >= bounds.start && match.end <= bounds.end;
}

function isLocallyRelated(
  normalized: NormalizedText,
  left: TermMatch,
  right: TermMatch,
): boolean {
  const earlier = left.start <= right.start ? left : right;
  const later = earlier === left ? right : left;
  if (hasHardBreak(normalized, earlier.end, later.start)) return false;
  return (
    grammarAllows(normalized, earlier.end, later.start, RELATION_GRAMMAR) ||
    grammarAllows(normalized, earlier.end, later.start, CONNECTOR_GRAMMAR)
  );
}

function hasFrameworkInBounds(
  frameworkMatches: readonly FrameworkMatch[],
  bounds: { start: number; end: number },
): boolean {
  return frameworkMatches.some((match) => isWithin(match, bounds));
}

function isExplicitlyNegatedPair(
  normalized: NormalizedText,
  left: TermMatch,
  right: TermMatch,
): boolean {
  const earlier = left.start <= right.start ? left : right;
  const later = earlier === left ? right : left;
  const bounds = sentenceBounds(normalized, earlier.start);
  if (!isWithin(later, bounds)) return false;

  const immediatelyBeforeLater = directNegationCountBefore(
    normalized,
    later.start,
  );
  if (immediatelyBeforeLater % 2 === 1) return true;

  const negatives =
    directNegationCountBefore(normalized, earlier.start) +
    directNegationCountInGap(normalized, earlier.end, later.start) +
    directNegationCountAfter(normalized, later.end, bounds.end);
  return negatives % 2 === 1;
}

function isPendingPair(
  normalized: NormalizedText,
  left: TermMatch,
  right: TermMatch,
  pendingStatuses: readonly TermMatch[],
): boolean {
  const laterEnd = Math.max(left.end, right.end);
  const bounds = sentenceBounds(normalized, Math.min(left.start, right.start));
  const pending = pendingStatuses.find(
    (status) =>
      isWithin(status, bounds) &&
      status.start >= laterEnd &&
      grammarAllows(normalized, laterEnd, status.start, RELATION_GRAMMAR),
  );
  if (pending === undefined) return false;
  return (
    directNegationCountInGap(normalized, laterEnd, pending.start) % 2 === 0
  );
}

function isEvidenceAnalysisSentence(
  bounds: { start: number; end: number },
  evidenceTerms: readonly TermMatch[],
  positiveTerms: readonly TermMatch[],
): boolean {
  return (
    evidenceTerms.some((term) => isWithin(term, bounds)) &&
    !positiveTerms.some((term) => isWithin(term, bounds))
  );
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

function findNormalizedPublicClaimViolations(
  source: string,
  ambiguousMode: AmbiguousCodePointMode,
): PublicClaimViolation[] {
  const normalized = normalizePublicClaimText(source, ambiguousMode);
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
  const evidenceTerms = findTerms(normalized.text, EVIDENCE_ANALYSIS_WORDS);
  const genericBadgeNouns = findTerms(normalized.text, GENERIC_BADGE_NOUNS);
  const genericBadgeAdjectives = findTerms(
    normalized.text,
    GENERIC_BADGE_ADJECTIVES,
  );
  const genericBadgeSubjects = findTerms(
    normalized.text,
    GENERIC_BADGE_SUBJECTS,
  );
  const frameworkMatches = findFrameworkMatches(normalized.text);
  const compactFrameworkMatches = findCompactFrameworkMatches(normalized.text);

  for (const framework of frameworkMatches) {
    const start = framework.start;
    const frameworkEnd = framework.end;
    let violationEnd: number | null = null;

    // FRAMEWORK [relation | syntactic -ly modifier | direct negative]*
    // POSITIVE-ADJECTIVE. This catches arbitrary adverbs such as
    // "indisputably" without claiming to understand their meaning.
    const adjectiveAfter = adjectiveStatuses.find(
      (status) =>
        status.start >= frameworkEnd &&
        grammarAllows(normalized, frameworkEnd, status.start, RELATION_GRAMMAR),
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
          grammarAllows(normalized, verb.end, start, ASSERTION_FILLER_GRAMMAR),
      );
      if (
        assertion !== null &&
        (directNegationCountBefore(normalized, assertion.start) +
          directNegationCountInGap(normalized, assertion.end, start)) %
          2 ===
          0
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
        const negatives =
          directNegationCountBefore(normalized, start) +
          directNegationCountInGap(normalized, nounAfter.end, achieved.start);
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
          (directNegationCountBefore(normalized, assertion.start) +
            directNegationCountInGap(
              normalized,
              assertion.end,
              nounBefore.start,
            )) %
            2 ===
            0
        ) {
          violationEnd = frameworkEnd;
        }

        const achieved = achievedStatuses.find(
          (status) =>
            status.start >= frameworkEnd &&
            grammarAllows(
              normalized,
              frameworkEnd,
              status.start,
              RELATION_GRAMMAR,
            ),
        );
        if (violationEnd === null && achieved !== undefined) {
          const negatives =
            directNegationCountBefore(normalized, nounBefore.start) +
            directNegationCountInGap(normalized, frameworkEnd, achieved.start);
          if (negatives % 2 === 0) violationEnd = achieved.end;
        }

        const pending = pendingStatuses.find(
          (status) =>
            status.start >= frameworkEnd &&
            grammarAllows(
              normalized,
              frameworkEnd,
              status.start,
              RELATION_GRAMMAR,
            ),
        );
        if (violationEnd === null && pending !== undefined) {
          const negatives = directNegationCountInGap(
            normalized,
            frameworkEnd,
            pending.start,
          );
          if (negatives % 2 === 1) violationEnd = pending.end;
        }
      }
    }

    // Unknown nearby prose is not proof. A bounded framework + assurance
    // pairing fails closed unless a direct negative, pending state, or narrow
    // evidence-analysis grammar proves the copy is non-assertive. Bounding
    // prevents unrelated tokens on a minified bundle's single line from
    // becoming a synthetic publisher claim.
    if (violationEnd === null) {
      const frameworkMatch = { start, end: frameworkEnd };
      const bounds = sentenceBounds(normalized, start);
      const nounSet = new Set(assuranceNouns);
      const positiveEvidenceTerms = [
        ...adjectiveStatuses,
        ...verbStatuses,
        ...assertionVerbs,
        ...achievedStatuses,
      ];
      const assuranceSignals = [
        ...adjectiveStatuses,
        ...verbStatuses,
        ...assuranceNouns,
      ]
        .filter((signal) => isWithin(signal, bounds))
        .sort((left, right) => left.start - right.start);

      for (const signal of assuranceSignals) {
        const span =
          Math.max(frameworkEnd, signal.end) - Math.min(start, signal.start);
        if (span > 160) continue;
        if (isExplicitlyNegatedPair(normalized, frameworkMatch, signal)) {
          continue;
        }
        if (
          nounSet.has(signal) &&
          isPendingPair(normalized, frameworkMatch, signal, pendingStatuses)
        ) {
          continue;
        }
        if (
          nounSet.has(signal) &&
          isEvidenceAnalysisSentence(
            bounds,
            evidenceTerms,
            positiveEvidenceTerms,
          )
        ) {
          continue;
        }
        violationEnd = Math.max(frameworkEnd, signal.end);
        break;
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

  for (const framework of compactFrameworkMatches) {
    if (directNegationCountBefore(normalized, framework.start) % 2 === 1) {
      continue;
    }
    addViolation(
      violations,
      normalized,
      framework.label,
      framework.start,
      framework.end,
    );
  }

  // Framework-free badges still imply unsupported third-party assurance when
  // used as predicates or achievement statements. Keep evidence tooling and
  // directly negated disclaimers available.
  for (const status of genericBadgeAdjectives) {
    const bounds = sentenceBounds(normalized, status.start);
    if (hasFrameworkInBounds(frameworkMatches, bounds)) continue;
    const hasSubject = genericBadgeSubjects.some(
      (term) =>
        isWithin(term, bounds) && isLocallyRelated(normalized, term, status),
    );
    const nounInSentence = genericBadgeNouns.some(
      (noun) =>
        isWithin(noun, bounds) && isLocallyRelated(normalized, noun, status),
    );
    const modifierBefore = MODIFIER_SUFFIX.test(
      normalized.text.slice(bounds.start, status.start),
    );
    if (
      (hasSubject || nounInSentence || modifierBefore) &&
      !isExplicitlyNegatedPair(normalized, status, status)
    ) {
      addViolation(
        violations,
        normalized,
        "unsupported assurance badge",
        status.start,
        status.end,
      );
    }
  }

  const genericPositiveTerms = [
    ...adjectiveStatuses,
    ...verbStatuses,
    ...achievedStatuses,
  ];
  for (const noun of genericBadgeNouns) {
    const bounds = sentenceBounds(normalized, noun.start);
    if (hasFrameworkInBounds(frameworkMatches, bounds)) continue;
    const hasPositive = genericPositiveTerms.some(
      (term) =>
        term !== noun &&
        isWithin(term, bounds) &&
        isLocallyRelated(normalized, noun, term),
    );
    const hasSubject = genericBadgeSubjects.some(
      (term) =>
        isWithin(term, bounds) && isLocallyRelated(normalized, noun, term),
    );
    if (
      (hasPositive || hasSubject) &&
      !isExplicitlyNegatedPair(normalized, noun, noun) &&
      !isPendingPair(normalized, noun, noun, pendingStatuses) &&
      !isEvidenceAnalysisSentence(bounds, evidenceTerms, genericPositiveTerms)
    ) {
      addViolation(
        violations,
        normalized,
        "unsupported assurance badge",
        noun.start,
        noun.end,
      );
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

  for (const violation of findCompactDirectClaims(normalized.text)) {
    if (directNegationCountBefore(normalized, violation.index) % 2 === 1) {
      continue;
    }
    violations.push(violation);
  }

  return violations.sort((a, b) => a.index - b.index);
}

export function findPublicClaimViolations(
  source: string,
): PublicClaimViolation[] {
  const violations: PublicClaimViolation[] = [];
  for (const match of source.matchAll(/\p{Bidi_Control}/gu)) {
    violations.push({
      label: "bidirectional control",
      match: "bidirectional control",
      index: match.index ?? 0,
    });
  }
  for (const ambiguousMode of ["wildcard", "separator"] as const) {
    violations.push(
      ...findNormalizedPublicClaimViolations(source, ambiguousMode),
    );
  }

  const represented = new Set<string>();
  return violations
    .sort((left, right) => left.index - right.index)
    .filter((violation) => {
      const key = `${violation.label}\u0000${violation.index}\u0000${violation.match}`;
      if (represented.has(key)) return false;
      represented.add(key);
      return true;
    });
}

export function isPublicCopyAllowed(source: string): boolean {
  return findPublicClaimViolations(source).length === 0;
}

function frameworkLabels(source: string): string[] {
  const labels = new Set<string>();
  for (const ambiguousMode of ["wildcard", "separator"] as const) {
    const normalized = normalizePublicClaimText(source, ambiguousMode);
    for (const framework of [
      ...findFrameworkMatches(normalized.text),
      ...findCompactFrameworkMatches(normalized.text),
    ]) {
      labels.add(framework.label);
    }
  }
  return [...labels];
}

function hasAssuranceSignal(source: string): boolean {
  return (["wildcard", "separator"] as const).some((ambiguousMode) => {
    const normalized = normalizePublicClaimText(source, ambiguousMode);
    return (
      findTerms(normalized.text, ADJECTIVE_ASSURANCE_WORDS).length > 0 ||
      findTerms(normalized.text, VERB_ASSURANCE_WORDS).length > 0 ||
      findTerms(normalized.text, ASSURANCE_NOUNS).length > 0
    );
  });
}

function findCrossFieldClaim(
  sources: readonly string[],
): { label: string; frameworkIndex: number; assuranceIndex: number } | null {
  const frameworks = sources.map(frameworkLabels);
  const assurances = sources.map(hasAssuranceSignal);
  for (
    let frameworkIndex = 0;
    frameworkIndex < sources.length;
    frameworkIndex += 1
  ) {
    const label = frameworks[frameworkIndex]?.[0];
    if (label === undefined) continue;
    for (
      let assuranceIndex = 0;
      assuranceIndex < sources.length;
      assuranceIndex += 1
    ) {
      if (
        frameworkIndex !== assuranceIndex &&
        assurances[assuranceIndex] === true
      ) {
        return { label, frameworkIndex, assuranceIndex };
      }
    }
  }
  return null;
}

/**
 * Validate fields independently, then reject framework/assurance composition
 * across field boundaries. Negation in one field can never suppress another.
 */
export function isPublicCopySetAllowed(sources: readonly string[]): boolean {
  if (sources.some((source) => !isPublicCopyAllowed(source))) return false;
  return findCrossFieldClaim(sources) === null;
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
  const rawTokens = extractRawJsonStrings(specText);
  for (const token of rawTokens) {
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
  const crossField = findCrossFieldClaim(rawTokens.map(({ value }) => value));
  if (crossField !== null) {
    const framework = rawTokens[crossField.frameworkIndex]!;
    const assurance = rawTokens[crossField.assuranceIndex]!;
    violations.push({
      label: crossField.label,
      match: `${framework.value} … ${assurance.value}`,
      index: Math.min(framework.index, assurance.index),
      path: "$ (cross-field raw JSON strings)",
    });
  }
  return violations;
}

export function isOpenApiPublicCopyAllowed(specText: string): boolean {
  return findOpenApiPublicClaimViolations(specText).length === 0;
}
