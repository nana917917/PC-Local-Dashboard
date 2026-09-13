// サーバーとのやり取り。エラーはサーバーが返す日本語メッセージをそのまま使う。

export function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function getJson(path, params) {
  const response = await fetch(`${path}${query(params)}`, { cache: 'no-store' });
  return read(response);
}

export async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return read(response);
}

async function read(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `通信に失敗しました（HTTP ${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function download(path, params) {
  const link = document.createElement('a');
  link.href = `${path}${query(params)}`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
