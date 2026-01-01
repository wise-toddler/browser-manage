let allTabs = [];
let pendingChanges = null;

const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

async function init() {
  allTabs = await chrome.runtime.sendMessage({ action: 'getTabs' });
  pendingChanges = await chrome.runtime.sendMessage({ action: 'getPendingChanges' });

  if (!pendingChanges) {
    pendingChanges = { toClose: [], groups: {} };
  }

  render();
}

function getTabById(id) {
  return allTabs.find(t => t.id === id);
}

function render() {
  renderStats();
  renderCloseList();
  renderGroups();
}

function renderStats() {
  const statsEl = document.getElementById('stats');
  const closeCount = pendingChanges.toClose?.length || 0;
  const groupCount = Object.keys(pendingChanges.groups || {}).length;

  statsEl.innerHTML = `
    <span>${closeCount}</span> tabs to close |
    <span>${groupCount}</span> groups to create |
    <span>${allTabs.length}</span> total tabs
  `;
}

function renderCloseList() {
  const listEl = document.getElementById('close-list');
  const toClose = pendingChanges.toClose || [];

  if (toClose.length === 0) {
    listEl.innerHTML = '<div class="empty">No tabs marked for closing</div>';
    return;
  }

  listEl.innerHTML = toClose.map(tabId => {
    const tab = getTabById(tabId);
    if (!tab) return '';
    return `
      <div class="tab-item">
        <input type="checkbox" checked data-tab-id="${tabId}" class="close-checkbox">
        <span class="tab-title">${escapeHtml(tab.title)}</span>
        <span class="tab-url">${getDomain(tab.url)}</span>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.close-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const tabId = parseInt(e.target.dataset.tabId);
      if (e.target.checked) {
        if (!pendingChanges.toClose.includes(tabId)) {
          pendingChanges.toClose.push(tabId);
        }
      } else {
        pendingChanges.toClose = pendingChanges.toClose.filter(id => id !== tabId);
      }
      updatePending();
      renderStats();
    });
  });
}

function renderGroups() {
  const listEl = document.getElementById('groups-list');
  const groups = pendingChanges.groups || {};

  if (Object.keys(groups).length === 0) {
    listEl.innerHTML = '<div class="empty">No groups proposed</div>';
    return;
  }

  listEl.innerHTML = Object.entries(groups).map(([name, config]) => {
    const colorOptions = COLORS.map(c =>
      `<option value="${c}" ${config.color === c ? 'selected' : ''}>${c}</option>`
    ).join('');

    const tabsHtml = (config.tabIds || []).map(tabId => {
      const tab = getTabById(tabId);
      if (!tab) return '';
      return `
        <div class="tab-item">
          <input type="checkbox" checked data-group="${name}" data-tab-id="${tabId}" class="group-tab-checkbox">
          <span class="tab-title">${escapeHtml(tab.title)}</span>
          <span class="tab-url">${getDomain(tab.url)}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="group-section" data-group-name="${escapeHtml(name)}">
        <div class="group-header">
          <input type="text" class="group-name" value="${escapeHtml(name)}" data-original="${escapeHtml(name)}">
          <select class="group-color" data-group="${escapeHtml(name)}">
            ${colorOptions}
          </select>
        </div>
        ${tabsHtml}
      </div>
    `;
  }).join('');

  // Event listeners for group name changes
  listEl.querySelectorAll('.group-name').forEach(input => {
    input.addEventListener('change', (e) => {
      const oldName = e.target.dataset.original;
      const newName = e.target.value.trim();
      if (newName && newName !== oldName && pendingChanges.groups[oldName]) {
        pendingChanges.groups[newName] = pendingChanges.groups[oldName];
        delete pendingChanges.groups[oldName];
        e.target.dataset.original = newName;
        updatePending();
      }
    });
  });

  // Event listeners for color changes
  listEl.querySelectorAll('.group-color').forEach(select => {
    select.addEventListener('change', (e) => {
      const groupName = e.target.dataset.group;
      if (pendingChanges.groups[groupName]) {
        pendingChanges.groups[groupName].color = e.target.value;
        updatePending();
      }
    });
  });

  // Event listeners for removing tabs from groups
  listEl.querySelectorAll('.group-tab-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const groupName = e.target.dataset.group;
      const tabId = parseInt(e.target.dataset.tabId);
      if (pendingChanges.groups[groupName]) {
        if (e.target.checked) {
          if (!pendingChanges.groups[groupName].tabIds.includes(tabId)) {
            pendingChanges.groups[groupName].tabIds.push(tabId);
          }
        } else {
          pendingChanges.groups[groupName].tabIds =
            pendingChanges.groups[groupName].tabIds.filter(id => id !== tabId);
        }
        updatePending();
        renderStats();
      }
    });
  });
}

async function updatePending() {
  await chrome.runtime.sendMessage({ action: 'updatePendingChanges', changes: pendingChanges });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

document.getElementById('apply-btn').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ action: 'applyChanges' });
  if (result.error) {
    alert('Error: ' + result.error);
  } else {
    window.close();
  }
});

document.getElementById('cancel-btn').addEventListener('click', () => {
  window.close();
});

init();
