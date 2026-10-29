// Set once when this process starts its graceful shutdown. `/ready` reads it
// so nothing treats a draining instance as ready for new traffic.
let draining = false

export function markDraining(): void {
  draining = true
}

export function isDraining(): boolean {
  return draining
}
