export function notImplemented(name: string, how: string): never {
  throw new Error(`${name} not implemented: ${how}`);
}
