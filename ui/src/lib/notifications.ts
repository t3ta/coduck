import type { Job } from './types';

class NotificationManager {
  private hasPermission = false;

  async requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) {
      console.warn('This browser does not support notifications');
      return false;
    }

    if (Notification.permission === 'granted') {
      this.hasPermission = true;
      return true;
    }

    if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      this.hasPermission = permission === 'granted';
      return this.hasPermission;
    }

    return false;
  }

  notify(job: Job, type: 'completed' | 'failed'): void {
    if (!this.hasPermission) {
      return;
    }

    const title = type === 'completed'
      ? '✅ ジョブが完了しました'
      : '❌ ジョブが失敗しました';

    const body = `${job.spec_json.goal.slice(0, 100)}${job.spec_json.goal.length > 100 ? '...' : ''}`;

    const notification = new Notification(title, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: job.id,
      requireInteraction: false,
      silent: false,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    // Auto-close after 5 seconds
    setTimeout(() => {
      notification.close();
    }, 5000);
  }
}

export const notificationManager = new NotificationManager();
