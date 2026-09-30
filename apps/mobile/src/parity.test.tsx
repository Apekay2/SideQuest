// The Cross-Platform Parity design, as tests. Every test runs twice — under the jest-expo iOS
// preset and the Android preset — so "held identical" and "native on each" are both asserted.
//
// 11-cross-platform.md §11.7 asks for approval-sheet snapshots that fail on a change in LAYOUT
// ORDER; the order test below is that check, run on both platforms.

import { render, screen, fireEvent, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ErrandDetail } from '@sidequest/contracts';
import { isIOS, requesterNav, metrics, confirmPresentation } from './platform/adaptive';
import { AdaptiveTabBar, PostFab } from './components/AdaptiveTabBar';
import { ConfirmDestructive } from './components/ConfirmDestructive';
import { StallApprovalSheet } from './screens/StallApproval/StallApprovalSheet';
import { useSession } from './lib/session';

jest.mock('./lib/api', () => {
  const actual = jest.requireActual('./lib/api');
  return { ...actual, api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(), upload: jest.fn() } };
});
const { api } = jest.requireMock('./lib/api') as { api: { get: jest.Mock; post: jest.Mock } };

const errand = (over: Partial<ErrandDetail> = {}): ErrandDetail => ({
  id: 'e1', kind: 'market_run', status: 'awaiting_approval', title: 'Kangemi Market run',
  spend_cap_cents: 100_000, spent_cents: 38_000, max_fee_cents: 40_000, agreed_fee_cents: 30_000, bonus_cents: 5_000,
  deadline_at: null, created_at: '2026-09-30T10:00:00Z', stall_count: 3, stalls_done: 1, role: 'requester',
  counterparty_name: 'Peter K.', stall_states: ['approved', 'photographed', 'pending'], eta_at: null,
  notes: null, assignment_mode: 'pick', funding_mode: 'tranche', pickup: null,
  dropoff: { lat: -1.29, lng: 36.78, label: 'Kilimani' }, auction_closes_at: null, offered_to: null,
  requester: { id: 'r1', display_name: 'Amina', verification_tier: 1 },
  runner: { id: 'n1', display_name: 'Peter K.', verification_tier: 3 },
  stalls: [
    { id: 's1', seq: 1, name: 'Cereals', till_number: null, status: 'approved', total_cents: 38_000, photo_url: null, evidence_attempts: 1, items: [] },
    { id: 's2', seq: 2, name: 'Mama Ngina Greens', till_number: '174379', status: 'photographed', total_cents: 38_000, photo_url: null, evidence_attempts: 1,
      items: [
        { id: 'i1', label: 'Sukuma wiki', qty: 2, unit: 'bunch', price_cents: 6_000, substituted_for_label: null, accepted: null },
        { id: 'i2', label: 'Tomatoes', qty: 1, unit: 'kg', price_cents: 18_000, substituted_for_label: 'Roma tomatoes', accepted: true },
        { id: 'i0', label: 'Roma tomatoes', qty: 1, unit: 'kg', price_cents: 20_000, substituted_for_label: null, accepted: false },
        { id: 'i3', label: 'Onions', qty: 1, unit: 'kg', price_cents: 14_000, substituted_for_label: null, accepted: null },
      ] },
    { id: 's3', seq: 3, name: 'Butchery', till_number: null, status: 'pending', total_cents: 0, photo_url: null, evidence_attempts: 0, items: [] },
  ],
  tranches: [], escrow: null, fee: null, eta: null, card: null,
  ...over,
});

async function renderSheet(e: ErrandDetail) {
  api.get.mockResolvedValue(e);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return await render(
    <QueryClientProvider client={qc}>
      <StallApprovalSheet errandId="e1" stallId="s2" onClose={jest.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => { useSession.setState({ language: 'en' }); api.get.mockReset(); api.post.mockReset(); });

describe('1 · requester shell: where the platforms part company', () => {
  const props = (names: readonly string[]) => ({
    state: { index: 0, routes: ['home', 'post', 'activity', 'wallet', 'profile'].map((n) => ({ key: n, name: n })) },
    navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
    descriptors: {}, insets: { top: 0, bottom: 34, left: 0, right: 0 }, visible: names,
  }) as unknown as Parameters<typeof AdaptiveTabBar>[0];

  test('iOS keeps Post as a fifth tab; Android drops to four', async () => {
    await render(<AdaptiveTabBar {...props(requesterNav.tabs)} />);
    const tabs = screen.getAllByRole('tab').map((t) => t.props.accessibilityLabel);
    expect(tabs).toEqual(isIOS ? ['Home', 'Post', 'Activity', 'Wallet', 'Profile'] : ['Home', 'Activity', 'Wallet', 'Profile']);
  });

  test('Android promotes Post to a FAB; iOS draws none', async () => {
    await render(<PostFab onPress={jest.fn()} />);
    expect(screen.queryAllByLabelText('Post a Qwest')).toHaveLength(isIOS ? 0 : 1);
  });

  test('bar metrics and label sizes are the platform minimums', () => {
    expect(metrics.tabBarHeight).toBe(isIOS ? 49 : 80);
    expect(metrics.tabLabelSize).toBe(isIOS ? 10 : 12);
    expect(metrics.gutter).toBe(isIOS ? 20 : 16);
  });

  test('the active tab is announced as selected on both', async () => {
    await render(<AdaptiveTabBar {...props(requesterNav.tabs)} />);
    expect(screen.getByRole('tab', { name: 'Home' }).props.accessibilityState).toEqual({ selected: true });
  });
});

describe('2 · stall approval: held identical on purpose', () => {
  test('order is fixed: name, stall count, photo, items, total, cap, approve, substitute, decline', async () => {
    const r = await renderSheet(errand());
    await screen.findByText('Mama Ngina Greens');
    const text = JSON.stringify(r.toJSON());
    const order = ['Mama Ngina Greens', 'Stall 2 of 3', "Runner's photo of the stall", 'Sukuma wiki', 'Tomatoes', 'Onions',
      'Total', 'KSh 620 left of cap', 'Approve KSh 380', 'Substitute', 'Decline'];
    const at = order.map((s) => text.indexOf(`"${s}"`));
    expect(order.filter((_, i) => at[i]! < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test('the amount is in the button label and its accessible name', async () => {
    await renderSheet(errand());
    const btn = await screen.findByRole('button', { name: 'Approve KSh 380 for Mama Ngina Greens' });
    expect(within(btn).getByText('Approve KSh 380')).toBeTruthy();
  });

  test('a substituted item says so; the item it replaced is not listed', async () => {
    await renderSheet(errand());
    expect(await screen.findByText('Substituted for Roma tomatoes')).toBeTruthy();
    expect(screen.queryByText('Roma tomatoes')).toBeNull();
  });

  test('over cap: approve disables and a sentence says by how much — never a silent disabled button', async () => {
    await renderSheet(errand({ spent_cents: 80_000 }));
    const btn = await screen.findByRole('button', { name: /Approve KSh 380/ });
    expect(btn.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText(/KSh 180 over what is left of your cap/)).toBeTruthy();
  });

  test('approve is never optimistic: it enters a loading state and the sheet stays open', async () => {
    api.post.mockReturnValue(new Promise(() => {}));
    await renderSheet(errand());
    await fireEvent.press(await screen.findByRole('button', { name: /Approve KSh 380/ }));
    expect(await screen.findByText('Loading the card…')).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith('/errands/e1/stalls/s2/approve', {}, expect.objectContaining({ idem: expect.any(String) }));
  });

  test('only feel adapts: button height and the drag affordance', () => {
    expect(metrics.primaryButtonHeight).toBe(isIOS ? 52 : 56);
    expect(metrics.sheetHandle).toEqual(isIOS ? { width: 44, height: 5 } : { width: 32, height: 4 });
    expect(metrics.sheetRadius).toBe(isIOS ? 26 : 28);
  });

  test('the same words in Swahili, with the amount', async () => {
    useSession.setState({ language: 'sw' });
    await renderSheet(errand());
    expect(await screen.findByText('Idhinisha KSh 380')).toBeTruthy();
    expect(screen.getByText('Kibanda 2 kati ya 3')).toBeTruthy();
  });
});

describe('3 · declining a stall: same decision, native shape', () => {
  const base = {
    visible: true, title: 'Decline this stall?', cancelLabel: 'Cancel', alternativeLabel: 'Ask for a substitute',
    onConfirm: jest.fn(), onCancel: jest.fn(), onAlternative: jest.fn(),
  };

  test('iOS: action sheet with the message, destructive option, alternative and a separate Cancel; Android: M3 dialog, confirm last', async () => {
    await render(<ConfirmDestructive {...base} body="Declining sends the stall back to Peter K. Nothing is charged." confirmLabel={isIOS ? 'Decline stall' : 'Decline'} />);
    const buttons = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
    if (isIOS) {
      expect(confirmPresentation.kind).toBe('action-sheet');
      expect(buttons).toEqual(['Decline stall', 'Ask for a substitute', 'Cancel']);
      expect(screen.queryByRole('header')).toBeNull();
    } else {
      expect(confirmPresentation.kind).toBe('dialog');
      expect(buttons).toEqual(['Cancel', 'Decline']);           // confirming action last, on the right
      expect(screen.getByRole('header').props.children).toBe('Decline this stall?');
    }
  });

  test('not negotiable on either: the scrim does not dismiss and nothing destructive has default focus', async () => {
    expect(confirmPresentation.dismissOnScrim).toBe(false);
    expect(confirmPresentation.defaultFocus).toBeNull();
    await render(<ConfirmDestructive {...base} body="b" confirmLabel="Decline" />);
    // The only pressables are the actions: no invisible scrim button exists to tap.
    expect(screen.getAllByRole('button')).toHaveLength(isIOS ? 3 : 2);
  });

  test('declining from the sheet asks first, then posts the decline', async () => {
    api.post.mockResolvedValue(undefined);
    await renderSheet(errand());
    await fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    // On Android the dialog's confirm reads "Decline", like the sheet's own button behind it
    // (the design words both that way); the dialog's is the last one rendered.
    const confirms = await screen.findAllByRole('button', { name: isIOS ? 'Decline stall' : 'Decline' });
    expect(confirms).toHaveLength(isIOS ? 1 : 2);
    expect(api.post).not.toHaveBeenCalled();
    await fireEvent.press(confirms.at(-1)!);
    expect(api.post).toHaveBeenCalledWith('/errands/e1/stalls/s2/decline', { reason: 'Not what I asked for' });
  });
});

describe('accessibility floor: the stricter of the two, on both', () => {
  test('every control reaches 48', () => {
    expect(metrics.hitFloor).toBe(48);
  });
});
