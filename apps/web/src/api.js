const BASE = (
  import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? "http://localhost:3000" : "")
).replace(/\/$/, "");
export const session = {
  get: () => sessionStorage.getItem("dashbv-token"),
  set: (t) => sessionStorage.setItem("dashbv-token", t),
  clear: () => sessionStorage.removeItem("dashbv-token"),
};
export async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const token = session.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  if (response.status === 401) {
    session.clear();
    window.dispatchEvent(new Event("dashbv:logout"));
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
  return data;
}
export function query(filters) {
  const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  return p.toString();
}
