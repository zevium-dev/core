// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SyntaxCode } from "./syntax-code";

afterEach(cleanup);

it("renders escaped highlighted code inline without block wrappers or line numbers", async () => {
  const code = 'const html = "<img src=x onerror=alert(1)>";';
  const view = render(<SyntaxCode code={code} lang="javascript" />);
  await waitFor(() =>
    expect(view.container.querySelector(".shj-syn-kwd")).not.toBeNull(),
  );
  expect(view.container.textContent).toBe(code);
  expect(view.container.querySelector("code")).not.toBeNull();
  expect(view.container.querySelector("img, div, .shj-numbers")).toBeNull();
});

it("replaces old highlighting immediately when code and language change", async () => {
  const view = render(<SyntaxCode code="const old = 1;" lang="js" />);
  await waitFor(() =>
    expect(view.container.querySelector(".shj-syn-kwd")).not.toBeNull(),
  );
  view.rerender(<SyntaxCode code="<new plain text>" lang="plaintext" />);
  expect(view.container.textContent).toBe("<new plain text>");
  await waitFor(() =>
    expect(view.container.querySelector(".shj-lang-plain")).not.toBeNull(),
  );
  expect(view.container.querySelector("new, .shj-syn-kwd")).toBeNull();
});
