// Post a Qwest: kind → stalls & items → where → cap and fee → clock and bonus → how to pick
// (05-ui-architecture §5.3). On submit it creates, publishes and funds in one go; the server
// never opens an errand whose escrow is not funded.
//
// Places: there is no geocoding provider in the MVP, so the pickup is chosen from the pilot's
// markets and the drop-off is the phone's own position with a typed label.

import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import type { CreateErrand, ErrandDetail } from '@sidequest/contracts';
import { tokens as t } from '../../theme/tokens';
import { metrics, requesterNav } from '../../platform/adaptive';
import { useT, type Key } from '../../i18n/useT';
import { kes, toMinor } from '../../lib/money';
import { api, ApiError, newIdemKey } from '../../lib/api';
import { Screen } from '../../components/Screen';
import { Card, Chip, Eyebrow, Field, Notice, PrimaryButton, SecondaryButton, Meta } from '../../components/ui';

type Kind = CreateErrand['kind'];
interface ItemDraft { label: string; qty: string; unit: string }
interface StallDraft { name: string; till: string; items: ItemDraft[] }

const MARKETS = [
  { label: 'Kangemi Market', lat: -1.2641, lng: 36.7519 },
  { label: 'Toi Market', lat: -1.3094, lng: 36.7839 },
  { label: 'Wakulima Market', lat: -1.2856, lng: 36.8305 },
  { label: 'Westlands Market', lat: -1.2676, lng: 36.8108 },
];
const CLOCKS = [30, 60, 120, 0] as const;

export default function Post() {
  const T = useT();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [kind, setKind] = useState<Kind>('market_run');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [market, setMarket] = useState(0);
  const [dropLabel, setDropLabel] = useState('');
  const [drop, setDrop] = useState<{ lat: number; lng: number } | null>(null);
  const [stalls, setStalls] = useState<StallDraft[]>([{ name: '', till: '', items: [{ label: '', qty: '1', unit: 'kg' }] }]);
  const [cap, setCap] = useState('1000');
  const [maxFee, setMaxFee] = useState('400');
  const [clock, setClock] = useState<(typeof CLOCKS)[number]>(60);
  const [bonus, setBonus] = useState(true);
  const [mode, setMode] = useState<'pick' | 'open'>('pick');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState<{ id: string; shortfall: number } | null>(null);
  // One key per intent: creating this errand, funding it from the wallet, funding it by M-Pesa.
  // A retry of any of them replays; a different intent never collides.
  const [keys] = useState(() => ({ create: newIdemKey(), wallet: newIdemKey(), mpesa: newIdemKey() }));
  const [createdId, setCreatedId] = useState<string | null>(null);

  // "Post again": copy a settled errand's shape.
  useEffect(() => {
    if (!from) return;
    api.get<ErrandDetail>(`/errands/${from}`).then((e) => {
      setKind(e.kind); setTitle(e.title); setNotes(e.notes ?? ''); setCap(String(e.spend_cap_cents / 100));
      setMaxFee(String(e.max_fee_cents / 100)); setDropLabel(e.dropoff.label); setDrop({ lat: e.dropoff.lat, lng: e.dropoff.lng });
      if (e.stalls.length) setStalls(e.stalls.map((s) => ({ name: s.name, till: s.till_number ?? '', items: s.items.filter((i) => i.accepted !== false).map((i) => ({ label: i.label, qty: String(i.qty), unit: i.unit })) })));
    }).catch(() => undefined);
  }, [from]);

  async function locate() {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return;
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    setDrop({ lat: p.coords.latitude, lng: p.coords.longitude });
  }

  const body = useMemo((): CreateErrand | null => {
    const capMinor = toMinor(cap), feeMinor = toMinor(maxFee);
    if (!title.trim() || !drop || !dropLabel.trim() || capMinor === null || !feeMinor) return null;
    const m = MARKETS[market]!;
    const cleanStalls = kind === 'market_run'
      ? stalls.filter((s) => s.name.trim()).map((s, i) => ({
          seq: i + 1, name: s.name.trim(), ...(s.till.trim() ? { till_number: s.till.trim() } : {}),
          items: s.items.filter((it) => it.label.trim()).map((it) => ({ label: it.label.trim(), qty: Number(it.qty) || 1, unit: it.unit || 'pc' })),
        })).filter((s) => s.items.length > 0)
      : [];
    if (kind === 'market_run' && cleanStalls.length === 0) return null;
    return {
      kind, title: title.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}),
      pickup: { lat: m.lat, lng: m.lng, label: m.label },
      dropoff: { ...drop, label: dropLabel.trim() },
      spend_cap_cents: capMinor, max_fee_cents: feeMinor,
      ...(clock ? { deadline_at: new Date(Date.now() + clock * 60_000).toISOString() } : {}),
      bonus_cents: clock && bonus ? 5_000 : 0,
      auction_minutes: 10, assignment_mode: mode, stalls: cleanStalls,
    };
  }, [kind, title, notes, market, drop, dropLabel, stalls, cap, maxFee, clock, bonus, mode]);

  async function submit(rail: 'wallet' | 'mpesa_stk') {
    if (!body) return;
    setBusy(true); setError(null);
    let id = createdId;
    try {
      if (!id) {
        id = (await api.post<ErrandDetail>('/errands', body, { idem: keys.create })).id;
        setCreatedId(id);
        await api.post(`/errands/${id}/publish`);
      }
      await api.post(`/errands/${id}/fund`, { rail }, { idem: rail === 'wallet' ? keys.wallet : keys.mpesa });
      router.replace(`/errand/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS') {
        setShort({ id: id ?? '', shortfall: Number(e.details?.shortfall_cents ?? 0) });
      } else setError(e instanceof ApiError ? e.message : T('error.generic'));
    } finally { setBusy(false); }
  }

  const upd = (i: number, f: (s: StallDraft) => StallDraft) => setStalls((xs) => xs.map((s, j) => (j === i ? f(s) : s)));

  return (
    // Reached from the FAB on Android it is a pushed screen with a back arrow; on iOS it is a tab.
    <Screen title={T('post.title')} back={requesterNav.createAs === 'fab'}>
      <Eyebrow>{T('post.what')}</Eyebrow>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['market_run', 'queue_stand', 'document_drop', 'custom'] as const).map((k) => (
          <Chip key={k} label={T(`post.kind.${k}` as Key)} selected={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      <Field label={T('post.title_field')} value={title} onChangeText={setTitle} maxLength={120} />
      <Field label={T('post.notes')} value={notes} onChangeText={setNotes} multiline style={{ minHeight: 88, paddingTop: 12, textAlignVertical: 'top' }} />

      <Eyebrow>{T('post.pickup')}</Eyebrow>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {MARKETS.map((m, i) => <Chip key={m.label} label={m.label} selected={market === i} onPress={() => setMarket(i)} />)}
      </View>
      <Field label={T('post.dropoff')} value={dropLabel} onChangeText={setDropLabel} placeholder="Kilimani, Wood Ave 12" />
      <SecondaryButton style={{ flex: 0 }} label={drop ? `✓ ${drop.lat.toFixed(4)}, ${drop.lng.toFixed(4)}` : '⌖'} accessibilityLabel={T('post.dropoff')} onPress={locate} />

      {kind === 'market_run' ? (
        <>
          <Eyebrow style={{ marginTop: 6 }}>{T('post.stalls')}</Eyebrow>
          {stalls.map((s, i) => (
            <Card key={i} style={{ gap: 10 }}>
              <Field label={T('post.stall_name')} value={s.name} onChangeText={(v) => upd(i, (x) => ({ ...x, name: v }))} />
              <Field label={T('post.till')} value={s.till} onChangeText={(v) => upd(i, (x) => ({ ...x, till: v.replace(/\D/g, '') }))} keyboardType="number-pad" />
              {s.items.map((it, j) => (
                <View key={j} style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 3 }}><Field label={T('post.item')} value={it.label} onChangeText={(v) => upd(i, (x) => ({ ...x, items: x.items.map((y, k) => (k === j ? { ...y, label: v } : y)) }))} /></View>
                  <View style={{ flex: 1 }}><Field label={T('post.qty')} value={it.qty} keyboardType="decimal-pad" onChangeText={(v) => upd(i, (x) => ({ ...x, items: x.items.map((y, k) => (k === j ? { ...y, qty: v } : y)) }))} /></View>
                </View>
              ))}
              <Pressable accessibilityRole="button" onPress={() => upd(i, (x) => ({ ...x, items: [...x.items, { label: '', qty: '1', unit: 'kg' }] }))}
                style={{ minHeight: metrics.hitFloor, justifyContent: 'center' }}>
                <Text style={{ fontFamily: t.fontBodySemi, color: t.accentDeep, fontSize: t.size.body }}>+ {T('post.add_item')}</Text>
              </Pressable>
            </Card>
          ))}
          <SecondaryButton style={{ flex: 0 }} label={`+ ${T('post.add_stall')}`} onPress={() => setStalls((xs) => [...xs, { name: '', till: '', items: [{ label: '', qty: '1', unit: 'kg' }] }])} />
        </>
      ) : null}

      <Field label={T('post.cap')} value={cap} onChangeText={setCap} keyboardType="number-pad" />
      <Field label={T('post.max_fee')} value={maxFee} onChangeText={setMaxFee} keyboardType="number-pad" />

      <Eyebrow style={{ marginTop: 6 }}>{T('post.clock')}</Eyebrow>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {CLOCKS.map((c) => <Chip key={c} label={T(`post.clock.${c === 0 ? 'none' : c}` as Key)} selected={clock === c} onPress={() => setClock(c)} />)}
      </View>
      {clock ? <Chip label={T('post.bonus')} selected={bonus} onPress={() => setBonus(!bonus)} /> : null}

      <Eyebrow style={{ marginTop: 6 }}>{T('post.mode')}</Eyebrow>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip label={T('post.mode.pick')} selected={mode === 'pick'} onPress={() => setMode('pick')} />
        <Chip label={T('post.mode.open')} selected={mode === 'open'} onPress={() => setMode('open')} />
      </View>

      {error ? <Notice>{error}</Notice> : null}
      {short ? (
        <Card tint style={{ gap: 10 }}>
          <Meta color={t.accentDeep}>{T('post.needs_funds', { short: kes(short.shortfall, T.locale) })}</Meta>
          <PrimaryButton label={T('post.submit_mpesa')} loading={busy} onPress={() => submit('mpesa_stk')} />
        </Card>
      ) : (
        <PrimaryButton label={T('post.submit')} loading={busy} disabled={!body} onPress={() => submit('wallet')} style={{ marginTop: 8 }} />
      )}
    </Screen>
  );
}
