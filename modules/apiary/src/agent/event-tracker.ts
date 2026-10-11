/**
 * Deduplication and delivery tracking for event IDs.
 *
 * Both `_processedIds` and `_deliveredIds` are bounded by FIFO halving so a
 * long-running agent between compactions can't bloat memory (and, transitively,
 * its own LLM context if it re-reads tracker state).
 *
 * Halving keeps the newer half — older IDs are dropped. Re-delivery of a
 * dropped ID would require the same event to re-appear from the source, which
 * the SSE multiplexer does not do.
 */

const PROCESSED_CAP = 500;
const DELIVERED_CAP = 5000;

export class EventTracker {
  private _processedIds = new Set<string>();
  private _deliveredIds = new Set<string>();

  /** Returns true if this event was already processed (and adds it if not). */
  isDuplicate(id: string): boolean {
    if (this._processedIds.has(id)) return true;
    this._processedIds.add(id);
    if (this._processedIds.size > PROCESSED_CAP) {
      this._processedIds = halve(this._processedIds);
    }
    return false;
  }

  isDelivered(id: string): boolean {
    return this._deliveredIds.has(id);
  }

  markDelivered(id: string): void {
    this._deliveredIds.add(id);
    if (this._deliveredIds.size > DELIVERED_CAP) {
      this._deliveredIds = halve(this._deliveredIds);
    }
  }

  markManyDelivered(ids: string[]): void {
    for (const id of ids) {
      this._deliveredIds.add(id);
      this._processedIds.add(id);
    }
    if (this._deliveredIds.size > DELIVERED_CAP) this._deliveredIds = halve(this._deliveredIds);
    if (this._processedIds.size > PROCESSED_CAP) this._processedIds = halve(this._processedIds);
  }

  clearDelivered(): void {
    this._deliveredIds.clear();
  }

  clearAll(): void {
    this._processedIds.clear();
    this._deliveredIds.clear();
  }
}

function halve(set: Set<string>): Set<string> {
  const arr = [...set];
  return new Set(arr.slice(arr.length >> 1));
}
