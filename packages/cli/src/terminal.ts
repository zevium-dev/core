/** Render untrusted output as inert text, including redirected stdout/stderr.
 * Keep newlines/tabs; show other controls as Unicode escapes so no terminal
 * escape sequence or bidi override can execute or disguise adjacent text.
 */
export function terminalText(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex -- This output boundary intentionally neutralizes terminal controls.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g,
    (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
