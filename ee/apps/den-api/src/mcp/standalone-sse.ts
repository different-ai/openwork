export function rejectStandaloneSseResponse() {
  return new Response(null, { status: 405, headers: { allow: "POST" } })
}
