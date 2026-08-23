export interface AgentMailConfig {
  apiKey: string;
  inboxId: string;
  apiBaseUrl?: string;
  websocketUrl?: string;
  maxMessageBytes?: number;
  fetch?: typeof fetch;
  websocketFactory?: WebSocketFactory;
}

export interface WebSocketEventLike {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: WebSocketEventLike) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
