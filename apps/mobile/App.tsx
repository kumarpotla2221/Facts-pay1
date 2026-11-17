import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { ApiError, api, baseUrl, demoCheckout, money, parseAmount, request, slug, type Lookup, type Order, type Receipt, type School } from './src/api';

const color = '#005d63';

function Button({ title, onPress, secondary = false, disabled = false, busy = false }: { title: string; onPress: () => void; secondary?: boolean; disabled?: boolean; busy?: boolean }) {
    const inactive = busy || disabled;
    return <Pressable accessibilityRole="button" accessibilityState={{ disabled: inactive }} disabled={inactive} onPress={onPress} style={({ pressed }) => [s.button, secondary && s.secondaryButton, { backgroundColor: secondary ? '#ffffff' : color }, inactive && { opacity: 0.45 }, pressed && { opacity: 0.8 }]}><Text style={[s.buttonText, secondary && { color }]}>{title}</Text></Pressable>;
  }

export default function App() {
  const [fonts, fontError] = useFonts({ Poppins: require('./assets/fonts/Poppins-Regular.ttf'), PoppinsSemiBold: require('./assets/fonts/Poppins-SemiBold.ttf'), PoppinsBold: require('./assets/fonts/Poppins-Bold.ttf') });
  const [school, setSchool] = useState<School | undefined>();
  const [logoError, setLogoError] = useState(false);
  const [adm, setAdm] = useState('');
  const [loadedAdm, setLoadedAdm] = useState('');
  const [data, setData] = useState<Lookup>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
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
  const [receipt, setReceipt] = useState<Receipt>();
  // Demo checkout needs both the build-time opt-in and the server's mock gateway, so a server switched to
  // MOCK_GATEWAY=0 turns checkout off in already-installed builds instead of failing with a 503.
  const demo = demoCheckout && school?.checkout?.mode === 'demo';
  useEffect(() => { scrollRef.current?.scrollTo({ y: 0, animated: true }); }, [error, order, receipt, review, data]);
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
    if (data) { setData(undefined); setShowStatement(false); setEmail(''); setPhone(''); return true; }
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
  async function lookup() {
    const value = adm.trim();
    if (!/^[A-Za-z0-9/_-]{1,20}$/.test(value)) throw new Error('Enter a valid admission number.');
    const result = await api<Lookup>('dues', { adm: value });
    setReceipt(undefined); setOrder(undefined);
    setLoadedAdm(value); setData(result); setShowStatement(false); setReview(false); setDetails({});
    setAmounts(Object.fromEntries(result.items.map(i => [i.id, (i.paise / 100).toFixed(2)])));
    setChosen(Object.fromEntries(result.items.map(i => [i.id, true])));
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
    setOrder(await api<Order>('orders', { adm: loadedAdm, pays, ...(cleanEmail && { email: cleanEmail }), ...(cleanPhone && { phone: cleanPhone }) }));
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
  if (!fonts && !fontError) return <View style={s.loading}><ActivityIndicator /></View>;
  const dueTotal = data?.items.reduce((sum, i) => sum + i.paise, 0) || 0;
  const paidTotal = data?.statement.reduce((sum, i) => sum + i.paidPaise, 0) || 0;
  const chargedTotal = data?.statement.reduce((sum, i) => sum + i.chargedPaise, 0) || 0;
  const statementBalance = chargedTotal - paidTotal;
  const step = receipt ? 3 : review || order ? 2 : data ? 1 : 0;
  const headings = ['Find your student', 'Choose what to pay', 'Check your payment', 'Your receipt'];
  return <SafeAreaProvider><SafeAreaView style={s.safe}><StatusBar style="dark" /><KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={s.schoolBar}><View style={s.schoolRow}>{!logoError && !!baseUrl && <Image accessibilityLabel="School logo" source={{ uri: `${baseUrl}/assets/schools/${slug}/logo.png` }} onError={() => setLogoError(true)} style={s.compactLogo} resizeMode="contain" />}<View style={{ flex: 1 }}><Text style={s.schoolName}>{school?.name || 'School fee payment'}</Text><Text style={s.muted}>Parent fee portal</Text></View></View></View>
    <ScrollView ref={scrollRef} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      {step > 0 && <Pressable accessibilityRole="button" accessibilityLabel={step === 1 ? 'Back to find student' : step === 3 ? 'Back to updated fees' : 'Back to choose fees'} accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => goBack()} style={[s.backButton, busy && { opacity: 0.45 }]}><Text style={[s.backText, { color }]}>{'\u2039'}  {step === 1 ? 'Back to find student' : step === 3 ? 'Back to fees' : 'Back to choose fees'}</Text></Pressable>}
      <View style={s.sectionHeading}><Text style={[s.eyebrow, { color }]}>STEP {step + 1} OF 4</Text>{demo &&<View style={s.demoBadge}><Text style={s.demoText}>Demo · No real money</Text></View>}</View>
      <View style={s.progressTrack}>{[0, 1, 2, 3].map(index => <React.Fragment key={index}>{index > 0 && <View style={s.progressConnector} />}<View style={[s.progressCircle, index === step && { backgroundColor: color, borderColor: color }]}><Text style={[s.progressNumeral, index === step && { color: "#fff" }]}>{index + 1}</Text></View></React.Fragment>)}</View>
      <View style={s.headingBlock}><Text accessibilityRole="header" style={s.screenTitle}>{headings[step]}</Text><Text style={s.helper}>{receipt ? 'Keep these details for your records.' : order ? 'Try a successful or failed payment. No money will be charged.' : review ? 'Check the student and amount before continuing.' : data ? 'Select a fee, then choose how much to pay.' : 'Enter the admission number from your school ID card or fee receipt.'}</Text></View>
      {!!error && <View style={s.errorBox}><Text style={s.errorTitle}>Please check</Text><Text accessibilityRole="alert" style={s.error}>{error}</Text></View>}
      {busy && <View style={s.busy}><ActivityIndicator color={color} /><Text style={s.muted}>Please wait...</Text></View>}
      {!school && !busy && <Button busy={busy} title="Try connecting again" secondary onPress={() => void run(loadSchool)} />}
      {!data && !receipt && <View style={s.card}><Text style={s.label}>Student admission number</Text><TextInput accessibilityLabel="Student admission number" value={adm} onChangeText={setAdm} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={20} placeholder="For example, 26/39" placeholderTextColor="#8293a2" returnKeyType="search" onSubmitEditing={() => { if (!busy && school && adm.trim()) void run(lookup); }} style={s.input} /><Text style={s.muted}>Enter the number exactly as shown, including any / or -.</Text><Button busy={busy} title="Show student fees" disabled={!school || !adm.trim()} onPress={() => void run(lookup)} /></View>}
      {data && !receipt && <View style={s.studentStrip}><View style={[s.avatar, { backgroundColor: color }]}><Text style={s.avatarText}>{data.student.name.trim().charAt(0)}</Text></View><View style={{ flex: 1 }}><Text style={s.student}>{data.student.name}</Text><Text style={s.muted}>Class {[data.student.cls, data.student.section].filter(Boolean).join(' - ')} · Admission {loadedAdm}</Text></View>{!review && !order && <Pressable accessibilityRole="button" disabled={busy} hitSlop={8} onPress={() => { setData(undefined); setError(''); setEmail(''); setPhone(''); }} style={s.smallAction}><Text style={[s.link, { color }]}>Change</Text></Pressable>}</View>}
      {data && !receipt && !review && !order && <>
        <View style={s.balanceCard}><Text style={s.balanceLabel}>Total fees left to pay</Text><Text style={s.balanceValue}>{money(dueTotal)}</Text><Text style={s.balanceHint}>{data.items.length ? 'You can choose the fees to pay today below.' : 'No payment is needed right now.'}</Text></View>
        {!data.items.length && <View style={s.empty}><Text style={s.checkmark}>✓</Text><Text style={s.sectionTitle}>All fees are paid</Text><Text style={s.helper}>You can still view or download your statement below.</Text></View>}
        {data.items.map(item => {
          const included = !!chosen[item.id];
          const entered = parseAmount(amounts[item.id] || '');
          const invalid = included && (entered === null || entered < item.minPaise || entered > item.paise);
          return <View key={item.id} style={[s.card, s.feeCard, included && { borderColor: "#d5e5d1", backgroundColor: "#edf4e9" }]}>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: included, disabled: busy }} accessibilityLabel={`Pay ${item.label}`} disabled={busy} onPress={() => setChosen({ ...chosen, [item.id]: !included })} style={s.feeSelect}><View style={[s.checkbox, included && { backgroundColor: color, borderColor: color }]}><Text style={s.checkboxTick}>{included ? '✓' : ''}</Text></View><View style={{ flex: 1 }}><Text style={s.feeTitle}>{item.label}</Text><Text style={s.muted}>{included ? 'Selected for payment' : 'Tap to select this fee'}</Text></View></Pressable>
            <View style={s.row}><Text style={s.helper}>Amount left to pay</Text><Text style={s.feeDue}>{money(item.paise)}</Text></View>
            {!!item.lines.length && <><Pressable accessibilityRole="button" accessibilityState={{ expanded: !!details[item.id] }} disabled={busy} onPress={() => setDetails({ ...details, [item.id]: !details[item.id] })} style={s.smallAction}><Text style={[s.link, { color }]}>{details[item.id] ? 'Hide fee details' : 'What is included in this fee?'}</Text></Pressable>{details[item.id] && item.lines.map((line, index) => <View key={index} style={s.row}><Text style={[s.muted, { flex: 1 }]}>{line.label}</Text><Text style={s.body}>{money(line.paise)}</Text></View>)}</>}
            {included && <><View style={s.divider} /><Text style={s.label}>How much would you like to pay?</Text>
              <View style={s.quickAmounts}>{[{ label: 'Full amount', value: item.paise }, ...(item.minPaise < item.paise ? [{ label: 'Minimum amount', value: item.minPaise }] : [])].map(option => <Pressable key={option.label} accessibilityRole="radio" accessibilityState={{ selected: entered === option.value, disabled: busy }} disabled={busy} onPress={() => setAmounts({ ...amounts, [item.id]: (option.value / 100).toFixed(2) })} style={[s.amountOption, entered === option.value && { backgroundColor: '#e4efdf', borderColor: color }]}><Text style={[s.label, { color }]}>{option.label}</Text><Text style={s.optionValue}>{money(option.value)}</Text></Pressable>)}</View>
              {item.minPaise < item.paise && <><Text style={s.muted}>Or enter another amount (at least {money(item.minPaise)})</Text><View style={[s.amountField, invalid && { borderColor: '#b43d32' }]}><Text style={s.currency}>₹</Text><TextInput accessibilityLabel={`Your payment amount for ${item.label}`} value={amounts[item.id] || ''} onChangeText={value => setAmounts({ ...amounts, [item.id]: value })} keyboardType="decimal-pad" editable={!busy} style={s.amountInput} /></View>{invalid && <Text style={s.fieldError}>Enter between {money(item.minPaise)} and {money(item.paise)}.</Text>}</>}
            </>}
          </View>;
        })}
        <View style={s.card}>
          <Text style={s.sectionTitle}>Fee statement</Text><Text style={s.muted}>Charges, payments and credits for this school year</Text>
          <Button busy={busy} title={showStatement ? 'Hide statement' : 'View statement'} secondary onPress={() => setShowStatement(!showStatement)} />
          {showStatement && <>
            <Text style={s.muted}>Read each entry below. Charges add to your balance; payments and credits reduce it.</Text>
            {data.statement.map((entry, index) => <View key={`${entry.ref}-${index}`} style={s.statementEntry}>
              <View style={s.statementDateRow}><Text style={s.statementDate}>{new Date(`${entry.date}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}</Text>{!!entry.ref && <Text selectable style={s.statementRef}>{entry.ref}</Text>}</View>
              <Text style={s.statementDescription}>{entry.label || 'Account entry'}</Text>
              <View style={s.statementAmounts}>
                <View style={s.statementAmountCell}><Text style={s.muted}>Charge</Text><Text style={[s.statementMoney, { color: entry.chargedPaise < 0 ? '#18734e' : '#9e3028' }]}>{entry.chargedPaise ? money(entry.chargedPaise) : '-'}</Text></View>
                <View style={s.statementAmountCell}><Text style={s.muted}>Payment / credit</Text><Text style={[s.statementMoney, { color: '#18734e' }]}>{entry.paidPaise ? money(entry.paidPaise) : '-'}</Text></View>
              </View>
            </View>)}
            {!data.statement.length && <Text style={s.muted}>No entries are available for this school year.</Text>}
            <View style={s.statementTotals}>
              <Text style={s.label}>Statement totals</Text>
              <View style={s.row}><Text style={s.body}>Total charges</Text><Text style={s.label}>{money(chargedTotal)}</Text></View>
              <View style={s.row}><Text style={[s.body, { flex: 1 }]}>Total payments / credits</Text><Text style={s.label}>{money(paidTotal)}</Text></View>
              <View style={s.divider} />
              <View style={s.row}><Text style={[s.label, { flex: 1 }]}>{statementBalance < 0 ? 'Credit balance' : statementBalance > 0 ? 'Statement balance due' : 'Statement balance'}</Text><Text style={[s.statementMoney, { color: statementBalance > 0 ? '#9e3028' : '#18734e' }]}>{money(Math.abs(statementBalance))}</Text></View>
              <Text style={s.muted}>{statementBalance < 0 ? 'Your statement shows a credit. Contact the school to confirm how it applies to individual fees.' : 'The fee cards above show the amounts available to pay.'}</Text>
              <Text style={s.muted}>Payments / credits may include an opening credit balance, not only money paid this year.</Text>
            </View>
          </>}
          <Button busy={busy} title="Save or share PDF" secondary onPress={() => void run(statementPdf)} />
        </View>
      </>}
      {data && review && !order && !receipt && <>
        <View style={s.card}><Text style={s.sectionTitle}>You are paying for</Text>{selected.map(item => <View key={item.id} style={s.reviewLine}><Text style={[s.body, { flex: 1 }]}>{item.label}</Text><Text style={s.label}>{money(parseAmount(amounts[item.id] || '') || 0)}</Text></View>)}<View style={s.divider} /><View style={s.row}><Text style={s.label}>Total to pay today</Text><Text style={[s.statValue, { color }]}>{money(total)}</Text></View><Text style={s.muted}>Fees left after this payment: {money(dueTotal - total)}</Text><Button busy={busy} title="Change fees or amounts" secondary onPress={() => setReview(false)} /></View>
        <View style={s.card}><Text style={s.sectionTitle}>Get your receipt by email</Text><Text style={s.helper}>Optional. You can continue without entering contact details.</Text><Text style={s.label}>Email address (optional)</Text><TextInput accessibilityLabel="Receipt email, optional" placeholder="parent@example.com" placeholderTextColor="#8293a2" value={email} onChangeText={setEmail} editable={!busy} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} style={s.input} /><Text style={s.label}>Phone number (optional)</Text><TextInput accessibilityLabel="Phone number, optional" placeholder="Enter phone number" placeholderTextColor="#8293a2" value={phone} onChangeText={setPhone} editable={!busy} keyboardType="phone-pad" style={s.input} /></View>
        <View style={s.notice}><Text style={s.noticeText}>{demo ? 'This is a demo. No money will leave your account. Completing it saves a test payment and changes the displayed fee balance.' : 'Online payments are not available yet. You can view fees and download your statement.'}</Text></View>
      </>}
      {order && <View style={s.card}><View style={s.demoBadge}><Text style={s.demoText}>Demo payment</Text></View><Text style={s.sectionTitle}>Try the payment experience</Text><Text style={[s.feeAmount, { color }]}>{money(order.paise)}</Text><Text style={s.helper}>Choose a result below. A successful demo saves a payment in the connected database.</Text><Button busy={busy} title="Complete demo payment" onPress={() => Alert.alert('Complete this demo?', 'No real money is charged. A test payment will be saved and the fee balance will change.', [{ text: 'Go back', style: 'cancel' }, { text: 'Complete demo', onPress: () => void run(() => settle('success')) }])} /><Button busy={busy} title="Try an unsuccessful payment" secondary onPress={() => void run(() => settle('fail'))} /><Button busy={busy} title="Cancel and return to fees" secondary onPress={() => { setOrder(undefined); setReview(false); setError(''); }} /><Text selectable style={s.reference}>Payment reference: {order.orderId}</Text></View>}
      {receipt && <View style={s.card}><View style={s.receiptHeader}><Text style={s.checkmark}>✓</Text><Text style={s.sectionTitle}>Demo payment completed</Text><Text style={s.helper}>No real money was charged.</Text><Text style={[s.feeAmount, { color }]}>{money(receipt.paise)}</Text></View><View style={s.divider} />{[['Receipt number', receipt.receiptNo], ['Student', data?.student.name || ''], ['Admission number', loadedAdm], ['Payment reference', receipt.gatewayRef]].map(([label, value]) => <View key={label} style={s.detail}><Text style={s.muted}>{label}</Text><Text selectable style={s.label}>{value}</Text></View>)}<Text style={s.helper}>{receipt.emailed ? 'Your receipt email has been requested. You can also share the details below.' : 'Share these payment details to keep a copy.'}</Text><Button busy={busy} title="Share receipt details" secondary onPress={() => void run(async () => { await Share.share({ message: `${school?.name || 'Facts Pay'}\nDEMO PAYMENT - no money charged\nReceipt: ${receipt.receiptNo}\nPaid: ${money(receipt.paise)}\nReference: ${receipt.gatewayRef}` }); })} /><Button busy={busy} title="See updated fees" onPress={() => void run(lookup)} /></View>}
      <View style={s.helpCard}><Text style={s.label}>Need help?</Text><Text style={s.helper}>{school?.phone ? `Call your school office: ${school.phone}` : 'Contact your school office for help with admission numbers or fee details.'}</Text></View>
      <Text style={s.footer}>School fee payments · Facts Pay</Text>
    </ScrollView>
    {data && !receipt && !order && !!data.items.length && <View style={s.bottomBar}><View style={s.bottomInner}><View style={{ flex: 1 }}><Text style={s.muted}>{review ? 'Total to pay today' : 'You will pay'}</Text><Text style={[s.statValue, { color }]}>{money(total)}</Text></View><View style={{ flex: 1 }}><Button busy={busy} title={review ? (demo ? 'Try demo payment' : 'Payments unavailable') : 'Continue'} disabled={!selected.length || (review && !demo)} onPress={() => void run(review ? createOrder : async () => reviewFees())} /></View></View><Text style={s.bottomNote}>{review ? 'Check your details before continuing' : 'Next: check your payment details'}</Text></View>}
  </KeyboardAvoidingView></SafeAreaView></SafeAreaProvider>;
}

const baseStyles = StyleSheet.create({
  backButton: { alignSelf: 'flex-start', paddingVertical: 10, paddingRight: 16, minHeight: 44, justifyContent: 'center' }, backText: { fontFamily: 'PoppinsSemiBold', fontSize: 14 },
  statementEntry: { borderWidth: 1, borderColor: '#e1e8ef', borderRadius: 12, padding: 14, gap: 10 }, statementDateRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, statementDate: { fontFamily: 'PoppinsSemiBold', fontSize: 12, color: '#344d60' }, statementRef: { fontFamily: 'Poppins', fontSize: 11, color: '#52697d', backgroundColor: '#eef3f7', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }, statementDescription: { fontFamily: 'Poppins', fontSize: 13, color: '#263e50', lineHeight: 22 }, statementAmounts: { flexDirection: 'row', gap: 12, borderTopWidth: 1, borderTopColor: '#edf1f5', paddingTop: 10 }, statementAmountCell: { flex: 1, gap: 4 }, statementMoney: { fontFamily: 'PoppinsSemiBold', fontSize: 16 }, statementTotals: { padding: 16, backgroundColor: '#f0f5f9', borderRadius: 12, gap: 12 },
  schoolBar: { backgroundColor: '#fff', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#e5ecf1' }, compactLogo: { width: 80, height: 48, backgroundColor: '#fff', borderRadius: 6 }, schoolName: { fontFamily: 'PoppinsSemiBold', fontSize: 14, lineHeight: 21, color: '#172e40' }, demoBadge: { backgroundColor: '#fff2d5', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' }, demoText: { fontFamily: 'PoppinsSemiBold', color: '#735015', fontSize: 11 }, progressTrack: { flexDirection: 'row', gap: 6 }, progressSegment: { flex: 1, height: 5, borderRadius: 3, backgroundColor: '#dfe7ee' }, headingBlock: { gap: 6 }, screenTitle: { fontFamily: 'PoppinsBold', fontSize: 26, lineHeight: 36, color: '#172e40' }, helper: { fontFamily: 'Poppins', fontSize: 14, color: '#52697d', lineHeight: 23 }, studentStrip: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: '#e5ecf1', padding: 15, flexDirection: 'row', alignItems: 'center', gap: 12 }, smallAction: { paddingVertical: 12, minHeight: 44, justifyContent: 'center' }, link: { fontFamily: 'PoppinsSemiBold', fontSize: 13 }, balanceCard: { padding: 20, borderRadius: 18, gap: 6 }, balanceLabel: { fontFamily: 'Poppins', fontSize: 14, color: '#e3edf5' }, balanceValue: { fontFamily: 'PoppinsBold', fontSize: 32, lineHeight: 46, color: '#fff' }, balanceHint: { fontFamily: 'Poppins', fontSize: 12, lineHeight: 20, color: '#e3edf5' }, feeSelect: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 48 }, checkbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: '#879aab', alignItems: 'center', justifyContent: 'center' }, checkboxTick: { fontSize: 19, color: '#fff' }, feeTitle: { fontFamily: 'PoppinsSemiBold', fontSize: 16, lineHeight: 24, color: '#172e40' }, feeDue: { fontFamily: 'PoppinsSemiBold', fontSize: 19, color: '#172e40' }, amountOption: { flex: 1, minWidth: 115, borderWidth: 1.5, borderColor: '#dce5ed', padding: 13, borderRadius: 12, gap: 5 }, optionValue: { fontFamily: 'PoppinsSemiBold', fontSize: 16, color: '#172e40' }, fieldError: { fontFamily: 'Poppins', fontSize: 12, color: '#b43d32', lineHeight: 20 }, reviewLine: { flexDirection: 'row', gap: 12, paddingVertical: 8, justifyContent: 'space-between' }, helpCard: { padding: 16, borderRadius: 14, backgroundColor: '#eaf1f7', gap: 4 }, reference: { fontFamily: 'Poppins', color: '#52697d', fontSize: 11, lineHeight: 18 },
  safe: { flex: 1, backgroundColor: '#f6f8fb' }, loading: { flex: 1, justifyContent: 'center' }, page: { padding: 20, gap: 18, maxWidth: 680, width: '100%', alignSelf: 'center', paddingBottom: 32 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, wordmark: { fontFamily: 'PoppinsBold', fontSize: 26, letterSpacing: -1 }, wordmarkLight: { fontFamily: 'Poppins', color: '#6e8293' }, pill: { alignSelf: 'flex-start', backgroundColor: '#e5edf3', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 }, pillText: { fontFamily: 'PoppinsSemiBold', color: '#38576d', fontSize: 10, letterSpacing: 1 },
  header: { padding: 24, borderRadius: 24, gap: 12 }, schoolRow: { flexDirection: 'row', alignItems: 'center', gap: 14 }, logo: { width: 68, height: 60, backgroundColor: '#fff', borderRadius: 12 }, school: { fontFamily: 'PoppinsSemiBold', fontSize: 16, color: '#fff', lineHeight: 24 }, headerNote: { fontFamily: 'Poppins', color: '#e0edf4', fontSize: 12, lineHeight: 20 }, headerDivider: { height: 1, backgroundColor: '#ffffff30', marginVertical: 4 }, eyebrow: { fontFamily: 'PoppinsSemiBold', color: '#bed7e5', fontSize: 10, letterSpacing: 1.7 }, heroTitle: { fontFamily: 'PoppinsBold', fontSize: 32, color: '#fff', lineHeight: 43 },
  steps: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }, step: { alignItems: 'center', flex: 1, gap: 8 }, stepDot: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#e3eaf0', alignItems: 'center', justifyContent: 'center' }, stepNumber: { fontFamily: 'PoppinsSemiBold', fontSize: 12, color: '#8493a2' }, stepText: { fontFamily: 'Poppins', fontSize: 10, color: '#7d8b99', textAlign: 'center' },
  card: { padding: 20, backgroundColor: '#fff', borderRadius: 20, gap: 12, borderWidth: 1, borderColor: '#e5ecf1' }, sectionTitle: { fontFamily: 'PoppinsSemiBold', fontSize: 17, lineHeight: 26, color: '#172e40' }, sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, label: { fontFamily: 'PoppinsSemiBold', fontSize: 14, color: '#263e50' }, student: { fontFamily: 'PoppinsSemiBold', fontSize: 17, color: '#172e40' }, body: { fontFamily: 'Poppins', fontSize: 13, color: '#344d60', lineHeight: 21 }, muted: { fontFamily: 'Poppins', fontSize: 13, color: '#52697d', lineHeight: 21 },
  avatar: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center' }, avatarText: { fontFamily: 'PoppinsSemiBold', color: '#fff', fontSize: 22 }, stats: { flexDirection: 'row', gap: 12, marginVertical: 6 }, stat: { flex: 1, backgroundColor: '#f6f8fb', borderRadius: 12, padding: 12, gap: 4 }, statValue: { fontFamily: 'PoppinsBold', fontSize: 19, color: '#1c6c55' }, feeCard: { borderWidth: 1.5 }, feeAmount: { fontFamily: 'PoppinsBold', fontSize: 30, lineHeight: 44 }, divider: { height: 1, backgroundColor: '#e8edf2', marginVertical: 4 },
  input: { fontFamily: 'Poppins', borderWidth: 1, borderColor: '#dce5ed', borderRadius: 12, padding: 15, backgroundColor: '#f8fafc', color: '#263e50', fontSize: 15, minHeight: 52 }, amountField: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#dce5ed', borderRadius: 12, backgroundColor: '#f8fafc', paddingHorizontal: 15 }, currency: { fontFamily: 'PoppinsSemiBold', fontSize: 20, color: '#748696', marginRight: 10 }, amountInput: { flex: 1, fontFamily: 'PoppinsSemiBold', fontSize: 20, paddingVertical: 13, color: '#263e50' }, quickAmounts: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' }, chip: { borderWidth: 1, borderColor: '#dce5ed', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, minHeight: 44 }, chipText: { fontFamily: 'PoppinsSemiBold', fontSize: 11 },
  button: { padding: 15, borderRadius: 12, alignItems: 'center', minHeight: 54, justifyContent: 'center' }, buttonText: { fontFamily: 'PoppinsSemiBold', color: '#fff', fontSize: 14, textAlign: 'center' }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, line: { borderBottomWidth: 1, borderBottomColor: '#e8edf2', paddingVertical: 12, gap: 4 }, errorBox: { padding: 16, backgroundColor: '#fff0ee', borderRadius: 14, gap: 5 }, errorTitle: { fontFamily: 'PoppinsSemiBold', color: '#a9362b', fontSize: 13 }, error: { fontFamily: 'Poppins', color: '#a9362b', fontSize: 12, lineHeight: 20 }, busy: { flexDirection: 'row', justifyContent: 'center', gap: 10, alignItems: 'center' },
  empty: { alignItems: 'center', padding: 28, gap: 10, backgroundColor: '#eaf6ef', borderRadius: 20 }, checkmark: { overflow: 'hidden', textAlign: 'center', textAlignVertical: 'center', width: 60, height: 60, lineHeight: 60, borderRadius: 30, backgroundColor: '#def2e8', color: '#20875f', fontSize: 30 }, receiptHeader: { alignItems: 'center', gap: 10, paddingVertical: 8 }, detail: { gap: 3, paddingVertical: 4 }, notice: { backgroundColor: '#fff5de', borderRadius: 12, padding: 14 }, noticeText: { fontFamily: 'Poppins', color: '#88631e', fontSize: 12, lineHeight: 20 }, footer: { fontFamily: 'Poppins', color: '#8493a2', textAlign: 'center', fontSize: 11, lineHeight: 20 }, bottomBar: { backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e5ecf1', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8 }, bottomInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, width: '100%', maxWidth: 640, alignSelf: 'center' }, bottomNote: { fontFamily: 'Poppins', color: '#8493a2', fontSize: 10, textAlign: 'center', marginTop: 8 },
});

// Reference theme: teal actions, sage surfaces, warm white cards.
const s = StyleSheet.create({
  ...baseStyles,
  safe: { ...baseStyles.safe, backgroundColor: '#fcfcfa' },
  page: { ...baseStyles.page, paddingHorizontal: 22, paddingTop: 18, gap: 17 },
  schoolBar: { ...baseStyles.schoolBar, backgroundColor: '#fcfcfa', borderBottomWidth: 0, paddingTop: 16, paddingBottom: 10 },
  compactLogo: { ...baseStyles.compactLogo, width: 78, height: 44, backgroundColor: 'transparent', borderRadius: 0 },
  schoolName: { ...baseStyles.schoolName, color: '#091725', fontFamily: 'PoppinsBold', fontSize: 14 },
  demoBadge: { ...baseStyles.demoBadge, backgroundColor: '#ffe6ac', borderRadius: 8, paddingVertical: 5 },
  demoText: { ...baseStyles.demoText, color: '#493019', fontSize: 11 },
  eyebrow: { ...baseStyles.eyebrow, color: '#566359', letterSpacing: 0.8, fontSize: 10 },
  progressTrack: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10 },
  progressConnector: { flex: 1, height: 1, backgroundColor: '#a7bfa2' },
  progressCircle: { width: 29, height: 29, borderRadius: 15, borderWidth: 1, borderColor: '#a7bfa2', backgroundColor: '#f5f8f1', alignItems: 'center', justifyContent: 'center' },
  progressNumeral: { fontFamily: 'PoppinsSemiBold', fontSize: 13, color: '#3b4942' },
  screenTitle: { ...baseStyles.screenTitle, color: '#071723', fontSize: 29, lineHeight: 39, letterSpacing: -0.8 },
  headingBlock: { ...baseStyles.headingBlock, gap: 8, paddingBottom: 4 },
  helper: { ...baseStyles.helper, color: '#50585b', fontSize: 14, lineHeight: 23 },
  muted: { ...baseStyles.muted, color: '#5b6366', lineHeight: 20 },
  body: { ...baseStyles.body, color: '#17252f' },
  label: { ...baseStyles.label, color: '#0c1b28' },
  sectionTitle: { ...baseStyles.sectionTitle, color: '#0b1927', fontFamily: 'PoppinsBold', fontSize: 16 },
  card: { ...baseStyles.card, borderRadius: 14, borderColor: '#e0e4e6', padding: 17, gap: 13, backgroundColor: '#fff' },
  studentStrip: { ...baseStyles.studentStrip, borderRadius: 13, padding: 13, backgroundColor: '#fff', borderColor: '#e0e4e6' },
  student: { ...baseStyles.student, color: '#081725', fontFamily: 'PoppinsBold', fontSize: 17 },
  avatar: { ...baseStyles.avatar, borderRadius: 11, width: 45, height: 45 },
  balanceCard: { ...baseStyles.balanceCard, backgroundColor: '#e7f0e1', borderRadius: 15, gap: 2, padding: 18 },
  balanceLabel: { ...baseStyles.balanceLabel, color: '#17252f', fontSize: 14 },
  balanceValue: { ...baseStyles.balanceValue, color: '#082f36', fontSize: 34, lineHeight: 46, letterSpacing: -1 },
  balanceHint: { ...baseStyles.balanceHint, color: '#485b4d' },
  feeCard: { ...baseStyles.feeCard, borderWidth: 1, borderRadius: 13, gap: 12 },
  feeTitle: { ...baseStyles.feeTitle, color: '#081725', fontFamily: 'PoppinsBold', fontSize: 15 },
  feeDue: { ...baseStyles.feeDue, color: '#081725', fontSize: 19 },
  checkbox: { ...baseStyles.checkbox, width: 25, height: 25, borderRadius: 6 },
  input: { ...baseStyles.input, backgroundColor: '#f5f7f8', borderColor: '#d4dadd', borderRadius: 12, fontFamily: 'PoppinsSemiBold', color: '#101e2a', fontSize: 16, padding: 14 },
  amountField: { ...baseStyles.amountField, backgroundColor: '#f6f8f7', borderColor: '#d4dadd', borderRadius: 10 },
  amountInput: { ...baseStyles.amountInput, color: '#0b2630' },
  amountOption: { ...baseStyles.amountOption, borderWidth: 1, borderRadius: 10, backgroundColor: '#fff', padding: 12 },
  optionValue: { ...baseStyles.optionValue, color: '#092f35' },
  button: { ...baseStyles.button, minHeight: 52, borderRadius: 12, paddingVertical: 14, borderWidth: 1, borderColor: '#005d63' },
  secondaryButton: { borderWidth: 1, borderColor: '#005d63' },
  buttonText: { ...baseStyles.buttonText, fontSize: 14, fontFamily: 'PoppinsSemiBold' },
  notice: { ...baseStyles.notice, backgroundColor: '#fff1d4', borderRadius: 13 },
  noticeText: { ...baseStyles.noticeText, color: '#624222' },
  reviewLine: { ...baseStyles.reviewLine, paddingVertical: 9 },
  divider: { ...baseStyles.divider, backgroundColor: '#dfe6df' },
  statementTotals: { ...baseStyles.statementTotals, backgroundColor: '#eaf2e5' },
  statementEntry: { ...baseStyles.statementEntry, borderColor: '#e0e4e6', backgroundColor: '#fff' },
  statementRef: { ...baseStyles.statementRef, backgroundColor: '#edf3e8', color: '#425447' },
  receiptHeader: { ...baseStyles.receiptHeader, paddingVertical: 18, gap: 12 },
  checkmark: { ...baseStyles.checkmark, width: 64, height: 64, lineHeight: 64, borderRadius: 32, backgroundColor: '#deefcf', color: '#18721d', fontSize: 34 },
  detail: { ...baseStyles.detail, borderBottomWidth: 1, borderBottomColor: '#eef0ed', paddingVertical: 10 },
  empty: { ...baseStyles.empty, backgroundColor: '#eaf3e3' },
  helpCard: { ...baseStyles.helpCard, borderRadius: 0, borderTopWidth: 1, borderTopColor: '#e5e8e2', backgroundColor: 'transparent', paddingHorizontal: 0, paddingTop: 20 },
  footer: { ...baseStyles.footer, color: '#6f7973' },
  bottomBar: { ...baseStyles.bottomBar, backgroundColor: '#fff', borderTopColor: '#e5e8e2', paddingBottom: 12, paddingTop: 14 },
  statValue: { ...baseStyles.statValue, color: '#082f36', fontSize: 22 },
  bottomNote: { ...baseStyles.bottomNote, color: '#58645d' },
});
