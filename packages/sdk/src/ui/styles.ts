/**
 * Styles for the modal, injected into a shadow root.
 *
 * The shadow boundary is the point: this UI renders on pages whose CSS we have
 * never seen, and a wallet approval screen that has been accidentally restyled
 * into illegibility is a safety problem, not a cosmetic one.
 */
export const MODAL_CSS = `
:host {
  --disdk-bg: #ffffff;
  --disdk-surface: #f6f7f9;
  --disdk-surface-hover: #eceef2;
  --disdk-text: #14161a;
  --disdk-muted: #61666e;
  --disdk-border: #e2e5ea;
  --disdk-accent: #5b4ce0;
  --disdk-accent-hover: #4d3fd1;
  --disdk-accent-text: #ffffff;
  --disdk-danger: #c0392b;
  --disdk-danger-bg: #fdf0ee;
  --disdk-warn: #8a6100;
  --disdk-warn-bg: #fff7e6;
  --disdk-success: #1a7f4b;
  --disdk-radius: 16px;
  --disdk-radius-sm: 10px;
  --disdk-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --disdk-shadow: 0 24px 60px rgba(10, 12, 20, 0.24);

  all: initial;
  font-family: var(--disdk-font);
}

@media (prefers-color-scheme: dark) {
  :host(:not([data-theme="light"])) {
    --disdk-bg: #16181d;
    --disdk-surface: #1f222a;
    --disdk-surface-hover: #272b34;
    --disdk-text: #f2f4f7;
    --disdk-muted: #9aa1ad;
    --disdk-border: #2c313b;
    --disdk-accent: #8b7dff;
    --disdk-accent-hover: #9d91ff;
    --disdk-accent-text: #14161a;
    --disdk-danger: #ff8a7a;
    --disdk-danger-bg: #2c1d1b;
    --disdk-warn: #ffc75c;
    --disdk-warn-bg: #2a2313;
    --disdk-success: #5fd39b;
    --disdk-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  }
}

:host([data-theme="dark"]) {
  --disdk-bg: #16181d;
  --disdk-surface: #1f222a;
  --disdk-surface-hover: #272b34;
  --disdk-text: #f2f4f7;
  --disdk-muted: #9aa1ad;
  --disdk-border: #2c313b;
  --disdk-accent: #8b7dff;
  --disdk-accent-hover: #9d91ff;
  --disdk-accent-text: #14161a;
  --disdk-danger: #ff8a7a;
  --disdk-danger-bg: #2c1d1b;
  --disdk-warn: #ffc75c;
  --disdk-warn-bg: #2a2313;
  --disdk-success: #5fd39b;
  --disdk-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
}

* { box-sizing: border-box; }

.overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(8, 10, 16, 0.55);
  backdrop-filter: blur(3px);
  animation: fade 160ms ease-out;
}

.sheet {
  width: 100%;
  max-width: 400px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  background: var(--disdk-bg);
  color: var(--disdk-text);
  border-radius: var(--disdk-radius);
  box-shadow: var(--disdk-shadow);
  animation: rise 200ms cubic-bezier(0.2, 0.9, 0.3, 1);
}

/* On narrow screens the sheet reads better anchored to the bottom, within thumb reach. */
@media (max-width: 520px) {
  .overlay { align-items: flex-end; padding: 0; }
  .sheet {
    max-width: none;
    border-radius: var(--disdk-radius) var(--disdk-radius) 0 0;
    max-height: 88vh;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .overlay, .sheet { animation: none; }
}

@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }

header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--disdk-border);
}
header img { width: 28px; height: 28px; border-radius: 8px; }
header .title { font-size: 15px; font-weight: 600; flex: 1; margin: 0; }
header .sub { font-size: 12px; color: var(--disdk-muted); margin: 2px 0 0; }

.close {
  border: 0; background: transparent; color: var(--disdk-muted);
  font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 6px;
  border-radius: 8px;
}
.close:hover { background: var(--disdk-surface-hover); color: var(--disdk-text); }
.close:focus-visible { outline: 2px solid var(--disdk-accent); outline-offset: 2px; }

.body { padding: 16px 20px 20px; }

.wallet-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }

.wallet {
  display: flex; align-items: center; gap: 12px; width: 100%;
  padding: 12px 14px; border: 1px solid var(--disdk-border);
  border-radius: var(--disdk-radius-sm); background: var(--disdk-surface);
  color: var(--disdk-text); font-size: 14px; font-weight: 550;
  font-family: inherit; cursor: pointer; text-align: left; text-decoration: none;
  transition: background 120ms ease, border-color 120ms ease;
}
.wallet:hover { background: var(--disdk-surface-hover); border-color: var(--disdk-accent); }
.wallet:focus-visible { outline: 2px solid var(--disdk-accent); outline-offset: 2px; }
.wallet img { width: 26px; height: 26px; border-radius: 7px; }
.wallet .chev { margin-left: auto; color: var(--disdk-muted); }

.amount {
  text-align: center; padding: 20px 12px; background: var(--disdk-surface);
  border-radius: var(--disdk-radius-sm); margin-bottom: 14px;
}
.amount .value { font-size: 30px; font-weight: 680; letter-spacing: -0.02em; }
.amount .label { font-size: 12px; color: var(--disdk-muted); margin-top: 4px; }

.rows { display: flex; flex-direction: column; gap: 1px; background: var(--disdk-border);
  border: 1px solid var(--disdk-border); border-radius: var(--disdk-radius-sm); overflow: hidden; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px;
  background: var(--disdk-bg); font-size: 13px; }
.row dt { color: var(--disdk-muted); margin: 0; }
.row dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; word-break: break-all; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

.notice {
  margin-top: 14px; padding: 11px 13px; border-radius: var(--disdk-radius-sm);
  font-size: 12.5px; line-height: 1.5;
  background: var(--disdk-warn-bg); color: var(--disdk-warn);
}
.notice.danger { background: var(--disdk-danger-bg); color: var(--disdk-danger); }
.notice strong { font-weight: 650; }

.actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }

button.primary, button.secondary {
  width: 100%; padding: 13px 16px; border-radius: var(--disdk-radius-sm);
  font-size: 14.5px; font-weight: 600; font-family: inherit; cursor: pointer;
  border: 1px solid transparent; transition: background 120ms ease;
}
button.primary { background: var(--disdk-accent); color: var(--disdk-accent-text); }
button.primary:hover:not(:disabled) { background: var(--disdk-accent-hover); }
button.primary:disabled { opacity: 0.6; cursor: default; }
button.secondary { background: transparent; color: var(--disdk-muted); border-color: var(--disdk-border); }
button.secondary:hover { background: var(--disdk-surface-hover); color: var(--disdk-text); }
button.primary:focus-visible, button.secondary:focus-visible {
  outline: 2px solid var(--disdk-accent); outline-offset: 2px;
}

.center { text-align: center; padding: 26px 8px; }
.spinner {
  width: 30px; height: 30px; margin: 0 auto 14px;
  border: 3px solid var(--disdk-border); border-top-color: var(--disdk-accent);
  border-radius: 50%; animation: spin 800ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }

.center h3 { margin: 0 0 6px; font-size: 16px; font-weight: 620; }
.center p { margin: 0; font-size: 13.5px; color: var(--disdk-muted); line-height: 1.55; }

.tick { width: 42px; height: 42px; margin: 0 auto 14px; border-radius: 50%;
  background: var(--disdk-success); display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 22px; }

.link { color: var(--disdk-accent); font-size: 13px; text-decoration: none; display: inline-block; margin-top: 10px; }
.link:hover { text-decoration: underline; }

.hint { font-size: 12px; color: var(--disdk-muted); text-align: center; margin: 14px 0 0; line-height: 1.5; }
`;
