function stringParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : ""
}

function safeNext(value: string): string {
  return value === "/" || value.startsWith("/?") ? value : "/"
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; next?: string | string[] }>
}) {
  const params = await searchParams
  const invalid = stringParam(params.error) === "invalid"
  const next = safeNext(stringParam(params.next))
  return <main className="login-shell">
    <section className="login-card">
      <div>
        <p className="eyebrow">OpenWork Enterprise</p>
        <h1>Diagnostics</h1>
        <p className="login-intro">Sign in to inspect safely redacted enterprise connectivity requests.</p>
      </div>
      {invalid ? <p className="login-error" role="alert">The username or password is incorrect.</p> : null}
      <form action="/api/dashboard-session" className="login-form" method="post">
        <input name="next" type="hidden" value={next} />
        <label>
          <span>Username</span>
          <input autoComplete="username" autoFocus name="username" required type="text" />
        </label>
        <label>
          <span>Password</span>
          <input autoComplete="current-password" name="password" required type="password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p className="login-note">Administrator access is configured by deployment environment variables.</p>
    </section>
  </main>
}
