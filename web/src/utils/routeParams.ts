export type RouteParamValue = string | (string | null)[] | null | undefined

export function firstRouteParam(value: RouteParamValue): string {
  if (!value) return ''
  return Array.isArray(value) ? (value[0] ?? '') : value
}

export function routePathParam(value: RouteParamValue): string {
  if (!value) return ''
  return Array.isArray(value) ? value.join('/') : value
}
