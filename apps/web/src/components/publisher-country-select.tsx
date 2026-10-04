import { SUPPORTED_CONNECT_COUNTRY_CODES } from "@zevium/shared";

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "#/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRIES = SUPPORTED_CONNECT_COUNTRY_CODES.map((code) => ({
  code,
  name: COUNTRY_NAMES.of(code) ?? code,
})).sort((left, right) => left.name.localeCompare(right.name, "en"));

export function PublisherCountrySelect({
  id,
  value,
  onValueChange,
  disabled = false,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <FieldGroup className="max-w-xs">
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor={id}>Publisher country</FieldLabel>
        <Select
          name={id}
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          required
        >
          <SelectTrigger
            id={id}
            className="w-full"
            aria-describedby={`${id}-description`}
          >
            <SelectValue placeholder="Select a country">
              {COUNTRIES.find((country) => country.code === value)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {COUNTRIES.map((country) => (
                <SelectItem key={country.code} value={country.code}>
                  {country.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription id={`${id}-description`}>
          Select the country where your business is registered.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
