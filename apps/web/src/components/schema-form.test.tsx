// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import {
  initialFormValue,
  operationParameters,
  schemaToForm,
  type FormNode,
} from "@zevium/shared";
import { SchemaBody, SchemaField } from "./schema-form";

afterEach(cleanup);
function Form({
  node,
  initial = initialFormValue(node),
  errors = {},
}: {
  node: FormNode;
  initial?: unknown;
  errors?: Record<string, string>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <SchemaField
        node={node}
        value={value}
        onChange={setValue}
        label="Payload"
        path="body"
        required
        errors={errors}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}
function choose(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
    key: "ArrowDown",
  });
  fireEvent.click(screen.getByRole("option", { name: option }));
}
// Radix Select uses browser APIs that jsdom does not implement.
HTMLElement.prototype.scrollIntoView = () => {};
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.releasePointerCapture = () => {};

it("renders typed controls, labels, bounds, descriptions, defaults, and field errors", () => {
  render(
    <Form
      node={schemaToForm({
        type: "object",
        required: ["count", "enabled"],
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            default: 2,
            description: "Result count",
          },
          enabled: { type: "boolean", default: false },
          color: { type: "string", enum: ["red", "blue"] },
        },
      })}
      errors={{ "body/count": "Must be at least 1." }}
    />,
  );
  const count = screen.getByLabelText<HTMLInputElement>("count · required");
  expect(count.value).toBe("2");
  expect(count.min).toBe("1");
  expect(count.max).toBe("5");
  expect(count.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(
      count.getAttribute("aria-describedby")!.split(" ")[0]!,
    )?.textContent,
  ).toBe("Result count");
  fireEvent.click(screen.getByRole("switch", { name: "enabled · required" }));
  choose("color", "blue");
  expect(screen.getByTestId("value").textContent).toBe(
    '{"count":2,"enabled":true,"color":"blue"}',
  );
  fireEvent.click(screen.getByRole("button", { name: "Omit color" }));
  expect(screen.getByTestId("value").textContent).not.toContain("color");
});

it("adds/removes nested array items and edits nested objects", () => {
  render(
    <Form
      node={schemaToForm({
        type: "object",
        required: ["items"],
        properties: {
          items: {
            type: "array",
            maxItems: 2,
            items: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          },
        },
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add items item" }));
  fireEvent.change(screen.getByLabelText("name · required"), {
    target: { value: "first" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add items item" }));
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Add items item" })
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove items item 2" }));
  expect(screen.getByTestId("value").textContent).toBe(
    '{"items":[{"name":"first"}]}',
  );
});

it("switches oneOf variants and seeds their declared defaults", () => {
  render(
    <Form
      node={schemaToForm({
        oneOf: [
          { title: "Text", type: "string", default: "hello" },
          { title: "Count", type: "integer", default: 3 },
        ],
      })}
    />,
  );
  choose("Payload variant", "Count");
  expect(
    screen.getByLabelText<HTMLInputElement>("Payload value · required").value,
  ).toBe("3");
  expect(screen.getByTestId("value").textContent).toBe("3");
});

function Body({ schema, initial }: { schema: unknown; initial: string }) {
  const [text, setText] = useState(initial);
  return (
    <>
      <SchemaBody
        node={schemaToForm(schema)}
        text={text}
        onChange={setText}
        required
        errors={{}}
        contentType="application/json"
      />
      <output data-testid="body">{text}</output>
    </>
  );
}
it("preserves body edits, including extra properties, across form/raw switches", () => {
  render(
    <Body
      schema={{
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      }}
      initial='{"name":"old","extra":true}'
    />,
  );
  fireEvent.change(screen.getByLabelText("name · required"), {
    target: { value: "new" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Raw JSON" }));
  const raw = screen.getByLabelText<HTMLTextAreaElement>("Request body JSON");
  expect(JSON.parse(raw.value)).toEqual({ name: "new", extra: true });
  fireEvent.change(raw, {
    target: { value: '{"name":"from raw","extra":false}' },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Form" }));
  expect(screen.getByLabelText<HTMLInputElement>("name · required").value).toBe(
    "from raw",
  );
  expect(JSON.parse(screen.getByTestId("body").textContent!)).toEqual({
    name: "from raw",
    extra: false,
  });
});
it("keeps invalid JSON editable and explains unsupported schema fallback", () => {
  const view = render(<Body schema={{ type: "string" }} initial='"valid"' />);
  fireEvent.click(screen.getByRole("radio", { name: "Raw JSON" }));
  fireEvent.change(screen.getByLabelText("Request body JSON"), {
    target: { value: "{" },
  });
  expect(
    screen.getByRole<HTMLButtonElement>("radio", { name: "Form" }).disabled,
  ).toBe(true);
  view.unmount();
  render(
    <Body
      schema={{ type: "object", additionalProperties: true }}
      initial="{}"
    />,
  );
  expect(screen.getByText("Raw editor required")).toBeTruthy();
  expect(screen.getByText(/Free-form object/)).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("radio", { name: "Form" }).disabled,
  ).toBe(true);
});

it("keeps the selected object variant while its required fields are incomplete", () => {
  render(
    <Body
      schema={{
        oneOf: [
          {
            title: "Person",
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
          {
            title: "Team",
            type: "object",
            required: ["team", "region"],
            properties: {
              team: { type: "string" },
              region: { type: "string" },
            },
          },
        ],
      }}
      initial="{}"
    />,
  );
  choose("Request body variant", "Team");
  fireEvent.change(screen.getByLabelText("team · required"), {
    target: { value: "Engineering" },
  });
  expect(screen.getByLabelText("region · required")).toBeTruthy();
  expect(JSON.parse(screen.getByTestId("body").textContent!)).toEqual({
    team: "Engineering",
  });
});

it.each([
  "parameter example",
  "named example",
  "default",
  "example",
  "examples",
])("bounds %s values before rendering parameter controls", (source) => {
  const values = Array.from({ length: 101 }, (_, i) => i);
  const parameter = operationParameters(
    [],
    [
      {
        in: "query",
        name: "ids",
        required: true,
        ...(source === "parameter example" ? { example: values } : {}),
        ...(source === "named example"
          ? { examples: { large: { value: values } } }
          : {}),
        schema: {
          type: "array",
          items: { type: "integer" },
          ...(["default", "example", "examples"].includes(source)
            ? { [source]: source === "examples" ? [values] : values }
            : {}),
        },
      },
    ],
    {},
  )[0]!;
  render(<Form node={parameter.node} initial={parameter.initialValue} />);
  const raw = screen.getByLabelText<HTMLTextAreaElement>("Payload · required");
  expect(raw.tagName).toBe("TEXTAREA");
  expect(JSON.parse(raw.value)).toEqual(values);
  expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
  expect(screen.getByText(/exceeds the form limit/)).toBeTruthy();
  fireEvent.change(raw, { target: { value: "[" } });
  expect(
    screen.getByLabelText<HTMLTextAreaElement>("Payload · required").value,
  ).toBe("[");
  fireEvent.change(raw, { target: { value: "[7]" } });
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toEqual([7]);
});
it("bounds defaults introduced by adding an array item", () => {
  const values = Array.from({ length: 101 }, () => "x");
  render(
    <Form
      node={schemaToForm({
        type: "array",
        items: {
          type: "array",
          items: { type: "string" },
          default: values,
        },
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add Payload item" }));
  const raw = screen.getByLabelText<HTMLTextAreaElement>("Payload · required");
  expect(raw.tagName).toBe("TEXTAREA");
  expect(JSON.parse(raw.value)).toEqual([values]);
});
