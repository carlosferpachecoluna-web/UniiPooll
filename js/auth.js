import {
  DEFAULT_CREDIT_LIMIT,
  DEFAULT_PASSWORD_ITERATIONS,
  DEFAULT_WALLET_BALANCE,
  DEMO_ACCOUNT,
  generateId,
  stateManager
} from './state.js';

export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 30000;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 60;

export const EMAIL_ERROR = 'Correo inválido. Usa un correo institucional terminado en .edu o .edu.co.';

export const AUTH_ERROR = Object.freeze({
  INVALID_NAME: 'INVALID_NAME',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  NOT_FOUND: 'NOT_FOUND',
  WRONG_PASSWORD: 'WRONG_PASSWORD',
  RATE_LIMITED: 'RATE_LIMITED',
  NO_CRYPTO: 'NO_CRYPTO',
  NO_SESSION: 'NO_SESSION',
  UNEXPECTED: 'UNEXPECTED'
});

const UNIVERSITY_EMAIL = /^(?=.{6,254}$)(?=[^@]{1,64}@)[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+edu(?:\.co)?$/i;

export const normalizeEmail = email => String(email ?? '').toLowerCase().trim();
export const isUniversityEmail = email => UNIVERSITY_EMAIL.test(normalizeEmail(email));

const failedAttempts = new Map();
let notifier = null;

export function setAuthNotifier(handler) {
  notifier = typeof handler === 'function' ? handler : null;
}

function reject(code, error, field = null) {
  if (notifier) {
    try {
      notifier(error, 'error');
    } catch (notifierError) {
      console.error('UniPool: el notificador de autenticación falló.', notifierError);
    }
  }
  return { ok: false, code, error, field };
}

function lockRemainingMs(email) {
  const entry = failedAttempts.get(email);
  if (!entry || entry.lockedUntil <= Date.now()) return 0;
  return entry.lockedUntil - Date.now();
}

function registerFailure(email) {
  const now = Date.now();
  const entry = failedAttempts.get(email) ?? { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    entry.count = 0;
    entry.lockedUntil = 0;
  }
  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.count = 0;
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  failedAttempts.set(email, entry);
}

const toHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('INVALID_HEX');
  }
  return Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));
}

async function derivePassword(password, salt, iterations) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SECURE_CRYPTO_UNAVAILABLE');
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toHex(new Uint8Array(bits));
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function toPublicUser(user) {
  const { passwordHash, passwordSalt, passwordIterations, ...publicUser } = user;
  return publicUser;
}

function validatePassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener mínimo ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `La contraseña no puede superar ${MAX_PASSWORD_LENGTH} caracteres.`;
  return null;
}

function validateName(name) {
  if (!name) return 'Escribe tu nombre.';
  if (name.length < MIN_NAME_LENGTH || !/\p{L}/u.test(name)) return 'Escribe tu nombre completo.';
  if (name.length > MAX_NAME_LENGTH) return `El nombre no puede superar ${MAX_NAME_LENGTH} caracteres.`;
  if (/[<>\u0000-\u001f\u007f]/.test(name)) return 'El nombre no puede contener etiquetas HTML ni caracteres de control.';
  return null;
}

function cryptoFailure(error, fallbackMessage) {
  if (error?.message === 'SECURE_CRYPTO_UNAVAILABLE') {
    return reject(AUTH_ERROR.NO_CRYPTO, 'Este navegador no ofrece cifrado seguro. Abre la aplicación en localhost o HTTPS.');
  }
  console.error('UniPool: error de autenticación.', error);
  return reject(AUTH_ERROR.UNEXPECTED, fallbackMessage);
}

export async function register({ name, email, password } = {}) {
  const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim();
  const cleanEmail = normalizeEmail(email);
  const cleanPassword = String(password ?? '');

  const nameError = validateName(cleanName);
  if (nameError) return reject(AUTH_ERROR.INVALID_NAME, nameError, 'name');
  if (!UNIVERSITY_EMAIL.test(cleanEmail)) return reject(AUTH_ERROR.INVALID_EMAIL, EMAIL_ERROR, 'email');
  const passwordError = validatePassword(cleanPassword);
  if (passwordError) return reject(AUTH_ERROR.INVALID_PASSWORD, passwordError, 'password');
  if (stateManager.getUserByEmail(cleanEmail)) return reject(AUTH_ERROR.EMAIL_TAKEN, 'Ya existe una cuenta con ese correo.', 'email');

  try {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await derivePassword(cleanPassword, salt, DEFAULT_PASSWORD_ITERATIONS);
    const newUser = {
      id: generateId(),
      name: cleanName,
      email: cleanEmail,
      passwordSalt: toHex(salt),
      passwordHash,
      passwordIterations: DEFAULT_PASSWORD_ITERATIONS,
      availableLimit: DEFAULT_CREDIT_LIMIT,
      walletBalance: DEFAULT_WALLET_BALANCE,
      paymentHistory: [],
      loans: [],
      investments: [],
      transactionHistory: [],
      createdAt: new Date().toISOString()
    };

    let storedUser;
    try {
      storedUser = stateManager.saveUser(newUser);
    } catch (error) {
      if (error?.message === 'DUPLICATE_USER') return reject(AUTH_ERROR.EMAIL_TAKEN, 'Ya existe una cuenta con ese correo.', 'email');
      throw error;
    }

    if (!storedUser || !stateManager.setCurrentUser(storedUser.id)) {
      return reject(AUTH_ERROR.NO_SESSION, 'La cuenta se creó, pero no fue posible iniciar la sesión automáticamente. Inicia sesión manualmente.');
    }
    return { ok: true, user: toPublicUser(storedUser), autoLogin: true };
  } catch (error) {
    return cryptoFailure(error, 'No fue posible crear la cuenta en este navegador.');
  }
}

export async function login({ email, password } = {}) {
  const cleanEmail = normalizeEmail(email);
  if (!UNIVERSITY_EMAIL.test(cleanEmail)) return reject(AUTH_ERROR.INVALID_EMAIL, EMAIL_ERROR, 'email');
  const cleanPassword = String(password ?? '');
  if (!cleanPassword) return reject(AUTH_ERROR.INVALID_PASSWORD, 'Ingresa tu contraseña.', 'password');
  if (cleanPassword.length > MAX_PASSWORD_LENGTH) return reject(AUTH_ERROR.WRONG_PASSWORD, 'Contraseña incorrecta.', 'password');

  const waitMs = lockRemainingMs(cleanEmail);
  if (waitMs > 0) {
    return reject(AUTH_ERROR.RATE_LIMITED, `Demasiados intentos fallidos. Espera ${Math.ceil(waitMs / 1000)} segundos e inténtalo de nuevo.`, 'password');
  }

  const user = stateManager.getUserByEmail(cleanEmail);
  if (!user) {
    registerFailure(cleanEmail);
    return reject(AUTH_ERROR.NOT_FOUND, 'Usuario no encontrado, regístrate.', 'email');
  }

  try {
    const salt = fromHex(user.passwordSalt);
    const iterations = Number.isSafeInteger(user.passwordIterations) && user.passwordIterations > 0
      ? user.passwordIterations
      : DEFAULT_PASSWORD_ITERATIONS;
    const candidate = await derivePassword(cleanPassword, salt, iterations);
    if (!safeEqual(candidate, user.passwordHash)) {
      registerFailure(cleanEmail);
      return reject(AUTH_ERROR.WRONG_PASSWORD, 'Contraseña incorrecta.', 'password');
    }
    failedAttempts.delete(cleanEmail);
    if (!stateManager.setCurrentUser(user.id)) return reject(AUTH_ERROR.NO_SESSION, 'No fue posible guardar la sesión.');
    return { ok: true, user: toPublicUser(stateManager.getUserById(user.id) ?? user) };
  } catch (error) {
    return cryptoFailure(error, 'No fue posible validar la cuenta en este navegador.');
  }
}

export function logout() {
  stateManager.clearCurrentUser();
  return { ok: true };
}

export function restoreSession() {
  stateManager.refreshFromStorage();
  const user = stateManager.getCurrentUser();
  if (!user) return { ok: false, code: AUTH_ERROR.NO_SESSION, error: 'No hay una sesión activa.' };
  return { ok: true, user: toPublicUser(user), restored: true };
}

export function getSessionUser() {
  const user = stateManager.getCurrentUser();
  return user ? toPublicUser(user) : null;
}

export function isAuthenticated() {
  return stateManager.getCurrentUser() !== null;
}

export function getDemoCredentials() {
  return { email: DEMO_ACCOUNT.email, password: DEMO_ACCOUNT.password };
}
