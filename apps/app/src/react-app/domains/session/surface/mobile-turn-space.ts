/** Remaining space below a submitted turn, consumed as the answer grows. */
export function mobileTurnSpace(viewportHeight: number, turnHeight: number) {
  return Math.max(0, Math.ceil(viewportHeight - Math.max(0, turnHeight)));
}
