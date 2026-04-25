export function escapeHtml(value: string): string {
  let escaped = value
  escaped = escaped.replace(/&/g, '&amp;')
  escaped = escaped.replace(/</g, '&lt;')
  escaped = escaped.replace(/>/g, '&gt;')
  escaped = escaped.replace(/"/g, '&quot;')
  return escaped
}
