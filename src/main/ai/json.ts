/**
 * Structured JSON output handling.
 *
 * Native schema-constrained output is attempted first (response_format:
 * json_schema). When unavailable/unreliable, we fall back to:
 *   strict JSON instruction → parse → schema validate → one repair request.
 * We never guess missing structural fields.
 */

export interface JSONSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, JSONSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JSONSchema
  minItems?: number
  maxItems?: number
  enum?: (string | number | boolean)[]
  anyOf?: JSONSchema[]
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

export function validate(schema: JSONSchema, value: unknown, path = '$'): ValidationResult {
  if (schema.anyOf) {
    for (const sub of schema.anyOf) {
      const r = validate(sub, value, path)
      if (r.ok) return { ok: true, errors: [] }
    }
    return { ok: false, errors: [`${path}: does not match anyOf`] }
  }
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, errors: [`${path}: expected object`] }
      }
      const obj = value as Record<string, unknown>
      const errors: string[] = []
      for (const key of schema.required ?? []) {
        if (!(key in obj)) errors.push(`${path}.${key}: required`)
      }
      // additional AI-provided keys are tolerated; required + type checks carry
      // the contract. Unknown keys are ignored rather than failing the op.
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (!(key in obj)) continue
        const r = validate(sub, obj[key], `${path}.${key}`)
        errors.push(...r.errors)
      }
      return { ok: errors.length === 0, errors }
    }
    case 'array': {
      if (!Array.isArray(value)) return { ok: false, errors: [`${path}: expected array`] }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return { ok: false, errors: [`${path}: fewer than ${schema.minItems} items`] }
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return { ok: false, errors: [`${path}: more than ${schema.maxItems} items`] }
      }
      const errors: string[] = []
      value.forEach((item, i) => {
        if (schema.items) errors.push(...validate(schema.items, item, `${path}[${i}]`).errors)
      })
      return { ok: errors.length === 0, errors }
    }
    case 'string': {
      if (typeof value !== 'string') return { ok: false, errors: [`${path}: expected string`] }
      if (schema.enum && !schema.enum.includes(value)) {
        return { ok: false, errors: [`${path}: must be one of ${schema.enum.join(', ')}`] }
      }
      return { ok: true, errors: [] }
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number') return { ok: false, errors: [`${path}: expected number`] }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        return { ok: false, errors: [`${path}: expected integer`] }
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return { ok: false, errors: [`${path}: must be one of ${schema.enum.join(', ')}`] }
      }
      return { ok: true, errors: [] }
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, errors: [] }
        : { ok: false, errors: [`${path}: expected boolean`] }
    case 'null':
      return value === null ? { ok: true, errors: [] } : { ok: false, errors: [`${path}: expected null`] }
    default:
      return { ok: true, errors: [] }
  }
}

/**
 * Extract a balanced JSON value from model text (tolerates fenced output and
 * leading/trailing prose). Prefers the first balanced OBJECT: practically all
 * structured operations expect an object at the root, and models sometimes
 * emit a stray array before the real answer, which would otherwise win.
 */
export function extractJson(raw: string): unknown {
  let text = raw.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim()
  const tryParseBalanced = (openAt: number, open: '{' | '['): { ok: boolean; value?: unknown } => {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = openAt; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === open) depth++
      else if ((open === '{' && ch === '}') || (open === '[' && ch === ']')) {
        depth--
        if (depth === 0) {
          const slice = text.slice(openAt, i + 1)
          try {
            return { ok: true, value: JSON.parse(slice) }
          } catch {
            return { ok: false }
          }
        }
      }
    }
    return { ok: false }
  }

  // 1) try balanced objects from every '{' (a '}' closes after nested '{'s)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const r = tryParseBalanced(i, '{')
      if (r.ok) return r.value
    }
  }
  // 2) fall back to balanced arrays
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      const r = tryParseBalanced(i, '[')
      if (r.ok) return r.value
    }
  }
  throw new Error('no valid JSON object or array found in model output')
}

/** Full pipeline: extract → normalize → validate. Throws StructuredOutputError. */
export function parseStructured<T>(raw: string, schema: JSONSchema, normalize?: (value: unknown) => unknown): T {
  let value: unknown
  try {
    value = extractJson(raw)
  } catch (e) {
    throw new StructuredOutputError(`Could not parse model output as JSON: ${(e as Error).message}`)
  }
  if (normalize) value = normalize(value)
  const v = validate(schema, value)
  if (!v.ok) {
    throw new StructuredOutputError(`Model output failed schema validation: ${v.errors.join('; ')}`)
  }
  return value as T
}

export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StructuredOutputError'
  }
}

/** JSON Schema objects for each structured operation. */
export const Schemas = {
  summary: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false
  } as JSONSchema,

  features: {
    type: 'object',
    properties: {
      features: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            summary: { type: 'string' },
            searchHints: { type: 'array', items: { type: 'string' } }
          },
          required: ['name'],
          additionalProperties: false
        }
      }
    },
    required: ['features'],
    additionalProperties: false
  } as JSONSchema,

  featureResolution: {
    type: 'object',
    properties: {
      feature: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' },
            importance: { type: 'string', enum: ['primary', 'secondary'] },
            locations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  startLine: { type: 'integer' },
                  endLine: { type: 'integer' }
                },
                required: ['label', 'startLine', 'endLine'],
                additionalProperties: false
              }
            }
          },
          required: ['path', 'reason', 'importance', 'locations'],
          additionalProperties: false
        }
      }
    },
    required: ['feature', 'files'],
    additionalProperties: false
  } as JSONSchema,

  fileOverview: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' }
          },
          required: ['title', 'startLine', 'endLine'],
          additionalProperties: false
        }
      },
      relatedFiles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' },
            relationshipType: { type: 'string', enum: ['direct', 'semantic'] }
          },
          required: ['path', 'reason', 'relationshipType'],
          additionalProperties: false
        }
      }
    },
    required: ['summary'], // sections/relatedFiles default to [] when omitted
    additionalProperties: false
  } as JSONSchema,

  aiSearchExpand: {
    type: 'object',
    properties: {
      concepts: { type: 'array', items: { type: 'string' } },
      likelySymbols: { type: 'array', items: { type: 'string' } },
      likelyFileTerms: { type: 'array', items: { type: 'string' } }
    },
    required: [],
    additionalProperties: false
  } as JSONSchema,

  aiSearchFinal: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' },
            reason: { type: 'string' }
          },
          required: ['path', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['summary'],
    additionalProperties: false
  } as JSONSchema,

  edits: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['replace', 'insert', 'create', 'delete'] },
            path: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' },
            replacement: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['operation', 'path'],
          additionalProperties: false
        }
      }
    },
    required: ['summary', 'edits'],
    additionalProperties: false
  } as JSONSchema,

  codebasePlan: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['path', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['summary', 'files'],
    additionalProperties: false
  } as JSONSchema,

  sessionSummary: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'summary', 'files'],
    additionalProperties: false
  } as JSONSchema
}