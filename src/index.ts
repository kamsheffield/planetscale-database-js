import { format } from './sanitization.js'
export { format } from './sanitization.js'
export { hex } from './text.js'
import { decode } from './text.js'
import { Version } from './version.js'

type Row = Record<string, any> | any[]

interface VitessError {
  message: string
  code: string
}

export class DatabaseError extends Error {
  body: VitessError
  status: number
  constructor(message: string, status: number, body: VitessError) {
    super(message)
    this.status = status
    this.name = 'DatabaseError'
    this.body = body
  }
}

type Types = Record<string, string>

export interface ExecutedQuery {
  headers: string[]
  types: Types
  rows: Row[]
  fields: Field[]
  size: number
  statement: string
  insertId: string
  rowsAffected: number
  time: number
}

type Req = {
  method: string
  headers: Record<string, string>
  body: string
  // cache?: RequestCache
  // TODO: Reimplement cache when it is available on Cloudflare Workers
  // issue: https://github.com/planetscale/database-js/issues/101
  // change: https://github.com/planetscale/database-js/pull/102
  // bug: https://github.com/cloudflare/workerd/issues/698
}

type Res = {
  ok: boolean
  status: number
  statusText: string
  json(): Promise<any>
  text(): Promise<string>
}

export type Cast = typeof cast

export interface Config {
  url?: string
  username?: string
  password?: string
  host?: string
  fetch?: (input: string, init?: Req) => Promise<Res>
  format?: (query: string, args: any) => string
  cast?: Cast
}

interface QueryResultRow {
  lengths: string[]
  values?: string
}

export interface Field {
  name: string
  type: string
  table?: string

  // Only populated for included fields
  orgTable?: string | null
  database?: string | null
  orgName?: string | null

  columnLength?: number | null
  charset?: number | null
  flags?: number | null
  columnType?: string | null
}

type QuerySession = unknown

interface QueryExecuteResponse {
  session: QuerySession
  result: QueryResult | null
  error?: VitessError
  timing?: number // duration in seconds
}

interface QueryResult {
  rowsAffected?: string | null
  insertId?: string | null
  fields?: Field[] | null
  rows?: QueryResultRow[]
}

type ExecuteAs = 'array' | 'object'

type ExecuteOptions = {
  as?: ExecuteAs
  cast?: Cast
}

type ExecuteArgs = object | any[] | null

const defaultExecuteOptions: ExecuteOptions = {
  as: 'object'
}

export class Client {
  private config: Config

  constructor(config: Config) {
    this.config = config
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.connection().transaction(fn)
  }

  async execute(
    query: string,
    args: ExecuteArgs = null,
    options: ExecuteOptions = defaultExecuteOptions
  ): Promise<ExecutedQuery> {
    return this.connection().execute(query, args, options)
  }

  connection(): Connection {
    return new Connection(this.config)
  }
}

export type Transaction = Tx

class Tx {
  private conn: Connection

  constructor(conn: Connection) {
    this.conn = conn
  }

  async execute(
    query: string,
    args: ExecuteArgs = null,
    options: ExecuteOptions = defaultExecuteOptions
  ): Promise<ExecutedQuery> {
    return this.conn.execute(query, args, options)
  }
}

export class Connection {
  private config: Config
  private session: QuerySession | null

  constructor(config: Config) {
    this.session = null
    this.config = { ...config }

    if (typeof fetch !== 'undefined') {
      this.config.fetch ||= fetch
    }

    if (config.url) {
      const url = new URL(config.url)
      this.config.username = url.username
      this.config.password = url.password
      this.config.host = url.hostname
    }
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const conn = new Connection(this.config) // Create a new connection specifically for the transaction
    const tx = new Tx(conn)

    try {
      await tx.execute('BEGIN')
      const res = await fn(tx)
      await tx.execute('COMMIT')

      return res
    } catch (err) {
      await tx.execute('ROLLBACK')
      throw err
    }
  }

  async refresh(): Promise<void> {
    await this.createSession()
  }

  async execute(
    query: string,
    args: ExecuteArgs = null,
    options: ExecuteOptions = defaultExecuteOptions
  ): Promise<ExecutedQuery> {
    const url = new URL('/psdb.v1alpha1.Database/Execute', `https://${this.config.host}`)

    const formatter = this.config.format || format
    const sql = args ? formatter(query, args) : query

    const saved = await postJSON<QueryExecuteResponse>(this.config, url, { query: sql, session: this.session })

    const { result, session, error, timing } = saved
    if (error) {
      throw new DatabaseError(error.message, 400, error)
    }

    const rowsAffected = result?.rowsAffected ? parseInt(result.rowsAffected, 10) : 0
    const insertId = result?.insertId ?? '0'

    this.session = session

    const fields = result?.fields ?? []
    // ensure each field has a type assigned,
    // the only case it would be omitted is in the case of
    // NULL due to the protojson spec. NULL in our enum
    // is 0, and empty fields are omitted from the JSON response,
    // so we should backfill an expected type.
    for (const field of fields) {
      field.type ||= 'NULL'
    }

    const castFn = options.cast || this.config.cast || cast
    const rows = result ? parse(result, castFn, options.as || 'object') : []
    const headers = fields.map((f) => f.name)

    const typeByName = (acc, { name, type }) => ({ ...acc, [name]: type })
    const types = fields.reduce<Types>(typeByName, {})
    const timingSeconds = timing ?? 0

    return {
      headers,
      types,
      fields,
      rows,
      rowsAffected,
      insertId,
      size: rows.length,
      statement: sql,
      time: timingSeconds * 1000
    }
  }

  private async createSession(): Promise<QuerySession> {
    const url = new URL('/psdb.v1alpha1.Database/CreateSession', `https://${this.config.host}`)
    const { session } = await postJSON<QueryExecuteResponse>(this.config, url)
    this.session = session
    return session
  }
}

async function postJSON<T>(config: Config, url: string | URL, body = {}): Promise<T> {
  const auth = btoa(`${config.username}:${config.password}`)
  const { fetch } = config

  // Add additional error handling logic to fetch
  // to allow us to throw a more specific error if there is one.
  let response
  try {
    response = await fetch(url.toString(), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `database-js/${Version}`,
        Authorization: `Basic ${auth}`
      },
      // cache: 'no-store'
      // TODO reimplement cache when it is available on cloudlfare, see above.
    })
  } catch (error) {
    if (error.cause) {
      throw error.cause
    } else {
      throw error
    }
  }

  if (response.ok) {
    return await response.json()
  } else {
    let error = null
    try {
      const e = (await response.json()).error
      error = new DatabaseError(e.message, response.status, e)
    } catch {
      error = new DatabaseError(response.statusText, response.status, {
        code: 'internal',
        message: response.statusText
      })
    }
    throw error
  }
}

export function connect(config: Config): Connection {
  return new Connection(config)
}

function parseArrayRow(fields: Field[], rawRow: QueryResultRow, cast: Cast): Row {
  const row = decodeRow(rawRow)

  return fields.map((field, ix) => {
    return cast(field, row[ix])
  })
}

function parseObjectRow(fields: Field[], rawRow: QueryResultRow, cast: Cast): Row {
  const row = decodeRow(rawRow)

  return fields.reduce((acc, field, ix) => {
    acc[field.name] = cast(field, row[ix])
    return acc
  }, {} as Row)
}

function parse(result: QueryResult, cast: Cast, returnAs: ExecuteAs): Row[] {
  const fields = result.fields
  const rows = result.rows ?? []
  return rows.map((row) =>
    returnAs === 'array' ? parseArrayRow(fields, row, cast) : parseObjectRow(fields, row, cast)
  )
}

function decodeRow(row: QueryResultRow): Array<string | null> {
  const values = row.values ? atob(row.values) : ''
  let offset = 0
  return row.lengths.map((size) => {
    const width = parseInt(size, 10)
    // Negative length indicates a null value.
    if (width < 0) return null
    const splice = values.substring(offset, offset + width)
    offset += width
    return splice
  })
}

export function cast(field: Field, value: string | null): any {
  if (value === '' || value == null) {
    return value
  }

  switch (field.type) {
    case 'INT8':
    case 'INT16':
    case 'INT24':
    case 'INT32':
    case 'UINT8':
    case 'UINT16':
    case 'UINT24':
    case 'UINT32':
    case 'YEAR':
      return parseInt(value, 10)
    case 'FLOAT32':
    case 'FLOAT64':
      return parseFloat(value)
    case 'DECIMAL':
    case 'INT64':
    case 'UINT64':
    case 'DATE':
    case 'TIME':
    case 'DATETIME':
    case 'TIMESTAMP':
    case 'BLOB':
    case 'BIT':
    case 'VARBINARY':
    case 'BINARY':
    case 'GEOMETRY':
      return value
    case 'JSON':
      return JSON.parse(decode(value))
    default:
      return decode(value)
  }
}
