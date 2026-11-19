/**
 * Side-by-side placement for overlapping timed blocks in one day column.
 * Blocks that overlap (directly or through a chain) form a cluster; each gets
 * the first free column, and every block in a cluster shares its column count.
 */
export type TimedBlock = { key: string; start: number; end: number }
export type BlockPlacement = { column: number; columns: number }

export function layoutOverlappingBlocks(blocks: readonly TimedBlock[]): Map<string, BlockPlacement> {
  const sorted = [...blocks].sort((left, right) => left.start - right.start || right.end - left.end || left.key.localeCompare(right.key))
  const placements = new Map<string, BlockPlacement>()
  let cluster: Array<{ key: string; column: number }> = []
  let columnEnds: number[] = []
  let clusterEnd = Number.NEGATIVE_INFINITY
  const closeCluster = () => {
    for (const entry of cluster) placements.set(entry.key, { column: entry.column, columns: columnEnds.length })
    cluster = []
    columnEnds = []
  }
  for (const block of sorted) {
    const end = Math.max(block.end, block.start + 1)
    if (block.start >= clusterEnd) closeCluster()
    let column = columnEnds.findIndex((columnEnd) => columnEnd <= block.start)
    if (column === -1) {
      column = columnEnds.length
      columnEnds.push(end)
    } else {
      columnEnds[column] = end
    }
    cluster.push({ key: block.key, column })
    clusterEnd = cluster.length === 1 ? end : Math.max(clusterEnd, end)
  }
  closeCluster()
  return placements
}
