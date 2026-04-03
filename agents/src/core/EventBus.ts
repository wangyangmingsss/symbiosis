/**
 * EventBus -- lightweight in-process pub/sub for inter-agent communication.
 *
 * Agents use this to signal each other without on-chain transactions,
 * e.g. broadcasting freshly computed data or alpha signals so
 * downstream agents can react within the same process.
 */

type Handler<T = any> = (data: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<T = any>(event: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return disposer
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /** Emit an event to all subscribers. Errors in handlers are logged, not thrown. */
  async emit<T = any>(event: string, data: T): Promise<void> {
    const subscribers = this.handlers.get(event);
    if (!subscribers || subscribers.size === 0) return;

    const promises = [...subscribers].map(async (handler) => {
      try {
        await handler(data);
      } catch (err) {
        console.warn(`[EventBus] Handler error for "${event}":`, err);
      }
    });

    await Promise.allSettled(promises);
  }

  /** Remove all handlers for an event (or all events if no arg). */
  clear(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  /** Number of listeners for a given event. */
  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/** Singleton event bus shared across all agents in the process. */
export const globalBus = new EventBus();
