export function mobileTurnSpace(viewportHeight: number, turnHeight: number) {
  return Math.max(0, Math.ceil(viewportHeight - Math.max(0, turnHeight)));
}
