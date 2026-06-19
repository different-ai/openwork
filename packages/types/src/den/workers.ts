export type DenWorkerOwnership = {
  status: string;
  isMine: boolean;
  isShared?: boolean | null;
};

export function isDenWorkerReady(worker: Pick<DenWorkerOwnership, "status">) {
  return worker.status.trim().toLowerCase() === "healthy";
}

export function canConnectDenWorker(worker: DenWorkerOwnership) {
  return isDenWorkerReady(worker) && (worker.isMine || worker.isShared === true);
}

export function countOwnedDenWorkers(workers: readonly DenWorkerOwnership[]) {
  return workers.filter((worker) => worker.isMine).length;
}

export function selectOwnedReadyDenWorker<T extends DenWorkerOwnership>(workers: readonly T[]) {
  return workers.find((worker) => worker.isMine && isDenWorkerReady(worker)) ?? null;
}
