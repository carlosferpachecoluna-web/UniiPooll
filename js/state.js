import { calculateStudentScore } from './score.js';

export const STORAGE_KEY = 'unipool.mvp.state.v2';
export const STATE_VERSION = 2;

export const REQUEST_STATUS = Object.freeze({
  PENDING: 'PENDIENTE',
  FUNDED: 'FINANCIADO',
  CANCELLED: 'CANCELADA',
  LATE: 'MORA'
});

export const DEFAULT_CREDIT_LIMIT = 35000;
export const DEFAULT_WALLET_BALANCE = 100000;
export const DEFAULT_SERVICE_FEE = 1000;
export const DEFAULT_PASSWORD_ITERATIONS = 150000;
export const SEED_FUND_BALANCE = 5000;
const MAX_ACTIVITIES = 300;
const MAX_TEXT_LENGTH = 60;
const MINUTE_MS = 60 * 1000;

export const FUND_ACCOUNT = 'system:guarantee-fund';
export const OPENING_EQUITY_ACCOUNT = 'system:opening-equity';
export const walletAccount = userId => `wallet:${userId}`;

export const DEMO_ACCOUNT = Object.freeze({
  id: 'demo-base',
  name: 'Estudiante Demo',
  email: 'demo@udes.edu.co',
  password: 'UniPool2026'
});
const DEMO_PASSWORD_SALT = 'c2de444d7c625dc472e15f6c7806cb99';
const DEMO_PASSWORD_HASH = '60ac4e0f5559b8d597320315fa2f5f925d84188a301abe6239ad83b6bb52ba76';

const SEED_BORROWERS = Object.freeze([
  { id: 'seed-maria', name: 'María G.', email: 'maria.g@demo.invalid', availableLimit: 25000, history: ['on_time', 'on_time'] },
  { id: 'seed-carlos', name: 'Carlos R.', email: 'carlos.r@demo.invalid', availableLimit: 50000, history: ['on_time'] },
  { id: 'seed-laura', name: 'Laura S.', email: 'laura.s@demo.invalid', availableLimit: 20000, history: [] },
  { id: 'seed-andres', name: 'Andrés M.', email: 'andres.m@demo.invalid', availableLimit: 10000, history: ['on_time', 'on_time', 'on_time'] }
]);

const SEED_REQUESTS = Object.freeze([
  { id: 'seed-request-maria', ownerId: 'seed-maria', reason: 'Transporte', amount: 25000, termDays: 7, ageMinutes: 35 },
  { id: 'seed-request-carlos', ownerId: 'seed-carlos', reason: 'Libros', amount: 50000, termDays: 15, ageMinutes: 140 },
  { id: 'seed-request-laura', ownerId: 'seed-laura', reason: 'Fotocopias e impresiones', amount: 15000, termDays: 7, ageMinutes: 420 },
  { id: 'seed-request-andres', ownerId: 'seed-andres', reason: 'Materiales de laboratorio', amount: 30000, termDays: 10, ageMinutes: 1560 }
]);

const clone = value => JSON.parse(JSON.stringify(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = value => (Array.isArray(value) ? value : []);
const isMoney = value => Number.isSafeInteger(value) && value >= 0;

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function generateId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createLedgerPosting(transactionId, type, amount, debitAccount, creditAccount, metadata = {}) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('LEDGER_INVALID_AMOUNT');
  const createdAt = new Date().toISOString();
  return [
    { ...metadata, id: `${transactionId}:debit`, transactionId, type, accountId: debitAccount, delta: -amount, createdAt },
    { ...metadata, id: `${transactionId}:credit`, transactionId, type, accountId: creditAccount, delta: amount, createdAt }
  ];
}

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function buildUser(fields) {
  return {
    id: '',
    name: '',
    email: '',
    availableLimit: DEFAULT_CREDIT_LIMIT,
    walletBalance: 0,
    paymentHistory: [],
    loans: [],
    investments: [],
    transactionHistory: [],
    ...fields
  };
}

function buildSeedState(now = new Date()) {
  const createdAt = now.toISOString();
  const minutesAgo = minutes => new Date(now.getTime() - minutes * MINUTE_MS).toISOString();

  const demoUser = buildUser({
    id: DEMO_ACCOUNT.id,
    name: DEMO_ACCOUNT.name,
    email: DEMO_ACCOUNT.email,
    passwordSalt: DEMO_PASSWORD_SALT,
    passwordHash: DEMO_PASSWORD_HASH,
    passwordIterations: DEFAULT_PASSWORD_ITERATIONS,
    availableLimit: DEFAULT_CREDIT_LIMIT,
    seed: true,
    createdAt
  });

  const borrowers = SEED_BORROWERS.map(borrower => buildUser({
    id: borrower.id,
    name: borrower.name,
    email: borrower.email,
    availableLimit: borrower.availableLimit,
    paymentHistory: borrower.history.map((status, index) => ({ loanId: `seed-history:${borrower.id}:${index}`, status, createdAt })),
    loans: SEED_REQUESTS.filter(request => request.ownerId === borrower.id).map(request => request.id),
    demo: true,
    createdAt
  }));

  const requests = SEED_REQUESTS.map(request => {
    const owner = borrowers.find(borrower => borrower.id === request.ownerId);
    return {
      id: request.id,
      ownerId: owner.id,
      name: owner.name,
      reason: request.reason,
      amount: request.amount,
      termDays: request.termDays,
      score: calculateStudentScore(owner.paymentHistory),
      fee: DEFAULT_SERVICE_FEE,
      totalToRepay: request.amount + DEFAULT_SERVICE_FEE,
      feeCredited: false,
      status: REQUEST_STATUS.PENDING,
      demo: true,
      createdAt: minutesAgo(request.ageMinutes)
    };
  });

  const state = {
    version: STATE_VERSION,
    users: [demoUser, ...borrowers],
    currentUserId: demoUser.id,
    requests,
    activities: [{
      id: 'seed-welcome',
      userId: demoUser.id,
      type: 'cash_in',
      title: 'Saldo inicial de demostración',
      detail: 'Billetera simulada',
      amount: DEFAULT_WALLET_BALANCE,
      createdAt
    }],
    poolBalance: SEED_FUND_BALANCE,
    ledger: [
      ...createLedgerPosting(`opening:${demoUser.id}`, 'opening_balance', DEFAULT_WALLET_BALANCE, OPENING_EQUITY_ACCOUNT, walletAccount(demoUser.id), { userId: demoUser.id }),
      ...createLedgerPosting('opening:guarantee-fund', 'opening_reserve', SEED_FUND_BALANCE, OPENING_EQUITY_ACCOUNT, FUND_ACCOUNT)
    ]
  };

  syncBalances(state);
  return state;
}

function syncBalances(state) {
  const totals = new Map();
  for (const entry of state.ledger) {
    totals.set(entry.accountId, (totals.get(entry.accountId) ?? 0) + entry.delta);
  }
  for (const user of state.users) user.walletBalance = totals.get(walletAccount(user.id)) ?? 0;
  state.poolBalance = totals.get(FUND_ACCOUNT) ?? 0;
}

function trimActivities(state) {
  if (state.activities.length > MAX_ACTIVITIES) state.activities.length = MAX_ACTIVITIES;
}

function normalizeStatus(status) {
  const value = String(status ?? '').trim().toUpperCase();
  return Object.values(REQUEST_STATUS).includes(value) ? value : null;
}

function normalizeUser(raw) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.email !== 'string') return null;
  return {
    ...raw,
    name: cleanText(raw.name) || 'Estudiante',
    email: raw.email.trim().toLowerCase(),
    availableLimit: isMoney(raw.availableLimit) ? raw.availableLimit : DEFAULT_CREDIT_LIMIT,
    walletBalance: 0,
    paymentHistory: asArray(raw.paymentHistory),
    loans: asArray(raw.loans),
    investments: asArray(raw.investments),
    transactionHistory: asArray(raw.transactionHistory)
  };
}

function normalizeRequest(raw) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.ownerId !== 'string') return null;
  const status = normalizeStatus(raw.status);
  if (!status || !Number.isSafeInteger(raw.amount) || raw.amount <= 0) return null;
  return {
    ...raw,
    status,
    name: cleanText(raw.name) || 'Estudiante',
    reason: cleanText(raw.reason),
    fee: isMoney(raw.fee) ? raw.fee : DEFAULT_SERVICE_FEE,
    feeCredited: typeof raw.feeCredited === 'boolean' ? raw.feeCredited : status !== REQUEST_STATUS.PENDING
  };
}

function normalizeLedger(rawLedger) {
  const seen = new Set();
  const ledger = [];
  for (const entry of asArray(rawLedger)) {
    const valid = isRecord(entry)
      && typeof entry.id === 'string'
      && typeof entry.accountId === 'string'
      && typeof entry.transactionId === 'string'
      && Number.isSafeInteger(entry.delta);
    if (!valid || seen.has(entry.id)) continue;
    seen.add(entry.id);
    ledger.push(entry);
  }
  return ledger;
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter(item => {
    if (!item || seen.has(item[key])) return false;
    seen.add(item[key]);
    return true;
  });
}

function findLoginUser(state, userId) {
  if (typeof userId !== 'string') return null;
  return state.users.find(user => user.id === userId && !user.demo) ?? null;
}

function normalizeState(raw) {
  const users = uniqueBy(asArray(raw.users).map(normalizeUser), 'id');
  const userIds = new Set(users.map(user => user.id));
  const requests = uniqueBy(asArray(raw.requests).map(normalizeRequest), 'id').filter(request => userIds.has(request.ownerId));

  const state = {
    version: STATE_VERSION,
    users,
    currentUserId: typeof raw.currentUserId === 'string' ? raw.currentUserId : null,
    requests,
    activities: asArray(raw.activities).filter(isRecord),
    poolBalance: 0,
    ledger: normalizeLedger(raw.ledger)
  };

  syncBalances(state);
  trimActivities(state);
  if (!findLoginUser(state, state.currentUserId)) state.currentUserId = null;
  return state;
}

function parseState(text) {
  try {
    const parsed = JSON.parse(text);
    const valid = isRecord(parsed) && parsed.version === STATE_VERSION && Array.isArray(parsed.users) && Array.isArray(parsed.requests);
    return valid ? parsed : null;
  } catch {
    return null;
  }
}

export class StateManager {
  constructor(storageKey = STORAGE_KEY) {
    this.storageKey = storageKey;
    this.storage = null;
    this.storageAvailable = true;
    this.lastSerialized = null;
    this.firstRun = false;
    this.listeners = new Set();
    this.state = buildSeedState();
    this.load();
    this.listenForExternalChanges();
  }

  load() {
    this.storage = getStorage();
    if (!this.storage) {
      this.storageAvailable = false;
      this.firstRun = true;
      return;
    }

    let saved = null;
    try {
      saved = this.storage.getItem(this.storageKey);
    } catch {
      this.storageAvailable = false;
      this.firstRun = true;
      return;
    }

    if (saved === null) {
      this.firstRun = true;
      this.persist();
      return;
    }

    const parsed = parseState(saved);
    if (!parsed) {
      this.backupUnreadableData(saved);
      this.state = buildSeedState();
      this.firstRun = true;
      this.persist();
      return;
    }

    this.lastSerialized = saved;
    this.state = normalizeState(parsed);
    this.persist();
  }

  persist() {
    try {
      if (!this.storage) this.storage = getStorage();
      if (!this.storage) throw new Error('STORAGE_UNAVAILABLE');
      const text = JSON.stringify(this.state);
      this.storage.setItem(this.storageKey, text);
      this.lastSerialized = text;
      this.storageAvailable = true;
    } catch {
      this.storageAvailable = false;
    }
    return this.storageAvailable;
  }

  backupUnreadableData(text) {
    try {
      this.storage.setItem(`${this.storageKey}.backup`, text);
      return true;
    } catch {
      return false;
    }
  }

  refreshFromStorage() {
    if (!this.storage) return false;
    let saved;
    try {
      saved = this.storage.getItem(this.storageKey);
    } catch {
      return false;
    }
    if (saved === null || saved === this.lastSerialized) return false;
    const parsed = parseState(saved);
    if (!parsed) return false;

    this.state = normalizeState(parsed);
    this.lastSerialized = saved;
    return true;
  }

  listenForExternalChanges() {
    if (typeof globalThis.addEventListener !== 'function') return;
    globalThis.addEventListener('storage', event => {
      if (!this.storage || event.storageArea !== this.storage || event.key !== this.storageKey) return;
      if (this.refreshFromStorage()) this.notify({ type: 'external' });
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error en un oyente de StateManager:', error);
      }
    }
  }

  consumeFirstRun() {
    const wasFirstRun = this.firstRun;
    this.firstRun = false;
    return wasFirstRun;
  }

  getState() { return this.state; }

  getCurrentUser() { return findLoginUser(this.state, this.state.currentUserId); }

  getUserById(userId) { return this.state.users.find(user => user.id === userId) ?? null; }

  getUserByEmail(email) {
    const clean = String(email ?? '').toLowerCase().trim();
    return this.state.users.find(user => !user.demo && user.email === clean) ?? null;
  }

  getLedgerForUser(userId) {
    const account = walletAccount(userId);
    return this.state.ledger.filter(entry => entry.accountId === account);
  }

  getWalletBalance(userId) { return this.getUserById(userId)?.walletBalance ?? 0; }

  getFundBalance() { return this.state.poolBalance; }

  isStorageAvailable() { return this.storageAvailable; }

  auditLedger() {
    const byTransaction = new Map();
    let total = 0;
    for (const entry of this.state.ledger) {
      byTransaction.set(entry.transactionId, (byTransaction.get(entry.transactionId) ?? 0) + entry.delta);
      total += entry.delta;
    }
    const unbalanced = [...byTransaction].filter(([, sum]) => sum !== 0).map(([transactionId, sum]) => ({ transactionId, sum }));
    return { balanced: total === 0 && unbalanced.length === 0, total, unbalanced, entries: this.state.ledger.length };
  }

  transact(mutator) {
    this.refreshFromStorage();
    const draft = clone(this.state);
    const result = mutator(draft);
    if (result && typeof result.then === 'function') throw new TypeError('TRANSACT_MUTATOR_MUST_BE_SYNC');
    if (isRecord(result) && result.ok === false) return result;

    syncBalances(draft);
    trimActivities(draft);
    this.state = draft;
    this.persist();
    return result;
  }

  saveUser(user) {
    if (!isRecord(user) || typeof user.id !== 'string' || !user.id || typeof user.email !== 'string') {
      throw new TypeError('INVALID_USER');
    }
    const email = user.email.trim().toLowerCase();
    const openingBalance = Number.isSafeInteger(user.walletBalance) ? Math.max(0, user.walletBalance) : 0;
    this.transact(data => {
      if (data.users.some(existing => existing.email === email || existing.id === user.id)) throw new Error('DUPLICATE_USER');
      data.users.push(normalizeUser({ ...clone(user), email }));
      if (openingBalance > 0) {
        data.ledger.push(...createLedgerPosting(`opening:${user.id}`, 'opening_balance', openingBalance, OPENING_EQUITY_ACCOUNT, walletAccount(user.id), { userId: user.id }));
      }
    });
    return this.getUserById(user.id);
  }

  setCurrentUser(userId) {
    this.refreshFromStorage();
    if (!findLoginUser(this.state, userId)) return false;
    this.state.currentUserId = userId;
    this.persist();
    return true;
  }

  clearCurrentUser() {
    this.refreshFromStorage();
    this.state.currentUserId = null;
    this.persist();
  }

  reset() {
    this.state = buildSeedState();
    this.firstRun = false;
    this.persist();
    this.notify({ type: 'reset' });
    return this.state;
  }
}

export const stateManager = new StateManager();
