const storage = {
  get: (keys) => new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  }),
  set: (items) => new Promise((resolve, reject) => {
    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  })
};
const sendMessage = (message) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      reject(chrome.runtime.lastError);
    } else {
      resolve(response);
    }
  });
});

const scopeField = document.querySelector('#scope');
const scopeStatus = document.querySelector('#scope-status');
const whitelistField = document.querySelector('#whitelist');
const whitelistStatus = document.querySelector('#whitelist-status');
const manualButton = document.querySelector('#close-duplicates');
const manualStatus = document.querySelector('#manual-status');

const sanitizeWhitelist = (value) => value
  .split(/\r?\n/)
  .map((entry) => entry.trim())
  .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index);

const showStatus = (element, message, timeout = 2000) => {
  element.textContent = message;
  if (timeout) {
    setTimeout(() => {
      if (element.textContent === message) {
        element.textContent = '';
      }
    }, timeout);
  }
};

const loadSettings = async () => {
  try {
    const { whitelist = [], scope = 'global' } = await storage.get({ whitelist: [], scope: 'global' });
    whitelistField.value = whitelist.join('\n');
    if (scopeField.querySelector(`option[value="${scope}"]`)) {
      scopeField.value = scope;
    } else {
      scopeField.value = 'global';
    }
  } catch (error) {
    console.error('Failed to load settings', error);
    showStatus(scopeStatus, 'Unable to load scope');
    showStatus(whitelistStatus, 'Unable to load whitelist');
  }
};

const saveWhitelist = async () => {
  const entries = sanitizeWhitelist(whitelistField.value);
  try {
    await storage.set({ whitelist: entries });
    showStatus(whitelistStatus, 'Whitelist saved');
  } catch (error) {
    console.error('Failed to save whitelist', error);
    showStatus(whitelistStatus, 'Unable to save whitelist');
  }
};

const saveScope = async () => {
  const value = scopeField.value === 'window' ? 'window' : 'global';
  try {
    await storage.set({ scope: value });
    showStatus(scopeStatus, 'Scope saved');
  } catch (error) {
    console.error('Failed to save scope', error);
    showStatus(scopeStatus, 'Unable to save scope');
  }
};

const triggerManualClose = async () => {
  manualButton.disabled = true;
  showStatus(manualStatus, 'Scanning for duplicates...', 0);

  try {
    const response = await sendMessage({ type: 'manualCloseDuplicates' });
    if (response && response.success) {
      showStatus(manualStatus, 'Duplicates closed');
    } else {
      throw new Error(response && response.error ? response.error : 'Unknown error');
    }
  } catch (error) {
    console.error('Manual duplicate close failed', error);
    showStatus(manualStatus, 'Unable to close duplicates');
  } finally {
    manualButton.disabled = false;
  }
};

scopeField.addEventListener('change', saveScope);
whitelistField.addEventListener('change', saveWhitelist);
manualButton.addEventListener('click', triggerManualClose);

loadSettings();
