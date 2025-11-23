import type { Job } from '../shared/types.js';

export type OrchestratorEvent =
  | { type: 'job_created'; data: Job }
  | { type: 'job_updated'; data: Job }
  | { type: 'worktree_changed' };

type EventListener = (event: OrchestratorEvent) => void;

class EventEmitter {
  private listeners: Set<EventListener> = new Set();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: OrchestratorEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in event listener:', error);
      }
    });
  }
}

export const orchestratorEvents = new EventEmitter();
