import {
  DEFAULT_SERVICE_FEE,
  FUND_ACCOUNT,
  REQUEST_STATUS,
  createLedgerPosting,
  generateId,
  stateManager,
  walletAccount
} from './state.js';
import { calculateStudentScore } from './score.js';

export const SERVICE_FEE = DEFAULT_SERVICE_FEE;
export const MIN_LOAN = 10000;
export const MAX_LOAN = 100000;
export const AMOUNT_STEP = 1000;
export const TERM_OPTIONS = Object.freeze([7, 10, 15]);
export const CASH_MIN = 10000;
export const CASH_MAX = 1000000;
export const PAYMENT_RAILS = Object.freeze(['PSE', 'Nequi']);
export const DEMO_ANNUAL_RETURN_RATE = 0.045;
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 60;

export const LOAN_ERROR = Object.freeze({
  NO_SESSION: 'NO_SESSION',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  OVER_LIMIT: 'OVER_LIMIT',
  INVALID_TERM: 'INVALID_TERM',
  INVALID_REASON: 'INVALID_REASON',
  INVALID_RAIL: 'INVALID_RAIL',
  NOT_FOUND: 'NOT_FOUND',
  NOT_OWNER: 'NOT_OWNER',
  OWN_REQUEST: 'OWN_REQUEST',
  NOT_PENDING: 'NOT_PENDING',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_WALLET: 'INVALID_WALLET',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  FUND_LIMIT: 'FUND_LIMIT',
  UNEXPECTED: 'UNEXPECTED'
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AMOUNT_DIGITS = 15;
const SERVICE_FEE_ACCRUAL_ACCOUNT = 'system:service-fee-accrual';
const UNEXPECTED_MESSAGE = 'No fue posible completar la operación. Inténtalo de nuevo.';
const REASON_ALLOWED = /^[\p{L}\p{M}\p{N} .,;:()¿?¡!\-–_/#%&+$'"°ºª]+$/u;

const copFormatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const formatCop = amount => copFormatter.format(amount);

class LoanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LoanError';
    this.code = code;
  }
}

const failure = (code, error) => ({ ok: false, code, error });

function execute(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LoanError) return failure(error.code, error.message);
    console.error('UniPool: error inesperado en una operación financiera.', error);
    return failure(LOAN_ERROR.UNEXPECTED, UNEXPECTED_MESSAGE);
  }
}

function requireSessionUser(message) {
  stateManager.refreshFromStorage();
  const user = stateManager.getCurrentUser();
  if (!user) throw new LoanError(LOAN_ERROR.NO_SESSION, message);
  return user;
}

function amountMessages(subject) {
  return {
    EMPTY: `Escribe el ${subject}.`,
    NOT_NUMERIC: `El ${subject} solo puede contener números. No se admiten letras ni símbolos.`,
    NEGATIVE: `El ${subject} no puede ser negativo.`,
    ZERO: `El ${subject} debe ser mayor que cero.`,
    DECIMAL: `Escribe el ${subject} sin puntos, comas ni decimales (por ejemplo, 10000).`,
    TOO_LARGE: `El ${subject} es demasiado grande.`
  };
}

function parseAmount(value, subject) {
  const messages = amountMessages(subject);
  const invalid = code => ({ amount: null, error: messages[code] });

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid('NOT_NUMERIC');
    if (value < 0) return invalid('NEGATIVE');
    if (value === 0) return invalid('ZERO');
    if (!Number.isInteger(value)) return invalid('DECIMAL');
    if (!Number.isSafeInteger(value)) return invalid('TOO_LARGE');
    return { amount: value, error: null };
  }

  if (value === undefined || value === null) return invalid('EMPTY');
  if (typeof value !== 'string') return invalid('NOT_NUMERIC');

  const text = value.trim();
  if (!text) return invalid('EMPTY');
  if (!/^[+-]?\d+(?:[.,]\d+)*$/.test(text)) return invalid('NOT_NUMERIC');
  if (text.startsWith('-')) return invalid('NEGATIVE');
  if (text.startsWith('+')) return invalid('NOT_NUMERIC');
  if (/[.,]/.test(text)) return invalid('DECIMAL');

  const digits = text.replace(/^0+(?=\d)/, '');
  if (digits.length > MAX_AMOUNT_DIGITS) return invalid('TOO_LARGE');
  const amount = Number(digits);
  if (amount === 0) return invalid('ZERO');
  return { amount, error: null };
}

function parseTerm(value) {
  const term = typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : value;
  return TERM_OPTIONS.includes(term) ? term : null;
}

function ledgerBalance(data, accountId) {
  let total = 0;
  for (const entry of data.ledger) {
    if (entry.accountId === accountId) total += entry.delta;
  }
  if (!Number.isSafeInteger(total)) throw new LoanError(LOAN_ERROR.INVALID_WALLET, 'No fue posible verificar el saldo de la billetera.');
  return total;
}

function validateLoanAmount(value) {
  const parsed = parseAmount(value, 'monto');
  if (parsed.error) throw new LoanError(LOAN_ERROR.INVALID_AMOUNT, parsed.error);
  const amount = parsed.amount;
  if (amount < MIN_LOAN || amount > MAX_LOAN) throw new LoanError(LOAN_ERROR.INVALID_AMOUNT, 'El monto debe estar entre $10.000 y $100.000 COP.');
  if (amount % AMOUNT_STEP !== 0) throw new LoanError(LOAN_ERROR.INVALID_AMOUNT, 'El monto debe ser múltiplo de $1.000 COP.');
  return amount;
}

function validateCashAmount(value, subject) {
  const parsed = parseAmount(value, subject);
  if (parsed.error) throw new LoanError(LOAN_ERROR.INVALID_AMOUNT, parsed.error);
  const amount = parsed.amount;
  if (amount < CASH_MIN || amount > CASH_MAX || amount % AMOUNT_STEP !== 0) {
    throw new LoanError(LOAN_ERROR.INVALID_AMOUNT, `El ${subject} debe estar entre $10.000 y $1.000.000 COP, en múltiplos de $1.000.`);
  }
  return amount;
}

export function sanitizeReason(value) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new LoanError(LOAN_ERROR.INVALID_REASON, 'El motivo debe ser texto.');
  }
  const reason = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!reason) throw new LoanError(LOAN_ERROR.INVALID_REASON, 'Escribe o selecciona el motivo del préstamo.');
  if (/[<>]/.test(reason)) {
    throw new LoanError(LOAN_ERROR.INVALID_REASON, 'El motivo no puede contener etiquetas HTML ni los símbolos < y >.');
  }
  if (reason.length < MIN_REASON_LENGTH) {
    throw new LoanError(LOAN_ERROR.INVALID_REASON, `El motivo debe tener al menos ${MIN_REASON_LENGTH} caracteres.`);
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new LoanError(LOAN_ERROR.INVALID_REASON, `El motivo no puede superar ${MAX_REASON_LENGTH} caracteres.`);
  }
  if (!REASON_ALLOWED.test(reason) || !/[\p{L}\p{N}]/u.test(reason)) {
    throw new LoanError(LOAN_ERROR.INVALID_REASON, 'El motivo solo admite letras, números y signos de puntuación básicos.');
  }
  return reason;
}

function isFinancingTerms(request) {
  return Number.isSafeInteger(request.amount)
    && request.amount >= MIN_LOAN
    && request.amount <= MAX_LOAN
    && TERM_OPTIONS.includes(Number(request.termDays));
}

function readDueTime(request) {
  const explicit = Date.parse(request.dueAt);
  if (Number.isFinite(explicit)) return explicit;
  const financedAt = Date.parse(request.financedAt);
  const term = Number(request.termDays);
  if (!Number.isFinite(financedAt) || !Number.isFinite(term)) return Number.NaN;
  return financedAt + term * DAY_MS;
}

function copyRequest(request) {
  return { ...request };
}

export function getAvailableLimit(user = stateManager.getCurrentUser()) {
  return user?.availableLimit ?? 0;
}

export function getWalletBalance(user = stateManager.getCurrentUser()) {
  return user?.walletBalance ?? 0;
}

export function calculateRepayment(amount) {
  return amount + SERVICE_FEE;
}

export function calculateEstimatedReturn(amount, termDays) {
  const earnings = Math.round(amount * DEMO_ANNUAL_RETURN_RATE * termDays / 365);
  return { earnings, total: amount + earnings };
}

export function getStudentScore(user = stateManager.getCurrentUser()) {
  return calculateStudentScore(user?.paymentHistory ?? []);
}

export function getFundBalance() {
  return stateManager.getState().poolBalance;
}

export function getRequest(requestId) {
  return stateManager.getState().requests.find(request => request.id === requestId) ?? null;
}

export function getOpenRequests() {
  return stateManager.getState().requests
    .filter(request => request.status === REQUEST_STATUS.PENDING)
    .sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
}

export function getPublicRequests(userId) {
  if (typeof userId !== 'string' || !userId) return [];
  return getOpenRequests().filter(request => request.ownerId !== userId);
}

export function getMyPendingRequests(userId) {
  if (typeof userId !== 'string' || !userId) return [];
  return getOpenRequests().filter(request => request.ownerId === userId);
}

export function getFinancedLoans(userId) {
  return stateManager.getState().requests
    .filter(request => request.ownerId === userId && (request.status === REQUEST_STATUS.FUNDED || request.status === REQUEST_STATUS.LATE))
    .sort((left, right) => (Date.parse(right.financedAt) || 0) - (Date.parse(left.financedAt) || 0));
}

export function getDueDate(request) {
  const dueTime = readDueTime(request);
  return Number.isFinite(dueTime) ? new Date(dueTime) : null;
}

export function requestLoan({ amount, termDays, reason } = {}) {
  return execute(() => {
    const sessionUser = requireSessionUser('Inicia sesión para solicitar un crédito.');
    const cleanAmount = validateLoanAmount(amount);
    const cleanTerm = parseTerm(termDays);
    if (cleanTerm === null) throw new LoanError(LOAN_ERROR.INVALID_TERM, 'Selecciona un plazo válido: 7, 10 o 15 días.');
    const cleanReason = sanitizeReason(reason);

    return stateManager.transact(data => {
      const owner = data.users.find(item => item.id === sessionUser.id);
      if (!owner) throw new LoanError(LOAN_ERROR.NO_SESSION, 'No encontramos tu cuenta. Inicia sesión de nuevo.');
      if (!Number.isSafeInteger(owner.availableLimit) || owner.availableLimit < 0) {
        throw new LoanError(LOAN_ERROR.OVER_LIMIT, 'No encontramos un cupo válido en tu cuenta.');
      }
      if (cleanAmount > owner.availableLimit) {
        throw new LoanError(LOAN_ERROR.OVER_LIMIT, `El monto supera tu cupo disponible (${formatCop(owner.availableLimit)}).`);
      }

      const createdAt = new Date().toISOString();
      const request = {
        id: generateId(),
        ownerId: owner.id,
        name: owner.name,
        reason: cleanReason,
        amount: cleanAmount,
        termDays: cleanTerm,
        score: calculateStudentScore(owner.paymentHistory),
        fee: SERVICE_FEE,
        totalToRepay: calculateRepayment(cleanAmount),
        feeCredited: false,
        status: REQUEST_STATUS.PENDING,
        createdAt
      };

      owner.availableLimit -= cleanAmount;
      owner.loans.push(request.id);
      data.requests.unshift(request);
      data.activities.unshift({
        id: `request:${request.id}`,
        userId: owner.id,
        type: 'request',
        title: 'Solicitud de microcrédito',
        detail: `${request.reason} · ${request.termDays} días`,
        amount: cleanAmount,
        createdAt
      });
      return { ok: true, request: copyRequest(request) };
    });
  });
}

export function cancelLoanRequest(requestId) {
  return execute(() => {
    const sessionUser = requireSessionUser('Inicia sesión para cancelar una solicitud.');

    return stateManager.transact(data => {
      const request = data.requests.find(item => item.id === requestId);
      if (!request) throw new LoanError(LOAN_ERROR.NOT_FOUND, 'No encontramos esa solicitud.');
      if (request.ownerId !== sessionUser.id) throw new LoanError(LOAN_ERROR.NOT_OWNER, 'Solo puedes cancelar tus propias solicitudes.');
      if (request.status !== REQUEST_STATUS.PENDING) {
        throw new LoanError(LOAN_ERROR.NOT_PENDING, 'Esta solicitud ya no está pendiente y no se puede cancelar.');
      }
      const owner = data.users.find(item => item.id === sessionUser.id);
      if (!owner || !Number.isSafeInteger(owner.availableLimit) || !Number.isSafeInteger(owner.availableLimit + request.amount)) {
        throw new LoanError(LOAN_ERROR.INVALID_REQUEST, 'No encontramos un cupo válido para restaurar.');
      }

      const createdAt = new Date().toISOString();
      owner.availableLimit += request.amount;
      owner.loans = owner.loans.filter(id => id !== request.id);
      data.requests.splice(data.requests.indexOf(request), 1);
      data.activities.unshift({
        id: `cancel:${request.id}`,
        userId: owner.id,
        type: 'cancel',
        title: 'Solicitud cancelada',
        detail: `${request.reason} · cupo restaurado`,
        amount: request.amount,
        createdAt
      });
      return { ok: true, request: { ...copyRequest(request), status: REQUEST_STATUS.CANCELLED } };
    });
  });
}

export function financeRequest(requestId) {
  return execute(() => {
    const sessionUser = requireSessionUser('Inicia sesión para financiar una solicitud.');
    const transactionId = generateId();

    return stateManager.transact(data => {
      const request = data.requests.find(item => item.id === requestId);
      if (!request) throw new LoanError(LOAN_ERROR.NOT_FOUND, 'No encontramos esa solicitud.');
      if (request.ownerId === sessionUser.id) throw new LoanError(LOAN_ERROR.OWN_REQUEST, 'No puedes financiar tu propia solicitud.');
      if (request.status !== REQUEST_STATUS.PENDING) throw new LoanError(LOAN_ERROR.NOT_PENDING, 'Esta solicitud ya no está pendiente.');
      if (!isFinancingTerms(request)) throw new LoanError(LOAN_ERROR.INVALID_REQUEST, 'Los datos de esta solicitud no son válidos.');

      const investor = data.users.find(item => item.id === sessionUser.id);
      const borrower = data.users.find(item => item.id === request.ownerId);
      if (!investor) throw new LoanError(LOAN_ERROR.INVALID_WALLET, 'No encontramos una billetera válida para el inversionista.');
      if (!borrower) throw new LoanError(LOAN_ERROR.INVALID_WALLET, 'No encontramos una billetera válida para el estudiante solicitante.');
      if (investor.id === borrower.id) throw new LoanError(LOAN_ERROR.OWN_REQUEST, 'No puedes financiar tu propia solicitud.');

      const principal = request.amount;
      const investorAccount = walletAccount(investor.id);
      const borrowerAccount = walletAccount(borrower.id);

      const investorBalance = ledgerBalance(data, investorAccount);
      if (investor.walletBalance !== investorBalance) {
        throw new LoanError(LOAN_ERROR.INVALID_WALLET, 'No fue posible verificar el saldo de tu billetera. Recarga la página e inténtalo de nuevo.');
      }
      if (investorBalance < principal) {
        throw new LoanError(LOAN_ERROR.INSUFFICIENT_FUNDS, `Saldo insuficiente: necesitas ${formatCop(principal)} y tu billetera tiene ${formatCop(investorBalance)}.`);
      }
      if (!Number.isSafeInteger(ledgerBalance(data, borrowerAccount) + principal)) {
        throw new LoanError(LOAN_ERROR.INVALID_WALLET, 'No encontramos una billetera válida para el estudiante solicitante.');
      }

      const feeTransactionId = `fee:${request.id}`;
      const feeAlreadyPosted = request.feeCredited === true || data.ledger.some(entry => entry.transactionId === feeTransactionId);
      if (!feeAlreadyPosted && !Number.isSafeInteger(ledgerBalance(data, FUND_ACCOUNT) + SERVICE_FEE)) {
        throw new LoanError(LOAN_ERROR.FUND_LIMIT, 'El Fondo de Cobertura alcanzó el límite permitido.');
      }

      const returnEstimate = calculateEstimatedReturn(principal, Number(request.termDays));
      const timestamp = new Date().toISOString();
      const dueAt = new Date(Date.parse(timestamp) + Number(request.termDays) * DAY_MS).toISOString();

      data.ledger.push(...createLedgerPosting(transactionId, 'p2p_funding', principal, investorAccount, borrowerAccount, {
        requestId: request.id,
        userId: investor.id,
        counterpartyId: borrower.id
      }));

      const investorBalanceAfter = ledgerBalance(data, investorAccount);
      if (investorBalanceAfter < 0 || investorBalanceAfter !== investorBalance - principal) {
        throw new LoanError(LOAN_ERROR.INVALID_WALLET, 'La verificación final del saldo falló. No se realizó ningún movimiento.');
      }

      let feeContributed = 0;
      if (!feeAlreadyPosted) {
        data.ledger.push(...createLedgerPosting(feeTransactionId, 'service_fee_accrual', SERVICE_FEE, SERVICE_FEE_ACCRUAL_ACCOUNT, FUND_ACCOUNT, {
          requestId: request.id,
          userId: investor.id
        }));
        feeContributed = SERVICE_FEE;
      }

      investor.investments.push(transactionId);
      if (!borrower.loans.includes(request.id)) borrower.loans.push(request.id);
      const movement = { id: transactionId, requestId: request.id, amount: principal, termDays: request.termDays, createdAt: timestamp };
      investor.transactionHistory.push({ ...movement, role: 'inversionista', delta: -principal });
      borrower.transactionHistory.push({ ...movement, role: 'solicitante', delta: principal });

      request.status = REQUEST_STATUS.FUNDED;
      request.feeCredited = true;
      request.fundedBy = investor.id;
      request.transactionId = transactionId;
      request.estimatedEarnings = returnEstimate.earnings;
      request.financedAt = timestamp;
      request.dueAt = dueAt;

      data.activities.unshift(
        {
          id: `${transactionId}:investor`,
          transactionId,
          userId: investor.id,
          type: 'investment',
          title: 'Financiación P2P enviada',
          detail: `A ${request.name} · retorno estimado ${formatCop(returnEstimate.total)}`,
          amount: -principal,
          createdAt: timestamp
        },
        {
          id: `${transactionId}:borrower`,
          transactionId,
          userId: borrower.id,
          type: 'loan',
          title: 'Fondos de microcrédito recibidos',
          detail: `${request.reason} · ${request.termDays} días`,
          amount: principal,
          createdAt: timestamp
        }
      );

      return {
        ok: true,
        request: copyRequest(request),
        returnEstimate,
        transactionId,
        feeContributed,
        investorBalanceAfter,
        fundBalanceAfter: ledgerBalance(data, FUND_ACCOUNT)
      };
    });
  });
}

export function simulateCashIn({ amount, rail } = {}) {
  return execute(() => {
    const sessionUser = requireSessionUser('Inicia sesión para recargar tu billetera.');
    const cleanRail = typeof rail === 'string' ? rail.trim() : '';
    if (!PAYMENT_RAILS.includes(cleanRail)) throw new LoanError(LOAN_ERROR.INVALID_RAIL, 'Selecciona PSE o Nequi.');
    const cleanAmount = validateCashAmount(amount, 'valor de la recarga');
    const transactionId = generateId();

    return stateManager.transact(data => {
      const user = data.users.find(item => item.id === sessionUser.id);
      if (!user) throw new LoanError(LOAN_ERROR.NO_SESSION, 'No encontramos tu cuenta. Inicia sesión de nuevo.');
      const account = walletAccount(user.id);
      if (!Number.isSafeInteger(ledgerBalance(data, account) + cleanAmount)) {
        throw new LoanError(LOAN_ERROR.INVALID_WALLET, 'La recarga supera el límite permitido para tu billetera.');
      }

      const timestamp = new Date().toISOString();
      data.ledger.push(...createLedgerPosting(transactionId, 'simulated_cash_in', cleanAmount, `external:cash-in:${cleanRail.toLowerCase()}`, account, {
        userId: user.id,
        rail: cleanRail
      }));
      user.transactionHistory.push({ id: transactionId, role: 'recarga', type: 'simulated_cash_in', amount: cleanAmount, delta: cleanAmount, rail: cleanRail, createdAt: timestamp });
      data.activities.unshift({
        id: transactionId,
        transactionId,
        userId: user.id,
        type: 'cash_in',
        title: 'Recarga simulada',
        detail: `Pasarela de demostración: ${cleanRail}`,
        amount: cleanAmount,
        createdAt: timestamp
      });
      return { ok: true, transactionId, amount: cleanAmount };
    });
  });
}

export function simulateCashOut({ amount } = {}) {
  return execute(() => {
    const sessionUser = requireSessionUser('Inicia sesión para retirar fondos.');
    const cleanAmount = validateCashAmount(amount, 'valor del retiro');
    const transactionId = generateId();

    return stateManager.transact(data => {
      const user = data.users.find(item => item.id === sessionUser.id);
      if (!user) throw new LoanError(LOAN_ERROR.NO_SESSION, 'No encontramos tu cuenta. Inicia sesión de nuevo.');
      const account = walletAccount(user.id);
      const balance = ledgerBalance(data, account);
      if (balance < cleanAmount) {
        throw new LoanError(LOAN_ERROR.INSUFFICIENT_FUNDS, `Saldo insuficiente: el retiro supera tu saldo disponible (${formatCop(balance)}).`);
      }

      const timestamp = new Date().toISOString();
      data.ledger.push(...createLedgerPosting(transactionId, 'simulated_cash_out', cleanAmount, account, 'external:cash-out', { userId: user.id }));
      user.transactionHistory.push({ id: transactionId, role: 'retiro', type: 'simulated_cash_out', amount: cleanAmount, delta: -cleanAmount, createdAt: timestamp });
      data.activities.unshift({
        id: transactionId,
        transactionId,
        userId: user.id,
        type: 'cash_out',
        title: 'Retiro simulado',
        detail: 'Transferencia de demostración',
        amount: -cleanAmount,
        createdAt: timestamp
      });
      return { ok: true, transactionId, amount: cleanAmount };
    });
  });
}

export function processMaturedLoans(now = new Date()) {
  const nowTime = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowTime)) return { ok: false, processed: 0, covered: 0 };

  const isDue = request => request.status === REQUEST_STATUS.FUNDED && nowTime >= readDueTime(request);
  if (!stateManager.getState().requests.some(isDue)) return { ok: true, processed: 0, covered: 0 };

  try {
    const outcome = stateManager.transact(data => {
      const appliedAt = new Date(nowTime).toISOString();
      let processed = 0;
      let covered = 0;

      for (const request of data.requests) {
        if (!isDue(request)) continue;

        const borrower = data.users.find(item => item.id === request.ownerId);
        const investor = data.users.find(item => item.id === request.fundedBy);
        request.status = REQUEST_STATUS.LATE;
        request.dueAt = new Date(readDueTime(request)).toISOString();
        request.defaultAppliedAt = appliedAt;
        if (borrower) borrower.paymentHistory.push({ loanId: request.id, status: 'default', createdAt: appliedAt });

        const coverageId = `coverage:${request.id}`;
        const alreadyCovered = data.ledger.some(entry => entry.transactionId === coverageId);
        const requested = request.amount + (Number.isSafeInteger(request.estimatedEarnings) ? request.estimatedEarnings : 0);
        const available = Math.max(0, ledgerBalance(data, FUND_ACCOUNT));
        const coverage = investor && !alreadyCovered ? Math.min(available, requested) : 0;

        if (coverage > 0) {
          data.ledger.push(...createLedgerPosting(coverageId, 'guarantee_coverage', coverage, FUND_ACCOUNT, walletAccount(investor.id), {
            requestId: request.id,
            userId: investor.id,
            borrowerId: request.ownerId
          }));
          investor.transactionHistory.push({ id: coverageId, requestId: request.id, role: 'cobertura', type: 'guarantee_coverage', amount: coverage, delta: coverage, createdAt: appliedAt });
          data.activities.unshift({
            id: `${coverageId}:investor`,
            userId: investor.id,
            type: 'coverage',
            title: 'Cobertura del Fondo recibida',
            detail: `${request.name} · ${request.reason}`,
            amount: coverage,
            createdAt: appliedAt
          });
          covered += coverage;
        }

        data.activities.unshift({
          id: `mora:${request.id}`,
          userId: request.ownerId,
          type: 'default',
          title: 'Crédito vencido: mora',
          detail: coverage ? `Cobertura aplicada: ${formatCop(coverage)}` : 'Fondo de Cobertura sin saldo disponible',
          amount: 0,
          createdAt: appliedAt
        });
        processed += 1;
      }

      if (!processed) return { ok: false, code: 'NOTHING_DUE' };
      return { ok: true, processed, covered };
    });

    if (outcome.ok === false) return { ok: true, processed: 0, covered: 0 };
    return outcome;
  } catch (error) {
    console.error('UniPool: no fue posible procesar los vencimientos.', error);
    return { ok: false, processed: 0, covered: 0 };
  }
}
