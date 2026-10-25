import type { LogFields, Logger } from '../../core/ports/logger.ts'

export function createJsonLogger(base: LogFields = {}): Logger {
  const write = (level: string, msg: string, fields?: LogFields) => {
    const line = { ts: new Date().toISOString(), level, msg, ...base, ...fields }
    process.stdout.write(`${JSON.stringify(line, errorReplacer)}\n`)
  }
  return {
    info: (msg, fields) => write('info', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createJsonLogger({ ...base, ...fields }),
  }
}

// Error properties are non-enumerable, so JSON.stringify would print {}.
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
  }
  return typeof value === 'bigint' ? value.toString() : value
}
