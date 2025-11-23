import type { Job } from './types';

type SSEEvent =
  | { type: 'job_created'; data: Job }
  | { type: 'job_updated'; data: Job }
  | { type: 'worktree_changed' }
  | { type: 'log_appended'; data: { jobId: string; stream: 'stdout' | 'stderr'; text: string } };

type SSEListener = (event: SSEEvent) => void;

class SSEClient {
  private eventSource: EventSource | null = null;
  private listeners: Set<SSEListener> = new Set();
  private reconnectTimer: number | null = null;
  private readonly reconnectDelay = 5000; // 5 seconds

  connect(): void {
    if (this.eventSource) {
      return; // Already connected
    }

    try {
      this.eventSource = new EventSource('/events');

      this.eventSource.addEventListener('job_created', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        this.emit({ type: 'job_created', data });
      });

      this.eventSource.addEventListener('job_updated', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        this.emit({ type: 'job_updated', data });
      });

      this.eventSource.addEventListener('worktree_changed', () => {
        this.emit({ type: 'worktree_changed' });
      });

      this.eventSource.addEventListener('log_appended', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        this.emit({ type: 'log_appended', data });
      });

      this.eventSource.onerror = () => {
        console.warn('SSE connection error, will reconnect...');
        this.disconnect();
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error('Failed to connect to SSE:', error);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return; // Already scheduled
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }

  on(listener: SSEListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SSEEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in SSE listener:', error);
      }
    });
  }
}

export const sseClient = new SSEClient();
