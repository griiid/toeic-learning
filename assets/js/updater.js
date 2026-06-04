// PWA Service Worker registration, automatic update, and post-update modal.

import { t } from './i18n.js';
import { DB } from './db.js';
import {
  safeLocalGet,
  safeLocalRemove,
  safeSessionGet,
  safeSessionRemove,
  safeSessionSet
} from './storageSafe.js';
import { fetchVersionInfo, getBootVersionInfo, normalizeVersionInfo } from './versioning.js';

const UPDATE_ACK_VERSION_KEY = 'update_ack_version';
const LEGACY_PENDING_KEY = 'update_ack_pending';
const PENDING_UPDATE_INFO_KEY = 'toeic_pending_update_info';
const ACTIVATION_APPROVED_KEY = 'toeic_sw_activation_approved';
const UPDATE_CHECK_THROTTLE_MS = 30000;

const updateState = {
  acknowledgedVersion: null,
  pendingInfo: null,
  registration: null,
  waitingWorker: null,
  modalVisible: false,
  reloadAuthorized: safeSessionGet(ACTIVATION_APPROVED_KEY) === '1',
  isReloading: false,
  lastUpdateCheckAt: 0
};

async function getAcknowledgedVersion() {
  try {
    let v = await DB.getSetting(UPDATE_ACK_VERSION_KEY);
    if (v != null) return v;
    const legacy = safeLocalGet(UPDATE_ACK_VERSION_KEY);
    if (legacy) {
      await DB.setSetting(UPDATE_ACK_VERSION_KEY, legacy);
      safeLocalRemove(UPDATE_ACK_VERSION_KEY);
      return legacy;
    }
    return null;
  } catch {
    return safeLocalGet(UPDATE_ACK_VERSION_KEY);
  }
}

async function setAcknowledgedVersion(version) {
  await DB.setSetting(UPDATE_ACK_VERSION_KEY, version);
  safeLocalRemove(UPDATE_ACK_VERSION_KEY);
}

function migrateLegacyPendingKey() {
  safeLocalRemove(LEGACY_PENDING_KEY);
}

function readPendingUpdateInfo() {
  const raw = safeSessionGet(PENDING_UPDATE_INFO_KEY);
  if (!raw) return null;
  try {
    return normalizeVersionInfo(JSON.parse(raw));
  } catch {
    safeSessionRemove(PENDING_UPDATE_INFO_KEY);
    return null;
  }
}

function storePendingUpdateInfo(info) {
  const normalized = normalizeVersionInfo(info);
  updateState.pendingInfo = normalized;
  if (normalized) {
    safeSessionSet(PENDING_UPDATE_INFO_KEY, JSON.stringify(normalized));
    return normalized;
  }
  safeSessionRemove(PENDING_UPDATE_INFO_KEY);
  return null;
}

function clearPendingUpdateInfo() {
  updateState.pendingInfo = null;
  safeSessionRemove(PENDING_UPDATE_INFO_KEY);
}

async function resolveLatestVersionInfo({ preferNetwork = true } = {}) {
  let info = getBootVersionInfo();
  if (!preferNetwork) return normalizeVersionInfo(info);

  try {
    const net = await fetchVersionInfo(true);
    if (net) info = net;
  } catch {
    /* use boot-only */
  }

  return normalizeVersionInfo(info);
}

function getWaitingWorker(registration = updateState.registration) {
  if (!registration) return null;
  return registration.waiting || registration.installing || null;
}

function markReloadAuthorized(authorized) {
  updateState.reloadAuthorized = authorized;
  if (authorized) {
    safeSessionSet(ACTIVATION_APPROVED_KEY, '1');
    return;
  }
  safeSessionRemove(ACTIVATION_APPROVED_KEY);
}

function waitForWaitingWorker(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const registration = updateState.registration;
    if (!registration) {
      resolve(null);
      return;
    }

    if (registration.waiting) {
      resolve(registration.waiting);
      return;
    }

    const installing = registration.installing;
    if (!installing) {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (worker) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(worker || null);
    };

    const timer = setTimeout(() => finish(registration.waiting || null), timeoutMs);
    installing.addEventListener('statechange', () => {
      if (registration.waiting) {
        finish(registration.waiting);
        return;
      }
      if (installing.state === 'redundant') {
        finish(null);
      }
    });
  });
}

async function purgeAndReload() {
  if (updateState.isReloading) return;
  updateState.isReloading = true;
  markReloadAuthorized(false);

  try {
    await purgeAppCaches();
  } catch {
    /* keep reload resilient */
  }

  window.location.reload();
}

async function applyApprovedUpdate() {
  markReloadAuthorized(true);
  updateState.waitingWorker = getWaitingWorker();

  if (updateState.waitingWorker && updateState.registration?.waiting) {
    autoActivate(updateState.waitingWorker);
    return;
  }

  try {
    await updateState.registration?.update();
  } catch {
    /* keep fallback resilient */
  }

  updateState.waitingWorker = await waitForWaitingWorker();
  if (updateState.waitingWorker && updateState.registration?.waiting) {
    autoActivate(updateState.waitingWorker);
    return;
  }

  await purgeAndReload();
}

function showUpdateModal(info) {
  if (updateState.modalVisible || document.getElementById('updateOverlay')) return;
  updateState.modalVisible = true;

  const overlay = document.createElement('div');
  overlay.id = 'updateOverlay';
  overlay.className = 'update-overlay';

  overlay.innerHTML = `
    <div class="update-modal">
      <div class="update-modal-icon">✓</div>
      <h2 class="update-modal-title">${t('updaterTitle', { version: info.version })}</h2>
      <ul class="update-modal-changes">
        ${info.changes.map((c) => `<li>${c}</li>`).join('')}
      </ul>
      <p class="update-modal-notice">${t('updaterNotice')}</p>
      <button class="update-modal-btn" id="btnUpdateAck">${t('updaterAck')}</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const ackButton = document.getElementById('btnUpdateAck');
  ackButton.addEventListener('click', async () => {
    if (ackButton.disabled) return;
    ackButton.disabled = true;

    try {
      await setAcknowledgedVersion(info.version);
      updateState.acknowledgedVersion = info.version;
      clearPendingUpdateInfo();
      updateState.modalVisible = false;
      overlay.remove();
      await applyApprovedUpdate();
    } catch (err) {
      console.warn('Failed to save update acknowledgement:', err);
      ackButton.disabled = false;
    }
  });
}

async function maybeShowUpdateNotice({ preferNetwork = true } = {}) {
  migrateLegacyPendingKey();

  const ack = await getAcknowledgedVersion();
  updateState.acknowledgedVersion = ack;

  const pending = readPendingUpdateInfo();
  if (pending) {
    updateState.pendingInfo = pending;
  }

  const normalized = await resolveLatestVersionInfo({ preferNetwork });
  const candidate = normalized || updateState.pendingInfo;

  if (!candidate) return null;

  if (ack == null) {
    await setAcknowledgedVersion(candidate.version);
    updateState.acknowledgedVersion = candidate.version;
    clearPendingUpdateInfo();
    return candidate;
  }

  if (candidate.version === ack) {
    if (updateState.registration?.waiting) {
      updateState.waitingWorker = updateState.registration.waiting;
      markReloadAuthorized(true);
      autoActivate(updateState.waitingWorker);
    }
    clearPendingUpdateInfo();
    return candidate;
  }

  storePendingUpdateInfo(candidate);
  showUpdateModal(candidate);
  return candidate;
}

export function scheduleUpdateNoticeAfterAppReady() {
  window.addEventListener(
    'toeic-app-ready',
    () => {
      const runWhenRevealed = () => {
        if (document.documentElement.classList.contains('app-booting')) {
          requestAnimationFrame(runWhenRevealed);
          return;
        }
        maybeShowUpdateNotice().catch(() => {});
      };
      requestAnimationFrame(runWhenRevealed);
    },
    { once: true }
  );
}

function autoActivate(worker) {
  if (worker) worker.postMessage('skipWaiting');
}

async function purgeAppCaches() {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((k) => k.startsWith('toeic-tutor-static'))
      .map((k) => caches.delete(k))
  );
}

async function triggerUpdateCheck({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - updateState.lastUpdateCheckAt < UPDATE_CHECK_THROTTLE_MS) return;
  updateState.lastUpdateCheckAt = now;

  try {
    await updateState.registration?.update();
  } catch {
    /* keep update checks resilient */
  }

  maybeShowUpdateNotice({ preferNetwork: true }).catch(() => {});
}

export async function registerServiceWorkerUpdater() {
  if (!('serviceWorker' in navigator) || updateState.registration) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateState.reloadAuthorized && safeSessionGet(ACTIVATION_APPROVED_KEY) !== '1') {
      return;
    }
    purgeAndReload().catch(() => {});
  });

  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    updateState.registration = reg;
    updateState.waitingWorker = reg.waiting || null;

    triggerUpdateCheck({ force: true }).catch(() => {});

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          updateState.waitingWorker = reg.waiting || installing;
          if (updateState.reloadAuthorized) {
            autoActivate(updateState.waitingWorker);
            return;
          }
          maybeShowUpdateNotice({ preferNetwork: true }).catch(() => {});
        }
      });
    });

    const triggerUpdate = () => {
      triggerUpdateCheck().catch(() => {});
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') triggerUpdate();
    });

    window.addEventListener('pageshow', (e) => {
      if (e.persisted) triggerUpdate();
    });
  } catch (err) {
    console.warn('SW registration failed:', err);
  }
}
