export interface PingResult {
  at: number;
  ok: boolean;
  statusCode?: number | null;
  ms: number;
  error?: string;
}

export interface Site {
  id: number;
  name: string;
  url: string;
  intervalMin: number;
  enabled: boolean;
  createdAt: number;
  lastPingAt?: number | null;
  history: PingResult[];
}

export interface User {
  email: string;
}

export const INTERVALS = [1, 5, 6, 7, 10, 13, 14, 30, 60];
export const DEFAULT_INTERVAL_MIN = 10;
