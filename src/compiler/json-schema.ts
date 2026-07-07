import type { z } from 'zod';

/**
 * Thrown when a Zod schema uses a construct that cannot be losslessly
 * represented as JSON Schema (e.g. `.transform()`, `.refine()`, `z.lazy()`).
 * Such schemas would advertise a wrong or empty shape to MCP/A2A clients, so
 * the M1 lint pass turns them into build-time errors (PRD §6.9, §11 edge #2).
 */
export class SchemaConversionError extends Error {
  readonly zodType: string;
  readonly path: string;

  constructor(zodType: string, path: string, hint: string) {
    super(`Cannot convert Zod type "${zodType}"${path ? ` at "${path}"` : ''} to JSON Schema. ${hint}`);
    this.name = 'SchemaConversionError';
    this.zodType = zodType;
    this.path = path;
  }
}

export type JsonSchema = Record<string, unknown>;

interface ZodDef {
  typeName: string;
  [key: string]: unknown;
}

function defOf(schema: unknown): ZodDef {
  return (schema as { _def: ZodDef })._def;
}

/**
 * Convert a Zod schema to a plain JSON Schema object. Supports the data-shape
 * subset that maps cleanly (primitives, objects, arrays, enums, unions,
 * records, tuples, optional/nullable/default wrappers). Anything else throws
 * SchemaConversionError with a fix-it hint.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema, '');
}

/** Like zodToJsonSchema but returns the error instead of throwing. */
export function tryZodToJsonSchema(
  schema: z.ZodTypeAny,
): { ok: true; schema: JsonSchema } | { ok: false; error: SchemaConversionError } {
  try {
    return { ok: true, schema: zodToJsonSchema(schema) };
  } catch (err) {
    if (err instanceof SchemaConversionError) return { ok: false, error: err };
    throw err;
  }
}

function convert(schema: z.ZodTypeAny, path: string): JsonSchema {
  const d = defOf(schema);
  switch (d.typeName) {
    case 'ZodString':
      return stringSchema(d);
    case 'ZodNumber':
      return numberSchema(d);
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return literalSchema(d.value);
    case 'ZodEnum':
      return { type: 'string', enum: [...(d.values as string[])] };
    case 'ZodNativeEnum':
      return nativeEnumSchema(d.values as Record<string, string | number>);
    case 'ZodObject':
      return objectSchema(schema as z.ZodObject<z.ZodRawShape>, path);
    case 'ZodArray':
      return arraySchema(d, path);
    case 'ZodOptional':
      return convert(d.innerType as z.ZodTypeAny, path);
    case 'ZodNullable':
      return makeNullable(convert(d.innerType as z.ZodTypeAny, path));
    case 'ZodDefault': {
      const inner = convert(d.innerType as z.ZodTypeAny, path);
      inner.default = (d.defaultValue as () => unknown)();
      return inner;
    }
    case 'ZodUnion':
      return { anyOf: (d.options as z.ZodTypeAny[]).map((opt, i) => convert(opt, `${path}|${i}`)) };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: convert(d.valueType as z.ZodTypeAny, `${path}.*`) };
    case 'ZodTuple':
      return {
        type: 'array',
        items: (d.items as z.ZodTypeAny[]).map((item, i) => convert(item, `${path}[${i}]`)),
        minItems: (d.items as unknown[]).length,
        maxItems: (d.items as unknown[]).length,
      };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    default:
      throw new SchemaConversionError(d.typeName, path, hintFor(d.typeName));
  }
}

function stringSchema(d: ZodDef): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  for (const check of (d.checks as Array<Record<string, unknown>>) ?? []) {
    switch (check.kind) {
      case 'min':
        out.minLength = check.value;
        break;
      case 'max':
        out.maxLength = check.value;
        break;
      case 'length':
        out.minLength = check.value;
        out.maxLength = check.value;
        break;
      case 'email':
        out.format = 'email';
        break;
      case 'url':
        out.format = 'uri';
        break;
      case 'uuid':
        out.format = 'uuid';
        break;
      case 'datetime':
        out.format = 'date-time';
        break;
      case 'regex':
        out.pattern = (check.regex as RegExp).source;
        break;
    }
  }
  return out;
}

function numberSchema(d: ZodDef): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const check of (d.checks as Array<Record<string, unknown>>) ?? []) {
    switch (check.kind) {
      case 'int':
        out.type = 'integer';
        break;
      case 'min':
        if (check.inclusive) out.minimum = check.value;
        else out.exclusiveMinimum = check.value;
        break;
      case 'max':
        if (check.inclusive) out.maximum = check.value;
        else out.exclusiveMaximum = check.value;
        break;
      case 'multipleOf':
        out.multipleOf = check.value;
        break;
    }
  }
  return out;
}

function literalSchema(value: unknown): JsonSchema {
  const out: JsonSchema = { const: value };
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') out.type = t;
  return out;
}

function nativeEnumSchema(values: Record<string, string | number>): JsonSchema {
  // TS numeric enums include reverse mappings; dedupe to the real values.
  const unique = [...new Set(Object.values(values))];
  return { enum: unique };
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>, path: string): JsonSchema {
  const shape = schema._def.shape();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const fieldPath = path ? `${path}.${key}` : key;
    properties[key] = convert(field as z.ZodTypeAny, fieldPath);
    if (!isOptionalField(field as z.ZodTypeAny)) required.push(key);
  }

  const out: JsonSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  if (schema._def.unknownKeys === 'strict') out.additionalProperties = false;
  return out;
}

function arraySchema(d: ZodDef, path: string): JsonSchema {
  const out: JsonSchema = { type: 'array', items: convert(d.type as z.ZodTypeAny, `${path}[]`) };
  const min = d.minLength as { value: number } | null;
  const max = d.maxLength as { value: number } | null;
  if (min) out.minItems = min.value;
  if (max) out.maxItems = max.value;
  return out;
}

/** A field is not required when it is optional or carries a default. */
function isOptionalField(field: z.ZodTypeAny): boolean {
  const name = defOf(field).typeName;
  return name === 'ZodOptional' || name === 'ZodDefault';
}

function makeNullable(inner: JsonSchema): JsonSchema {
  if (typeof inner.type === 'string') return { ...inner, type: [inner.type, 'null'] };
  return { anyOf: [inner, { type: 'null' }] };
}

function hintFor(typeName: string): string {
  const hints: Record<string, string> = {
    ZodEffects:
      'Move .transform()/.refine()/.superRefine() logic into the handler — a schema exposed as a tool must be a plain data shape.',
    ZodLazy: 'Recursive schemas cannot be expressed as a JSON Schema tool. Flatten or bound the recursion.',
    ZodPipeline: 'Split the .pipe() — validate the input shape here and transform inside the handler.',
    ZodFunction: 'Function values are not serializable. Tools exchange data, not callables.',
    ZodPromise: 'Await the value before validating; a Promise has no JSON Schema representation.',
    ZodMap: 'Use z.record(...) instead of z.map(...) so it serializes as a JSON object.',
    ZodSet: 'Use z.array(...) with .refine-free uniqueness handled in the handler.',
    ZodDate: 'Use z.string().datetime() — JSON has no native date type.',
    ZodBigInt: 'Use z.string() — JSON has no bigint type.',
    ZodSymbol: 'Symbols are not serializable.',
    ZodUndefined: 'Model absence with an optional field instead of z.undefined().',
    ZodNever: 'z.never() has no representable values.',
    ZodIntersection: 'Merge the object shapes with .merge() instead of z.intersection().',
  };
  return hints[typeName] ?? `${typeName} is not supported by the JSON Schema converter.`;
}
