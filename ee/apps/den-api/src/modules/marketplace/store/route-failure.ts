export class PluginArchRouteFailure extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly error: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "PluginArchRouteFailure"
  }
}
