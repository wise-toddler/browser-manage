const NATIVE_HOST = 'com.tabmanager.host';

let port = null;
let pendingChanges = null;

// Connect to native host on startup
function connectNative() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    console.log('Connected to native host');

    port.onMessage.addListener((message) => {
      console.log('Received from native:', message);
      handleNativeMessage(message);
    });

    port.onDisconnect.addListener(() => {
      console.log('Native host disconnected:', chrome.runtime.lastError?.message);
      port = null;
      // Reconnect after 2 seconds
      setTimeout(connectNative, 2000);
    });
  } catch (err) {
    console.error('Failed to connect to native host:', err);
    setTimeout(connectNative, 5000);
  }
}

async function handleNativeMessage(message) {
  const { action, id, payload } = message;
  let result;

  try {
    switch (action) {
      case 'getTabs':
        result = await getTabs();
        break;
      case 'getTabsWithMemory':
        result = await getTabsWithMemory();
        break;
      case 'closeTabs':
        result = await closeTabs(payload.tabIds);
        break;
      case 'createGroup':
        result = await createGroup(payload.name, payload.color, payload.tabIds);
        break;
      case 'addToGroup':
        result = await addToGroup(payload.groupId, payload.tabIds);
        break;
      case 'previewChanges':
        result = await previewChanges(payload);
        break;
      case 'applyChanges':
        result = await applyChanges();
        break;
      default:
        result = { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    result = { error: err.message };
  }

  // Send result back to native host
  if (port) {
    port.postMessage({ id, result });
  }
}

async function getTabs() {
  const windows = await chrome.windows.getAll({});
  const normalWindowIds = new Set(windows.filter(w => w.type === 'normal').map(w => w.id));

  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});

  const groupMap = {};
  for (const g of groups) {
    groupMap[g.id] = { title: g.title, color: g.color };
  }

  return tabs.filter(t => normalWindowIds.has(t.windowId)).map(t => ({
    id: t.id,
    windowId: t.windowId,
    title: t.title,
    url: t.url,
    groupId: t.groupId,
    groupInfo: t.groupId !== -1 ? groupMap[t.groupId] : null
  }));
}

async function getTabsWithMemory() {
  const tabs = await getTabs();

  try {
    const processInfo = await chrome.processes.getProcessInfo([], true);

    // Map process info by ID
    const processMap = {};
    for (const [pid, info] of Object.entries(processInfo)) {
      processMap[pid] = {
        privateMemory: info.privateMemory || 0,
        cpu: info.cpu || 0,
        type: info.type || 'unknown'
      };
    }

    // Get tab process IDs and add memory info
    let totalMemory = 0;
    const tabsWithMemory = await Promise.all(tabs.map(async (tab) => {
      try {
        const tabProcess = await chrome.processes.getProcessIdForTab(tab.id);
        const procInfo = processMap[tabProcess] || {};
        const memoryMb = (procInfo.privateMemory || 0) / (1024 * 1024);
        totalMemory += memoryMb;
        return {
          ...tab,
          processId: tabProcess,
          memory_mb: Math.round(memoryMb * 10) / 10,
          cpu: procInfo.cpu || 0
        };
      } catch (e) {
        return { ...tab, memory_mb: 0, cpu: 0 };
      }
    }));

    // Sort by memory descending
    tabsWithMemory.sort((a, b) => b.memory_mb - a.memory_mb);

    return {
      tabs: tabsWithMemory,
      total_memory_mb: Math.round(totalMemory * 10) / 10,
      total_memory_gb: Math.round(totalMemory / 1024 * 100) / 100
    };
  } catch (e) {
    // Fallback if processes API not available
    return { tabs, total_memory_mb: 0, error: e.message };
  }
}

async function closeTabs(tabIds) {
  await chrome.tabs.remove(tabIds);
  return { closed: tabIds.length };
}

async function createGroup(name, color, tabIds) {
  if (!tabIds || tabIds.length === 0) {
    return { error: 'No tab IDs provided' };
  }

  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, {
    title: name,
    color: color || 'blue'
  });
  return { groupId, name, tabIds, success: true };
}

async function addToGroup(groupId, tabIds) {
  await chrome.tabs.group({ groupId, tabIds });
  return { groupId, added: tabIds.length };
}

async function previewChanges(changes) {
  pendingChanges = changes;
  await chrome.action.openPopup();
  return { status: 'preview_opened' };
}

async function applyChanges() {
  if (!pendingChanges) {
    return { error: 'No pending changes' };
  }

  const { toClose, groups } = pendingChanges;
  const results = { closed: 0, groupsCreated: 0 };

  if (toClose && toClose.length > 0) {
    await chrome.tabs.remove(toClose);
    results.closed = toClose.length;
  }

  if (groups) {
    for (const [name, config] of Object.entries(groups)) {
      if (config.tabIds && config.tabIds.length > 0) {
        const groupId = await chrome.tabs.group({ tabIds: config.tabIds });
        await chrome.tabGroups.update(groupId, {
          title: name,
          color: config.color || 'blue'
        });
        results.groupsCreated++;
      }
    }
  }

  pendingChanges = null;
  return results;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getPendingChanges') {
    sendResponse(pendingChanges);
  } else if (message.action === 'updatePendingChanges') {
    pendingChanges = message.changes;
    sendResponse({ ok: true });
  } else if (message.action === 'applyChanges') {
    applyChanges().then(sendResponse);
    return true;
  } else if (message.action === 'getTabs') {
    getTabs().then(sendResponse);
    return true;
  }
});

// Connect on startup
connectNative();
console.log('Tab Manager extension loaded');
