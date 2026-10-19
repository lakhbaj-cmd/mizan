// Mizan Nutrition — site logic (connected to the Supabase database via db.js)
// ===== Settings: change these =====
const WHATSAPP_NUMBER = "";   // your sister's WhatsApp, country code, no + or spaces, e.g. "9665XXXXXXXX"
// Bank transfer details shown to clients on the payment step
const BANK_NAME = "[اسم البنك]";
const ACCOUNT_NAME = "[اسم صاحبة الحساب]";
const IBAN = "SA00 0000 0000 0000 0000 0000";
// Payment switch: false = clients sign up without paying (for testing). Set to true to turn bank-transfer payment back on.
const PAYMENT_ENABLED = false;
const isPaid = c => !!c && (c.paid || !PAYMENT_ENABLED);
const MATCH_RANGE = 150;      // a schedule "matches" a client if its calories are within ± this many kcal
const PACKAGES = {
  basic: { price: 250, nameKey: "pk_basic_name", workout: false },
  plus:  { price: 300, nameKey: "pk_plus_name",  workout: true  }
};

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

// ===== Recipes & day plans (cached after loading) =====
// A day has 5 meals: breakfast, snack 1, lunch, snack 2, dinner
const SLOTS = ["b", "s1", "l", "s2", "d"];
const SLOT_MEAL = { b: "b", s1: "s", l: "l", s2: "s", d: "d" };   // which recipe type fits each slot
let SCHEDULES = [];      // ready one-day plans made by the dietitian
let CUSTOM_RECIPES = [];
async function loadSchedules() { SCHEDULES = await DB.select("schedules", "select=*&order=kcal.asc"); return SCHEDULES; }
async function loadRecipes() { CUSTOM_RECIPES = (await DB.select("recipes", "select=*&order=created_at.asc")).map(r => ({ ...r, custom: true })); }
function allRecipes() { return (typeof BUILTIN_RECIPES !== "undefined" ? BUILTIN_RECIPES : []).concat(CUSTOM_RECIPES); }
function recipeById(id) { return allRecipes().find(r => r.id === id); }
function rText(r, field) { const v = r[field]; return v == null ? "" : typeof v === "string" ? v : (v[LANG] || v.en || ""); }
function recipesFor(slot) { return allRecipes().filter(r => r.meal === SLOT_MEAL[slot]); }
function slotLabel(slot) { return t("meal_" + slot); }
function tplMeals(s) { return (s.days && s.days[0]) || {}; }
function mealsTotal(meals) { return SLOTS.reduce((sum, k) => sum + ((recipeById(meals[k]) || {}).kcal || 0), 0); }
// Portion factor so the day reaches the calorie target (rounded to ¼, between ½ and 2)
function portionFactor(target, meals) {
  const total = mealsTotal(meals);
  if (!total || !target) return 1;
  return Math.min(2, Math.max(0.5, Math.round((target / total) * 4) / 4));
}
function matchingTemplates(kcal) {
  return SCHEDULES.filter(s => Math.abs(s.kcal - kcal) <= MATCH_RANGE).sort((a, b) => Math.abs(a.kcal - kcal) - Math.abs(b.kcal - kcal));
}
function mealNamesHTML(meals) {
  return "<ul class='mini-meals'>" + SLOTS.map(k => { const r = recipeById(meals[k]); return r ? "<li><b>" + esc(slotLabel(k)) + ":</b> " + esc(rText(r, "name")) + "</li>" : ""; }).join("") + "</ul>";
}
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
// Where the client is today
function dayState(c) {
  const today = c.today && c.today.date === todayStr() ? c.today : null;
  const plan = today ? (c.plans || [])[today.plan] : null;
  if (!plan) return null;
  const prog = today.progress || {};
  const factor = portionFactor(plan.kcal, plan.meals);
  const slots = SLOTS.map(k => ({ k, recipe: recipeById(plan.meals[k]), status: prog[k] }));
  const next = slots.find(s => !s.status);
  const done = slots.filter(s => s.status === "done").length;
  const handled = slots.filter(s => s.status).length;
  const kcal = slots.filter(s => s.status === "done").reduce((sum, s) => sum + Math.round((s.recipe ? s.recipe.kcal : 0) * factor), 0);
  return { today, plan, factor, slots, next, done, handled, kcal };
}

// ===== Calories =====
// Without InBody: Mifflin-St Jeor (height, weight, age).
// With InBody (more accurate): the BMR printed on the InBody report, or Katch-McArdle from body fat %:
//   BMR = 370 + 21.6 × lean body mass (kg), lean mass = weight × (1 − fat%)
function calcCalories(c, ib) {
  let bmr = 10 * c.weight + 6.25 * c.height - 5 * c.age + (c.sex === "male" ? 5 : -161);
  let method = "std";
  if (ib && ib.bmr) { bmr = ib.bmr; method = "ib"; }
  else if (ib && ib.fat) { bmr = 370 + 21.6 * c.weight * (1 - ib.fat / 100); method = "ib"; }
  let daily = bmr * c.activity;
  if (c.goal === "lose") daily = Math.max(daily - 500, c.sex === "male" ? 1500 : 1200);
  if (c.goal === "gain") daily += 300;
  return { bmr: Math.round(bmr / 10) * 10, kcal: Math.round(daily / 10) * 10, method };
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
  let ibData = null;       // InBody results typed at sign-up (optional)
  let current = 1;
  document.querySelectorAll("input[name=ibmode]").forEach(r => r.addEventListener("change", () => {
    $("ib-fields").hidden = document.querySelector("input[name=ibmode]:checked").value !== "with";
  }));
  const params = new URLSearchParams(location.search);
  let chosen = PACKAGES[params.get("package")] ? params.get("package") : "plus";

  function show(n) {
    current = n;
    document.querySelectorAll(".step").forEach(s => s.classList.remove("show"));
    $("step-" + n).classList.add("show");
    document.querySelectorAll("#progress span").forEach(s => { const k = +s.dataset.step; s.className = k === n ? "active" : k < n ? "done" : ""; });
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (n === 4) $("pay-total").textContent = PACKAGES[chosen].price + " " + t("sar");
  }
  function markPackage() { document.querySelectorAll(".pick").forEach(p => p.classList.toggle("selected", p.dataset.package === chosen)); }
  document.querySelectorAll(".pick").forEach(p => p.addEventListener("click", () => { chosen = p.dataset.package; markPackage(); }));
  markPackage();
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => { if (b.dataset.go) show(+b.dataset.go); }));

  $("info-form").addEventListener("submit", e => {
    e.preventDefault();
    const required = ["f-name", "f-phone", "f-email", "f-password", "f-age", "f-height", "f-weight"];
    const bad = required.some(id => !$(id).value.trim()) || !$("f-email").validity.valid || $("f-password").value.length < 6;
    if (bad) { $("err-1").textContent = t("err_fill"); return; }
    const withIb = document.querySelector("input[name=ibmode]:checked").value === "with";
    const num = id => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
    ibData = withIb ? { fat: num("f-ib-fat"), muscle: num("f-ib-muscle"), bmr: num("f-ib-bmr") } : null;
    if (withIb && !ibData.fat && !ibData.bmr) { $("err-1").textContent = t("err_ib_fat"); return; }
    $("err-1").textContent = "";
    client = {
      name: $("f-name").value.trim(), phone: $("f-phone").value.trim(), email: $("f-email").value.trim().toLowerCase(),
      sex: document.querySelector("input[name=sex]:checked").value,
      age: +$("f-age").value, height: +$("f-height").value, weight: +$("f-weight").value,
      activity: +$("f-activity").value, goal: $("f-goal").value,
      health: $("f-health").value.trim(), food: $("f-food").value.trim(), agreed_inbody: withIb
    };
    // calories are set by the dietitian after she reviews the client
    show(3);
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

  // create the account + profile (with the receipt when payment is on)
  async function createAccount(btn, errEl) {
    if (PAYMENT_ENABLED && !receipt) { errEl.textContent = t("err_receipt"); return; }
    errEl.textContent = "";
    busy(btn, true);
    try {
      let user;
      try { user = await DB.signUp(client.email, $("f-password").value); }
      catch (e) {
        if (/already|exists/i.test(e.message)) user = await DB.signIn(client.email, $("f-password").value);
        else throw e;
      }
      const row = { id: user.id, ...client, package: chosen, progress: {}, inbody_requested: false };
      if (PAYMENT_ENABLED) {
        row.receipt_path = await uploadReceipt(user.id, receipt);
        Object.assign(row, { receipt_type: receipt.type, receipt_sender: $("sender").value.trim(), receipt_amount: PACKAGES[chosen].price, receipt_date: new Date().toISOString() });
      }
      const existing = await DB.select("profiles", "select=id&id=eq." + user.id);
      if (existing.length) await DB.update("profiles", user.id, row); else await DB.insert("profiles", row);
      if (ibData) await DB.insert("inbody", { user_id: user.id, weight: client.weight, fat: ibData.fat, muscle: ibData.muscle, bmr: ibData.bmr });
      show(5);
    } catch (e) {
      errEl.textContent = friendlyError(e);
    } finally { busy(btn, false); }
  }
  $("pay-btn").addEventListener("click", () => createAccount($("pay-btn"), $("err-4")));

  // payment off: the package step creates the account directly
  if (!PAYMENT_ENABLED) {
    const nextBtn = document.querySelector('#step-3 [data-go="4"]');
    nextBtn.removeAttribute("data-go");
    nextBtn.dataset.i18n = "btn_create_account";
    nextBtn.id = "create-btn";
    const err = document.createElement("p"); err.className = "error"; err.id = "err-3";
    nextBtn.closest(".actions").before(err);
    nextBtn.addEventListener("click", () => createAccount(nextBtn, err));
    const paySpan = document.querySelector('#progress span[data-step="4"]'); if (paySpan) paySpan.remove();
    document.querySelector('#step-5 [data-i18n="tr_done_text"]').dataset.i18n = "done_text_free";
  }

  $("wa-send").addEventListener("click", e => {
    if (!WHATSAPP_NUMBER) { e.preventDefault(); $("err-5").textContent = t("err_wa"); return; }
    const msg = [
      (LANG === "ar" ? "طلب جديد — " : "New client — ") + t(PACKAGES[chosen].nameKey) + " (" + PACKAGES[chosen].price + " " + t("sar") + ")",
      t("f_name") + ": " + client.name, t("f_phone") + ": " + client.phone,
      t("f_age") + ": " + client.age + " | " + t("f_height") + ": " + client.height + " | " + t("f_weight") + ": " + client.weight,
      t("f_goal") + ": " + t("goal_" + client.goal),
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
  let tab = "ready";
  let draft = [];          // the 7 days being chosen (kept on this device until saved)
  let custom = {};         // the day the client is building
  const draftKey = () => "mizan_draft_" + (me ? me.id : "");
  const loadDraft = () => { try { draft = JSON.parse(localStorage.getItem(draftKey()) || "[]"); } catch (e) { draft = []; } };
  const saveDraft = () => { try { localStorage.setItem(draftKey(), JSON.stringify(draft)); } catch (e) {} };

  async function refresh() {
    const u = await DB.user();
    if (!u) { me = null; return render(); }
    $("loading").hidden = false;
    try {
      const rows = await DB.select("profiles", "select=*&id=eq." + u.id);
      me = rows[0] || null;
      if (me && me.role === "admin") { await DB.signOut(); me = null; $("loading").hidden = true; $("login-err").textContent = t("pt_is_pro"); return render(); }
      await Promise.all([loadSchedules(), loadRecipes()]);
      loadDraft();
    } catch (e) { me = null; $("login-err").textContent = friendlyError(e); }
    $("loading").hidden = true;
    render();
  }
  async function updateMe(changes) { me = await DB.update("profiles", me.id, changes); render(); }

  function render() {
    const c = me;
    $("login-view").hidden = !!c;
    $("dash-view").hidden = !c;
    if (!c) return;
    $("d-name").textContent = (c.name || "").split(" ")[0];
    $("ib-alert").hidden = !c.inbody_requested;
    const plans = c.plans || [];
    const paid = isPaid(c);
    const st = paid && plans.length >= 7 ? dayState(c) : null;
    $("v-wait").hidden = paid;
    $("wait-rejected").hidden = c.pay_status !== "rejected";
    $("wait-pending").hidden = c.pay_status === "rejected";
    const noKcal = paid && !c.kcal;
    $("v-kcal-wait").hidden = !noKcal;
    $("v-build").hidden = !(paid && c.kcal && plans.length < 7);
    $("v-pick").hidden = !(paid && plans.length >= 7 && !st);
    $("v-plan").hidden = !(paid && st);
    $("workout-card").hidden = !(paid && (c.workout_link || (PACKAGES[c.package] && PACKAGES[c.package].workout)));
    renderWorkout(c);
    if (!$("v-build").hidden) renderBuild(c);
    if (!$("v-pick").hidden) renderPick(c);
    if (st) renderToday(c, st);
  }

  function renderWorkout(c) {
    const link = c.workout_link && /^https?:\/\//i.test(c.workout_link) ? c.workout_link : "";
    $("wk-link").hidden = !link;
    if (link) $("wk-link").href = link;
    $("wk-none").hidden = !!link;
  }

  // ---------- Step 1: choose 7 days ----------
  function renderBuild(c) {
    $("b-count").textContent = draft.length;
    $("b-kcal").textContent = (c.kcal || 0).toLocaleString();
    document.querySelectorAll("[data-btab]").forEach(b => b.classList.toggle("active", b.dataset.btab === tab));
    $("b-ready").hidden = tab !== "ready";
    $("b-custom").hidden = tab !== "custom";
    const full = draft.length >= 7;

    // ready plans that match the client's calories — food names only
    const list = matchingTemplates(c.kcal);
    $("b-no-ready").hidden = list.length > 0;
    $("b-ready-list").innerHTML = list.map(s =>
      '<div class="card sched-card"><h3>' + esc(s.name) + '</h3><p class="stat">' + s.kcal.toLocaleString() + " <small>" + esc(t("kcal_short")) + "</small></p>" +
      mealNamesHTML(tplMeals(s)) + '<button class="btn small" data-addtpl="' + esc(s.id) + '"' + (full ? " disabled" : "") + ">" + esc(t("b_add")) + "</button></div>").join("");
    document.querySelectorAll("[data-addtpl]").forEach(b => b.addEventListener("click", () => {
      const s = SCHEDULES.find(x => x.id === b.dataset.addtpl);
      if (!s || draft.length >= 7) return;
      draft.push({ name: s.name, kcal: s.kcal, meals: { ...tplMeals(s) }, source: "ready" });
      saveDraft(); renderBuild(c);
    }));

    renderCustom(c);

    // the 7 chosen days
    let rows = "";
    for (let i = 0; i < 7; i++) {
      const p = draft[i];
      rows += '<li class="' + (p ? "" : "empty") + '"><span class="day-num">' + (i + 1) + "</span><span class='grow'>" +
        (p ? "<b>" + esc(p.name) + "</b> · " + p.kcal + " " + esc(t("kcal_short")) + "<br><small class='muted'>" + SLOTS.map(k => { const r = recipeById(p.meals[k]); return r ? esc(rText(r, "name")) : ""; }).filter(Boolean).join(" · ") + "</small>" : "<span class='muted'>" + esc(t("b_empty_slot")) + "</span>") +
        "</span>" + (p ? '<button class="install-close" data-rm="' + i + '" aria-label="Remove">×</button>' : "") + "</li>";
    }
    $("b-chosen").innerHTML = rows;
    document.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", () => { draft.splice(+b.dataset.rm, 1); saveDraft(); renderBuild(c); }));
    $("b-save").disabled = !full;
  }

  // build-your-own: each list only shows food that still fits the calories
  function renderCustom(c) {
    const target = c.kcal || 0;
    const chosenSum = SLOTS.reduce((s, k) => s + ((recipeById(custom[k]) || {}).kcal || 0), 0);
    const minOf = k => Math.min(...recipesFor(k).map(r => r.kcal), Infinity);
    $("c-target").textContent = target.toLocaleString();
    $("c-total").textContent = chosenSum.toLocaleString();
    $("c-left").textContent = Math.max(0, target - chosenSum).toLocaleString();
    $("c-slots").innerHTML = SLOTS.map(k => {
      const others = SLOTS.filter(x => x !== k);
      const othersChosen = others.reduce((s, x) => s + ((recipeById(custom[x]) || {}).kcal || 0), 0);
      const othersMin = others.filter(x => !custom[x]).reduce((s, x) => s + (isFinite(minOf(x)) ? minOf(x) : 0), 0);
      const fits = recipesFor(k).filter(r => r.kcal + othersChosen + othersMin <= target + 50);
      const opts = fits.map(r => '<option value="' + esc(r.id) + '"' + (custom[k] === r.id ? " selected" : "") + ">" + esc(rText(r, "name")) + " (" + r.kcal + ")</option>").join("");
      return '<div class="field"><label for="cs-' + k + '">' + esc(slotLabel(k)) + '</label><select id="cs-' + k + '" data-cslot="' + k + '"><option value="">' + esc(fits.length ? t("b_choose") : t("b_nothing_fits")) + "</option>" + opts + "</select></div>";
    }).join("");
    document.querySelectorAll("[data-cslot]").forEach(s => s.addEventListener("change", () => { custom[s.dataset.cslot] = s.value; renderCustom(c); }));
    const complete = SLOTS.every(k => custom[k]);
    $("c-add").disabled = !complete || draft.length >= 7;
  }
  $("c-add").addEventListener("click", () => {
    if (draft.length >= 7 || !SLOTS.every(k => custom[k])) return;
    const n = draft.filter(p => p.source === "custom").length + 1;
    draft.push({ name: t("b_custom_name") + " " + n, kcal: me.kcal, meals: { ...custom }, source: "custom" });
    custom = {}; saveDraft(); renderBuild(me);
  });
  document.querySelectorAll("[data-btab]").forEach(b => b.addEventListener("click", () => { tab = b.dataset.btab; renderBuild(me); }));
  $("b-save").addEventListener("click", async () => {
    if (draft.length < 7) return;
    busy($("b-save"), true);
    try { await updateMe({ plans: draft.slice(0, 7) }); draft = []; saveDraft(); }
    catch (e) { $("b-err").textContent = friendlyError(e); } finally { busy($("b-save"), false); }
  });

  // ---------- Step 2: every day, pick one of the 7 ----------
  function renderPick(c) {
    $("pick-list").innerHTML = c.plans.slice(0, 7).map((p, i) =>
      '<div class="card sched-card"><p class="eyebrow">' + esc(t("pt_day")) + " " + (i + 1) + "</p><h3>" + esc(p.name) + '</h3><p class="stat">' + p.kcal.toLocaleString() + " <small>" + esc(t("kcal_short")) + "</small></p>" +
      mealNamesHTML(p.meals) + '<button class="btn small" data-pickday="' + i + '">' + esc(t("p_start")) + "</button></div>").join("");
    document.querySelectorAll("[data-pickday]").forEach(b => b.addEventListener("click", async () => {
      busy(b, true);
      const history = (c.history || []).slice();
      if (c.today && c.today.date !== todayStr()) {
        const pr = c.today.progress || {};
        history.push({ date: c.today.date, plan: c.today.plan, done: Object.values(pr).filter(v => v === "done").length, skipped: Object.values(pr).filter(v => v === "skip").length });
      }
      try { await updateMe({ today: { date: todayStr(), plan: +b.dataset.pickday, progress: {} }, history: history.slice(-60) }); }
      finally { busy(b, false); }
    }));
  }

  // ---------- Step 3: today's meals one by one ----------
  function renderToday(c, st) {
    $("p-sched").textContent = st.plan.name;
    $("p-done").textContent = st.done;
    $("p-total").textContent = SLOTS.length;
    $("p-kcal").textContent = st.kcal.toLocaleString();
    $("p-target").textContent = st.plan.kcal.toLocaleString();
    $("p-days").textContent = (c.history || []).filter(h => h.done > 0).length + (st.done > 0 ? 1 : 0);
    $("p-bar").style.width = Math.round((st.handled / SLOTS.length) * 100) + "%";
    $("change-day").hidden = st.handled > 0;
    $("next-card").hidden = !st.next;
    $("finished-card").hidden = !!st.next;
    if (st.next && st.next.recipe) {
      const r = st.next.recipe;
      $("n-type").textContent = slotLabel(st.next.k);
      $("n-name").textContent = rText(r, "name");
      $("n-kcal").textContent = Math.round(r.kcal * st.factor);
      $("n-protein").textContent = Math.round((r.protein || 0) * st.factor);
      $("n-portion").textContent = st.factor !== 1 ? "· " + t("pt_portion") + " ×" + st.factor : "";
      $("n-ing").textContent = rText(r, "ing");
      $("n-steps").textContent = rText(r, "steps");
    }
    $("today-list").innerHTML = st.slots.map(s => {
      const isNext = st.next && s.k === st.next.k;
      const label = s.status === "done" ? t("st_done") : s.status === "skip" ? t("st_skipped") : isNext ? t("st_next") : t("st_later");
      const cls = s.status ? "is-" + s.status : isNext ? "is-next" : "";
      return '<li class="' + cls + '"><span class="icon">' + (statusIcon[s.status] || "🍽️") + "</span><span class='grow'><b>" + esc(slotLabel(s.k)) + "</b> — " +
        esc(s.recipe ? rText(s.recipe, "name") : "") + "</span><span class='tag'>" + esc(label) + "</span></li>";
    }).join("");
  }
  async function mark(status, btn) {
    const st = dayState(me); if (!st || !st.next) return;
    busy(btn, true);
    try { await updateMe({ today: { ...st.today, progress: { ...(st.today.progress || {}), [st.next.k]: status } } }); } finally { busy(btn, false); }
  }
  $("done-btn").addEventListener("click", () => mark("done", $("done-btn")));
  $("skip-btn").addEventListener("click", () => mark("skip", $("skip-btn")));
  $("change-day").addEventListener("click", async () => { await updateMe({ today: null }); });

  $("ib-submit").addEventListener("click", async () => {
    const num = id => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
    busy($("ib-submit"), true);
    try {
      await DB.insert("inbody", { user_id: me.id, weight: num("ib-weight"), fat: num("ib-fat"), muscle: num("ib-muscle") });
      await updateMe({ inbody_requested: false });
      $("ib-thanks").hidden = false;
    } catch (e) { $("ib-err").textContent = friendlyError(e); } finally { busy($("ib-submit"), false); }
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

// Example one-day plans, added automatically the first time the dietitian signs in (she can delete them)
const DEMO_SCHEDULES = () => [
  { name: "يوم خفيف ١٢٠٠", kcal: 1200, days: [{ b: "b5", s1: "s5", l: "l4", s2: "s4", d: "d5" }] },
  { name: "يوم متوازن ١٣٠٠", kcal: 1300, days: [{ b: "b3", s1: "s1", l: "l3", s2: "s5", d: "d1" }] },
  { name: "يوم مدى ١٣٥٠", kcal: 1350, days: [{ b: "b1", s1: "s4", l: "l4", s2: "s3", d: "d4" }] },
  { name: "يوم بروتين ١٤٥٠", kcal: 1450, days: [{ b: "b2", s1: "s4", l: "l2", s2: "s1", d: "d1" }] },
  { name: "يوم شبع ١٥٠٠", kcal: 1500, days: [{ b: "b4", s1: "s3", l: "l1", s2: "s4", d: "d5" }] },
  { name: "يوم نشيط ١٨٠٠", kcal: 1800, days: [{ b: "b1", s1: "s2", l: "l5", s2: "s1", d: "d3" }] }
];

// ===== Dietitian page =====
if ($("admin-login")) {
  let editing = null;      // the one-day plan being built
  let recipeFilter = "all";
  let openClient = null;
  let deleteArmed = null;
  let CLIENTS = [];
  let signupMode = false;
  const RECIPE_TYPES = ["b", "l", "d", "s"];

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

  // ---- One-day plans ----
  function renderSchedules() {
    $("no-sched").hidden = SCHEDULES.length > 0;
    const cards = SCHEDULES.map(s => {
      const match = CLIENTS.filter(c => Math.abs((c.kcal || 0) - s.kcal) <= MATCH_RANGE).length;
      return '<div class="card sched-card"><h3>' + esc(s.name) + '</h3><p class="stat">' + s.kcal.toLocaleString() + " <small>" + esc(t("kcal_short")) + "</small></p>" +
        mealNamesHTML(tplMeals(s)) + "<p class='muted'>" + match + " " + esc(t("ad_matching")) + "</p>" +
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
    editing = { b: "", s1: "", l: "", s2: "", d: "" };
    $("s-name").value = "";
    renderDayEditor();
    $("sched-editor").hidden = false;
    $("sched-err").textContent = "";
    $("sched-editor").scrollIntoView({ behavior: "smooth" });
  }
  function renderDayEditor() {
    if (!editing) return;
    const target = +$("s-kcal").value || 0;
    const total = mealsTotal(editing);
    const f = total ? portionFactor(target, editing) : 1;
    $("day-editor").innerHTML = SLOTS.map(k => {
      const opts = recipesFor(k).map(r => '<option value="' + esc(r.id) + '"' + (editing[k] === r.id ? " selected" : "") + ">" + esc(rText(r, "name")) + " (" + r.kcal + ")</option>").join("");
      return '<div class="field"><label for="se-' + k + '">' + esc(slotLabel(k)) + '</label><select id="se-' + k + '" data-se="' + k + '"><option value="">' + esc(t("ad_choose")) + "</option>" + opts + "</select></div>";
    }).join("");
    $("day-total").textContent = total + (total ? " → ×" + f + " = " + Math.round(total * f) : "") + " " + t("kcal_short");
    document.querySelectorAll("[data-se]").forEach(s => s.addEventListener("change", () => { editing[s.dataset.se] = s.value; renderDayEditor(); }));
  }
  // pick recipes so the day lands close to the target
  function autofill() {
    const target = +$("s-kcal").value || 1500;
    let best = null, bestDiff = Infinity;
    for (let i = 0; i < 400; i++) {
      const day = {};
      SLOTS.forEach(k => { const list = recipesFor(k); day[k] = list.length ? list[Math.floor(Math.random() * list.length)].id : ""; });
      if (day.s1 === day.s2 && recipesFor("s1").length > 1) continue;
      const diff = Math.abs(mealsTotal(day) - target);
      if (diff < bestDiff) { best = day; bestDiff = diff; }
    }
    editing = best; renderDayEditor();
  }
  $("s-kcal").addEventListener("input", renderDayEditor);
  $("autofill-btn").addEventListener("click", autofill);
  $("cancel-sched").addEventListener("click", () => { editing = null; $("sched-editor").hidden = true; });
  $("save-sched").addEventListener("click", async () => {
    const name = $("s-name").value.trim(), kcal = +$("s-kcal").value;
    if (!name || !kcal || !SLOTS.every(k => editing[k])) { $("sched-err").textContent = t("err_sched"); return; }
    busy($("save-sched"), true);
    try {
      await DB.insert("schedules", { name, kcal, days: [{ ...editing }] });
      await loadSchedules();
      editing = null; $("sched-editor").hidden = true;
      renderSchedules(); msg(t("ad_saved"));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { $("sched-err").textContent = friendlyError(e); } finally { busy($("save-sched"), false); }
  });

  // ---- Recipes ----
  function renderRecipes() {
    const filters = ["all"].concat(RECIPE_TYPES);
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
  function todayText(c) {
    const st = (c.plans || []).length >= 7 ? dayState(c) : null;
    return st ? st.done + " / " + SLOTS.length : "—";
  }
  function renderClients() {
    $("no-clients").hidden = CLIENTS.length > 0;
    $("clients-list").hidden = !!openClient;
    $("client-detail").hidden = !openClient;
    if (openClient) return renderDetail();
    if (!CLIENTS.length) { $("clients-table").innerHTML = ""; return; }
    $("clients-table").innerHTML = "<tr><th>" + [t("ad_c_name"), t("ad_c_target"), t("pt_package"), t("pt_status"), t("ad_days_chosen"), t("ad_today"), "InBody", ""].map(esc).join("</th><th>") + "</th></tr>" +
      CLIENTS.map(c => {
        const pay = !PAYMENT_ENABLED ? "—" : c.paid ? esc(t("ad_paid"))
          : c.pay_status === "rejected" ? '<span class="status-pill bad">' + esc(t("tr_rejected")) + "</span>"
          : '<button class="btn small" data-open="' + esc(c.id) + '">' + esc(t("ad_view_receipt")) + "</button>";
        const ib = c.inbody_requested ? '<span class="status-pill">' + esc(t("ib_requested")) + "</span>" : "✓";
        const pk = PACKAGES[c.package] ? t(PACKAGES[c.package].nameKey) : "—";
        return "<tr><td>" + esc(c.name) + "</td><td>" + (c.kcal || '<span class="status-pill">' + esc(t("ad_need_kcal")) + "</span>") + "</td><td>" + esc(pk) + "</td><td>" + pay + "</td><td>" + Math.min(7, (c.plans || []).length) + " / 7</td><td>" + todayText(c) + "</td><td>" + ib + '</td><td><button class="btn outline small" data-open="' + esc(c.id) + '">' + esc(t("ad_open")) + "</button></td></tr>";
      }).join("");
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
    $("cd-workout").value = c.workout_link || "";
    $("cd-kcal").value = c.kcal || "";
    $("cd-kcal-msg").textContent = "";
    $("cd-kcal-need").hidden = !!c.kcal;
    $("cd-workout-msg").textContent = "";

    // the client's 7 days + daily history
    const plans = c.plans || [];
    $("cd-reset").hidden = !plans.length;
    if (!plans.length) $("cd-progress").innerHTML = "<p class='muted'>" + esc(t("ad_no_plans")) + "</p>";
    else {
      const st = plans.length >= 7 ? dayState(c) : null;
      const planCards = plans.slice(0, 7).map((p, i) => '<div class="mini-plan' + (st && st.today.plan === i ? " is-today" : "") + '"><b>' + esc(t("pt_day")) + " " + (i + 1) + " · " + esc(p.name) + "</b> <small class='muted'>" + p.kcal + " " + esc(t("kcal_short")) + "</small>" + mealNamesHTML(p.meals) + "</div>").join("");
      const hist = (c.history || []).slice().reverse().slice(0, 14);
      const histRows = (st ? [{ date: st.today.date, plan: st.today.plan, done: st.done, skipped: st.slots.filter(x => x.status === "skip").length, isToday: true }] : []).concat(hist);
      $("cd-progress").innerHTML = (st ? "<p><b>" + esc(t("ad_today")) + ":</b> " + esc(st.plan.name) + " — " + st.done + " / " + SLOTS.length + " " + esc(t("h_meals")) + "</p>" : "") +
        "<div class='mini-plans'>" + planCards + "</div>" +
        "<h4>" + esc(t("ad_history")) + "</h4>" +
        (histRows.length ? "<div class='table-wrap'><table><tr><th>" + [t("h_date"), t("h_plan"), t("h_meals"), t("cd_skipped")].map(esc).join("</th><th>") + "</th></tr>" +
          histRows.map(h => "<tr><td>" + esc(h.date) + (h.isToday ? " (" + esc(t("ad_today")) + ")" : "") + "</td><td>" + esc(plans[h.plan] ? plans[h.plan].name : "—") + "</td><td>" + h.done + " / " + SLOTS.length + "</td><td>" + (h.skipped || 0) + "</td></tr>").join("") + "</table></div>"
          : "<p class='muted'>—</p>");
    }

    // payment review
    $("cd-pay").hidden = isPaid(c);
    if (!isPaid(c)) {
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
      $("cd-ib-table").innerHTML = ibs.length ? "<tr><th>" + ["", t("ib_weight"), t("ib_fat"), t("ib_muscle"), "BMR"].map(esc).join("</th><th>") + "</th></tr>" +
        ibs.map(i => "<tr><td>" + esc(fmtDate(i.date)) + "</td><td>" + (i.weight ?? "—") + "</td><td>" + (i.fat ?? "—") + "</td><td>" + (i.muscle ?? "—") + "</td><td>" + (i.bmr ?? "—") + "</td></tr>").join("") : "";
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
  $("cd-workout-save").addEventListener("click", async () => {
    const v = $("cd-workout").value.trim();
    if (v && !/^https?:\/\//i.test(v)) { $("cd-workout-msg").textContent = t("err_link"); return; }
    await changeClient({ workout_link: v || null });
    $("cd-workout-msg").textContent = t("ad_saved_ok");
  });
  $("cd-kcal-save").addEventListener("click", async () => {
    const v = parseInt($("cd-kcal").value, 10);
    if (!v || v < 800 || v > 5000) { $("cd-kcal-msg").textContent = t("err_kcal"); return; }
    await changeClient({ kcal: v });
    $("cd-kcal-msg").textContent = t("ad_saved_ok");
  });
  let resetArmed = false;
  $("cd-reset").addEventListener("click", async () => {
    if (!resetArmed) { resetArmed = true; $("cd-reset").textContent = t("ad_confirm_delete"); return; }
    resetArmed = false; $("cd-reset").textContent = t("ad_reset_plans");
    await changeClient({ plans: [], today: null });
  });
  $("refresh-btn").addEventListener("click", async () => { busy($("refresh-btn"), true); await Promise.all([loadClients(), loadSchedules(), loadRecipes()]); renderAll(); busy($("refresh-btn"), false); });

  function updateBadge() {
    const n = CLIENTS.filter(c => (!isPaid(c) && c.pay_status === "pending" && c.receipt_path) || (isPaid(c) && !c.kcal)).length;
    document.querySelector('.tab[data-tab="clients"]').textContent = t("tab_clients") + (n ? " (" + n + ")" : "");
  }
  function renderAll() { renderSchedules(); renderRecipes(); renderClients(); renderDayEditor(); updateBadge(); }
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
  const installKey = document.getElementById("admin-login") ? "app_install_pro" : "app_install";
  const bar = document.createElement("div");
  bar.className = "install-bar";
  bar.hidden = true;
  bar.innerHTML = '<img src="icon-192.png" alt="" width="40" height="40"><span class="grow" data-i18n="' + (isIOS ? "app_ios" : installKey) + '"></span>' +
    (isIOS ? "" : '<button class="btn small" id="install-btn" data-i18n="' + installKey + '"></button>') +
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
