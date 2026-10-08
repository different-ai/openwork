const pendingSelections = new Set<object>();

export function beginPendingGatewayModelSelection(): () => void {
  const selection = {};
  pendingSelections.add(selection);
  return () => { pendingSelections.delete(selection); };
}

export function hasPendingGatewayModelSelection(): boolean {
  return pendingSelections.size > 0;
}
