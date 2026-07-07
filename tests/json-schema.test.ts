import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SchemaConversionError, tryZodToJsonSchema, zodToJsonSchema } from '../src/compiler/json-schema.js';

describe('zodToJsonSchema', () => {
  it('converts primitives with constraints', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
    expect(zodToJsonSchema(z.string().min(2).max(5))).toEqual({ type: 'string', minLength: 2, maxLength: 5 });
    expect(zodToJsonSchema(z.string().email())).toEqual({ type: 'string', format: 'email' });
    expect(zodToJsonSchema(z.string().uuid())).toEqual({ type: 'string', format: 'uuid' });
    expect(zodToJsonSchema(z.number().int())).toEqual({ type: 'integer' });
    expect(zodToJsonSchema(z.number().min(0))).toEqual({ type: 'number', minimum: 0 });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('marks optional and default fields as not required', () => {
    const schema = z.object({
      id: z.string(),
      nickname: z.string().optional(),
      role: z.string().default('user'),
    });
    const json = zodToJsonSchema(schema);
    expect(json.type).toBe('object');
    expect(json.required).toEqual(['id']);
    expect((json.properties as Record<string, unknown>).role).toMatchObject({ type: 'string', default: 'user' });
  });

  it('sets additionalProperties:false for strict objects', () => {
    expect(zodToJsonSchema(z.object({ a: z.string() }).strict())).toMatchObject({ additionalProperties: false });
  });

  it('converts arrays, enums, unions, records, and literals', () => {
    expect(zodToJsonSchema(z.array(z.number()).min(1))).toEqual({
      type: 'array',
      items: { type: 'number' },
      minItems: 1,
    });
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(zodToJsonSchema(z.record(z.string()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
    expect(zodToJsonSchema(z.literal('go'))).toEqual({ const: 'go', type: 'string' });
  });

  it('makes nullable types a type union', () => {
    expect(zodToJsonSchema(z.string().nullable())).toEqual({ type: ['string', 'null'] });
  });

  it('handles nested objects', () => {
    const schema = z.object({ user: z.object({ id: z.string() }) });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { user: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      required: ['user'],
    });
  });

  it.each([
    ['transform', z.string().transform((s) => s.length), 'ZodEffects'],
    ['refine', z.string().refine((s) => s.length > 0), 'ZodEffects'],
    ['lazy', z.lazy(() => z.string()), 'ZodLazy'],
    ['date', z.date(), 'ZodDate'],
    ['bigint', z.bigint(), 'ZodBigInt'],
    ['function', z.function(), 'ZodFunction'],
  ])('throws SchemaConversionError for %s', (_label, schema, zodType) => {
    expect(() => zodToJsonSchema(schema as z.ZodTypeAny)).toThrowError(SchemaConversionError);
    try {
      zodToJsonSchema(schema as z.ZodTypeAny);
    } catch (err) {
      expect((err as SchemaConversionError).zodType).toBe(zodType);
    }
  });

  it('reports the path to a nested lossy field', () => {
    const schema = z.object({ meta: z.object({ at: z.date() }) });
    const result = tryZodToJsonSchema(schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('meta.at');
  });

  it('tryZodToJsonSchema returns ok for valid schemas', () => {
    const result = tryZodToJsonSchema(z.object({ a: z.string() }));
    expect(result.ok).toBe(true);
  });
});
