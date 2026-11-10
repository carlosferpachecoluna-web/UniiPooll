import { getDemoCredentials, login, logout, register, restoreSession, setAuthNotifier } from './auth.js';
import {
  AMOUNT_STEP,
  CASH_MAX,
  CASH_MIN,
  LOAN_ERROR,
  MAX_LOAN,
  MAX_REASON_LENGTH,
  MIN_LOAN,
  SERVICE_FEE,
  calculateEstimatedReturn,
  calculateRepayment,
  cancelLoanRequest,
  financeRequest,
  getAvailableLimit,
  getDueDate,
  getFinancedLoans,
  getFundBalance,
  getMyPendingRequests,
  getPublicRequests,
  getRequest,
  getStudentScore,
  getWalletBalance,
  processMaturedLoans,
  requestLoan,
  simulateCashIn,
  simulateCashOut
} from './loans.js';
import { formatScore } from './score.js';
import { REQUEST_STATUS, stateManager } from './state.js';

const MIN_LATENCY_MS = 800;
const MAX_LATENCY_MS = 1200;
const PROCESSING_LABEL = 'Procesando...';
const TOAST_LIMIT = 3;
const TOAST_LEAVE_FALLBACK_MS = 400;
const TOAST_DEFAULT_MS = 4000;
const TOAST_VARIANTS = Object.freeze(['success', 'error', 'warning', 'info']);
const SCREENS = Object.freeze(['home', 'loan', 'fund', 'profile']);
const NEUTRAL_ACTIVITY = new Set(['request', 'cancel', 'default']);
const CAPACITY_NOTICE = 'capacity';
const SESSION_LOST_MESSAGE = 'Tu sesión ya no está activa. Inicia sesión para continuar.';
const UNEXPECTED_MESSAGE = 'No fue posible completar la operación. Inténtalo de nuevo.';
const NUMBERS_ONLY_MESSAGE = 'Escribe solo números enteros positivos, sin letras, signos, puntos ni comas.';
const HTML_SYMBOLS_MESSAGE = 'El motivo no admite etiquetas HTML ni los símbolos < y >.';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const copFormatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const money = amount => copFormatter.format(amount);
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const initials = name => String(name ?? '').trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join('') || 'U';
const firstName = name => String(name ?? '').trim().split(/\s+/)[0] || 'Estudiante';

function formatDate(value, options) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('es-CO', options).format(date);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomLatency = () => MIN_LATENCY_MS + Math.round(Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS));

const svg = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = Object.freeze({
  request: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>'),
  loan: svg('<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 17v3h14v-3"/>'),
  investment: svg('<path d="M12 3v18m5-14H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  cash_in: svg('<path d="M3 7a2 2 0 0 1 2-2h12v4"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z"/><path d="M16 14h.01"/>'),
  cash_out: svg('<path d="M7 17 17 7M9 7h8v8"/>'),
  cancel: svg('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>'),
  default: svg('<path d="M12 4 3 20h18z"/><path d="M12 10v4m0 3h.01"/>'),
  coverage: svg('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>'),
  star: '<svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>'
});

const iconFor = type => (Object.hasOwn(ICONS, type) ? ICONS[type] : ICONS.loan);

const LEDGER_LABELS = Object.freeze({
  opening_balance: 'Saldo inicial',
  simulated_cash_in: 'Recarga simulada',
  simulated_cash_out: 'Retiro simulado',
  guarantee_coverage: 'Cobertura del Fondo'
});

const LOAN_FIELD_BY_CODE = Object.freeze({
  [LOAN_ERROR.INVALID_AMOUNT]: '#loan-amount',
  [LOAN_ERROR.OVER_LIMIT]: '#loan-amount',
  [LOAN_ERROR.INVALID_TERM]: '.term-options input[name="term"]',
  [LOAN_ERROR.INVALID_REASON]: '#loan-reason'
});

const AUTH_FIELD_IDS = Object.freeze({
  login: { email: '#login-email', password: '#login-password' },
  register: { name: '#reg-name', email: '#reg-email', password: '#reg-password' }
});

const toastRegistry = new Set();
let activeConfirmation = null;
let shownUserId = null;

function removeToast(entry) {
  clearTimeout(entry.timer);
  clearTimeout(entry.leaveTimer);
  toastRegistry.delete(entry);
  entry.node.remove();
}

function dismissToast(entry) {
  if (entry.leaving) return;
  entry.leaving = true;
  clearTimeout(entry.timer);
  entry.node.classList.add('is-leaving');
  entry.node.addEventListener('animationend', event => {
    if (event.target === entry.node && event.animationName === 'toast-out') removeToast(entry);
  });
  entry.leaveTimer = setTimeout(() => removeToast(entry), TOAST_LEAVE_FALLBACK_MS);
}

function readToastDuration(node) {
  const raw = getComputedStyle(node).getPropertyValue('--toast-duration').trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return TOAST_DEFAULT_MS;
  return raw.endsWith('ms') ? value : value * 1000;
}

function startToastTimer(entry) {
  entry.startedAt = performance.now();
  entry.timer = setTimeout(() => dismissToast(entry), Math.max(entry.remaining, 0));
}

function pauseToastTimer(entry) {
  if (entry.leaving || entry.paused) return;
  entry.paused = true;
  clearTimeout(entry.timer);
  entry.remaining -= performance.now() - entry.startedAt;
}

function resumeToastTimer(entry) {
  if (entry.leaving || !entry.paused) return;
  entry.paused = false;
  startToastTimer(entry);
}

export function showToast(message, variant = 'info') {
  const region = $('#toast-region');
  const template = $('#toast-template');
  const text = String(message ?? '').trim();
  if (!region || !template || !text) return null;

  const type = TOAST_VARIANTS.includes(variant) ? variant : 'info';
  for (const existing of [...toastRegistry]) {
    if (existing.type === type && existing.text === text) removeToast(existing);
  }
  const visible = [...toastRegistry].filter(entry => !entry.leaving);
  for (const entry of visible.slice(0, Math.max(0, visible.length - (TOAST_LIMIT - 1)))) dismissToast(entry);

  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(`toast--${type}`);
  node.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');
  $('.toast-message', node).textContent = text;

  const entry = { node, type, text, timer: 0, leaveTimer: 0, startedAt: 0, remaining: TOAST_DEFAULT_MS, leaving: false, paused: false };
  $('.toast-close', node).addEventListener('click', () => dismissToast(entry));
  node.addEventListener('focusin', () => pauseToastTimer(entry));
  node.addEventListener('focusout', event => {
    if (!node.contains(event.relatedTarget)) resumeToastTimer(entry);
  });

  region.append(node);
  toastRegistry.add(entry);
  entry.remaining = readToastDuration(node);
  startToastTimer(entry);
  return node;
}

export const toast = Object.freeze({
  success: message => showToast(message, 'success'),
  error: message => showToast(message, 'error'),
  warning: message => showToast(message, 'warning'),
  info: message => showToast(message, 'info')
});

function isBusy(button) {
  return button.getAttribute('aria-busy') === 'true';
}

export async function withProcessing(button, action, label = PROCESSING_LABEL) {
  if (!button || button.disabled || isBusy(button)) return null;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try {
    await pause(randomLatency());
    return await action();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = originalLabel;
  }
}

function showError(element, message) {
  element.textContent = message;
  element.classList.remove('hidden');
}

function clearError(element) {
  element.textContent = '';
  element.classList.add('hidden');
  delete element.dataset.notice;
}

function focusField(selector) {
  const field = selector ? $(selector) : null;
  if (!field) return;
  field.setAttribute('aria-invalid', 'true');
  field.focus();
}

function removeBootScreen() {
  $('#boot-screen')?.remove();
}

function isAppVisible() {
  return !$('#app-view').classList.contains('hidden');
}

function setAuthTab(name, { focus = false } = {}) {
  $$('.auth-tabs [data-auth-tab]').forEach(button => {
    const active = button.dataset.authTab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('[data-auth-form]').forEach(form => {
    const hidden = form.dataset.authForm !== name;
    form.hidden = hidden;
    form.classList.toggle('hidden', hidden);
  });
  $$('[data-auth-form] input').forEach(input => input.removeAttribute('aria-invalid'));
  clearError($('#login-error'));
  clearError($('#register-error'));
  if (focus) $(`[data-auth-form="${name}"] input`)?.focus();
}

function renderDemoHint() {
  const credentials = getDemoCredentials();
  const available = Boolean(stateManager.getUserByEmail(credentials.email));
  $('#demo-email').textContent = credentials.email;
  $('#demo-password').textContent = credentials.password;
  $('#demo-hint').classList.toggle('hidden', !available);
}

function clearPrivateViews() {
  ['#header-name', '#welcome-name', '#home-limit', '#home-wallet', '#profile-name', '#profile-email', '#profile-wallet', '#profile-score', '#fund-balance']
    .forEach(selector => { $(selector).textContent = ''; });
  $('#header-avatar').textContent = 'U';
  $('#profile-avatar').textContent = '';
  ['#my-request-list', '#request-list', '#activity-list', '#wallet-ledger', '#loan-status-list']
    .forEach(selector => { $(selector).innerHTML = ''; });
  $('#loan-form').reset();
  $('#cash-in-form').reset();
  $('#cash-out-form').reset();
  $$('.reason-suggestions [data-reason]').forEach(chip => {
    chip.classList.remove('active');
    chip.setAttribute('aria-pressed', 'false');
  });
  $('#reason-counter').textContent = `0 / ${MAX_REASON_LENGTH}`;
  $('#reason-counter').classList.remove('is-limit');
  syncTermChips();
  clearError($('#loan-error'));
  clearError($('#dialog-error'));
}

function showAuth(tab = 'login', { focus = false } = {}) {
  const dialog = $('#confirm-dialog');
  activeConfirmation = null;
  if (dialog.open) dialog.close();
  shownUserId = null;
  clearPrivateViews();
  $('#app-view').classList.add('hidden');
  $('.bottom-nav').classList.add('hidden');
  $('#screen-login').classList.remove('hidden');
  $('#login-password').value = '';
  renderDemoHint();
  setAuthTab(tab, { focus });
  $('#app-container').scrollTop = 0;
}

function showApp() {
  const user = stateManager.getCurrentUser();
  if (!user) {
    showAuth('login');
    return;
  }
  shownUserId = user.id;
  $('#screen-login').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('.bottom-nav').classList.remove('hidden');
  navigateTo('home');
}

function forceLogin(message, { focus = false } = {}) {
  showAuth('login', { focus });
  if (message) toast.warning(message);
}

function ensureSession() {
  stateManager.refreshFromStorage();
  const user = stateManager.getCurrentUser();
  if (user) return user;
  if (isAppVisible()) forceLogin(SESSION_LOST_MESSAGE);
  return null;
}

function syncSessionView() {
  const user = stateManager.getCurrentUser();
  if (!user) {
    if (isAppVisible()) forceLogin(SESSION_LOST_MESSAGE);
    return;
  }
  if (!isAppVisible() || user.id !== shownUserId) {
    showApp();
    toast.info('Tu sesión se sincronizó con otra pestaña.');
    return;
  }
  render();
}

function enterApp(message) {
  if (!stateManager.getCurrentUser()) {
    showAuth('login');
    return;
  }
  showApp();
  toast.success(message);
  if (!stateManager.isStorageAvailable()) {
    toast.warning('El almacenamiento está bloqueado: los cambios podrían perderse al cerrar esta pestaña.');
  }
}

export function navigateTo(screenName) {
  if (!ensureSession()) return;
  const target = SCREENS.includes(screenName) ? screenName : 'home';
  $$('.screen').forEach(screen => {
    const active = screen.dataset.screen === target;
    screen.hidden = !active;
    screen.classList.toggle('hidden', !active);
    screen.classList.toggle('is-current', active);
  });
  $$('.nav-btn').forEach(button => {
    const active = button.dataset.navigate === target;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#app-container').scrollTop = 0;
  render();
}

function activityTone(item) {
  if (NEUTRAL_ACTIVITY.has(item.type) || !item.amount) return '';
  return item.amount > 0 ? ' is-credit' : ' is-debit';
}

function renderActivity(user) {
  const items = stateManager.getState().activities.filter(item => item.userId === user.id).slice(0, 6);
  $('#activity-list').innerHTML = items.length ? items.map(item => {
    const date = formatDate(item.createdAt, { day: 'numeric', month: 'short' });
    const tone = activityTone(item);
    const amount = Number(item.amount) || 0;
    const sign = tone === ' is-credit' ? '+' : '';
    const shown = tone ? amount : Math.abs(amount);
    const amountMarkup = amount === 0 ? '' : `<span class="activity-amount${tone}">${sign}${money(shown)}</span>`;
    const detail = [safe(item.detail), safe(date)].filter(Boolean).join(' · ');
    return `<article class="activity-item"><span class="activity-icon">${iconFor(item.type)}</span><div class="activity-copy"><b>${safe(item.title)}</b><span>${detail}</span></div>${amountMarkup}</article>`;
  }).join('') : '<p class="empty-state">Tus solicitudes y movimientos aparecerán aquí.</p>';
}

function ledgerLabel(entry) {
  if (entry.type === 'p2p_funding') return entry.delta < 0 ? 'Financiación enviada' : 'Financiación recibida';
  return Object.hasOwn(LEDGER_LABELS, entry.type) ? LEDGER_LABELS[entry.type] : 'Movimiento';
}

function ledgerReference(transactionId) {
  return String(transactionId ?? '').split(':').pop().slice(0, 8);
}

function renderWalletLedger(user) {
  const entries = stateManager.getLedgerForUser(user.id)
    .map((entry, index) => ({ entry, index, time: Date.parse(entry.createdAt) || 0 }))
    .sort((left, right) => (right.time - left.time) || (right.index - left.index))
    .slice(0, 12)
    .map(item => item.entry);

  $('#wallet-ledger').innerHTML = entries.length ? entries.map(entry => {
    const dateLabel = formatDate(entry.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) || 'Fecha no disponible';
    const debitClass = entry.delta < 0 ? ' class="is-debit"' : '';
    const sign = entry.delta > 0 ? '+' : '';
    const rail = entry.rail ? ` · ${safe(entry.rail)}` : '';
    const reference = ledgerReference(entry.transactionId);
    const meta = reference ? `${safe(dateLabel)} · Asiento ${safe(reference)}` : safe(dateLabel);
    return `<div class="ledger-row"><div class="ledger-copy"><b>${safe(ledgerLabel(entry))}${rail}</b><span>${meta}</span></div><div class="ledger-amount"><b${debitClass}>${sign}${money(entry.delta)}</b><small>${entry.delta < 0 ? 'Débito' : 'Crédito'}</small></div></div>`;
  }).join('') : '<p class="empty-state">Aún no hay movimientos en tu libro.</p>';
}

function renderLoanStatuses(user) {
  const loans = getFinancedLoans(user.id);
  $('#loan-status-list').innerHTML = loans.length ? loans.map(request => {
    const late = request.status === REQUEST_STATUS.LATE;
    const due = formatDate(getDueDate(request), { dateStyle: 'medium' });
    return `<div class="ledger-row"><div class="ledger-copy"><b>${safe(request.reason)}</b><span>${money(request.amount)} · Vencimiento ${safe(due || 'pendiente')}</span></div><span class="status-pill${late ? ' is-late' : ''}">${late ? 'EN MORA' : 'FINANCIADO'}</span></div>`;
  }).join('') : '<p class="empty-state">No tienes créditos financiados.</p>';
}

function requestCardMarkup(request, buttonMarkup) {
  const demoNote = request.demo ? ' · Ejemplo de demostración' : '';
  return `<article class="card request-card"><div class="request-top"><div><h3>${safe(request.name)}</h3><p class="request-reason">${safe(request.reason)}</p></div><span class="score-pill">${formatScore(request.score)} ${ICONS.star}</span></div><div class="request-bottom"><div><span class="request-amount">${money(request.amount)}</span><span class="request-meta"> · ${safe(request.termDays)} días${demoNote}</span></div>${buttonMarkup}</div></article>`;
}

function publicRequestCard(request) {
  const button = `<button class="button button-primary button-finance" type="button" data-action="finance" data-request-id="${safe(request.id)}">Financiar</button>`;
  return requestCardMarkup(request, button);
}

function ownRequestCard(request) {
  const button = `<button class="button button-secondary button-cancel-request" type="button" data-action="cancel-request" data-request-id="${safe(request.id)}">Cancelar</button>`;
  return requestCardMarkup(request, button);
}

function renderRequests(user) {
  const requests = getPublicRequests(user.id).filter(request => request.ownerId !== user.id);
  $('#request-list').innerHTML = requests.length
    ? requests.map(publicRequestCard).join('')
    : '<p class="empty-state">No hay solicitudes de otros estudiantes por ahora. Vuelve pronto.</p>';
}

function renderMyRequests(user) {
  const requests = getMyPendingRequests(user.id);
  $('#my-request-list').innerHTML = requests.length
    ? requests.map(ownRequestCard).join('')
    : '<p class="empty-state">Todavía no tienes solicitudes pendientes.</p>';
}

function syncTermChips() {
  $$('.term-options .chip-btn').forEach(chip => {
    const input = $('input[name="term"]', chip);
    chip.classList.toggle('active', Boolean(input?.checked));
  });
}

function updateReasonUi() {
  const input = $('#loan-reason');
  const counter = $('#reason-counter');
  const length = input.value.length;
  counter.textContent = `${length} / ${MAX_REASON_LENGTH}`;
  counter.classList.toggle('is-limit', length >= MAX_REASON_LENGTH);
  const current = input.value.trim();
  $$('.reason-suggestions [data-reason]').forEach(chip => {
    const active = current !== '' && chip.dataset.reason === current;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
}

function updateLoanControls() {
  const user = stateManager.getCurrentUser();
  const limit = getAvailableLimit(user);
  const slider = $('#loan-amount');
  const submit = $('#loan-submit');
  const errorElement = $('#loan-error');
  const cap = Math.floor(Math.min(MAX_LOAN, limit) / AMOUNT_STEP) * AMOUNT_STEP;
  const noCapacity = cap < MIN_LOAN;

  slider.min = String(MIN_LOAN);
  slider.step = String(AMOUNT_STEP);
  slider.max = String(Math.max(MIN_LOAN, cap));
  slider.disabled = noCapacity;
  if (!isBusy(submit)) submit.disabled = noCapacity;

  let amount = Number(slider.value);
  if (!Number.isFinite(amount) || amount < MIN_LOAN) amount = MIN_LOAN;
  if (!noCapacity && amount > cap) amount = cap;
  slider.value = String(amount);
  slider.setAttribute('aria-valuetext', money(amount));

  $('#limit-label').textContent = money(limit);
  $('#amount-output').textContent = money(amount);
  $('#repayment-principal').textContent = money(amount);
  $('#repayment-fee').textContent = money(SERVICE_FEE);
  $('#repayment-total').textContent = money(calculateRepayment(amount));

  if (noCapacity) {
    showError(errorElement, 'Tu cupo es menor al monto mínimo de $10.000 COP.');
    errorElement.dataset.notice = CAPACITY_NOTICE;
  } else if (errorElement.dataset.notice === CAPACITY_NOTICE) {
    clearError(errorElement);
  }
}

function render() {
  const user = stateManager.getCurrentUser();
  if (!user) return;
  const name = firstName(user.name);
  const score = formatScore(getStudentScore(user));
  const wallet = money(getWalletBalance(user));

  $('#header-name').textContent = name;
  $('#header-avatar').textContent = initials(user.name);
  $('#welcome-name').textContent = name;
  $('#home-limit').textContent = money(getAvailableLimit(user));
  $('#home-wallet').textContent = wallet;
  $('#home-score').textContent = score;
  $('#profile-name').textContent = user.name;
  $('#profile-email').textContent = user.email;
  $('#profile-wallet').textContent = wallet;
  $('#profile-avatar').textContent = initials(user.name);
  $('#profile-score').textContent = score;
  $('#cash-out-amount').max = String(Math.max(CASH_MIN, Math.min(CASH_MAX, getWalletBalance(user))));
  $('#fund-balance').textContent = money(getFundBalance());

  renderActivity(user);
  renderWalletLedger(user);
  renderLoanStatuses(user);
  renderRequests(user);
  renderMyRequests(user);
  updateLoanControls();
}

function showConfirmation({ eyebrow = 'CONFIRMACIÓN', title, description, details = '', confirmLabel, onConfirm }) {
  const dialog = $('#confirm-dialog');
  const confirmButton = $('#dialog-confirm');
  activeConfirmation = onConfirm;
  $('#dialog-eyebrow').textContent = eyebrow;
  $('#dialog-title').textContent = title;
  $('#dialog-description').textContent = description;
  $('#dialog-details').innerHTML = details;
  clearError($('#dialog-error'));
  confirmButton.textContent = confirmLabel;
  confirmButton.disabled = false;
  $('#dialog-cancel').disabled = false;
  if (!dialog.open) dialog.showModal();
  $('#dialog-cancel').focus();
}

function openFinanceConfirmation(requestId) {
  const user = ensureSession();
  if (!user) return;
  const request = getRequest(requestId);
  if (!request || request.status !== REQUEST_STATUS.PENDING) {
    render();
    toast.warning('Esta solicitud ya no está disponible.');
    return;
  }
  if (request.ownerId === user.id) {
    render();
    toast.error('No puedes financiar tu propia solicitud.');
    return;
  }

  const balance = getWalletBalance(user);
  if (balance < request.amount) {
    toast.error(`Saldo insuficiente: necesitas ${money(request.amount)} y tu billetera tiene ${money(balance)}. Recarga desde tu perfil.`);
    return;
  }

  const estimate = calculateEstimatedReturn(request.amount, request.termDays);
  const details = `<div class="dialog-summary"><div><span>Estudiante</span><b>${safe(request.name)}</b></div><div><span>Monto a transferir</span><b>${money(request.amount)}</b></div><div><span>Tu saldo disponible</span><b>${money(balance)}</b></div><div><span>Retorno estimado total</span><b>${money(estimate.total)}</b></div><div class="summary-total"><span>Utilidad estimada</span><b>${money(estimate.earnings)}</b></div></div><p class="dialog-note">La estimación usa 4,5 % E.A. proporcional a ${safe(request.termDays)} días. Es ilustrativa; el prototipo no procesa pagos ni liquidaciones reales.</p>`;

  showConfirmation({
    eyebrow: 'TRANSFERENCIA P2P',
    title: 'Financiar a un compañero',
    description: 'Revisa los datos. Al confirmar, se debitará tu billetera y se abonará el monto al estudiante.',
    details,
    confirmLabel: 'Financiar',
    onConfirm: () => {
      const result = financeRequest(requestId);
      if (!result.ok) return result;
      return {
        ok: true,
        message: `Compañero financiado. Transferiste ${money(result.request.amount)} a ${result.request.name} y se sumaron ${money(result.feeContributed)} al Fondo de Cobertura.`
      };
    }
  });
}

function openCancelConfirmation(requestId) {
  const user = ensureSession();
  if (!user) return;
  const request = getRequest(requestId);
  if (!request || request.status !== REQUEST_STATUS.PENDING || request.ownerId !== user.id) {
    render();
    toast.warning('Solo puedes cancelar tus solicitudes que aún están pendientes.');
    return;
  }

  showConfirmation({
    eyebrow: 'CANCELAR SOLICITUD',
    title: '¿Deseas cancelar esta solicitud?',
    description: 'La solicitud se retirará del Fondo y se restaurará tu cupo. La tarifa se suma al Fondo de Cobertura únicamente cuando la solicitud se financia.',
    details: `<div class="dialog-summary"><div><span>Motivo</span><b>${safe(request.reason)}</b></div><div><span>Monto solicitado</span><b>${money(request.amount)}</b></div></div>`,
    confirmLabel: 'Sí, cancelar solicitud',
    onConfirm: () => {
      const result = cancelLoanRequest(requestId);
      return result.ok ? { ok: true, message: 'Solicitud cancelada. Tu cupo fue restaurado.' } : result;
    }
  });
}

function openResetConfirmation() {
  if (!ensureSession()) return;
  showConfirmation({
    eyebrow: 'RESTABLECER DEMO',
    title: 'Restablecer datos de demostración',
    description: 'Se borrarán las cuentas, solicitudes y movimientos guardados en este navegador y volverán los datos iniciales de la demostración. Esta acción no se puede deshacer.',
    confirmLabel: 'Restablecer',
    onConfirm: () => {
      stateManager.reset();
      return {
        ok: true,
        message: 'Datos de demostración restablecidos. Entraste con la cuenta de demostración.',
        afterClose: () => {
          showApp();
        }
      };
    }
  });
}

function closeConfirmation() {
  const dialog = $('#confirm-dialog');
  activeConfirmation = null;
  if (dialog.open) dialog.close();
}

async function handleDialogConfirm() {
  const confirmButton = $('#dialog-confirm');
  const cancelButton = $('#dialog-cancel');
  const action = activeConfirmation;
  if (!action || confirmButton.disabled || isBusy(confirmButton)) return;
  if (!ensureSession()) return;

  cancelButton.disabled = true;
  let result = null;
  try {
    result = await withProcessing(confirmButton, async () => action());
  } catch (error) {
    console.error('UniPool: error al confirmar la operación.', error);
    result = { ok: false, code: LOAN_ERROR.UNEXPECTED, error: UNEXPECTED_MESSAGE };
  } finally {
    cancelButton.disabled = false;
  }
  if (!result) return;

  closeConfirmation();
  if (result.ok) {
    if (result.afterClose) result.afterClose();
    else render();
    toast.success(result.message);
    return;
  }

  if (result.code === LOAN_ERROR.NO_SESSION) {
    forceLogin(result.error);
    return;
  }
  render();
  toast.error(result.error);
}

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function readNumberInput(input) {
  return input.validity.badInput ? 'NaN' : input.value;
}

function guardNumberInput(input) {
  input.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    if (!/\d/.test(event.key)) {
      event.preventDefault();
      toast.warning(NUMBERS_ONLY_MESSAGE);
    }
  });
  input.addEventListener('paste', event => {
    const text = (event.clipboardData?.getData('text') ?? '').trim();
    if (!/^\d+$/.test(text)) {
      event.preventDefault();
      toast.warning(NUMBERS_ONLY_MESSAGE);
    }
  });
}

function reportAuthFailure(result, formName) {
  const selector = AUTH_FIELD_IDS[formName]?.[result.field];
  focusField(selector);
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = readForm(form);
  $$('input', form).forEach(input => input.removeAttribute('aria-invalid'));
  try {
    const result = await withProcessing($('[type="submit"]', form), () => login({ email: values.email, password: values.password }));
    if (!result) return;
    if (!result.ok) {
      reportAuthFailure(result, 'login');
      return;
    }
    form.reset();
    enterApp(`Bienvenido, ${firstName(result.user.name)}.`);
  } catch (error) {
    console.error('UniPool: error al iniciar sesión.', error);
    toast.error('No fue posible iniciar sesión. Inténtalo de nuevo.');
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = readForm(form);
  $$('input', form).forEach(input => input.removeAttribute('aria-invalid'));
  try {
    const result = await withProcessing($('[type="submit"]', form), () => register({ name: values.name, email: values.email, password: values.password }));
    if (!result) return;
    if (!result.ok) {
      reportAuthFailure(result, 'register');
      return;
    }
    form.reset();
    enterApp(`Cuenta creada. ¡Bienvenido, ${firstName(result.user.name)}!`);
  } catch (error) {
    console.error('UniPool: error al crear la cuenta.', error);
    toast.error('Ocurrió un error al crear la cuenta. Inténtalo de nuevo.');
  }
}

function handleOperationFailure(result, fieldSelector) {
  if (result.code === LOAN_ERROR.NO_SESSION) {
    forceLogin(result.error);
    return;
  }
  toast.error(result.error);
  focusField(fieldSelector);
}

async function handleLoanSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#loan-submit');
  if (button.disabled || !ensureSession()) return;
  clearError($('#loan-error'));
  $$('#loan-form [aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
  const payload = {
    amount: $('#loan-amount').value,
    termDays: readForm(form).term,
    reason: $('#loan-reason').value
  };
  try {
    const result = await withProcessing(button, () => requestLoan(payload));
    if (!result) return;
    if (!result.ok) {
      handleOperationFailure(result, LOAN_FIELD_BY_CODE[result.code]);
      return;
    }
    form.reset();
    syncTermChips();
    updateReasonUi();
    navigateTo('home');
    toast.success(`Crédito solicitado por ${money(result.request.amount)}. Un compañero podrá financiarlo; la tarifa de ${money(SERVICE_FEE)} se suma al Fondo cuando eso ocurra.`);
  } catch (error) {
    console.error('UniPool: error al registrar la solicitud.', error);
    toast.error('No fue posible registrar la solicitud. Inténtalo de nuevo.');
  } finally {
    updateLoanControls();
  }
}

function bindCashForm({ formSelector, run, successMessage }) {
  const form = $(formSelector);
  const amountInput = $('input[name="amount"]', form);
  guardNumberInput(amountInput);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ensureSession()) return;
    amountInput.removeAttribute('aria-invalid');
    const values = { amount: readNumberInput(amountInput), rail: form.elements.rail?.value };
    try {
      const result = await withProcessing($('[type="submit"]', form), () => run(values));
      if (!result) return;
      if (!result.ok) {
        handleOperationFailure(result, `#${amountInput.id}`);
        return;
      }
      render();
      toast.success(successMessage(result));
    } catch (error) {
      console.error('UniPool: error en el movimiento de billetera.', error);
      toast.error('No fue posible registrar el movimiento. Inténtalo de nuevo.');
    }
  });
}

async function handleLogout(button) {
  const result = await withProcessing(button, async () => logout());
  if (!result) return;
  showAuth('login', { focus: true });
  toast.info('Sesión cerrada. ¡Hasta pronto!');
}

function handleAction(action, target) {
  switch (action) {
    case 'logout':
      handleLogout(target);
      break;
    case 'fill-demo': {
      const credentials = getDemoCredentials();
      $('#login-email').value = credentials.email;
      $('#login-password').value = credentials.password;
      $$('#form-login input').forEach(input => input.removeAttribute('aria-invalid'));
      $('#login-password').focus();
      break;
    }
    case 'finance':
      openFinanceConfirmation(target.dataset.requestId);
      break;
    case 'cancel-request':
      openCancelConfirmation(target.dataset.requestId);
      break;
    case 'reset-demo':
      openResetConfirmation();
      break;
    default:
      break;
  }
}

function reportMaturities(result) {
  if (!result?.processed) return '';
  return `${result.processed} crédito(s) pasaron a mora. Cobertura simulada aplicada: ${money(result.covered)}.`;
}

function reportUnexpectedError(error) {
  console.error('UniPool: error no controlado.', error);
  toast.error('Ocurrió un error inesperado. Si persiste, recarga la página.');
}

export class UIController {
  constructor() {
    this.bindEvents();
    this.start();
  }

  navigateTo(screenName) {
    navigateTo(screenName);
  }

  render() {
    render();
  }

  bindEvents() {
    setAuthNotifier((message, variant) => showToast(message, variant));

    $$('.auth-tabs [data-auth-tab]').forEach(button => {
      button.addEventListener('click', () => setAuthTab(button.dataset.authTab, { focus: true }));
    });

    $('#form-login').addEventListener('submit', handleLogin);
    $('#form-register').addEventListener('submit', handleRegister);
    $('#loan-form').addEventListener('submit', handleLoanSubmit);

    bindCashForm({
      formSelector: '#cash-in-form',
      run: values => simulateCashIn({ amount: values.amount, rail: values.rail }),
      successMessage: result => `Recarga simulada de ${money(result.amount)} registrada en el libro de movimientos.`
    });
    bindCashForm({
      formSelector: '#cash-out-form',
      run: values => simulateCashOut({ amount: values.amount }),
      successMessage: result => `Retiro simulado de ${money(result.amount)} registrado en el libro de movimientos.`
    });

    $('#loan-amount').addEventListener('input', () => {
      const errorElement = $('#loan-error');
      if (errorElement.dataset.notice !== CAPACITY_NOTICE) clearError(errorElement);
      updateLoanControls();
    });
    $$('.term-options input[name="term"]').forEach(input => input.addEventListener('change', syncTermChips));

    const reasonInput = $('#loan-reason');
    reasonInput.addEventListener('input', () => {
      reasonInput.removeAttribute('aria-invalid');
      if (/[<>]/.test(reasonInput.value)) {
        reasonInput.value = reasonInput.value.replace(/[<>]/g, '');
        toast.warning(HTML_SYMBOLS_MESSAGE);
      }
      updateReasonUi();
    });
    $$('.reason-suggestions [data-reason]').forEach(chip => {
      chip.addEventListener('click', () => {
        reasonInput.value = chip.dataset.reason.slice(0, MAX_REASON_LENGTH);
        reasonInput.removeAttribute('aria-invalid');
        updateReasonUi();
      });
    });
    updateReasonUi();

    document.addEventListener('input', event => {
      if (event.target instanceof HTMLElement) event.target.removeAttribute('aria-invalid');
    });

    document.addEventListener('click', event => {
      const tab = event.target.closest('[data-navigate]');
      if (tab) {
        navigateTo(tab.dataset.navigate);
        return;
      }
      const trigger = event.target.closest('[data-action]');
      if (trigger) handleAction(trigger.dataset.action, trigger);
    });

    $('#dialog-cancel').addEventListener('click', () => {
      if (!isBusy($('#dialog-confirm'))) closeConfirmation();
    });
    $('#dialog-confirm').addEventListener('click', handleDialogConfirm);
    $('#confirm-dialog').addEventListener('cancel', event => {
      if (isBusy($('#dialog-confirm'))) event.preventDefault();
    });
    $('#confirm-dialog').addEventListener('close', () => {
      if (!isBusy($('#dialog-confirm'))) activeConfirmation = null;
    });

    stateManager.subscribe(event => {
      if (event.type === 'external') syncSessionView();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      stateManager.refreshFromStorage();
      syncSessionView();
      const message = reportMaturities(processMaturedLoans());
      if (message && isAppVisible()) {
        render();
        toast.warning(message);
      }
    });

    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      stateManager.refreshFromStorage();
      syncSessionView();
    });

    window.addEventListener('error', event => {
      if (/ResizeObserver/.test(String(event.message))) return;
      reportUnexpectedError(event.error ?? event.message);
    });
    window.addEventListener('unhandledrejection', event => reportUnexpectedError(event.reason));
  }

  start() {
    const maturity = reportMaturities(processMaturedLoans());
    const session = restoreSession();
    if (session.ok) showApp();
    else showAuth('login');
    removeBootScreen();
    if (!session.ok) return;

    if (stateManager.consumeFirstRun()) {
      toast.info('Bienvenido a UniPool. Cargamos datos de demostración: explora el Fondo y financia a un compañero.');
    }
    if (maturity) toast.warning(maturity);
    if (!stateManager.isStorageAvailable()) {
      toast.warning('El almacenamiento está bloqueado: los cambios podrían perderse al cerrar esta pestaña.');
    }
  }
}

export const ui = new UIController();
