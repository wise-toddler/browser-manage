// --- Tab suspension (built-in, no external dependency) ---
import { getTabs } from './tabs.js';

export const OWN_SUSPEND_PREFIX = chrome.runtime.getURL('suspended.html');
// Detect any suspended tab: our own, Great Suspender (chrome-extension:// or extension://)
const EXTERNAL_SUSPENDED_PATTERN = /^(?:chrome-extension|extension):\/\/[a-z]+\/suspended\.html/;

export function isSuspendedTab(url) {
  return url.startsWith(OWN_SUSPEND_PREFIX) || EXTERNAL_SUSPENDED_PATTERN.test(url);
}

export function parseSuspendedUrl(url) {
  const hash = url.split('#')[1] || '';
  const params = new URLSearchParams(hash);
  return { title: params.get('ttl') || params.get('title') || '', originalUrl: params.get('uri') || params.get('url') || '' };
}

export function suspendUrlFor(tab) {
  return `${OWN_SUSPEND_PREFIX}#ttl=${encodeURIComponent(tab.title)}&uri=${encodeURIComponent(tab.url)}`;
}

export async function listSuspendedTabs() {
  const tabs = await getTabs();
  return tabs.filter(t => isSuspendedTab(t.url)).map(t => {
    const parsed = parseSuspendedUrl(t.url);
    return { ...t, original_url: parsed.originalUrl, original_title: parsed.title, suspended: true };
  });
}

export async function suspendTabs(tabIds) {
  const tabs = await getTabs();
  const whitelist = await getWhitelist();
  const results = { suspended: 0, skipped_whitelisted: 0, skipped_already: 0 };

  for (const tabId of tabIds) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) continue;
    if (isSuspendedTab(tab.url)) { results.skipped_already++; continue; }
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://')) continue;
    try {
      const domain = new URL(tab.url).hostname.replace('www.', '');
      if (whitelist.some(d => domain.includes(d))) { results.skipped_whitelisted++; continue; }
    } catch {}
    await chrome.tabs.update(tabId, { url: suspendUrlFor(tab) });
    results.suspended++;
  }
  return results;
}

export async function unsuspendTabs(tabIds) {
  const tabs = await chrome.tabs.query({});
  let unsuspended = 0;
  for (const tabId of tabIds) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !isSuspendedTab(tab.url)) continue;
    const parsed = parseSuspendedUrl(tab.url);
    if (parsed.originalUrl) {
      await chrome.tabs.update(tabId, { url: parsed.originalUrl });
      unsuspended++;
    }
  }
  return { unsuspended };
}

export async function getWhitelist() {
  const data = await chrome.storage.local.get('suspendWhitelist');
  return data.suspendWhitelist || [];
}

export async function updateWhitelist(action, domains) {
  let whitelist = await getWhitelist();
  if (action === 'add') {
    whitelist = [...new Set([...whitelist, ...domains])];
  } else if (action === 'remove') {
    whitelist = whitelist.filter(d => !domains.includes(d));
  } else if (action === 'list') {
    return whitelist;
  }
  await chrome.storage.local.set({ suspendWhitelist: whitelist });
  return whitelist;
}
