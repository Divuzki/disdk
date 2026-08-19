// @vitest-environment jsdom
//
// The amount-entry screen is the whole of what makes a user-priced checkout
// "user-priced": it is where the payer names the sum before anything is signed.
// Two things must hold — the decimal they type becomes the right base-unit
// integer, and the server ceiling is enforced locally before the request is
// ever made (the server re-checks it regardless).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisdkModal, parseAmount, type ModalCallbacks } from '../src/ui/modal.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('parseAmount', () => {
  it('scales a whole number by the token decimals', () => {
    expect(parseAmount('5', 6)).toBe(5_000_000n);
  });

  it('scales a fractional amount exactly', () => {
    expect(parseAmount('12.5', 6)).toBe(12_500_000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
  });

  it('accepts a leading dot and strips grouping commas', () => {
    expect(parseAmount('.25', 6)).toBe(250_000n);
    expect(parseAmount('1,000', 6)).toBe(1_000_000_000n);
  });

  it('rejects more fractional digits than the token has', () => {
    expect(parseAmount('1.0000001', 6)).toBeNull();
  });

  it('rejects anything that is not a clean decimal', () => {
    for (const bad of ['', '.', 'abc', '1.2.3', '-5', '1e6', ' ']) {
      expect(parseAmount(bad, 6)).toBeNull();
    }
  });
});

/** Stub callbacks; the amount screen only ever reaches onCancel of these. */
function callbacks(): ModalCallbacks {
  return {
    onSelectWallet: vi.fn(),
    onApprove: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
}

function shadow(): ShadowRoot {
  const host = document.querySelector('[data-disdk-modal]');
  if (!host?.shadowRoot) throw new Error('modal not mounted');
  return host.shadowRoot;
}

describe('showAmountEntry', () => {
  it('submits the chosen amount as base units', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();

    const onSubmit = vi.fn();
    modal.showAmountEntry(
      { symbol: 'USDC', decimals: 6, treasury: 'Trea5ury', maxAmount: 50_000_000n },
      { onSubmit, onCancel: vi.fn() },
    );

    const input = shadow().querySelector('input') as HTMLInputElement;
    input.value = '12.5';
    (shadow().querySelector('button.primary') as HTMLButtonElement).click();

    expect(onSubmit).toHaveBeenCalledWith('12500000');
  });

  it('blocks an amount above the ceiling and shows why, without submitting', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();

    const onSubmit = vi.fn();
    modal.showAmountEntry(
      { symbol: 'USDC', decimals: 6, treasury: 'Trea5ury', maxAmount: 50_000_000n },
      { onSubmit, onCancel: vi.fn() },
    );

    const input = shadow().querySelector('input') as HTMLInputElement;
    input.value = '60';
    (shadow().querySelector('button.primary') as HTMLButtonElement).click();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(shadow().querySelector('.amount-error')?.textContent).toMatch(/most you can pay/i);
  });

  it('blocks a zero amount', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();

    const onSubmit = vi.fn();
    modal.showAmountEntry(
      { symbol: 'USDC', decimals: 6, treasury: 'Trea5ury' },
      { onSubmit, onCancel: vi.fn() },
    );

    const input = shadow().querySelector('input') as HTMLInputElement;
    input.value = '0';
    (shadow().querySelector('button.primary') as HTMLButtonElement).click();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('routes Cancel to its own handler, not a submission', () => {
    const modal = new DisdkModal(callbacks());
    modal.open();

    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    modal.showAmountEntry(
      { symbol: 'USDC', decimals: 6, treasury: 'Trea5ury' },
      { onSubmit, onCancel },
    );

    (shadow().querySelector('button.secondary') as HTMLButtonElement).click();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
