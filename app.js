// Mizan Nutrition — site logic (connected to the Supabase database via db.js)
// ===== Settings: change these =====
const WHATSAPP_NUMBER = "";   // your sister's WhatsApp, country code, no + or spaces, e.g. "9665XXXXXXXX"
// Bank transfer details shown to clients on the payment step
const BANK_NAME = "[اسم البنك]";
const ACCOUNT_NAME = "[اسم صاحبة الحساب]";
const IBAN = "SA00 0000 0000 0000 0000 0000";
const MATCH_RANGE = 150;      // a schedule "matches" a client if its calories are within ± this many kcal
const PACKAGES = {
  basic: { price: 250, nameKey: "pk_basic_name", workout: false },
  plus:  { price: 300, nameKey: "pk_plus_name",  workout: true  }
};
const MEALS = ["b", "l", "d", "s"]; // breakfast, lunch, dinner, snack

// ===== Small helpers =====
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function waLink(number, text) { return "https://wa.me/" + number + "?text=" + encodeURIComponent(text); }
function saudiNumber(phone) { const d = String(phone || "").replace(/\D/g, ""); return d.startsWith("0") ? "966" + d.slice(1) : d; }
function fmtDate(iso) {
  if (!iso) return t("ad_never");
  return new Date(iso).toLocaleDateString(LANG === "ar" ? "ar-SA-u-ca-gregory" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function friendlyError(e) {
  const m = String((e && e.message) || e || "");
  if (/already registered|already exists|user_already_exists/i.test(m)) return t("err_exists");
  if (/invalid login|invalid_credentials|invalid grant/i.test(m)) return t("pt_wrong");
  if (/password/i.test(m) && /6|short|weak/i.test(m)) return t("err_password");
  if (/failed to fetch|network/i.test(m)) return t("err_network");
  return t("err_generic");
}
function busy(btn, on) { if (!btn) return; btn.disabled = on; btn.classList.toggle("is-busy", on); }

// Read a receipt: photos are shrunk to keep them small, PDFs are kept as they are (max ~1.5 MB)
function readReceipt(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject("none");
    const reader = new FileReader();
    reader.onerror = () => reject("read");
    if (file.type === "application/pdf") {
      if (file.size > 1.5 * 1024 * 1024) return reject("big");
      reader.onload = () => resolve({ blob: file, data: reader.result, type: "pdf", ext: "pdf" });
      return reader.readAsDataURL(file);
    }
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1100 / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        const data = cv.toDataURL("image/jpeg", 0.75);
        cv.toBlob(blob => resolve({ blob, data, type: "image", ext: "jpg" }), "image/jpeg", 0.75);
      };
      img.onerror = () => reject("read");
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function uploadReceipt(userId, receipt) {
  const path = userId + "/receipt-" + Date.now() + "." + receipt.ext;
  await DB.upload("receipts", path, receipt.blob);
  return path;
}
function copyText(text, btn) {
  const done = () => { const old = btn.textContent; btn.textContent = t("tr_copied"); setTimeout(() => { btn.textContent = old; }, 1500); };
  try { navigator.clipboard.writeText(text).then(done, () => {}); } catch (e) {}
}

// ===== Recipes & schedules (cached after loading) =====
let SCHEDULES = [];
let CUSTOM_RECIPES = [];
async function loadSchedules() { SCHEDULES = await DB.select("schedules", "select=*&order=created_at.asc"); return SCHEDULES; }
async function loadRecipes() { CUSTOM_RECIPES = (await DB.select("recipes", "select=*&order=created_at.asc")).map(r => ({ ...r, custom: true })); }
function allRecipes() { return (typeof BUILTIN_RECIPES !== "undefined" ? BUILTIN_RECIPES : []).concat(CUSTOM_RECIPES); }
function recipeById(id) { return allRecipes().find(r => r.id === id); }
function rText(r, field) { const v = r[field]; return v == null ? "" : typeof v === "string" ? v : (v[LANG] || v.en || ""); }
function scheduleById(id) { return SCHEDULES.find(s => s.id === id); }

function dayTotal(day) { return MEALS.reduce((sum, m) => sum + ((recipeById(day[m]) || {}).kcal || 0), 0); }
function portionFactor(sched, day) {
  const total = dayTotal(day);
  if (!total) return 1;
  return Math.min(2, Math.max(0.5, Math.round((sched.kcal / total) * 4) / 4));
}
function matchingSchedules(kcal) {
  return SCHEDULES.filter(s => Math.abs(s.kcal - kcal) <= MATCH_RANGE).sort((a, b) => Math.abs(a.kcal - kcal) - Math.abs(b.kcal - kcal));
}
function slotKey(dayIndex, meal) { return dayIndex + "-" + meal; }
function planState(c, sched) {
  const prog = c.progress || {};
  const slots = [];
  sched.days.forEach((day, di) => MEALS.forEach(m => slots.push({ di, m, key: slotKey(di, m), recipe: recipeById(day[m]), status: prog[slotKey(di, m)] })));
  const next = slots.find(s => !s.status);
  const doneCount = slots.filter(s => s.status === "done").length;
  const handled = slots.filter(s => s.status).length;
  const dayIndex = next ? next.di : sched.days.length - 1;
  const factor = portionFactor(sched, sched.days[dayIndex]);
  const todaySlots = slots.filter(s => s.di === dayIndex);
  const todayKcal = todaySlots.filter(s => s.status === "done").reduce((sum, s) => sum + Math.round((s.recipe ? s.recipe.kcal : 0) * factor), 0);
  return { slots, next, doneCount, handled, total: slots.length, dayIndex, factor, todaySlots, todayKcal };
}

// ===== Calories (Mifflin-St Jeor) =====
function calcCalories(c) {
  const bmr = 10 * c.weight + 6.25 * c.height - 5 * c.age + (c.sex === "male" ? 5 : -161);
  let daily = bmr * c.activity;
  if (c.goal === "lose") daily = Math.max(daily - 500, c.sex === "male" ? 1500 : 1200);
  if (c.goal === "gain") daily += 300;
  return { bmr: Math.round(bmr / 10) * 10, kcal: Math.round(daily / 10) * 10 };
}

// ===== Home page =====
const waHero = $("wa-hero");
if (waHero) {
  waHero.addEventListener("click", e => {
    if (!WHATSAPP_NUMBER) { e.preventDefault(); waHero.textContent = t("err_wa"); return; }
    waHero.href = waLink(WHATSAPP_NUMBER, LANG === "ar" ? "مرحباً، أبغى أعرف عن باقات التغذية" : "Hi, I'd like to know about your nutrition packages");
  });
}

// ===== Start page (sign up + pay) =====
if ($("info-form")) {
  let client = {};
  let current = 1;
  const params = new URLSearchParams(location.search);
  let chosen = PACKAGES[params.get("package")] ? params.get("package") : "plus";

  function show(n) {
    current = n;
    document.querySelectorAll(".step").forEach(s => s.classList.remove("show"));
    $("step-" + n).classList.add("show");
    document.querySelectorAll("#progress span").forEach((s, i) => { s.className = i + 1 === n ? "active" : i + 1 < n ? "done" : ""; });
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (n === 4) $("pay-total").textContent = PACKAGES[chosen].price + " " + t("sar");
  }
  function markPackage() { document.querySelectorAll(".pick").forEach(p => p.classList.toggle("selected", p.dataset.package === chosen)); }
  document.querySelectorAll(".pick").forEach(p => p.addEventListener("click", () => { chosen = p.dataset.package; markPackage(); }));
  markPackage();
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => show(+b.dataset.go)));

  $("info-form").addEventListener("submit", e => {
    e.preventDefault();
    const required = ["f-name", "f-phone", "f-email", "f-password", "f-age", "f-height", "f-weight"];
    const bad = required.some(id => !$(id).value.trim()) || !$("f-email").validity.valid || $("f-password").value.length < 6;
    if (bad) { $("err-1").textContent = t("err_fill"); return; }
    if (!$("f-rule").checked) { $("err-1").textContent = t("err_rule"); return; }
    $("err-1").textContent = "";
    client = {
      name: $("f-name").value.trim(), phone: $("f-phone").value.trim(), email: $("f-email").value.trim().toLowerCase(),
      sex: document.querySelector("input[name=sex]:checked").value,
      age: +$("f-age").value, height: +$("f-height").value, weight: +$("f-weight").value,
      activity: +$("f-activity").value, goal: $("f-goal").value,
      health: $("f-health").value.trim(), food: $("f-food").value.trim(), agreed_inbody: true
    };
    const r = calcCalories(client);
    client.kcal = r.kcal; client.bmr = r.bmr;
    $("kcal").textContent = r.kcal.toLocaleString();
    $("bmr").textContent = r.bmr.toLocaleString();
    show(2);
  });

  // Bank transfer step
  $("bank-name").textContent = BANK_NAME;
  $("bank-holder").textContent = ACCOUNT_NAME;
  $("bank-iban").textContent = IBAN;
  $("copy-iban").addEventListener("click", () => copyText(IBAN.replace(/\s/g, ""), $("copy-iban")));
  $("copy-amount").addEventListener("click", () => copyText(String(PACKAGES[chosen].price), $("copy-amount")));
  let receipt = null;
  $("receipt").addEventListener("change", async () => {
    $("err-4").textContent = ""; receipt = null; $("receipt-preview").hidden = true;
    try {
      receipt = await readReceipt($("receipt").files[0]);
      if (receipt.type === "image") { $("receipt-preview").src = receipt.data; $("receipt-preview").hidden = false; }
    } catch (e) { $("err-4").textContent = t(e === "big" ? "err_receipt_big" : "err_receipt"); }
  });

  $("pay-btn").addEventListener("click", async () => {
    if (!receipt) { $("err-4").textContent = t("err_receipt"); return; }
    $("err-4").textContent = "";
    busy($("pay-btn"), true);
    try {
      // 1) create the account (or sign in if this email already signed up a moment ago)
      let user;
      try { user = await DB.signUp(client.email, $("f-password").value); }
      catch (e) {
        if (/already|exists/i.test(e.message)) user = await DB.signIn(client.email, $("f-password").value);
        else throw e;
      }
      // 2) upload the receipt to private storage
      const path = await uploadReceipt(user.id, receipt);
      // 3) save the client's profile
      const row = {
        id: user.id, ...client, package: chosen,
        receipt_path: path, receipt_type: receipt.type, receipt_sender: $("sender").value.trim(),
        receipt_amount: PACKAGES[chosen].price, receipt_date: new Date().toISOString(),
        progress: {}, inbody_requested: true
      };
      const existing = await DB.select("profiles", "select=id&id=eq." + user.id);
      if (existing.length) await DB.update("profiles", user.id, row); else await DB.insert("profiles", row);
      show(5);
    } catch (e) {
      $("err-4").textContent = friendlyError(e);
    } finally { busy($("pay-btn"), false); }
  });

  $("wa-send").addEventListener("click", e => {
    if (!WHATSAPP_NUMBER) { e.preventDefault(); $("err-5").textContent = t("err_wa"); return; }
    const msg = [
      (LANG === "ar" ? "طلب جديد — " : "New client — ") + t(PACKAGES[chosen].nameKey) + " (" + PACKAGES[chosen].price + " " + t("sar") + ")",
      t("f_name") + ": " + client.name, t("f_phone") + ": " + client.phone,
      t("f_age") + ": " + client.age + " | " + t("f_height") + ": " + client.height + " | " + t("f_weight") + ": " + client.weight,
      t("f_goal") + ": " + t("goal_" + client.goal), t("res_title") + ": " + client.kcal + " kcal",
      client.health ? t("f_health") + ": " + client.health : "", client.food ? t("f_food") + ": " + client.food : ""
    ].filter(Boolean).join("\n");
    $("wa-send").href = waLink(WHATSAPP_NUMBER, msg);
  });

  document.addEventListener("langchange", () => { if (current === 4) $("pay-total").textContent = PACKAGES[chosen].price + " " + t("sar"); });
}

// ===== Client portal (client home) =====
if ($("login-form")) {
  const statusIcon = { done: "✅", skip: "⏭️" };
  let me = null;

  async function refresh() {
    const u = await DB.user();
    if (!u) { me = null; return render(); }
    $("loading").hidden = false;
    try {
      const rows = await DB.select("profiles", "select=*&id=eq." + u.id);
      me = rows[0] || null;
      if (me && me.role === "admin") { location.href = "admin.html"; return; }
      await Promise.all([loadSchedules(), loadRecipes()]);
    } catch (e) { me = null; $("login-err").textContent = friendlyError(e); }
    $("loading").hidden = true;
    render();
  }
  async function updateMe(changes) {
    me = await DB.update("profiles", me.id, changes);
    render();
  }

  function render() {
    const c = me;
    $("login-view").hidden = !!c;
    $("dash-view").hidden = !c;
    if (!c) return;
    $("d-name").textContent = (c.name || "").split(" ")[0];
    $("ib-alert").hidden = !c.inbody_requested;
    const sched = c.schedule_id && scheduleById(c.schedule_id);
    $("v-wait").hidden = !!c.paid;
    $("wait-rejected").hidden = c.pay_status !== "rejected";
    $("wait-pending").hidden = c.pay_status === "rejected";
    $("v-choose").hidden = !(c.paid && !sched);
    $("v-plan").hidden = !(c.paid && sched);
    if (c.paid && !sched) renderChoose(c);
    if (c.paid && sched) renderPlan(c, sched);
  }

  function renderChoose(c) {
    $("c-kcal").textContent = (c.kcal || 0).toLocaleString();
    const list = matchingSchedules(c.kcal);
    $("no-match").hidden = list.length > 0;
    $("sched-options").innerHTML = list.map(s => {
      const d1 = s.days[0];
      const meals = MEALS.map(m => { const r = recipeById(d1[m]); return r ? "<li><b>" + esc(t("meal_" + m)) + ":</b> " + esc(rText(r, "name")) + "</li>" : ""; }).join("");
      return '<div class="card sched-card"><h3>' + esc(s.name) + '</h3><p class="stat">' + s.kcal.toLocaleString() + " <small>" + esc(t("kcal_short")) + "</small></p>" +
        '<p class="muted">' + s.days.length + " " + esc(t("ad_days")) + "</p><p class='small-label muted'>" + esc(t("pt_day1")) + "</p><ul class='mini-meals'>" + meals + "</ul>" +
        '<button class="btn" data-pick="' + esc(s.id) + '">' + esc(t("pt_start_sched")) + "</button></div>";
    }).join("");
    document.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", async () => {
      busy(b, true); try { await updateMe({ schedule_id: b.dataset.pick, progress: {} }); } finally { busy(b, false); }
    }));
  }

  function renderPlan(c, sched) {
    const st = planState(c, sched);
    $("p-day").textContent = st.dayIndex + 1;
    $("p-days").textContent = sched.days.length;
    $("p-done").textContent = st.doneCount;
    $("p-total").textContent = st.total;
    $("p-kcal").textContent = st.todayKcal.toLocaleString();
    $("p-target").textContent = sched.kcal.toLocaleString();
    $("p-bar").style.width = Math.round((st.handled / st.total) * 100) + "%";
    $("p-sched").textContent = sched.name;
    $("workout-card").hidden = !(PACKAGES[c.package] && PACKAGES[c.package].workout);
    $("next-card").hidden = !st.next;
    $("finished-card").hidden = !!st.next;
    if (st.next && st.next.recipe) {
      const r = st.next.recipe;
      $("n-type").textContent = t("meal_" + st.next.m);
      $("n-name").textContent = rText(r, "name");
      $("n-kcal").textContent = Math.round(r.kcal * st.factor);
      $("n-protein").textContent = Math.round((r.protein || 0) * st.factor);
      $("n-portion").textContent = st.factor !== 1 ? "· " + t("pt_portion") + " ×" + st.factor : "";
      $("n-ing").textContent = rText(r, "ing");
      $("n-steps").textContent = rText(r, "steps");
    }
    $("today-list").innerHTML = st.todaySlots.map(s => {
      const label = s.status === "done" ? t("st_done") : s.status === "skip" ? t("st_skipped") : st.next && s.key === st.next.key ? t("st_next") : t("st_later");
      const cls = s.status ? "is-" + s.status : st.next && s.key === st.next.key ? "is-next" : "";
      return '<li class="' + cls + '"><span class="icon">' + (statusIcon[s.status] || "🍽️") + "</span><span class='grow'><b>" + esc(t("meal_" + s.m)) + "</b> — " +
        esc(s.recipe ? rText(s.recipe, "name") : "") + "</span><span class='tag'>" + esc(label) + "</span></li>";
    }).join("");
  }

  async function mark(status, btn) {
    const sched = scheduleById(me.schedule_id); const st = planState(me, sched);
    if (!st.next) return;
    busy(btn, true);
    try { await updateMe({ progress: { ...(me.progress || {}), [st.next.key]: status } }); } finally { busy(btn, false); }
  }
  $("done-btn").addEventListener("click", () => mark("done", $("done-btn")));
  $("skip-btn").addEventListener("click", () => mark("skip", $("skip-btn")));

  $("ib-submit").addEventListener("click", async () => {
    const num = id => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
    busy($("ib-submit"), true);
    try {
      await DB.insert("inbody", { user_id: me.id, weight: num("ib-weight"), fat: num("ib-fat"), muscle: num("ib-muscle") });
      await updateMe({ inbody_requested: false });
      $("ib-thanks").hidden = false;
    } catch (e) { alert(friendlyError(e)); } finally { busy($("ib-submit"), false); }
  });

  $("re-send").addEventListener("click", async () => {
    let r;
    try { r = await readReceipt($("re-receipt").files[0]); } catch (e) { $("re-err").textContent = t(e === "big" ? "err_receipt_big" : "err_receipt"); return; }
    $("re-err").textContent = "";
    busy($("re-send"), true);
    try {
      const path = await uploadReceipt(me.id, r);
      await updateMe({ receipt_path: path, receipt_type: r.type, receipt_date: new Date().toISOString(), pay_status: "pending" });
    } catch (e) { $("re-err").textContent = friendlyError(e); } finally { busy($("re-send"), false); }
  });

  $("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = $("login-form").querySelector("button");
    busy(btn, true); $("login-err").textContent = "";
    try { await DB.signIn($("l-email").value.trim().toLowerCase(), $("l-password").value); await refresh(); }
    catch (err) { $("login-err").textContent = friendlyError(err); }
    finally { busy(btn, false); }
  });

  $("logout-btn").addEventListener("click", async () => { await DB.signOut(); me = null; render(); });
  document.addEventListener("langchange", render);
  refresh();
}

// Example schedules, added automatically the first time the dietitian signs in (she can delete them)
const DEMO_SCHEDULES = () => {
  const week = pattern => Array.from({ length: 7 }, (_, i) => pattern[i % pattern.length]);
  return [
    { name: "نزول وزن ١٢٥٠", kcal: 1250, days: week([{ b: "b5", l: "l4", d: "d5", s: "s5" }, { b: "b3", l: "l3", d: "d4", s: "s4" }]) },
    { name: "نزول وزن ١٤٥٠", kcal: 1450, days: week([{ b: "b1", l: "l4", d: "d1", s: "s1" }, { b: "b5", l: "l2", d: "d4", s: "s3" }, { b: "b3", l: "l3", d: "d5", s: "s2" }]) },
    { name: "محافظة ١٨٠٠", kcal: 1800, days: week([{ b: "b2", l: "l1", d: "d3", s: "s2" }, { b: "b4", l: "l5", d: "d2", s: "s1" }]) }
  ];
};

// ===== Dietitian page =====
if ($("admin-login")) {
  let editing = null;
  let recipeFilter = "all";
  let openClient = null;
  let deleteArmed = null;
  let CLIENTS = [];
  let signupMode = false;

  function msg(text) { $("admin-msg").textContent = text; $("admin-msg").hidden = !text; }

  async function gate() {
    const u = await DB.user();
    let profile = null;
    if (u) { try { profile = (await DB.select("profiles", "select=*&id=eq." + u.id))[0]; } catch (e) {} }
    const isAdmin = profile && profile.role === "admin";
    $("pin-view").hidden = !!u;
    $("not-admin").hidden = !(u && !isAdmin);
    $("admin-view").hidden = !isAdmin;
    if (!isAdmin) return;
    $("loading").hidden = false;
    await Promise.all([loadSchedules(), loadRecipes(), loadClients()]);
    if (!SCHEDULES.length) { for (const s of DEMO_SCHEDULES()) await DB.insert("schedules", s); await loadSchedules(); }
    $("loading").hidden = true;
    renderAll();
  }
  async function loadClients() { CLIENTS = await DB.select("profiles", "select=*&role=eq.client&order=created_at.desc"); }

  $("toggle-signup").addEventListener("click", () => {
    signupMode = !signupMode;
    $("a-name-field").hidden = !signupMode;
    $("admin-submit").textContent = t(signupMode ? "ad_create" : "ad_enter");
    $("toggle-signup").textContent = t(signupMode ? "ad_have_account" : "ad_need_account");
  });
  $("admin-login").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("a-email").value.trim().toLowerCase(), pw = $("a-password").value;
    $("pin-err").textContent = "";
    busy($("admin-submit"), true);
    try {
      if (signupMode) {
        if (!$("a-name").value.trim() || pw.length < 6) { $("pin-err").textContent = t("err_fill"); return; }
        const u = await DB.signUp(email, pw);
        await DB.insert("profiles", { id: u.id, name: $("a-name").value.trim(), email });
      } else {
        await DB.signIn(email, pw);
      }
      await gate();
    } catch (err) { $("pin-err").textContent = friendlyError(err); }
    finally { busy($("admin-submit"), false); }
  });
  document.querySelectorAll(".admin-logout").forEach(b => b.addEventListener("click", async () => { await DB.signOut(); gate(); }));

  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab-panel").forEach(p => { p.hidden = p.id !== "tab-" + b.dataset.tab; });
    msg("");
  }));

  // ---- Schedules ----
  function renderSchedules() {
    $("no-sched").hidden = SCHEDULES.length > 0;
    const cards = SCHEDULES.map(s => {
      const users = CLIENTS.filter(c => c.schedule_id === s.id).length;
      const match = CLIENTS.filter(c => Math.abs((c.kcal || 0) - s.kcal) <= MATCH_RANGE).length;
      return '<div class="card sched-card"><h3>' + esc(s.name) + '</h3><p class="stat">' + s.kcal.toLocaleString() + " <small>" + esc(t("kcal_short")) + "</small></p>" +
        "<p class='muted'>" + s.days.length + " " + esc(t("ad_days")) + " · " + users + " " + esc(t("ad_clients_on")) + " · " + match + " " + esc(t("ad_matching")) + "</p>" +
        '<button class="btn outline small" data-del="' + esc(s.id) + '">' + esc(t(deleteArmed === s.id ? "ad_confirm_delete" : "ad_delete")) + "</button></div>";
    }).join("");
    $("sched-list").innerHTML = '<button class="add-card" id="add-sched-btn"><span class="plus">+</span><span>' + esc(t("ad_new_sched")) + "</span></button>" + cards;
    $("add-sched-btn").addEventListener("click", openEditor);
    document.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (deleteArmed !== b.dataset.del) { deleteArmed = b.dataset.del; renderSchedules(); return; }
      busy(b, true);
      try { await DB.remove("schedules", b.dataset.del); deleteArmed = null; await loadSchedules(); renderSchedules(); }
      catch (e) { msg(friendlyError(e)); busy(b, false); }
    }));
  }
  function openEditor() {
    editing = { days: [] };
    $("s-name").value = "";
    resizeDays();
    $("sched-editor").hidden = false;
    $("sched-err").textContent = "";
    $("sched-editor").scrollIntoView({ behavior: "smooth" });
  }
  function resizeDays() {
    const n = Math.min(14, Math.max(1, +$("s-days").value || 7));
    while (editing.days.length < n) editing.days.push({ b: "", l: "", d: "", s: "" });
    editing.days.length = n;
    renderDaysEditor();
  }
  function renderDaysEditor() {
    if (!editing) return;
    const target = +$("s-kcal").value || 0;
    const recipes = allRecipes();
    $("days-editor").innerHTML = editing.days.map((day, di) => {
      const total = dayTotal(day);
      const f = total ? portionFactor({ kcal: target }, day) : 1;
      const selects = MEALS.map(m => {
        const opts = recipes.filter(r => r.meal === m).map(r => '<option value="' + esc(r.id) + '"' + (day[m] === r.id ? " selected" : "") + ">" + esc(rText(r, "name")) + " (" + r.kcal + ")</option>").join("");
        return '<div class="field"><label for="sel-' + di + "-" + m + '">' + esc(t("meal_" + m)) + '</label><select id="sel-' + di + "-" + m + '" data-day="' + di + '" data-meal="' + m + '"><option value="">' + esc(t("ad_choose")) + "</option>" + opts + "</select></div>";
      }).join("");
      return '<div class="day-box"><div class="day-head"><b>' + esc(t("pt_day")) + " " + (di + 1) + "</b><span class='muted'>" + esc(t("ad_day_total")) + ": " + total + (total ? " → ×" + f + " = " + Math.round(total * f) : "") + " " + esc(t("kcal_short")) + "</span></div><div class='form-grid'>" + selects + "</div></div>";
    }).join("");
    document.querySelectorAll("#days-editor select").forEach(s => s.addEventListener("change", () => { editing.days[+s.dataset.day][s.dataset.meal] = s.value; renderDaysEditor(); }));
  }
  function autofill() {
    const target = +$("s-kcal").value || 1500;
    const by = m => allRecipes().filter(r => r.meal === m);
    editing.days = editing.days.map((_, di) => {
      let best = null, bestDiff = Infinity;
      for (let tries = 0; tries < 60; tries++) {
        const day = {};
        MEALS.forEach(m => { const list = by(m); day[m] = list.length ? list[(di + tries * (MEALS.indexOf(m) + 1)) % list.length].id : ""; });
        const diff = Math.abs(dayTotal(day) - target);
        if (diff < bestDiff) { best = day; bestDiff = diff; }
      }
      return best;
    });
    renderDaysEditor();
  }
  $("s-days").addEventListener("input", () => editing && resizeDays());
  $("s-kcal").addEventListener("input", renderDaysEditor);
  $("autofill-btn").addEventListener("click", autofill);
  $("cancel-sched").addEventListener("click", () => { editing = null; $("sched-editor").hidden = true; });
  $("save-sched").addEventListener("click", async () => {
    const name = $("s-name").value.trim(), kcal = +$("s-kcal").value;
    const complete = editing.days.every(d => MEALS.every(m => d[m]));
    if (!name || !kcal || !complete) { $("sched-err").textContent = t("err_sched"); return; }
    busy($("save-sched"), true);
    try {
      await DB.insert("schedules", { name, kcal, days: editing.days.map(d => ({ ...d })) });
      await loadSchedules();
      editing = null; $("sched-editor").hidden = true;
      renderSchedules(); msg(t("ad_saved"));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { $("sched-err").textContent = friendlyError(e); } finally { busy($("save-sched"), false); }
  });

  // ---- Recipes ----
  function renderRecipes() {
    const filters = ["all"].concat(MEALS);
    $("recipe-filter").innerHTML = filters.map(f => '<button class="chip' + (recipeFilter === f ? " active" : "") + '" data-f="' + f + '">' + esc(f === "all" ? t("ad_all") : t("meal_" + f)) + "</button>").join("");
    document.querySelectorAll("[data-f]").forEach(b => b.addEventListener("click", () => { recipeFilter = b.dataset.f; renderRecipes(); }));
    const list = allRecipes().filter(r => recipeFilter === "all" || r.meal === recipeFilter);
    $("recipe-grid").innerHTML = list.map(r =>
      '<div class="card recipe"><p class="meal-type">' + esc(t("meal_" + r.meal)) + (r.custom ? " · " + esc(t("ad_custom")) : "") + "</p><h4>" + esc(rText(r, "name")) + "</h4>" +
      "<p class='meal-meta'><b>" + r.kcal + "</b> " + esc(t("kcal_short")) + " · " + (r.protein || 0) + " " + esc(t("protein_short")) + "</p>" +
      "<details><summary>" + esc(t("pt_ingredients")) + "</summary><p>" + esc(rText(r, "ing")) + "</p><p class='muted'>" + esc(rText(r, "steps")) + "</p></details></div>"
    ).join("");
  }
  $("save-recipe").addEventListener("click", async () => {
    const name = $("r-name").value.trim(), kcal = +$("r-kcal").value;
    if (!name || !kcal) { $("recipe-err").textContent = t("err_recipe"); return; }
    $("recipe-err").textContent = "";
    busy($("save-recipe"), true);
    try {
      await DB.insert("recipes", { id: "c" + Date.now(), meal: $("r-meal").value, kcal, protein: +$("r-protein").value || 0, name, ing: $("r-ing").value.trim(), steps: $("r-steps").value.trim() });
      await loadRecipes();
      ["r-name", "r-kcal", "r-protein", "r-ing", "r-steps"].forEach(id => { $(id).value = ""; });
      recipeFilter = "all"; renderRecipes(); msg(t("ad_recipe_saved"));
    } catch (e) { $("recipe-err").textContent = friendlyError(e); } finally { busy($("save-recipe"), false); }
  });

  // ---- Clients ----
  function clientById(id) { return CLIENTS.find(c => c.id === id); }
  function renderClients() {
    $("no-clients").hidden = CLIENTS.length > 0;
    $("clients-list").hidden = !!openClient;
    $("client-detail").hidden = !openClient;
    if (openClient) return renderDetail();
    if (!CLIENTS.length) { $("clients-table").innerHTML = ""; return; }
    $("clients-table").innerHTML = "<tr><th>" + [t("ad_c_name"), t("ad_c_target"), t("pt_package"), t("pt_status"), t("ad_c_plan"), t("ad_c_progress"), "InBody", ""].map(esc).join("</th><th>") + "</th></tr>" +
      CLIENTS.map(c => {
        const sched = scheduleById(c.schedule_id);
        const prog = sched ? Math.round(planState(c, sched).handled / (sched.days.length * MEALS.length) * 100) + "%" : "—";
        const opts = '<option value="">' + esc(t("ad_client_choice")) + "</option>" + SCHEDULES.map(s => '<option value="' + esc(s.id) + '"' + (c.schedule_id === s.id ? " selected" : "") + ">" + esc(s.name) + " (" + s.kcal + ")</option>").join("");
        const pay = c.paid ? esc(t("ad_paid"))
          : c.pay_status === "rejected" ? '<span class="status-pill bad">' + esc(t("tr_rejected")) + "</span>"
          : '<button class="btn small" data-open="' + esc(c.id) + '">' + esc(t("ad_view_receipt")) + "</button>";
        const ib = c.inbody_requested ? '<span class="status-pill">' + esc(t("ib_requested")) + "</span>" : "✓";
        const pk = PACKAGES[c.package] ? t(PACKAGES[c.package].nameKey) : "—";
        return "<tr><td>" + esc(c.name) + "</td><td>" + (c.kcal || "—") + "</td><td>" + esc(pk) + "</td><td>" + pay + "</td><td><select data-assign='" + esc(c.id) + "'>" + opts + "</select></td><td>" + prog + "</td><td>" + ib + '</td><td><button class="btn outline small" data-open="' + esc(c.id) + '">' + esc(t("ad_open")) + "</button></td></tr>";
      }).join("");
    document.querySelectorAll("[data-assign]").forEach(s => s.addEventListener("change", async () => {
      try { await DB.update("profiles", s.dataset.assign, { schedule_id: s.value || null, progress: {} }); await loadClients(); renderClients(); } catch (e) { msg(friendlyError(e)); }
    }));
    document.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => { openClient = b.dataset.open; renderClients(); }));
    updateBadge();
  }

  async function renderDetail() {
    const c = clientById(openClient);
    if (!c) { openClient = null; return renderClients(); }
    $("cd-name").textContent = c.name;
    const rows = [
      [t("f_phone"), c.phone], [t("f_email"), c.email], [t("f_age"), c.age], [t("f_height"), c.height], [t("f_weight"), c.weight],
      [t("f_goal"), c.goal ? t("goal_" + c.goal) : "—"], [t("ad_c_target"), (c.kcal || "—") + " " + t("kcal_short")],
      [t("pt_package"), PACKAGES[c.package] ? t(PACKAGES[c.package].nameKey) : "—"], [t("f_health"), c.health || "—"], [t("f_food"), c.food || "—"]
    ];
    $("cd-info").innerHTML = rows.map(r => "<div><span class='muted small-label'>" + esc(r[0]) + "</span><div>" + esc(r[1]) + "</div></div>").join("");
    $("wa-client").href = waLink(saudiNumber(c.phone), (LANG === "ar" ? "مرحباً " : "Hi ") + (c.name || "").split(" ")[0] + "، " + t("ib_alert_text"));
    $("cd-ib-pending").hidden = !c.inbody_requested;

    // payment review
    $("cd-pay").hidden = !!c.paid;
    if (!c.paid) {
      $("cd-pay-info").innerHTML = c.receipt_path ? "<p><b>" + esc(t("ad_amount")) + ":</b> " + (c.receipt_amount || "—") + " " + esc(t("sar")) + " · <b>" + esc(t("ad_sender")) + ":</b> " + esc(c.receipt_sender || "—") + " · <b>" + esc(t("ad_sent_at")) + ":</b> " + esc(fmtDate(c.receipt_date)) + "</p>" : "";
      $("cd-pay-actions").hidden = c.pay_status === "rejected" || !c.receipt_path;
      $("cd-receipt").innerHTML = c.receipt_path ? "<p class='muted'>…</p>" : "<p class='muted'>" + esc(t("ad_no_receipt")) + "</p>";
      if (c.receipt_path) {
        try {
          const url = await DB.signedUrl("receipts", c.receipt_path, 3600);
          $("cd-receipt").innerHTML = c.receipt_type === "pdf"
            ? '<a class="btn outline small" href="' + esc(url) + '" target="_blank" rel="noopener">📄 ' + esc(t("ad_open_file")) + "</a>"
            : '<a href="' + esc(url) + '" target="_blank" rel="noopener"><img class="receipt-full" src="' + esc(url) + '" alt="' + esc(t("ad_receipt")) + '"></a>';
        } catch (e) { $("cd-receipt").innerHTML = "<p class='error'>" + esc(friendlyError(e)) + "</p>"; }
      }
    }

    // InBody history
    try {
      const ibs = await DB.select("inbody", "select=*&user_id=eq." + c.id + "&order=date.desc");
      $("cd-ib-last").textContent = fmtDate(ibs.length ? ibs[0].date : null);
      $("cd-ib-none").hidden = ibs.length > 0;
      $("cd-ib-table").innerHTML = ibs.length ? "<tr><th>" + ["", t("ib_weight"), t("ib_fat"), t("ib_muscle")].map(esc).join("</th><th>") + "</th></tr>" +
        ibs.map(i => "<tr><td>" + esc(fmtDate(i.date)) + "</td><td>" + (i.weight ?? "—") + "</td><td>" + (i.fat ?? "—") + "</td><td>" + (i.muscle ?? "—") + "</td></tr>").join("") : "";
    } catch (e) {}
  }
  async function changeClient(changes, text) {
    try { await DB.update("profiles", openClient, changes); await loadClients(); await renderDetail(); updateBadge(); if (text) msg(text); }
    catch (e) { msg(friendlyError(e)); }
  }
  $("detail-back").addEventListener("click", () => { openClient = null; msg(""); renderClients(); });
  $("confirm-pay").addEventListener("click", () => changeClient({ paid: true, pay_status: "confirmed" }));
  $("reject-pay").addEventListener("click", () => changeClient({ pay_status: "rejected" }));
  $("send-ib").addEventListener("click", () => changeClient({ inbody_requested: true, inbody_requested_at: new Date().toISOString() }, t("ad_ib_sent")));
  $("refresh-btn").addEventListener("click", async () => { busy($("refresh-btn"), true); await Promise.all([loadClients(), loadSchedules(), loadRecipes()]); renderAll(); busy($("refresh-btn"), false); });

  function updateBadge() {
    const n = CLIENTS.filter(c => !c.paid && c.pay_status === "pending" && c.receipt_path).length;
    document.querySelector('.tab[data-tab="clients"]').textContent = t("tab_clients") + (n ? " (" + n + ")" : "");
  }
  function renderAll() { renderSchedules(); renderRecipes(); renderClients(); renderDaysEditor(); updateBadge(); }
  document.addEventListener("langchange", () => { if (!$("admin-view").hidden) renderAll(); });
  gate();
}

// ===== App (PWA): offline support + install button =====
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
(function installBanner() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem("mizan_install_closed") === "1"; } catch (e) {}
  if (standalone || dismissed || window.top !== window) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const bar = document.createElement("div");
  bar.className = "install-bar";
  bar.hidden = true;
  bar.innerHTML = '<img src="icon-192.png" alt="" width="40" height="40"><span class="grow" data-i18n="' + (isIOS ? "app_ios" : "app_install") + '"></span>' +
    (isIOS ? "" : '<button class="btn small" id="install-btn" data-i18n="app_install"></button>') +
    '<button class="install-close" id="install-close" aria-label="Close">×</button>';
  const main = document.querySelector("main");
  if (!main) return;
  main.prepend(bar);
  const tr = () => bar.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  tr(); document.addEventListener("langchange", tr);
  bar.querySelector("#install-close").addEventListener("click", () => { bar.hidden = true; try { localStorage.setItem("mizan_install_closed", "1"); } catch (e) {} });
  if (isIOS) { bar.hidden = false; return; }
  let promptEvent = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); promptEvent = e; bar.hidden = false; });
  bar.querySelector("#install-btn").addEventListener("click", async () => {
    if (!promptEvent) return;
    promptEvent.prompt(); await promptEvent.userChoice; promptEvent = null; bar.hidden = true;
  });
  window.addEventListener("appinstalled", () => { bar.hidden = true; });
})();
