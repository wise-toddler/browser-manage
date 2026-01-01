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
