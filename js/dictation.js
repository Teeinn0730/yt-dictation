// 文字比對工具：單字正規化、LCS 對齊、遮罩
const NUM = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', okay: 'ok',
};

// 比對時忽略大小寫、標點和撇號（don't = dont），數字寫成英文也算對
export function normWord(w) {
  const s = String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
  return NUM[s] ?? s;
}

export function tokenize(text) {
  return String(text)
    .replace(/[—–]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(orig => ({ orig, norm: normWord(orig) }))
    .filter(t => t.norm);
}

// 回傳 a、b 最長共同子序列的配對索引 [[i, j], ...]
export function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

// 字母數字換成圓點，保留標點和撇號當提示，例如 don't → •••'•
export const maskWord = w => String(w).replace(/[A-Za-z0-9]/g, '•');

// 去掉前後標點，用來查字典
export const cleanWord = w => String(w).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'was',
  'were', 'it', 'i', 'you', 'he', 'she', 'we', 'they', 'that', 'this', 'for', 'with', 'be', 'as', 'so', 'not',
  'do', 'my', 'me', 'your', 'its', 'im', 'if', 'just', 'like', 'have', 'has', 'can']);
export const isStopWord = w => STOP.has(normWord(w));

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
