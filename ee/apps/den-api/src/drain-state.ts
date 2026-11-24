let draining = false

export function markDraining(): void {
  draining = true
}

export function isDraining(): boolean {
  return draining
}
