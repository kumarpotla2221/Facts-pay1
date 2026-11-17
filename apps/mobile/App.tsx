import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { ApiError, api, baseUrl, demoCheckout, money, parseAmount, request, slug, type Lookup, type Order, type Receipt, type School } from './src/api';

const c = {
  primary: '#1f55e0', primarySoft: '#e8f0fd', ink: '#0f1729', body: '#1f2937', muted: '#4b5563', faint: '#6b7280',
  line: '#dfe4ec', lineSoft: '#eceff4', panel: '#eef1f5', iconTile: '#f3f5f8',
  demoBg: '#fde6bd', demoInk: '#5b3b0c', noticeBg: '#fdebc9', noticeInk: '#b45309', noticeTitle: '#92400e',
  success: '#22b04b', danger: '#b42318', dangerBg: '#fdeceb', charge: '#9e3028', paid: '#16794c',
};

// Line icons (24px grid, Lucide geometry) drawn with react-native-svg.
type Shape = string | ['c', number, number, number] | ['r', number, number, number, number, number];
type IconName = 'back' | 'next' | 'help' | 'school' | 'bus' | 'file' | 'mail' | 'phone' | 'info' | 'share' | 'check' | 'arrow';
const icons: Record<IconName, Shape[]> = {
  back: ['m15 18-6-6 6-6'],
  next: ['m9 18 6-6-6-6'],
  help: [['c', 12, 12, 10], 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  school: ['M14 22v-4a2 2 0 1 0-4 0v4', 'm18 10 3.447 1.724a1 1 0 0 1 .553.894V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7.382a1 1 0 0 1 .553-.894L6 10', 'M18 5v17', 'm4 6 7.106-3.553a2 2 0 0 1 1.788 0L20 6', 'M6 5v17', ['c', 12, 9, 2]],
  bus: ['M4 6 2 7', 'M10 6h4', 'm22 7-2-1', ['r', 4, 3, 16, 16, 2], 'M4 11h16', 'M8 15h.01', 'M16 15h.01', 'M6 19v2', 'M18 21v-2'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  mail: [['r', 2, 4, 20, 16, 2], 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  phone: [['r', 5, 2, 14, 20, 2], 'M12 18h.01'],
  info: [['c', 12, 12, 10], 'M12 16v-4', 'M12 8h.01'],
  share: [['c', 18, 5, 3], ['c', 6, 12, 3], ['c', 18, 19, 3], 'm8.59 13.51 6.83 3.98', 'm15.41 6.51-6.82 3.98'],
  check: ['M20 6 9 17l-5-5'],
  arrow: ['M5 12h14', 'm12 5 7 7-7 7'],
};
function Icon({ name, size = 22, color = c.ink, stroke = 1.8 }: { name: IconName; size?: number; color?: string; stroke?: number }) {
  const p = { stroke: color, strokeWidth: stroke, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return <Svg width={size} height={size} viewBox="0 0 24 24">{icons[name].map((sh, i) => typeof sh === 'string'
    ? <Path key={i} d={sh} {...p} />
    : sh[0] === 'c' ? <Circle key={i} cx={sh[1]} cy={sh[2]} r={sh[3]} {...p} /> : <Rect key={i} x={sh[1]} y={sh[2]} width={sh[3]} height={sh[4]} rx={sh[5]} {...p} />)}</Svg>;
}

function Brand() {
  return <View style={s.brand}>
    <Svg width={26} height={26} viewBox="0 0 26 26"><Path d="M10 2h14l-6 9H4z" fill={c.primary} /><Path d="M8 14h14l-6 9H2z" fill={c.primary} opacity={0.7} /></Svg>
    <Text style={s.brandText}>facts pay</Text>
  </View>;
}

function Button({ title, subtitle, icon, iconAfter, onPress, secondary = false, disabled = false, busy = false }: { title: string; subtitle?: string; icon?: IconName; iconAfter?: IconName; onPress: () => void; secondary?: boolean; disabled?: boolean; busy?: boolean }) {
  const inactive = busy || disabled;
  const fg = secondary ? c.ink : '#ffffff';
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: inactive }} disabled={inactive} onPress={onPress} style={({ pressed }) => [s.button, secondary && s.buttonSecondary, inactive && { opacity: 0.45 }, pressed && { opacity: 0.85 }]}>
    <View style={s.buttonRow}>{icon && <Icon name={icon} size={20} color={fg} />}<Text style={[s.buttonText, { color: fg }]}>{title}</Text>{iconAfter && <Icon name={iconAfter} size={20} color={fg} />}</View>
    {!!subtitle && <Text style={[s.buttonSub, { color: secondary ? c.muted : '#dce6ff' }]}>{subtitle}</Text>}
  </Pressable>;
}

/** Whole rupees display without ".00", as in the design; part-rupee amounts keep their paise. */
const rupees = (paise: number) => (paise % 100 === 0 ? money(paise).replace(/\.00$/, '') : money(paise));
const initials = (name: string) => { const w = name.trim().split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
const feeIcon = (label: string): IconName => (/transport|bus|van|conveyance/i.test(label) ? 'bus' : 'school');
const listLabels = (labels: string[]) => (labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`);

export default function App() {
  const [fonts, fontError] = useFonts({ Poppins: require('./assets/fonts/Poppins-Regular.ttf'), PoppinsSemiBold: require('./assets/fonts/Poppins-SemiBold.ttf'), PoppinsBold: require('./assets/fonts/Poppins-Bold.ttf') });
  const [school, setSchool] = useState<School | undefined>();
  const [logoError, setLogoError] = useState(false);
  const [adm, setAdm] = useState('');
  const [loadedAdm, setLoadedAdm] = useState('');
  const [data, setData] = useState<Lookup>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [amountMode, setAmountMode] = useState<'full' | 'other'>('full');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [error, setError] = useState('');
  const [showStatement, setShowStatement] = useState(false);
  const [review, setReview] = useState(false);
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const [order, setOrder] = useState<Order>();
  const [paidItems, setPaidItems] = useState<{ id: string; label: string; paise: number }[]>([]);
  const [receipt, setReceipt] = useState<Receipt>();
  // Demo checkout needs both the build-time opt-in and the server's mock gateway, so a server switched to
  // MOCK_GATEWAY=0 turns checkout off in already-installed builds instead of failing with a 503.
  const demo = demoCheckout && school?.checkout?.mode === 'demo';
  useEffect(() => { scrollRef.current?.scrollTo({ y: 0, animated: true }); }, [error, order, receipt, review, data]);
  function changeStudent() { setData(undefined); setShowStatement(false); setError(''); setEmail(''); setPhone(''); }
  function goBack(): boolean {
    if (busyRef.current) return true;
    setError('');
    if (receipt) {
      // Refresh balances after a completed payment instead of showing stale dues.
      void run(lookup);
      return true;
    }
    if (order) {
      Alert.alert('Leave demo checkout?', 'Your fee selections and contact details will be kept.', [
        { text: 'Stay here', style: 'cancel' },
        { text: 'Back to fees', onPress: () => { setOrder(undefined); setReview(false); setError(''); } },
      ]);
      return true;
    }
    if (review) { setReview(false); return true; }
    if (data) { changeStudent(); return true; }
    return false;
  }
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', goBack);
    return () => subscription.remove();
  });

  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const loadSchool = () => api<School>('info').then(setSchool);
  useEffect(() => { void run(loadSchool); }, []);
  const fullAmounts = (items: Lookup['items']) => Object.fromEntries(items.map(i => [i.id, (i.paise / 100).toFixed(2)]));
  async function lookup() {
    const value = adm.trim();
    if (!/^[A-Za-z0-9/_-]{1,20}$/.test(value)) throw new Error('Enter a valid admission number.');
    const result = await api<Lookup>('dues', { adm: value });
    setReceipt(undefined); setOrder(undefined);
    setLoadedAdm(value); setData(result); setShowStatement(false); setReview(false); setDetails({});
    setAmountMode('full'); setAmounts(fullAmounts(result.items));
    setChosen(Object.fromEntries(result.items.map(i => [i.id, true])));
  }
  function chooseAmountMode(mode: 'full' | 'other') {
    setAmountMode(mode);
    if (mode === 'full' && data) setAmounts(fullAmounts(data.items));
  }
  const selected = data?.items.filter(i => chosen[i.id]) || [];
  const total = selected.reduce((sum, i) => sum + (parseAmount(amounts[i.id] || '') || 0), 0);
  function reviewFees() {
    if (!selected.length) throw new Error('Choose at least one fee to continue.');
    for (const item of selected) {
      const value = parseAmount(amounts[item.id] || '');
      if (value === null || value < item.minPaise || value > item.paise) throw new Error(`${item.label}: enter an amount between ${money(item.minPaise)} and ${money(item.paise)}.`);
    }
    setReview(true);
  }
  async function createOrder() {
    if (!demo) throw new Error(school?.checkout?.message || 'Payment gateway integration is pending. Checkout is currently unavailable.');
    if (!selected.length) throw new Error('Select a fee to pay.');
    const pays = selected.map(i => {
      const paise = parseAmount(amounts[i.id] || '');
      if (paise === null || paise < i.minPaise || paise > i.paise) throw new Error(`${i.label}: enter an amount between ${money(i.minPaise)} and ${money(i.paise)}.`);
      return { id: i.id, paise };
    });
    const cleanEmail = email.trim(), cleanPhone = phone.replace(/[\s-]/g, '');
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Enter a valid email address.');
    if (cleanPhone && !/^\+?[0-9]{10,14}$/.test(cleanPhone)) throw new Error('Enter a valid phone number.');
    const created = await api<Order>('orders', { adm: loadedAdm, pays, ...(cleanEmail && { email: cleanEmail }), ...(cleanPhone && { phone: cleanPhone }) });
    // Remember what this order covers, so the receipt lists what was actually paid.
    setPaidItems(selected.map((i, index) => ({ id: i.id, label: i.label, paise: pays[index].paise })));
    setOrder(created);
  }
  async function settle(outcome: 'success' | 'fail') {
    if (!order) return;
    // Keep the order after uncertain errors; never silently create another payment attempt.
    try {
      const result = await api<Receipt>(`orders/${order.orderId}/pay`, { outcome, mode: 'Online' });
      setReceipt(result); setOrder(undefined);
    } catch (error) {
      // A confirmed failure is terminal; transport errors keep the order for investigation.
      if (error instanceof ApiError && error.status === 402) {
        setOrder(undefined); setReview(false);
      }
      throw error;
    }
  }
  async function statementPdf() {
    if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is unavailable on this device.');
    const response = await request('statement', { adm: loadedAdm });
    const file = new File(Paths.cache, `Statement-${Date.now()}.pdf`);
    try {
      file.write(new Uint8Array(await response.arrayBuffer()));
      await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Save or share statement' });
    } finally { if (file.exists) file.delete(); }
  }
  if (!fonts && !fontError) return <View style={s.loading}><ActivityIndicator color={c.primary} /></View>;

  const dueTotal = data?.items.reduce((sum, i) => sum + i.paise, 0) || 0;
  const paidTotal = data?.statement.reduce((sum, i) => sum + i.paidPaise, 0) || 0;
  const chargedTotal = data?.statement.reduce((sum, i) => sum + i.chargedPaise, 0) || 0;
  const statementBalance = chargedTotal - paidTotal;
  const anyPartial = !!data?.items.some(i => i.minPaise < i.paise);
  const step = receipt ? 3 : review || order ? 2 : data ? 1 : 0;

  const status = <>
    {!!error && <View style={s.errorBox}><Text style={s.errorTitle}>Please check</Text><Text accessibilityRole="alert" style={s.errorText}>{error}</Text></View>}
    {busy && <View style={s.busy}><ActivityIndicator color={c.primary} /><Text style={s.muted}>Please wait...</Text></View>}
  </>;

  const schoolBlock = <View style={s.schoolBlock}>
    {!logoError && !!baseUrl && <Image accessibilityLabel="School logo" source={{ uri: `${baseUrl}/assets/schools/${slug}/logo.png` }} onError={() => setLogoError(true)} style={s.schoolLogo} resizeMode="contain" />}
    <View style={{ flex: 1 }}><Text style={s.schoolName}>{school?.name || 'School fee payment'}</Text><Text style={s.schoolSub}>{school?.address || 'Parent fee portal'}</Text></View>
    {demo && <View style={s.demoBadge}><Text style={s.demoText}>Demo</Text></View>}
  </View>;

  const studentInfo = data && <>
    <View style={s.avatar}><Text style={s.avatarText}>{initials(data.student.name)}</Text></View>
    <View style={{ flex: 1 }}>
      <Text style={s.studentName}>{data.student.name}</Text>
      <View style={s.studentMeta}><Text style={s.muted}>Class {[data.student.cls, data.student.section].filter(Boolean).join(' · ')}</Text><View style={s.metaRule} /><Text style={s.muted}>Admission {loadedAdm}</Text></View>
    </View>
  </>;
  const studentCard = (label: string, onPress: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={onPress} style={({ pressed }) => [s.studentCard, pressed && { opacity: 0.85 }]}>
    {studentInfo}<Icon name="next" size={22} color={c.body} />
  </Pressable>;

  return <SafeAreaProvider><SafeAreaView style={s.safe}><StatusBar style="dark" /><KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    {step <= 1
      ? <View style={s.header}><Brand /><Pressable accessibilityRole="button" accessibilityLabel="Help" hitSlop={10} onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}><Icon name="help" size={26} color={c.body} /></Pressable></View>
      : <View style={s.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={step === 3 ? 'Back to fees' : 'Back to choose fees'} accessibilityState={{ disabled: busy }} disabled={busy} hitSlop={10} onPress={() => goBack()} style={[s.headerBack, busy && { opacity: 0.45 }]}><Icon name="back" size={24} color={c.body} /></Pressable>
        <Text accessibilityRole="header" style={s.headerTitle}>{step === 3 ? 'Payment receipt' : 'Review payment'}</Text>
        {step === 2 && <Text style={s.headerStep}>Step 2 of 3</Text>}
      </View>}

    <ScrollView ref={scrollRef} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      {/* ---- Find the student ---- */}
      {step === 0 && <>
        {schoolBlock}
        <View style={s.titleBlock}><Text accessibilityRole="header" style={s.title}>Find your student</Text><Text style={s.helper}>Enter the admission number from your school ID card or fee receipt.</Text></View>
        {status}
        {!school && !busy && <Button title="Try connecting again" secondary onPress={() => void run(loadSchool)} />}
        <View style={s.card}>
          <Text style={s.fieldLabel}>Student admission number</Text>
          <TextInput accessibilityLabel="Student admission number" value={adm} onChangeText={setAdm} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={20} placeholder="For example, 26/39" placeholderTextColor={c.faint} returnKeyType="search" onSubmitEditing={() => { if (!busy && school && adm.trim()) void run(lookup); }} style={s.input} />
          <Text style={s.muted}>Enter the number exactly as shown, including any / or -.</Text>
          <Button busy={busy} title="Show student fees" disabled={!school || !adm.trim()} onPress={() => void run(lookup)} />
        </View>
      </>}

      {/* ---- Step 1: fees overview and selection ---- */}
      {step === 1 && data && <>
        {schoolBlock}
        {studentCard('Change student', changeStudent)}
        {status}
        <Text accessibilityRole="header" style={s.sectionTitle}>Fees overview</Text>
        <View style={s.overview}>
          <Text style={s.overviewLabel}>Total outstanding</Text>
          <Text style={s.overviewValue}>{rupees(dueTotal)}</Text>
          <Text style={s.overviewSub}>{data.items.length ? listLabels(data.items.map(i => i.label)) : 'No payment is needed right now.'}</Text>
        </View>
        {!data.items.length && <View style={s.empty}><View style={s.successCircle}><Icon name="check" size={28} color="#fff" stroke={3} /></View><Text style={s.sectionTitle}>All fees are paid</Text><Text style={[s.helper, { textAlign: 'center' }]}>You can still view or download your statement below.</Text></View>}
        {!!data.items.length && <View style={s.sectionRow}><Text accessibilityRole="header" style={s.sectionTitle}>Select fees</Text><Text style={s.sectionMeta}>{selected.length} selected</Text></View>}
        {data.items.map(item => {
          const included = !!chosen[item.id];
          const partial = item.minPaise < item.paise;
          const entered = parseAmount(amounts[item.id] || '');
          const invalid = included && (entered === null || entered < item.minPaise || entered > item.paise);
          const sub = item.lines.length ? item.lines.map(l => l.label).join(' & ') : included ? 'Selected for payment' : 'Tap to select this fee';
          return <View key={item.id} style={[s.feeCard, included && s.feeCardOn]}>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: included, disabled: busy }} accessibilityLabel={`Pay ${item.label}`} disabled={busy} onPress={() => setChosen({ ...chosen, [item.id]: !included })} style={s.feeRow}>
              <View style={[s.checkbox, included && s.checkboxOn]}>{included && <Icon name="check" size={16} color="#fff" stroke={3} />}</View>
              <View style={s.feeIcon}><Icon name={feeIcon(item.label)} size={26} color={c.body} stroke={1.5} /></View>
              <View style={{ flex: 1 }}><Text style={s.feeTitle}>{item.label}</Text><Text numberOfLines={1} style={s.feeSub}>{sub}</Text></View>
              <Text style={s.feeAmount}>{rupees(item.paise)}</Text>
            </Pressable>
            {item.lines.length > 1 && <>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: !!details[item.id] }} disabled={busy} onPress={() => setDetails({ ...details, [item.id]: !details[item.id] })} style={s.smallAction}><Text style={s.linkSmall}>{details[item.id] ? 'Hide fee details' : 'What is included in this fee?'}</Text></Pressable>
              {details[item.id] && item.lines.map((line, index) => <View key={index} style={s.row}><Text style={[s.muted, { flex: 1 }]}>{line.label}</Text><Text style={s.body}>{money(line.paise)}</Text></View>)}
            </>}
            {included && amountMode === 'other' && (partial ? <View style={s.amountEditor}>
              <Text style={s.muted}>Or enter another amount (at least {money(item.minPaise)})</Text>
              <View style={s.amountRow}>
                <View style={[s.amountField, invalid && { borderColor: c.danger }]}><Text style={s.currency}>₹</Text><TextInput accessibilityLabel={`Your payment amount for ${item.label}`} value={amounts[item.id] || ''} onChangeText={value => setAmounts({ ...amounts, [item.id]: value })} keyboardType="decimal-pad" editable={!busy} style={s.amountInput} /></View>
                <Pressable accessibilityRole="button" accessibilityLabel={`Minimum amount ${money(item.minPaise)}`} disabled={busy} onPress={() => setAmounts({ ...amounts, [item.id]: (item.minPaise / 100).toFixed(2) })} style={[s.chip, entered === item.minPaise && s.chipOn]}><Text style={s.chipLabel}>Minimum amount</Text><Text style={s.chipValue}>{rupees(item.minPaise)}</Text></Pressable>
              </View>
              {invalid && <Text style={s.fieldError}>Enter between {money(item.minPaise)} and {money(item.paise)}.</Text>}
            </View> : <Text style={s.muted}>Payable in full</Text>)}
          </View>;
        })}

        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showStatement }} disabled={busy} onPress={() => setShowStatement(!showStatement)} style={s.linkRow}>
          <Icon name="file" size={22} color={c.primary} stroke={1.6} /><Text style={s.link}>{showStatement ? 'Hide fee statement' : 'View fee statement'}</Text>
        </Pressable>
        {showStatement && <View style={s.card}>
          <Text style={s.cardTitle}>Fee statement</Text><Text style={s.muted}>Charges, payments and credits for this school year</Text>
          <Text style={s.muted}>Read each entry below. Charges add to your balance; payments and credits reduce it.</Text>
          {data.statement.map((entry, index) => <View key={`${entry.ref}-${index}`} style={s.statementEntry}>
            <View style={s.statementDateRow}><Text style={s.statementDate}>{new Date(`${entry.date}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}</Text>{!!entry.ref && <Text selectable style={s.statementRef}>{entry.ref}</Text>}</View>
            <Text style={s.body}>{entry.label || 'Account entry'}</Text>
            <View style={s.statementAmounts}>
              <View style={{ flex: 1, gap: 2 }}><Text style={s.muted}>Charge</Text><Text style={[s.statementMoney, { color: entry.chargedPaise < 0 ? c.paid : c.charge }]}>{entry.chargedPaise ? money(entry.chargedPaise) : '-'}</Text></View>
              <View style={{ flex: 1, gap: 2 }}><Text style={s.muted}>Payment / credit</Text><Text style={[s.statementMoney, { color: c.paid }]}>{entry.paidPaise ? money(entry.paidPaise) : '-'}</Text></View>
            </View>
          </View>)}
          {!data.statement.length && <Text style={s.muted}>No entries are available for this school year.</Text>}
          <View style={s.panel}>
            <Text style={s.fieldLabel}>Statement totals</Text>
            <View style={s.row}><Text style={s.body}>Total charges</Text><Text style={s.fieldLabel}>{money(chargedTotal)}</Text></View>
            <View style={s.row}><Text style={[s.body, { flex: 1 }]}>Total payments / credits</Text><Text style={s.fieldLabel}>{money(paidTotal)}</Text></View>
            <View style={s.divider} />
            <View style={s.row}><Text style={[s.fieldLabel, { flex: 1 }]}>{statementBalance < 0 ? 'Credit balance' : statementBalance > 0 ? 'Statement balance due' : 'Statement balance'}</Text><Text style={[s.statementMoney, { color: statementBalance > 0 ? c.charge : c.paid }]}>{money(Math.abs(statementBalance))}</Text></View>
            <Text style={s.muted}>{statementBalance < 0 ? 'Your statement shows a credit. Contact the school to confirm how it applies to individual fees.' : 'The fee cards above show the amounts available to pay.'}</Text>
            <Text style={s.muted}>Payments / credits may include an opening credit balance, not only money paid this year.</Text>
          </View>
          <Button busy={busy} title="Save or share PDF" icon="share" secondary onPress={() => void run(statementPdf)} />
        </View>}

        {anyPartial && !!selected.length && <>
          <View accessibilityRole="radiogroup" style={s.radioRow}>{(['full', 'other'] as const).map(mode => {
            const on = amountMode === mode;
            return <Pressable key={mode} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: busy }} disabled={busy} onPress={() => chooseAmountMode(mode)} style={[s.radio, on && s.radioOn]}>
              <View style={[s.radioDot, on && { borderColor: c.primary }]}>{on && <View style={s.radioInner} />}</View>
              <Text style={s.radioText}>{mode === 'full' ? 'Full amount' : 'Other amount'}</Text>
            </Pressable>;
          })}</View>
          <Text style={s.muted}>{amountMode === 'full' ? 'Pay the full selected balance.' : 'Choose how much to pay for each selected fee above.'}</Text>
        </>}
      </>}

      {/* ---- Step 2: review ---- */}
      {step === 2 && data && review && !order && <>
        <View style={s.titleBlock}><Text accessibilityRole="header" style={s.title}>Check your payment</Text><Text style={s.helper}>Confirm the student and selected fees.</Text></View>
        {status}
        {studentCard('Edit fees', () => setReview(false))}
        <View style={s.card}>
          {selected.map(item => <View key={item.id} style={s.summaryRow}>
            <Icon name={feeIcon(item.label)} size={26} color={c.body} stroke={1.5} />
            <Text style={s.summaryLabel}>{item.label}</Text>
            <Text style={s.summaryValue}>{rupees(parseAmount(amounts[item.id] || '') || 0)}</Text>
          </View>)}
          <View style={s.divider} />
          <View style={s.row}><Text style={s.totalLabel}>Total</Text><Text style={s.totalValue}>{rupees(total)}</Text></View>
          <View style={s.panelRow}><Text style={s.body}>Remaining balance</Text><Text style={s.panelValue}>{rupees(dueTotal - total)}</Text></View>
        </View>
        <View style={{ gap: 8 }}>
          <Text style={s.fieldLabel}>Receipt email (optional)</Text>
          <View style={s.iconInput}><Icon name="mail" size={22} color={c.faint} stroke={1.6} /><TextInput accessibilityLabel="Receipt email, optional" placeholder="Enter email address" placeholderTextColor={c.faint} value={email} onChangeText={setEmail} editable={!busy} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} style={s.iconInputText} /></View>
        </View>
        <View style={{ gap: 8 }}>
          <Text style={s.fieldLabel}>Phone number (optional)</Text>
          <View style={s.iconInput}><Icon name="phone" size={22} color={c.faint} stroke={1.6} /><TextInput accessibilityLabel="Phone number, optional" placeholder="Enter phone number" placeholderTextColor={c.faint} value={phone} onChangeText={setPhone} editable={!busy} keyboardType="phone-pad" style={s.iconInputText} /></View>
        </View>
        <View style={s.notice}>
          <Icon name="info" size={24} color={c.noticeInk} stroke={1.8} />
          <View style={{ flex: 1 }}>
            <Text style={s.noticeTitle}>{demo ? 'Demo payment' : 'Payments unavailable'}</Text>
            <Text style={s.noticeText}>{demo ? 'No money will be charged.' : school?.checkout?.message || 'Online payments are not available yet. You can view fees and download your statement.'}</Text>
          </View>
        </View>
        <View style={s.editRow}><Text style={s.muted}>Need to change something?</Text><Pressable accessibilityRole="button" hitSlop={8} disabled={busy} onPress={() => setReview(false)}><Text style={s.linkUnderline}>Edit fees</Text></Pressable></View>
      </>}

      {/* ---- Step 2: mock gateway ---- */}
      {step === 2 && order && <>
        <View style={s.titleBlock}><Text accessibilityRole="header" style={s.title}>Check your payment</Text><Text style={s.helper}>Try a successful or failed payment. No money will be charged.</Text></View>
        {status}
        <View style={s.card}>
          <View style={s.demoBadge}><Text style={s.demoText}>Demo payment</Text></View>
          <Text style={s.cardTitle}>Try the payment experience</Text>
          <Text style={s.bigAmount}>{rupees(order.paise)}</Text>
          <Text style={s.helper}>Choose a result below. A successful demo saves a payment in the connected database.</Text>
          <Button busy={busy} title="Complete demo payment" onPress={() => Alert.alert('Complete this demo?', 'No real money is charged. A test payment will be saved and the fee balance will change.', [{ text: 'Go back', style: 'cancel' }, { text: 'Complete demo', onPress: () => void run(() => settle('success')) }])} />
          <Button busy={busy} title="Try an unsuccessful payment" secondary onPress={() => void run(() => settle('fail'))} />
          <Button busy={busy} title="Cancel and return to fees" secondary onPress={() => { setOrder(undefined); setReview(false); setError(''); }} />
          <Text selectable style={s.reference}>Payment reference: {order.orderId}</Text>
        </View>
      </>}

      {/* ---- Step 3: receipt ---- */}
      {step === 3 && receipt && <>
        <View style={s.receiptHero}>
          <View style={s.successCircle}><Icon name="check" size={30} color="#fff" stroke={3} /></View>
          <Text accessibilityRole="header" style={s.receiptTitle}>Demo payment complete</Text>
          <Text style={s.helper}>No money was charged</Text>
          <Text style={s.receiptAmount}>{rupees(receipt.paise)}</Text>
        </View>
        {status}
        <View style={s.card}>
          <View><Text style={s.cardTitle}>{school?.name || 'School fee payment'}</Text>{!!school?.address && <Text style={s.muted}>{school.address}</Text>}</View>
          <View style={s.divider} />
          <View style={s.studentRow}>{studentInfo}</View>
          <View style={s.divider} />
          {paidItems.map(item => <View key={item.id} style={s.row}><Text style={[s.body, { flex: 1 }]}>{item.label}</Text><Text style={s.body}>{rupees(item.paise)}</Text></View>)}
          <View style={s.divider} />
          <View style={s.row}><Text style={s.totalLabel}>Total recorded</Text><Text style={s.totalLabel}>{rupees(receipt.paise)}</Text></View>
          <View style={s.panelRow}><Text style={s.body}>Balance</Text><Text style={s.panelValue}>{rupees(Math.max(0, dueTotal - receipt.paise))}</Text></View>
          <View style={s.row}><Text style={s.body}>Receipt number</Text><Text selectable style={s.body}>{receipt.receiptNo}</Text></View>
          <View style={s.divider} />
          <View style={s.row}><Text style={s.body}>Reference</Text><Text selectable style={s.body}>{receipt.gatewayRef}</Text></View>
          <View style={s.divider} />
          <Text style={s.faint}>Demo receipt</Text>
          {receipt.emailed && <Text style={s.muted}>Your receipt email has been requested.</Text>}
        </View>
        <Button busy={busy} title="Share receipt" icon="share" secondary onPress={() => void run(async () => { await Share.share({ message: `${school?.name || 'Facts Pay'}\nDEMO PAYMENT - no money charged\nReceipt: ${receipt.receiptNo}\nPaid: ${money(receipt.paise)}\nReference: ${receipt.gatewayRef}` }); })} />
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(lookup)} style={s.centerLink}><Text style={s.link}>Back to fees</Text></Pressable>
      </>}

      {step <= 1 && <>
        <View style={s.helpCard}><Text style={s.fieldLabel}>Need help?</Text><Text style={s.helper}>{school?.phone ? `Call your school office: ${school.phone}` : 'Contact your school office for help with admission numbers or fee details.'}</Text></View>
        <Text style={s.footer}>School fee payments · Facts Pay</Text>
      </>}
    </ScrollView>

    {step === 1 && data && !!data.items.length && <View style={s.bottomBar}>
      <View style={s.row}><Text style={s.bottomLabel}>Selected total</Text><Text style={s.bottomValue}>{rupees(total)}</Text></View>
      <Button busy={busy} title="Review payment" iconAfter="arrow" disabled={!selected.length} onPress={() => void run(async () => reviewFees())} />
    </View>}
    {step === 2 && review && !order && <View style={s.bottomBar}>
      <Button busy={busy} title={demo ? 'Confirm demo payment' : 'Payments unavailable'} subtitle={demo ? `${rupees(total)} · Demo only` : undefined} disabled={!demo} onPress={() => void run(createOrder)} />
    </View>}
  </KeyboardAvoidingView></SafeAreaView></SafeAreaProvider>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#ffffff' },
  loading: { flex: 1, justifyContent: 'center', backgroundColor: '#ffffff' },
  page: { padding: 20, gap: 16, maxWidth: 680, width: '100%', alignSelf: 'center', paddingBottom: 32 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, minHeight: 60, borderBottomWidth: 1, borderBottomColor: c.lineSoft, backgroundColor: '#ffffff' },
  headerBack: { minWidth: 32, minHeight: 44, justifyContent: 'center' },
  headerTitle: { flex: 1, fontFamily: 'PoppinsSemiBold', fontSize: 19, lineHeight: 28, color: c.ink },
  headerStep: { fontFamily: 'Poppins', fontSize: 13, color: c.muted },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandText: { fontFamily: 'PoppinsBold', fontSize: 21, lineHeight: 30, color: c.ink, letterSpacing: -0.4 },

  schoolBlock: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  schoolLogo: { width: 44, height: 44 },
  schoolName: { fontFamily: 'PoppinsBold', fontSize: 19, lineHeight: 27, color: c.ink },
  schoolSub: { fontFamily: 'Poppins', fontSize: 14, lineHeight: 21, color: c.muted },
  demoBadge: { alignSelf: 'flex-start', backgroundColor: c.demoBg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  demoText: { fontFamily: 'PoppinsSemiBold', fontSize: 13, color: c.demoInk },

  studentCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: '#ffffff' },
  studentRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 48, height: 48, borderRadius: 10, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: 'PoppinsSemiBold', fontSize: 17, color: '#ffffff' },
  studentName: { fontFamily: 'PoppinsSemiBold', fontSize: 16, lineHeight: 24, color: c.ink },
  studentMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 },
  metaRule: { width: 1, height: 14, backgroundColor: c.line },

  titleBlock: { gap: 4 },
  title: { fontFamily: 'PoppinsBold', fontSize: 25, lineHeight: 34, color: c.ink, letterSpacing: -0.3 },
  helper: { fontFamily: 'Poppins', fontSize: 15, lineHeight: 23, color: c.muted },
  sectionTitle: { fontFamily: 'PoppinsBold', fontSize: 19, lineHeight: 27, color: c.ink, marginTop: 4 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionMeta: { fontFamily: 'PoppinsSemiBold', fontSize: 14, color: c.primary, marginTop: 4 },
  cardTitle: { fontFamily: 'PoppinsBold', fontSize: 17, lineHeight: 25, color: c.ink },
  body: { fontFamily: 'Poppins', fontSize: 14, lineHeight: 21, color: c.body },
  muted: { fontFamily: 'Poppins', fontSize: 13, lineHeight: 20, color: c.muted },
  faint: { fontFamily: 'Poppins', fontSize: 13, lineHeight: 20, color: c.faint },
  fieldLabel: { fontFamily: 'PoppinsSemiBold', fontSize: 14, lineHeight: 21, color: c.ink },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  divider: { height: 1, backgroundColor: c.lineSoft },

  overview: { backgroundColor: c.primarySoft, borderRadius: 12, padding: 20, gap: 2 },
  overviewLabel: { fontFamily: 'Poppins', fontSize: 15, color: c.body },
  overviewValue: { fontFamily: 'PoppinsBold', fontSize: 34, lineHeight: 46, color: c.ink, letterSpacing: -0.6 },
  overviewSub: { fontFamily: 'Poppins', fontSize: 14, lineHeight: 21, color: c.body },

  feeCard: { borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 14, gap: 10, backgroundColor: '#ffffff' },
  feeCardOn: { borderColor: c.primary, borderWidth: 1.5 },
  feeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  checkbox: { width: 24, height: 24, borderRadius: 5, borderWidth: 1.5, borderColor: '#9aa4b2', alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: c.primary, borderColor: c.primary },
  feeIcon: { width: 46, height: 46, borderRadius: 10, backgroundColor: c.iconTile, alignItems: 'center', justifyContent: 'center' },
  feeTitle: { fontFamily: 'PoppinsSemiBold', fontSize: 15, lineHeight: 22, color: c.ink },
  feeSub: { fontFamily: 'Poppins', fontSize: 12, lineHeight: 18, color: c.muted },
  feeAmount: { fontFamily: 'PoppinsSemiBold', fontSize: 16, color: c.ink },
  smallAction: { minHeight: 32, justifyContent: 'center' },
  amountEditor: { gap: 8, borderTopWidth: 1, borderTopColor: c.lineSoft, paddingTop: 10 },
  amountRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  amountField: { flex: 1, minWidth: 150, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 12 },
  currency: { fontFamily: 'PoppinsSemiBold', fontSize: 18, color: c.faint, marginRight: 8 },
  amountInput: { flex: 1, fontFamily: 'PoppinsSemiBold', fontSize: 18, paddingVertical: 10, color: c.ink },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, justifyContent: 'center' },
  chipOn: { borderColor: c.primary, backgroundColor: c.primarySoft },
  chipLabel: { fontFamily: 'Poppins', fontSize: 11, color: c.muted },
  chipValue: { fontFamily: 'PoppinsSemiBold', fontSize: 14, color: c.ink },
  fieldError: { fontFamily: 'Poppins', fontSize: 12, lineHeight: 18, color: c.danger },

  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  link: { fontFamily: 'PoppinsSemiBold', fontSize: 15, color: c.primary },
  linkSmall: { fontFamily: 'PoppinsSemiBold', fontSize: 12, color: c.primary },
  linkUnderline: { fontFamily: 'PoppinsSemiBold', fontSize: 14, color: c.primary, textDecorationLine: 'underline' },
  centerLink: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },

  radioRow: { flexDirection: 'row', gap: 12 },
  radio: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 16, minHeight: 46 },
  radioOn: { borderColor: '#9db7f2', backgroundColor: c.primarySoft },
  radioDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: '#9aa4b2', alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.primary },
  radioText: { fontFamily: 'Poppins', fontSize: 14, color: c.ink },

  card: { padding: 18, gap: 12, borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: '#ffffff' },
  input: { fontFamily: 'Poppins', fontSize: 16, color: c.ink, borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 14, minHeight: 50 },
  iconInput: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 14, minHeight: 50 },
  iconInputText: { flex: 1, fontFamily: 'Poppins', fontSize: 15, color: c.ink, paddingVertical: 10 },

  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 40 },
  summaryLabel: { flex: 1, fontFamily: 'PoppinsSemiBold', fontSize: 15, color: c.ink },
  summaryValue: { fontFamily: 'Poppins', fontSize: 16, color: c.ink },
  totalLabel: { fontFamily: 'PoppinsBold', fontSize: 17, color: c.ink },
  totalValue: { fontFamily: 'PoppinsBold', fontSize: 21, color: c.ink },
  panelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.panel, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  panelValue: { fontFamily: 'PoppinsBold', fontSize: 16, color: c.ink },
  panel: { backgroundColor: c.panel, borderRadius: 10, padding: 14, gap: 10 },

  notice: { flexDirection: 'row', gap: 12, backgroundColor: c.noticeBg, borderRadius: 10, padding: 16 },
  noticeTitle: { fontFamily: 'PoppinsSemiBold', fontSize: 15, color: c.noticeTitle },
  noticeText: { fontFamily: 'Poppins', fontSize: 14, lineHeight: 21, color: c.body },
  editRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },

  statementEntry: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, gap: 8 },
  statementDateRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  statementDate: { fontFamily: 'PoppinsSemiBold', fontSize: 12, color: c.body },
  statementRef: { fontFamily: 'Poppins', fontSize: 11, color: c.muted, backgroundColor: c.panel, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statementAmounts: { flexDirection: 'row', gap: 12, borderTopWidth: 1, borderTopColor: c.lineSoft, paddingTop: 8 },
  statementMoney: { fontFamily: 'PoppinsSemiBold', fontSize: 15 },

  receiptHero: { alignItems: 'center', gap: 4, paddingTop: 4 },
  successCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  receiptTitle: { fontFamily: 'PoppinsBold', fontSize: 23, lineHeight: 32, color: c.ink, textAlign: 'center' },
  receiptAmount: { fontFamily: 'PoppinsBold', fontSize: 34, lineHeight: 46, color: c.ink, marginTop: 4 },
  bigAmount: { fontFamily: 'PoppinsBold', fontSize: 30, lineHeight: 42, color: c.ink },
  reference: { fontFamily: 'Poppins', fontSize: 11, lineHeight: 18, color: c.muted },
  empty: { alignItems: 'center', padding: 24, gap: 6, backgroundColor: '#eaf6ee', borderRadius: 12 },

  errorBox: { padding: 14, backgroundColor: c.dangerBg, borderRadius: 10, gap: 4 },
  errorTitle: { fontFamily: 'PoppinsSemiBold', fontSize: 13, color: c.danger },
  errorText: { fontFamily: 'Poppins', fontSize: 13, lineHeight: 20, color: c.danger },
  busy: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },

  button: { backgroundColor: c.primary, borderRadius: 8, minHeight: 52, paddingVertical: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonSecondary: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#9aa4b2' },
  buttonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  buttonText: { fontFamily: 'PoppinsSemiBold', fontSize: 16, textAlign: 'center' },
  buttonSub: { fontFamily: 'Poppins', fontSize: 13, marginTop: 1 },

  bottomBar: { backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: c.lineSoft, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 10 },
  bottomLabel: { fontFamily: 'Poppins', fontSize: 15, color: c.body },
  bottomValue: { fontFamily: 'PoppinsBold', fontSize: 21, color: c.ink },

  helpCard: { gap: 4, paddingTop: 18, borderTopWidth: 1, borderTopColor: c.lineSoft },
  footer: { fontFamily: 'Poppins', fontSize: 11, lineHeight: 18, color: c.faint, textAlign: 'center' },
});
