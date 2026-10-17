// Mizan — connection to the Supabase database (accounts, data, receipt files)
// Only the PUBLISHABLE key goes here. Never put the secret / service_role key in the site.
const SUPABASE_URL = "https://cpphymyouugaqkufphcq.supabase.co";
const SUPABASE_KEY = "sb_publishable_Q_9Cn11tSC6hraPhQcQItg_oKMPD_8i";

let DB = (() => {
  const SESSION_KEY = "mizan_auth";
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) {}

  function keep(s) {
    session = s;
    try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function fromAuthResponse(d) {
    if (!d || !d.access_token) return null;
    return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: d.user };
  }
  async function readError(res) {
    let body = {}; try { body = await res.json(); } catch (e) {}
    const msg = body.msg || body.message || body.error_description || body.error || res.statusText;
    const err = new Error(msg); err.status = res.status; err.code = body.code || body.error_code; throw err;
  }

  async function token() {
    if (!session) return null;
    if (session.expires_at - 60 < Date.now() / 1000) {
      const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (!res.ok) { keep(null); return null; }
      keep(fromAuthResponse(await res.json()));
    }
    return session && session.access_token;
  }
  async function headers(extra) {
    const h = { apikey: SUPABASE_KEY, ...extra };
    const tk = await token();
    if (tk) h.Authorization = "Bearer " + tk;
    return h;
  }

  // ---------- Accounts ----------
  async function signUp(email, password) {
    const res = await fetch(SUPABASE_URL + "/auth/v1/signup", {
      method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) await readError(res);
    const s = fromAuthResponse(await res.json());
    if (!s) throw new Error("confirm_email");
    keep(s); return s.user;
  }
  async function signIn(email, password) {
    const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) await readError(res);
    const s = fromAuthResponse(await res.json()); keep(s); return s.user;
  }
  async function signOut() {
    try { await fetch(SUPABASE_URL + "/auth/v1/logout", { method: "POST", headers: await headers() }); } catch (e) {}
    keep(null);
  }
  async function user() { return (await token()) ? session.user : null; }

  // ---------- Tables ----------
  async function select(table, query) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + (query || "select=*"), { headers: await headers() });
    if (!res.ok) await readError(res);
    return res.json();
  }
  async function insert(table, row) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
      method: "POST", headers: await headers({ "Content-Type": "application/json", Prefer: "return=representation" }), body: JSON.stringify(row)
    });
    if (!res.ok) await readError(res);
    return (await res.json())[0];
  }
  async function update(table, id, changes) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: await headers({ "Content-Type": "application/json", Prefer: "return=representation" }), body: JSON.stringify(changes)
    });
    if (!res.ok) await readError(res);
    return (await res.json())[0];
  }
  async function remove(table, id) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: await headers() });
    if (!res.ok) await readError(res);
  }

  // ---------- Receipt files (private) ----------
  async function upload(bucket, path, blob) {
    const res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + path, {
      method: "POST", headers: await headers({ "Content-Type": blob.type || "application/octet-stream", "x-upsert": "true" }), body: blob
    });
    if (!res.ok) await readError(res);
    return path;
  }
  async function signedUrl(bucket, path, seconds) {
    const res = await fetch(SUPABASE_URL + "/storage/v1/object/sign/" + bucket + "/" + path, {
      method: "POST", headers: await headers({ "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn: seconds || 3600 })
    });
    if (!res.ok) await readError(res);
    const d = await res.json();
    return SUPABASE_URL + "/storage/v1" + (d.signedURL || d.signedUrl);
  }

  return { signUp, signIn, signOut, user, select, insert, update, remove, upload, signedUrl };
})();
