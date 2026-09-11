import { describe, expect, it } from 'vitest';
import {
  isLoginUrl,
  LOGIN_SELECTORS,
  STUDYDRIVE_NETWORK_ARGS,
} from './studydrive-login';

describe('StudyDrive login helpers', () => {
  it('recognizes localized login URLs with or without a trailing slash', () => {
    expect(isLoginUrl('https://www.studydrive.net/en/login')).toBe(true);
    expect(isLoginUrl('https://www.studydrive.net/de/login/')).toBe(true);
    expect(isLoginUrl('https://www.studydrive.net/en/dashboard')).toBe(false);
  });

  it('prioritizes autocomplete selectors while retaining compatible fallbacks', () => {
    expect(LOGIN_SELECTORS.email).toContain('autocomplete="username"');
    expect(LOGIN_SELECTORS.email).toContain('type="email"');
    expect(LOGIN_SELECTORS.password).toContain('autocomplete="current-password"');
  });

  it('forces HTTP/1.1 when serverless HTTP/2 transport is broken', () => {
    expect(STUDYDRIVE_NETWORK_ARGS).toContain('--disable-http2');
    expect(STUDYDRIVE_NETWORK_ARGS).toContain('--disable-quic');
  });
});
