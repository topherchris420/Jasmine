export interface Notice {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function noticePage(options: { app: 'chat' | 'search'; state: 'offline' | 'timeout' | 'unconfigured' | 'missing' }): Notice;
