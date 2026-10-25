export type LogFields = Record<string, unknown>

export interface Logger {
  info(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Returns a logger that adds `fields` (e.g. trace_id) to every line. */
  child(fields: LogFields): Logger
}
