// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECTOR, autoAttach, readScriptConfig } from '../src/autoattach.js';
import { readSessionIdFromUrl } from '../src/core.js';

const API_BASE = 'https://api.example.test';

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

function scriptTag(attrs: Record<string, string>): HTMLScriptElement {
  const script = document.createElement('script');
  for (const [key, value] of Object.entries(attrs)) script.setAttribute(key, value);
  document.head.append(script);
  return script;
}

describe('readScriptConfig', () => {
  it('reads configuration off the script tag', () => {
    const script = scriptTag({
      'data-disdk-auto': '',
      'data-api-base': API_BASE,
      'data-selector': '#pay',
      'data-theme': 'dark',
      'data-ui': 'headless',
      'data-session-param': 'sid',
    });

    expect(readScriptConfig(script)).toEqual({
      apiBase: API_BASE,
      selector: '#pay',
      theme: 'dark',
      ui: 'headless',
      sessionParam: 'sid',
    });
  });

  it('ignores a script tag without the auto flag', () => {
    expect(readScriptConfig(scriptTag({ 'data-api-base': API_BASE }))).toBeNull();
  });

  it('refuses to initialise without an API base', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readScriptConfig(scriptTag({ 'data-disdk-auto': '' }))).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('rejects a bogus theme rather than passing it through', () => {
    const config = readScriptConfig(
      scriptTag({ 'data-disdk-auto': '', 'data-api-base': API_BASE, 'data-theme': 'neon' }),
    );
    expect(config?.theme).toBeUndefined();
  });
});

describe('autoAttach', () => {
  it('binds a button by its id, with no page JavaScript', () => {
    document.body.innerHTML = '<button id="connect-wallet">Connect Wallet</button>';
    const { disdk, stop } = autoAttach({ apiBase: API_BASE });

    const button = document.querySelector('#connect-wallet') as HTMLButtonElement;
    expect(button.getAttribute('data-disdk-state')).toBe('idle');

    // Clicking starts the flow; with no session in the URL it reports an error
    // rather than throwing at the page.
    const errors: unknown[] = [];
    disdk.on('error', (error) => errors.push(error));
    button.click();

    return Promise.resolve().then(() => {
      expect(errors.length).toBeGreaterThan(0);
      stop();
    });
  });

  it('also binds the data attribute form', () => {
    document.body.innerHTML = '<a href="#" data-disdk-connect>Link wallet</a>';
    const { stop } = autoAttach({ apiBase: API_BASE });

    expect(
      document.querySelector('[data-disdk-connect]')?.getAttribute('data-disdk-state'),
    ).toBe('idle');
    stop();
  });

  it('binds buttons added later, so single-page apps work', async () => {
    const { stop } = autoAttach({ apiBase: API_BASE });

    const button = document.createElement('button');
    button.id = 'connect-wallet';
    document.body.append(button);

    // MutationObserver callbacks are delivered as microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.getAttribute('data-disdk-state')).toBe('idle');
    stop();
  });

  it('binds a button nested inside a later-added subtree', async () => {
    const { stop } = autoAttach({ apiBase: API_BASE });

    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<section><button id="connect-wallet">Go</button></section>';
    document.body.append(wrapper);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wrapper.querySelector('button')?.getAttribute('data-disdk-state')).toBe('idle');
    stop();
  });

  it('reflects flow state onto the button and dispatches a DOM error event', async () => {
    document.body.innerHTML = '<button id="connect-wallet">Connect Wallet</button>';
    const { stop } = autoAttach({ apiBase: API_BASE });
    const button = document.querySelector('#connect-wallet') as HTMLButtonElement;

    const seen: string[] = [];
    button.addEventListener('disdk:error', (event) => {
      seen.push((event as CustomEvent<{ code: string }>).detail.code);
    });

    // No session id in the URL, so the flow fails immediately — which is enough
    // to prove the button reflects state and the page gets a DOM event.
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(button.getAttribute('data-disdk-state')).toBe('error');
    expect(seen).toContain('SESSION_NOT_FOUND');
    // The label returns to what the page author wrote.
    expect(button.textContent).toBe('Connect Wallet');
    stop();
  });

  it('does not double-bind the same element', () => {
    document.body.innerHTML = '<button id="connect-wallet">Connect</button>';
    const button = document.querySelector('#connect-wallet') as HTMLButtonElement;
    const spy = vi.spyOn(button, 'addEventListener');

    const first = autoAttach({ apiBase: API_BASE });
    const countAfterFirst = spy.mock.calls.filter(([type]) => type === 'click').length;
    const second = autoAttach({ apiBase: API_BASE });
    const countAfterSecond = spy.mock.calls.filter(([type]) => type === 'click').length;

    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(1);
    first.stop();
    second.stop();
  });

  it('uses the documented default selector', () => {
    expect(DEFAULT_SELECTOR).toBe('#connect-wallet, [data-disdk-connect]');
  });
});

describe('readSessionIdFromUrl', () => {
  const setUrl = (url: string) => {
    window.history.replaceState({}, '', url);
  };

  it('reads the session id from the query string', () => {
    setUrl('/connect?ds=abc123DEF456ghi789');
    expect(readSessionIdFromUrl()).toBe('abc123DEF456ghi789');
  });

  it('reads it from the fragment, which keeps it out of server logs', () => {
    setUrl('/connect#ds=abc123DEF456ghi789');
    expect(readSessionIdFromUrl()).toBe('abc123DEF456ghi789');
  });

  it('reads a path-style link', () => {
    setUrl('/c/abc123DEF456ghi789');
    expect(readSessionIdFromUrl()).toBe('abc123DEF456ghi789');
  });

  it('honours a custom parameter name', () => {
    setUrl('/connect?sid=abc123DEF456ghi789');
    expect(readSessionIdFromUrl('sid')).toBe('abc123DEF456ghi789');
  });

  it('returns null when there is no link', () => {
    setUrl('/connect');
    expect(readSessionIdFromUrl()).toBeNull();
  });
});
