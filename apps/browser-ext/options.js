const DEFAULT_L1 = 'http://localhost:4120';
const input = document.getElementById('l1');
const save = document.getElementById('save');

chrome.storage.sync.get('l1Url').then(({ l1Url }) => {
  input.value = l1Url || DEFAULT_L1;
});

save.addEventListener('click', () => {
  const v = String(input.value || '').trim().replace(/\/+$/, '') || DEFAULT_L1;
  chrome.storage.sync.set({ l1Url: v }, () => {
    save.textContent = '已保存 ✓';
    setTimeout(() => { save.textContent = '保存'; }, 1500);
  });
});
