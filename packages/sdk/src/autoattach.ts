/**
 * Zero-JavaScript integration.
 *
 * A page includes one script tag and marks a button; the SDK finds it, wires
 * the click, reflects progress back onto the button, and dispatches DOM events
 * the host page can listen to without importing anything.
 */

import type { CompleteResponse } from '@disdk/protocol';
import { createDisdk, type Disdk, type DisdkConfig } from './core.js';
import type { DisdkState } from './events.js';
import type { Theme } from './ui/modal.js';

export const DEFAULT_SELECTOR = '#connect-wallet, [data-disdk-connect]';

export interface AutoAttachOptions extends DisdkConfig {
  selector?: string;
  /** Keep binding buttons that appear later. Needed for single-page apps. */
  observe?: boolean;
}

const BOUND = new WeakSet<Element>();

const DEFAULT_LABELS: Partial<Record<DisdkState, string>> = {
  connecting: 'Connecting…',
  reviewing: 'Review in wallet…',
  permitting: 'Confirm in wallet…',
};

export function autoAttach(options: AutoAttachOptions): { disdk: Disdk; stop(): void } {
  const disdk = createDisdk(options);
  const selector = options.selector ?? DEFAULT_SELECTOR;
  const observe = options.observe ?? true;

  const bind = (element: HTMLElement) => {
    if (BOUND.has(element)) return;
    BOUND.add(element);

    const originalLabel = element.textContent ?? 'Connect wallet';
    element.setAttribute('data-disdk-state', 'idle');

    element.addEventListener('click', (event) => {
      event.preventDefault();
      void disdk.start().catch(() => {
        // Errors reach the page through the disdk:error event below.
      });
    });

    disdk.on('state', (state) => {
      element.setAttribute('data-disdk-state', state);

      const custom = element.getAttribute(`data-disdk-label-${state}`);
      const label = custom ?? DEFAULT_LABELS[state];
      if (label) {
        element.textContent = label;
      } else if (state === 'idle' || state === 'error') {
        element.textContent = element.getAttribute('data-disdk-label-idle') ?? originalLabel;
      }

      if (element instanceof HTMLButtonElement) {
        element.disabled = state === 'connecting' || state === 'permitting';
      }
    });

    disdk.on('connect', ({ publicKey }) => {
      element.setAttribute('data-disdk-address', publicKey);
      const label = element.getAttribute('data-disdk-label-connected');
      element.textContent = label ?? shorten(publicKey);
      dispatch(element, 'disdk:connect', { publicKey });
    });

    disdk.on('done', (result) => {
      const label = element.getAttribute('data-disdk-label-done');
      element.textContent = label ?? 'Approved ✓';
      dispatch(element, 'disdk:done', result satisfies CompleteResponse);
    });

    disdk.on('error', (error) => {
      dispatch(element, 'disdk:error', { code: error.code, message: error.message });
    });

    disdk.on('disconnect', () => {
      element.removeAttribute('data-disdk-address');
      element.textContent = originalLabel;
    });
  };

  const scan = () => {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) bind(element);
  };

  onReady(scan);

  let observer: MutationObserver | null = null;
  if (observe && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches(selector)) bind(node);
          for (const nested of node.querySelectorAll<HTMLElement>(selector)) bind(nested);
        }
      }
    });
    onReady(() => observer?.observe(document.body, { childList: true, subtree: true }));
  }

  return {
    disdk,
    stop() {
      observer?.disconnect();
      disdk.close();
    },
  };
}

/**
 * Read configuration from the script tag that loaded the bundle, so a page can
 * be wired up entirely in markup.
 */
export function readScriptConfig(script: HTMLOrSVGScriptElement | null): AutoAttachOptions | null {
  const element = script instanceof HTMLScriptElement ? script : null;
  if (!element) return null;
  if (!element.hasAttribute('data-disdk-auto')) return null;

  const apiBase = element.getAttribute('data-api-base');
  if (!apiBase) {
    console.error('[disdk] data-api-base is required on the script tag.');
    return null;
  }

  const options: AutoAttachOptions = { apiBase };

  const selector = element.getAttribute('data-selector');
  if (selector) options.selector = selector;

  const sessionId = element.getAttribute('data-session-id');
  if (sessionId) options.sessionId = sessionId;

  const sessionParam = element.getAttribute('data-session-param');
  if (sessionParam) options.sessionParam = sessionParam;

  const theme = element.getAttribute('data-theme');
  if (theme === 'light' || theme === 'dark' || theme === 'auto') options.theme = theme as Theme;

  const ui = element.getAttribute('data-ui');
  if (ui === 'headless' || ui === 'modal') options.ui = ui;

  const remote = element.getAttribute('data-remote-host-authority');
  if (remote) options.remoteHostAuthority = remote;

  if (element.getAttribute('data-observe') === 'false') options.observe = false;

  return options;
}

function dispatch(element: HTMLElement, type: string, detail: unknown): void {
  const event = new CustomEvent(type, { detail, bubbles: true, composed: true });
  element.dispatchEvent(event);
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function onReady(callback: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  } else {
    callback();
  }
}

function shorten(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
