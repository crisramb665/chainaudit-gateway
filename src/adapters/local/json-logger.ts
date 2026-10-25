import type { LogFields, Logger } from '../../core/ports/logger.ts'

/** One JSON line per log entry on stdout. */
export class JsonLogger implements Logger {
  private readonly base: LogFields

  constructor(base: LogFields = {}) {
    this.base = base
  }

  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields)
  }

  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields)
  }

  child(fields: LogFields): Logger {
    return new JsonLogger({ ...this.base, ...fields })
  }

  private write(level: string, msg: string, fields?: LogFields) {
    const line = { ts: new Date().toISOString(), level, msg, ...this.base, ...fields }
    process.stdout.write(`${JSON.stringify(line, errorReplacer)}\n`)
  }
}

// Error properties are non-enumerable, so JSON.stringify would print {}.
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
  }
  return typeof value === 'bigint' ? value.toString() : value
}
