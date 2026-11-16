// All server data is rendered with textContent only (no innerHTML) => no XSS from DB values.
const slug = location.pathname.split('/').pop();
const $ = id => document.getElementById(id);
const rs = p => (p < 0 ? '-₹' : '₹') + (Math.abs(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = d => new Date(d).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const sum = (list, of) => list.reduce((a, x) => a + of(x), 0);
const classOf = s => [s.cls, s.section].filter(Boolean).join(' - ');   // "XI Comm - A"
let school = {}, adm, student, items = [], order;

async function api(path, body) {
  const r = await fetch(`/api/${slug}/${path}`, body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Something went wrong');
  return r.headers.get('content-type')?.includes('pdf') ? r.blob() : r.json();
}
// busy: spinner + optional text on the clicked button while the request runs
const run = (btn, fn, busyText) => async e => {
  e?.preventDefault(); $('err').hidden = true;
  const text = btn.textContent; btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true');
  if (busyText) btn.textContent = busyText;
  try { await fn(); } catch (x) { $('err').textContent = x.message; $('err').hidden = false; }
  finally { btn.disabled = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); btn.textContent = text; refreshTotal(); }
};
const selected = () => items.filter(i => $('c_' + i.id).checked);
const paying = i => Math.round($('p_' + i.id).value * 100) || 0;   // what the parent typed for a due, in paise
const refreshTotal = () => {
  const s = selected(), t = rs(sum(s, paying));
  const available = school.checkout?.mode === 'demo';
  $('total').textContent = t;
  $('pay').textContent = !available ? 'Online payments unavailable' : s.length ? 'Pay ' + t : 'Select a fee to pay';
  $('pay').disabled = !available || !s.length || $('pay').classList.contains('busy');
};
const el = (tag, className, text) => Object.assign(document.createElement(tag), className && { className }, text != null && { textContent: text });
// placeholder cards shaped like the real ones while the school DB answers
const skeleton = () => [0, 1].map(() => {
  const c = el('div', 'fee skel'); c.setAttribute('aria-hidden', 'true');
  c.append(el('span', 'bar w60'), ...[0, 1, 2, 3].map(() => el('span', 'bar')), el('span', 'bar w40 end'));
  return c;
});

// Embedded in the school's site: tell that page how tall we are, so its iframe can grow with the content
// (no inner scrollbar on phones). It only learns a number; demo-site/index.html shows the 3-line listener.
if (document.documentElement.classList.contains('framed'))
  new ResizeObserver(() => parent.postMessage({ type: 'facts-pay:height', height: document.body.offsetHeight }, '*')).observe(document.body);

// ---- school branding: registry info + optional /assets/schools/<slug>/logo.png and hero.jpg ----
function asset(img, file) {
  img.addEventListener('load', () => { img.hidden = false; });
  img.src = `/assets/schools/${slug}/${file}`;
}
asset($('logo'), 'logo.png');
asset($('hero'), 'hero.jpg');
api('info').then(i => {
  school = i;
  $('checkoutNotice').textContent = i.checkout?.message || 'Online payments are currently unavailable. Please pay at the school fee counter.';
  refreshTotal();
  $('school').textContent = i.name; $('addr').textContent = i.address || '';
  document.title = i.name + ' - Fee Payment';
  document.documentElement.style.setProperty('--c', i.color);
  $('copy').textContent = `© ${new Date().getFullYear()} ${i.name}`;
  if (i.email) { $('mail').textContent = i.email; $('mailBox').href = 'mailto:' + i.email; $('mailBox').hidden = false; }
  if (i.website) for (const a of document.querySelectorAll('a.site')) a.href = i.website;
  if (i.phone) { $('tel').textContent = i.phone; $('telBox').href = 'tel:' + i.phone.replace(/\s/g, ''); $('telBox').hidden = false; }
}).catch(() => {
  $('checkoutNotice').textContent = 'Payment availability could not be checked. Refresh the page or contact the school.';
  refreshTotal();
});

// ---- lookup ----
$('lookup').onsubmit = run($('lookup').querySelector('button'), async () => {
  adm = $('adm').value.trim();
  $('gw').hidden = true; $('receipt').hidden = true; items = [];
  const list = $('list'), foot = $('dueFoot');
  $('sname').value = ''; $('scls').value = '';
  list.replaceChildren(...skeleton()); list.setAttribute('aria-busy', 'true'); foot.hidden = true; $('stmt').hidden = true; $('dues').hidden = false;
  try { var d = await api('dues', { adm }); }   // POST: the admission number never goes in a URL
  catch (x) { $('dues').hidden = true; throw x; }
  finally { list.removeAttribute('aria-busy'); }
  student = d.student; items = d.items;
  $('sname').value = student.name; $('scls').value = classOf(student);
  showStatement(d.statement);

  list.replaceChildren(); foot.hidden = !items.length;
  if (!items.length) list.append(el('p', 'empty', 'Nothing to pay. All fees are paid up to date.'));
  for (const i of items) {
    const card = el('div', 'fee');
    const head = el('label', 'fee-head');
    const sw = Object.assign(el('input', 'switch'), { type: 'checkbox', id: 'c_' + i.id, checked: true });
    sw.setAttribute('aria-label', 'Include ' + i.label);
    head.append(el('span', 'name', i.label), sw);
    const lines = el('table', 'lines'); lines.hidden = !i.lines?.length;
    for (const l of i.lines || []) { const tr = lines.insertRow(); tr.insertCell().textContent = l.label; tr.insertCell().textContent = rs(l.paise); }
    const due = el('span', 'fee-sum');
    due.append(el('span', null, 'Amount due'), el('strong', null, rs(i.paise)));
    // How much of it to pay now. The school's rule is the due's minimum: the browser enforces min/max natively,
    // and the server checks the same again.
    const partial = i.minPaise < i.paise;
    const amt = Object.assign(el('input'), { type: 'number', id: 'p_' + i.id, min: i.minPaise / 100, max: i.paise / 100, step: '0.01',
      value: i.paise / 100, required: true, readOnly: !partial, inputMode: 'decimal', oninput: refreshTotal });
    amt.setAttribute('aria-label', 'Amount to pay now for ' + i.label);
    const pay = el('label', 'fee-pay');
    const what = el('span', null, 'Pay now'); what.append(el('small', null, partial ? 'Minimum ' + rs(i.minPaise) : 'Payable in full'));
    pay.append(what, amt);
    sw.onchange = () => { amt.disabled = !sw.checked; refreshTotal(); };
    card.append(head, lines, due, pay); list.append(card);
  }
  $('paidYear').textContent = rs(sum(d.statement, e => e.paidPaise));
  $('totalDue').textContent = rs(sum(items, i => i.paise));
}, 'Finding student…');

function showStatement(entries) {
  const rows = $('sRows'); rows.replaceChildren();
  for (const e of entries) {
    const tr = rows.insertRow();
    tr.insertCell().textContent = day(e.date);
    tr.insertCell().append(e.label || '-', el('small', null, e.ref));
    // red = a charge, green = a payment or a concession (a negative charge)
    Object.assign(tr.insertCell(), { className: e.chargedPaise < 0 ? 'paid' : 'charged', textContent: e.chargedPaise ? rs(e.chargedPaise) : '' });
    Object.assign(tr.insertCell(), { className: 'paid', textContent: e.paidPaise ? rs(e.paidPaise) : '' });
  }
  if (!entries.length) Object.assign(rows.insertRow().insertCell(), { colSpan: 4, className: 'muted', textContent: 'No transactions this academic year.' });
  const charged = sum(entries, e => e.chargedPaise), paid = sum(entries, e => e.paidPaise);
  $('sCharged').textContent = rs(charged); $('sPaid').textContent = rs(paid);
  Object.assign($('sBal'), { textContent: rs(charged - paid), className: charged > paid ? 'charged' : 'paid' });   // red while something is owed
  $('stmt').open = false; $('stmt').hidden = false;
}

// the same statement as a PDF file
$('pdf').onclick = run($('pdf'), async () => {
  const url = URL.createObjectURL(await api('statement', { adm }));
  Object.assign(document.createElement('a'), { href: url, download: `Statement-${adm.replace(/[^\w-]+/g, '-')}.pdf` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}, 'Preparing PDF…');

// ---- order + (mock) gateway ----
$('pay').onclick = run($('pay'), async () => {
  if (school.checkout?.mode !== 'demo') throw new Error(school.checkout?.message || 'Online payments are currently unavailable.');
  const chosen = selected();
  for (const i of chosen) if (!$('p_' + i.id).reportValidity()) return;   // the browser points at the amount and says why
  const email = $('email').value.trim(), phone = $('phone').value.replace(/[\s-]/g, '');
  const pays = chosen.map(i => ({ id: i.id, paise: paying(i) }));
  const o = await api('orders', { adm, pays, ...(email && { email }), ...(phone && { phone }) });
  // Remember what THIS order covers: the switches, the amounts and the email box can still change while the
  // gateway is open, and the receipt must show what was actually paid.
  order = { id: o.orderId, items: chosen.map(i => ({ ...i, paying: paying(i) })), email };
  $('gwAmt').textContent = rs(o.paise); $('gw').hidden = false;
  $('gw').scrollIntoView({ behavior: 'smooth', block: 'center' });
}, 'Starting payment…');

const finish = outcome => run($(outcome === 'success' ? 'ok' : 'fail'), async () => {
  const mode = $('mode').value;
  try { var r = await api(`orders/${order.id}/pay`, { outcome, mode }); }
  finally { $('gw').hidden = true; }
  showReceipt(r, order.items, order.email, mode);
}, outcome === 'success' ? 'Confirming payment…' : 'Cancelling…');
$('ok').onclick = finish('success');
$('fail').onclick = finish('fail');

function showReceipt(r, paid, email, mode) {
  $('rSchool').textContent = school.name || ''; $('rAddr').textContent = school.address || '';
  $('rNo').textContent = r.receiptNo; $('rDate').textContent = new Date().toLocaleString('en-IN');
  $('rAdm').textContent = adm; $('rName').textContent = student.name; $('rCls').textContent = classOf(student);
  $('rRef').textContent = `${r.gatewayRef || '-'} (${mode})`;
  $('rItems').replaceChildren(...paid.map(i => {
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('td'), { textContent: i.paying < i.paise ? `${i.label} (part payment of ${rs(i.paise)} due)` : i.label }),
      Object.assign(document.createElement('td'), { textContent: rs(i.paying) }));
    return tr;
  }));
  $('rTotal').textContent = rs(r.paise);
  const balance = sum(items, i => i.paise - (paid.find(p => p.id === i.id)?.paying ?? 0));   // still owed, all dues
  Object.assign($('rBal'), { textContent: rs(balance), className: balance > 0 ? 'charged' : 'paid' });
  $('rMail').textContent = r.emailed ? `A PDF copy of this receipt has been sent to ${email}.` : ''; $('rMail').hidden = !r.emailed;
  $('dues').hidden = true; $('receipt').hidden = false;
  $('receipt').scrollIntoView({ behavior: 'smooth' });
}
$('print').onclick = () => window.print();
