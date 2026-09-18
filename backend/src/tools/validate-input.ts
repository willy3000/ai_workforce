import type { LlmToolDefinition } from '../services/llm/types';

/**
 * Runtime validation of model-supplied tool arguments against the tool's own
 * JSON schema.
 *
 * Audit finding S7: "Runtime JSON tool schemas are sent to the model but not
 * validated before execution; TypeScript interfaces disappear at runtime." The
 * tool declared `input: { path: string; content: string }`, the model sent
 * `{ path: 42 }`, and the tool ran with `input.path === 42` — reaching `fs` and
 * the permission guard with a non-string. Every tool would otherwise need its
 * own defensive parsing; validating once against the schema the model was given
 * keeps the contract in a single place.
 *
 * ## Why not a JSON Schema library
 * The schemas here use a deliberately small subset — object, string, integer,
 * number, boolean, array-of-scalar, `required`, `additionalProperties: false`,
 * and `enum`. Implementing that subset is ~80 lines with no dependency and no
 * ambiguity about which draft is in effect. If the schemas grow to need `oneOf`,
 * `$ref` or conditional subschemas, replace this with Ajv rather than extending
 * it: a partial implementation that silently passes what it does not understand
 * is worse than no implementation, which is why unknown keywords here are
 * ignored only for *constraints*, never for types.
 */

export interface ValidationSuccess {
  ok: true;
  /** The input, with unspecified-but-allowed properties preserved. */
  value: Record<string, unknown>;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

type JsonSchema = LlmToolDefinition['input_schema'];

interface PropertySchema {
  type?: string;
  enum?: unknown[];
  items?: PropertySchema;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** Hard ceiling on any string argument, so one call cannot carry a megabyte. */
const MAX_STRING_LENGTH = 400_000;
const MAX_ARRAY_LENGTH = 500;

export function validateToolInput(
  schema: JsonSchema,
  input: unknown,
): ValidationSuccess | ValidationFailure {
  const errors: string[] = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['expected an object of arguments'] };
  }
  const value = input as Record<string, unknown>;

  const shape = schema as {
    properties?: Record<string, PropertySchema>;
    required?: string[];
    additionalProperties?: boolean;
  };
  const properties = shape.properties ?? {};
  const required = shape.required ?? [];

  for (const key of required) {
    if (value[key] === undefined || value[key] === null) {
      errors.push(`'${key}' is required`);
    }
  }

  if (shape.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push(`'${key}' is not a recognised argument (allowed: ${Object.keys(properties).join(', ')})`);
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    const provided = value[key];
    if (provided === undefined || provided === null) continue;
    errors.push(...checkValue(key, provided, propertySchema));
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}

function checkValue(path: string, value: unknown, schema: PropertySchema): string[] {
  const errors: string[] = [];

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`'${path}' must be a string, received ${describe(value)}`);
        break;
      }
      if (value.length > (schema.maxLength ?? MAX_STRING_LENGTH)) {
        errors.push(
          `'${path}' is ${value.length} characters, over the ${schema.maxLength ?? MAX_STRING_LENGTH} limit`,
        );
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`'${path}' must be at least ${schema.minLength} characters`);
      }
      break;

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`'${path}' must be an integer, received ${describe(value)}`);
      }
      break;

    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`'${path}' must be a finite number, received ${describe(value)}`);
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`'${path}' must be a boolean, received ${describe(value)}`);
      }
      break;

    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`'${path}' must be an array, received ${describe(value)}`);
        break;
      }
      if (value.length > MAX_ARRAY_LENGTH) {
        errors.push(`'${path}' has ${value.length} items, over the ${MAX_ARRAY_LENGTH} limit`);
        break;
      }
      if (schema.items) {
        value.forEach((item, index) => {
          errors.push(...checkValue(`${path}[${index}]`, item, schema.items as PropertySchema));
        });
      }
      break;
    }

    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`'${path}' must be an object, received ${describe(value)}`);
      }
      break;

    default:
      // No declared type: nothing to check. Constraints below still apply.
      break;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`'${path}' must be one of: ${schema.enum.map(String).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`'${path}' must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`'${path}' must be <= ${schema.maximum}`);
    }
  }

  return errors;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
