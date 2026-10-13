import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { capitalizeFirstLetter, spellingInputProps } from "../utils/spelling";

type Shared = {
  value: string;
  onChange: (value: string) => void;
};

function applyCapitalized(
  el: HTMLInputElement | HTMLTextAreaElement,
  onChange: (value: string) => void,
) {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const next = capitalizeFirstLetter(el.value);
  onChange(next);
  if (next !== el.value && start != null) {
    const pos = start;
    const endPos = end ?? start;
    queueMicrotask(() => {
      try {
        el.setSelectionRange(pos, endPos);
      } catch {
        /* ignore */
      }
    });
  }
}

/** Textarea that always capitalises the first letter while typing. */
export function ProseTextarea({
  value,
  onChange,
  className,
  ...rest
}: Shared & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  return (
    <textarea
      value={value}
      onChange={(e) => applyCapitalized(e.target, onChange)}
      className={className}
      {...spellingInputProps("prose")}
      {...rest}
    />
  );
}

/** Single-line input that capitalises the first letter (subjects, titles, notes). */
export function ProseInput({
  value,
  onChange,
  className,
  ...rest
}: Shared & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => applyCapitalized(e.target, onChange)}
      className={className}
      {...spellingInputProps("prose")}
      {...rest}
    />
  );
}
