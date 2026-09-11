import { describe, expect, it } from 'vitest';
import {
  isLoginUrl,
  LOGIN_SELECTORS,
  mergeSetCookies,
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

  it('merges response cookies without truncating values containing equals signs', () => {
    const cookies = new Map<string, string>([['existing', 'one']]);
    const headers = new Headers();
    headers.append('set-cookie', 'sd_session=abc==; Path=/; HttpOnly');

    mergeSetCookies(cookies, headers);

    expect(cookies.get('existing')).toBe('one');
    expect(cookies.get('sd_session')).toBe('abc==');
  });
});
