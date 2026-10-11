import { highlightHTML, type ShjLanguage } from "@speed-highlight/core";
import { useEffect, useMemo, useState } from "react";

import { cn } from "#/lib/utils";

const LANGUAGE_ALIASES: Record<string, ShjLanguage> = {
  javascript: "js",
  plaintext: "plain",
  shell: "bash",
  text: "plain",
  typescript: "ts",
};

function syntaxLanguage(lang: string | undefined): ShjLanguage {
  if (!lang) return "plain";
  return LANGUAGE_ALIASES[lang] ?? (lang as ShjLanguage);
}

type SyntaxCodeProps = {
  code: string;
  lang?: string;
  className?: string;
};

export function SyntaxCode({ code, lang, className }: SyntaxCodeProps) {
  const [result, setResult] = useState<{
    code: string;
    language: ShjLanguage;
    html: string;
  } | null>(null);
  const language = useMemo(() => syntaxLanguage(lang), [lang]);

  useEffect(() => {
    let cancelled = false;

    void highlightHTML(code, language, {
      block: false,
      showLineNumbers: false,
    })
      .then((html) => {
        if (!cancelled) setResult({ code, language, html });
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const highlighted =
    result?.code === code && result.language === language ? result.html : null;
  if (highlighted === null) {
    return <code className={className}>{code}</code>;
  }

  return (
    <code
      className={cn(`shj-lang-${language}`, className)}
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}
