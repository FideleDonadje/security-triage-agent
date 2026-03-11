export const API_URL = (import.meta.env.VITE_API_URL as string ?? '').replace(/\/$/, '');
export const USER_POOL_ID = import.meta.env.VITE_USER_POOL_ID as string ?? '';
export const CLIENT_ID = import.meta.env.VITE_CLIENT_ID as string ?? '';
export const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string ?? '';
