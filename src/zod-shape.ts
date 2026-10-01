/**
 * JSON Schema → Zod raw shape for the SDK MCP server.
 *
 * `createSdkMcpServer()` silently degrades an unrecognized schema to an empty
 * object, which leaves the model with no parameter information. The Harness
 * declares tool parameters as JSON Schema, so they are translated here.
 */

import { z, type ZodTypeAny } from 'zod'

function propertyToZod(property: Record<string, unknown>): ZodTypeAny {
  if (Array.isArray(property.enum)) return z.enum(property.enum as [string, ...string[]])
  let base: ZodTypeAny
  switch (property.type) {
    case 'string':
      base = z.string()
      break
    case 'number':
    case 'integer':
      base = z.number()
      break
    case 'boolean':
      base = z.boolean()
      break
    case 'array':
      base = property.items
        ? z.array(propertyToZod(property.items as Record<string, unknown>))
        : z.array(z.unknown())
      break
    case 'object':
      base = z.record(z.string(), z.unknown())
      break
    default:
      base = z.unknown()
  }
  return typeof property.description === 'string' ? base.describe(property.description) : base
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, ZodTypeAny> {
  const object = schema as Record<string, unknown> | undefined
  if (!object || object.type !== 'object' || !object.properties) return {}
  const properties = object.properties as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(object.required) ? object.required as string[] : [])
  const shape: Record<string, ZodTypeAny> = {}
  for (const [key, property] of Object.entries(properties)) {
    const zodProperty = propertyToZod(property)
    shape[key] = required.has(key) ? zodProperty : zodProperty.optional()
  }
  return shape
}
