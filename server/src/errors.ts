// Любой 4xx/5xx отдаём как ApiError { error, message }
export class HttpError extends Error {
  statusCode: number
  error: string

  constructor(statusCode: number, error: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.error = error
  }
}

export const notFound = (what = 'Не найдено') => new HttpError(404, 'not_found', what)
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message)

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  416: 'range_not_satisfiable',
}

export function codeFor(status: number): string {
  return CODES[status] ?? (status >= 500 ? 'internal' : 'error')
}

export const forbidden = (message = 'Нет доступа') => new HttpError(403, 'forbidden', message)
