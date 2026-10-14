// A deliberately small JSON Schema validator: exactly the keywords contracts/manifest.schema.json uses.
// Unknown keywords throw at compile time so a contract change cannot silently pass unvalidated.
import { readFileSync } from "node:fs";
import { MANIFEST_SCHEMA_PATH } from "./repo-root.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };

const IGNORED = new Set(["$schema", "$id", "title", "description", "default"]);
const KNOWN = new Set([
  "type", "const", "enum", "pattern", "maxItems", "minItems", "items", "required", "additionalProperties",
  "properties", "minimum", "maximum", "maxLength", "minLength", "allOf", "if", "then", "else",
]);

export interface Validator {
  validate(value: unknown): string[];
  /** Pattern of `externalScripts.items`: the CDN allowlist the HTML stage reuses. */
  externalScriptPattern: RegExp;
}

export function compileSchema(schema: Schema): Validator {
  assertKnown(schema);
  const items = ((schema.properties as Schema)?.externalScripts as Schema)?.items as Schema | undefined;
  const pattern = typeof items?.pattern === "string" ? items.pattern : "^$";
  return { validate: (value) => check(schema, value, ""), externalScriptPattern: new RegExp(pattern) };
}

let cached: Validator | undefined;
export function manifestValidator(): Validator {
  if (!cached) cached = compileSchema(JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf8")) as Schema);
  return cached;
}

function assertKnown(schema: Schema): void {
  for (const key of Object.keys(schema)) {
    if (IGNORED.has(key)) continue;
    if (!KNOWN.has(key)) throw new Error(`manifest schema uses unsupported keyword "${key}"`);
  }
  for (const key of ["items", "if", "then", "else", "additionalProperties"]) {
    const sub = schema[key];
    if (isObject(sub)) assertKnown(sub);
  }
  if (isObject(schema.properties)) for (const sub of Object.values(schema.properties)) if (isObject(sub)) assertKnown(sub);
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) if (isObject(sub)) assertKnown(sub);
}

function check(schema: Schema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  const at = path || "/";
  if ("const" in schema && !same(schema.const as Json, value)) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof schema.type === "string" && !hasType(schema.type, value)) {
    errors.push(`${at}: must be ${schema.type}`);
    return errors;
  }
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (isObject(schema.items)) value.forEach((item, i) => errors.push(...check(schema.items as Schema, item, `${path}/${i}`)));
  }
  if (isObject(value)) {
    const obj = value as Record<string, unknown>;
    const props = isObject(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
    if (Array.isArray(schema.required)) for (const r of schema.required) if (!(String(r) in obj)) errors.push(`${at}: missing required property "${r}"`);
    for (const [name, sub] of Object.entries(props)) if (name in obj) errors.push(...check(sub, obj[name], `${path}/${name}`));
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(obj)) if (!(name in props)) errors.push(`${at}: unexpected property "${name}"`);
    }
  }
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) errors.push(...check(sub as Schema, value, path));
  if (isObject(schema.if)) {
    const branch = check(schema.if as Schema, value, path).length === 0 ? schema.then : schema.else;
    if (isObject(branch)) errors.push(...check(branch as Schema, value, path));
  }
  return errors;
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: throw new Error(`unsupported type "${type}"`);
  }
}

function isObject(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function same(a: Json, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
