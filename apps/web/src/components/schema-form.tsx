import { useId, useState } from "react";
import {
  formPath,
  formValueFits,
  initialFormValue,
  isFormObject,
  validateFormValue,
  type FormNode,
} from "@zevium/shared";
import { Button } from "#/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
import { Textarea } from "#/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";

type Props = {
  node: FormNode;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  path: string;
  required?: boolean;
  errors: Record<string, string>;
  description?: string;
  document?: unknown;
};

/** Bound every entry into the recursive renderer, including seeded parameters and defaults. */
export function SchemaField(props: Props) {
  const fits =
    props.node.kind === "raw" ||
    (typeof props.value !== "symbol" && formValueFits(props.value));
  const node: FormNode = fits
    ? props.node
    : {
        kind: "raw",
        schema: props.node.schema,
        reason:
          typeof props.value === "symbol"
            ? "Enter valid JSON to use form controls."
            : "This value exceeds the form limit (100 array items / 500 values / 8 levels). Use raw JSON.",
      };
  return <SchemaFieldControl key={node.kind} {...props} node={node} />;
}

/** Typed controls keep absence separate from false, zero, empty strings and null. */
function SchemaFieldControl({
  node,
  value,
  onChange,
  label,
  path,
  required = false,
  errors,
  description,
  document = {},
}: Props) {
  const id = useId();
  const error = errors[path];
  const [rawText, setRawText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [chosenVariant, setChosenVariant] = useState<{
    index: number;
    value: string | undefined;
  } | null>(null);
  const inferred =
    node.variants?.findIndex(
      (variant) =>
        !validateFormValue(variant.schema, value, document).errors.length,
    ) ?? 0;
  const variant =
    chosenVariant && chosenVariant.value === JSON.stringify(value)
      ? chosenVariant.index
      : Math.max(0, inferred);
  const s = node.schema;
  const help =
    description ??
    (typeof s.description === "string" ? s.description : undefined);
  const describedBy =
    [help ? `${id}-help` : "", error ? `${id}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const common = {
    id,
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy,
    "data-form-path": path,
  };
  const labelText = `${label}${required ? " · required" : ""}`;
  const optional = !required && (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
        const next =
          value === undefined ? (initialFormValue(node) ?? "") : undefined;
        if (node.kind === "raw")
          setRawText(next === undefined ? "" : JSON.stringify(next, null, 2));
        onChange(next);
      }}
    >
      {value === undefined ? `Include ${label}` : `Omit ${label}`}
    </Button>
  );
  const nullValue = value === null;
  const enumeration = Array.isArray(s.enum)
    ? s.enum
    : ownConst(s)
      ? [s.const]
      : undefined;

  if (
    node.kind === "object" ||
    node.kind === "array" ||
    node.kind === "variant"
  ) {
    return (
      <FieldSet
        data-invalid={Boolean(error)}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        data-form-path={node.kind === "variant" ? undefined : path}
        tabIndex={-1}
      >
        <FieldLegend>{labelText}</FieldLegend>
        {help && <FieldDescription id={`${id}-help`}>{help}</FieldDescription>}
        {optional}
        {(required || value !== undefined) && (
          <FieldGroup>
            {node.kind === "object" &&
              node.properties?.map((property) => (
                <SchemaField
                  document={document}
                  key={property.name}
                  node={property.node}
                  label={property.name}
                  required={property.required}
                  path={formPath(path, property.name)}
                  errors={errors}
                  value={
                    isFormObject(value) && Object.hasOwn(value, property.name)
                      ? value[property.name]
                      : undefined
                  }
                  onChange={(next) => {
                    const updated = {
                      ...(isFormObject(value) ? value : {}),
                      [property.name]: next,
                    };
                    if (next === undefined) delete updated[property.name];
                    onChange(updated);
                  }}
                />
              ))}
            {node.kind === "array" && (
              <>
                {(Array.isArray(value) ? value : []).map((item, index) => (
                  <FieldSet key={index}>
                    <SchemaField
                      document={document}
                      node={node.item!}
                      label={`${label} item ${index + 1}`}
                      required
                      path={formPath(path, index)}
                      errors={errors}
                      value={item}
                      onChange={(next) =>
                        onChange(
                          (value as unknown[]).map((old, i) =>
                            i === index ? next : old,
                          ),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onChange(
                          (value as unknown[]).filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove {label} item {index + 1}
                    </Button>
                  </FieldSet>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    Array.isArray(value) &&
                    value.length >=
                      Math.min(
                        typeof s.maxItems === "number" ? s.maxItems : 100,
                        100,
                      )
                  }
                  onClick={() =>
                    onChange([
                      ...(Array.isArray(value) ? value : []),
                      initialFormValue(node.item!) ?? "",
                    ])
                  }
                >
                  Add {label} item
                </Button>
              </>
            )}
            {node.kind === "variant" && (
              <>
                <Field>
                  <FieldLabel htmlFor={id}>{label} variant</FieldLabel>
                  <Select
                    value={String(variant)}
                    onValueChange={(next) => {
                      const nextValue = initialFormValue(
                        node.variants![Number(next)]!,
                      );
                      setChosenVariant({
                        index: Number(next),
                        value: JSON.stringify(nextValue),
                      });
                      onChange(nextValue);
                    }}
                  >
                    <SelectTrigger {...common}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {node.variants?.map((candidate, i) => (
                          <SelectItem key={i} value={String(i)}>
                            {typeof candidate.schema.title === "string"
                              ? candidate.schema.title
                              : `Variant ${i + 1}`}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <SchemaField
                  document={document}
                  key={variant}
                  node={node.variants![variant]!}
                  value={value}
                  onChange={(next) => {
                    setChosenVariant({
                      index: variant,
                      value: JSON.stringify(next),
                    });
                    onChange(next);
                  }}
                  label={`${label} value`}
                  required
                  path={path}
                  errors={errors}
                />
              </>
            )}
          </FieldGroup>
        )}
        <FieldError id={`${id}-error`}>{error}</FieldError>
      </FieldSet>
    );
  }
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
      {optional}
      {node.kind === "raw" ? (
        <>
          <FieldDescription>{node.reason}</FieldDescription>
          <Textarea
            {...common}
            value={rawText}
            onChange={(event) => {
              const text = event.target.value;
              setRawText(text);
              try {
                onChange(text.trim() ? JSON.parse(text) : undefined);
              } catch {
                onChange(Symbol("invalid-json"));
              }
            }}
          />
        </>
      ) : enumeration ? (
        <Select
          value={
            value === undefined
              ? ""
              : String(enumeration.findIndex((item) => item === value))
          }
          onValueChange={(next) => onChange(enumeration[Number(next)])}
        >
          <SelectTrigger {...common}>
            <SelectValue placeholder="Choose a value" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {enumeration.map((item, i) => (
                <SelectItem key={i} value={String(i)}>
                  {String(item)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : node.kind === "boolean" ? (
        <Switch
          {...common}
          checked={value === true}
          onCheckedChange={onChange}
        />
      ) : (
        <Input
          {...common}
          type={
            node.kind === "number" || node.kind === "integer"
              ? "number"
              : "text"
          }
          min={typeof s.minimum === "number" ? s.minimum : undefined}
          max={typeof s.maximum === "number" ? s.maximum : undefined}
          step={node.kind === "integer" ? 1 : "any"}
          value={
            typeof value === "string" || typeof value === "number" ? value : ""
          }
          onChange={(event) => {
            const text = event.target.value;
            onChange(
              node.kind === "number" || node.kind === "integer"
                ? text === ""
                  ? undefined
                  : Number(text)
                : text,
            );
          }}
          placeholder={s.example === undefined ? undefined : String(s.example)}
        />
      )}
      {nullValue && (
        <FieldDescription>
          Value is null. Use raw JSON to preserve or edit it.
        </FieldDescription>
      )}
      {help && <FieldDescription id={`${id}-help`}>{help}</FieldDescription>}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </Field>
  );
}
function ownConst(schema: object) {
  return Object.hasOwn(schema, "const");
}

/** Raw and form views share one JSON text value, so switching never discards edits. */
export function SchemaBody({
  node,
  text,
  onChange,
  errors,
  required,
  contentType,
  document = {},
}: {
  node: FormNode;
  text: string;
  onChange: (text: string) => void;
  errors: Record<string, string>;
  required: boolean;
  contentType: string;
  document?: unknown;
}) {
  const [mode, setMode] = useState("form");
  const json = contentType.toLowerCase().includes("json");
  let value: unknown;
  let validJson = true;
  try {
    value = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    validJson = false;
  }
  const fits = formValueFits(value);
  const raw =
    mode === "raw" || node.kind === "raw" || !json || !validJson || !fits;
  return (
    <FieldGroup>
      <Field>
        <FieldLabel id="body-editor-label">
          Request body · {contentType}
          {required ? " · required" : ""}
        </FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          value={raw ? "raw" : "form"}
          aria-labelledby="body-editor-label"
          onValueChange={(next) => {
            if (next) setMode(next);
          }}
        >
          <ToggleGroupItem
            value="form"
            disabled={node.kind === "raw" || !json || !validJson || !fits}
          >
            Form
          </ToggleGroupItem>
          <ToggleGroupItem value="raw">
            Raw {json ? "JSON" : "body"}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {(node.reason || !json || !fits) && (
        <Alert>
          <AlertTitle>Raw editor required</AlertTitle>
          <AlertDescription>
            {json
              ? !fits
                ? "This value exceeds the form limit (100 array items / 500 values / 8 levels). Use raw JSON."
                : node.reason
              : "This media type has no generated form. Enter the body using the published format."}
          </AlertDescription>
        </Alert>
      )}
      <FieldDescription>
        Form values come from the published schema. Use raw JSON for additional
        properties and explicit null values.
      </FieldDescription>
      {raw ? (
        <Field data-invalid={Boolean(errors.body)}>
          <FieldLabel htmlFor="try-body">
            Request body {json ? "JSON" : "text"}
          </FieldLabel>
          <Textarea
            id="try-body"
            data-form-path="body"
            value={text}
            onChange={(event) => onChange(event.target.value)}
            rows={8}
            spellCheck={false}
            aria-invalid={Boolean(errors.body)}
            aria-describedby="try-body-error"
          />
          <FieldError id="try-body-error">{errors.body}</FieldError>
        </Field>
      ) : (
        <SchemaField
          document={document}
          node={node}
          value={value}
          onChange={(next) =>
            onChange(next === undefined ? "" : JSON.stringify(next, null, 2))
          }
          label="Request body"
          path="body"
          required={required}
          errors={errors}
        />
      )}
    </FieldGroup>
  );
}
