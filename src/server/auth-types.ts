export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  username?: string;
}

export interface AuthSession {
  token: string;
  username: string;
  expiresAt: number;
}
