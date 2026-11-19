// {{trigger.name}} and {{steps.ai_call.transcript}} in node settings, filled in when the step runs.

const TAG = /\{\{\s*([\w.-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*([\w.-]+)\s*\}\}$/;

const lookup = (data: unknown, path: string) =>
  path.split(".").reduce<unknown>((value, key) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), data);

const asText = (value: unknown) =>
  value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/**
 * Replaces every {{path}} in the strings inside `value`. Missing values become "". With
 * `keepTypes`, a string that is exactly one {{path}} becomes the value itself (a number stays a
 * number, a missing value is left out), which tool arguments need.
 */
export function fill(value: unknown, data: unknown, keepTypes = false): unknown {
  if (typeof value === "string") {
    const whole = keepTypes ? WHOLE.exec(value) : null;
    if (whole?.[1]) return lookup(data, whole[1]) ?? undefined;
    return value.replace(TAG, (_, path: string) => asText(lookup(data, path)));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, data, keepTypes));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, data, keepTypes)]));
  return value;
}
