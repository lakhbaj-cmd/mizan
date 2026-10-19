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
  basic: { price: 180, nameKey: "pk_basic_name", workout: false, custom: false },  // ready plans only
  plus:  { price: 250, nameKey: "pk_plus_name",  workout: true,  custom: true  }   // + workout plan + build own days
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
// show/hide the "Start now" buttons depending on whether a client is signed in
function markSignedIn(on) { document.body.classList.toggle("signed-in", !!on); }

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
// plans/schedules are named only by their calories (e.g. "1300 سعرة")
function planTitle(p) { return (p && p.kcal ? String(p.kcal) : "—") + " " + t("kcal_short"); }
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
// is today marked as an off day by the client?
const isOffToday = c => !!(c && c.today && c.today.off && c.today.date === todayStr());
// move the current day (if any) into the history list
function archiveDay(c) {
  const history = (c.history || []).slice();
  if (c.today) {
    if (c.today.off) history.push({ date: c.today.date, off: true });
    else {
      const pr = c.today.progress || {};
      history.push({ date: c.today.date, plan: c.today.plan, done: Object.values(pr).filter(v => v === "done").length, skipped: Object.values(pr).filter(v => v === "skip").length });
    }
  }
  return history.slice(-60);
}
function dayState(c) {
  const today = c.today && !c.today.off && c.today.date === todayStr() ? c.today : null;
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
      markSignedIn(true);
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
    markSignedIn(!!c);
    $("login-view").hidden = !!c;
    if ($("chat-fab")) { if (!c) { $("chat-panel").hidden = true; $("chat-msgs").innerHTML = ""; } $("chat-fab").hidden = !c || !$("chat-panel").hidden; }
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
    const off = paid && plans.length >= 7 && isOffToday(c);
    $("v-off").hidden = !off;
    $("v-pick").hidden = !(paid && plans.length >= 7 && !st && !off);
    $("v-plan").hidden = !(paid && st);
    $("workout-card").hidden = !(paid && PACKAGES[c.package] && PACKAGES[c.package].workout);
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
    // only the plus package can build its own days; basic chooses from the ready plans
    const canCustom = !!(PACKAGES[c.package] && PACKAGES[c.package].custom);
    if (!canCustom) tab = "ready";
    document.querySelector('[data-btab="custom"]').hidden = !canCustom;
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
      '<div class="card sched-card"><h3>' + esc(planTitle(s)) + "</h3>" +
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
        (p ? "<b>" + esc(planTitle(p)) + "</b><br><small class='muted'>" + SLOTS.map(k => { const r = recipeById(p.meals[k]); return r ? esc(rText(r, "name")) : ""; }).filter(Boolean).join(" · ") + "</small>" : "<span class='muted'>" + esc(t("b_empty_slot")) + "</span>") +
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
    draft.push({ name: String(me.kcal), kcal: me.kcal, meals: { ...custom }, source: "custom" });
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
      '<div class="card sched-card"><p class="eyebrow">' + esc(t("pt_day")) + " " + (i + 1) + "</p><h3>" + esc(planTitle(p)) + "</h3>" +
      mealNamesHTML(p.meals) + '<button class="btn small" data-pickday="' + i + '">' + esc(t("p_start")) + "</button></div>").join("");
    document.querySelectorAll("[data-pickday]").forEach(b => b.addEventListener("click", async () => {
      busy(b, true);
      try { await updateMe({ today: { date: todayStr(), plan: +b.dataset.pickday, progress: {} }, history: archiveDay(c) }); }
      finally { busy(b, false); }
    }));
  }

  // ---------- Step 3: today's meals one by one ----------
  function renderToday(c, st) {
    $("p-sched").textContent = planTitle(st.plan);
    $("p-done").textContent = st.done;
    $("p-total").textContent = SLOTS.length;
    $("p-kcal").textContent = st.kcal.toLocaleString();
    $("p-target").textContent = st.plan.kcal.toLocaleString();
    $("p-days").textContent = (c.history || []).filter(h => h.done > 0).length + (st.done > 0 ? 1 : 0);
    $("p-bar").style.width = Math.round((st.handled / SLOTS.length) * 100) + "%";
    $("change-day").hidden = st.handled > 0;
    $("next-card").hidden = !st.next;
    $("finished-card").hidden = !!st.next;
    document.querySelector("#v-plan [data-offday]").hidden = !st.next;
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
  // finished the day → save it and choose the next plan from the 7
  $("next-sched").addEventListener("click", async () => {
    busy($("next-sched"), true);
    try { await updateMe({ today: null, history: archiveDay(me) }); } finally { busy($("next-sched"), false); }
  });
  // off day: no meals today (a started day with progress is kept in the history)
  document.querySelectorAll("[data-offday]").forEach(b => b.addEventListener("click", async () => {
    busy(b, true);
    const started = me.today && !me.today.off && Object.keys(me.today.progress || {}).length;
    const history = started ? archiveDay(me) : (me.history || []);
    try { await updateMe({ today: { date: todayStr(), off: true }, history }); } finally { busy(b, false); }
  }));
  $("off-cancel").addEventListener("click", async () => { await updateMe({ today: null }); });

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

  // ---------- Nojood helper: a rule-based chat assistant for clients ----------
  // It only answers from the client's own plan and the recipes. It never changes calories or plans,
  // and anything about health goes to Nojood.
  const CHAT = {
    ar: {
      title: "مساعد نجود", open: "اسأل المساعد", ph: "اكتب سؤالك…", send: "إرسال",
      hi: "هلا! أنا مساعد نجود 🌿 أقدر أقولك وجبتك الجاية، طريقة الوصفة، المكونات، وكم سعرة باقي لك اليوم.",
      chips: ["وش وجبتي الجاية؟", "كيف أسويها؟", "كم سعرة باقي؟", "جدول اليوم"],
      no_plan: "لسا ما اخترت جدول اليوم. اختر واحد من أيامك السبعة فوق وبعدين اسألني.",
      no_days: "لسا ما اخترت أيامك السبعة. اختارها فوق وبعدين أقدر أساعدك.",
      wait: "الأخصائية لسا ما حددت سعراتك. أول ما تحددها يطلع لك جدولك.",
      off: "اليوم يوم أوف 🌿 ما فيه جدول. استمتع وارجع بكرة!",
      done: "خلّصت كل وجبات اليوم 🎉 تقدر تضغط \"ابدأ الجدول التالي\" لو تبي يوم جديد.",
      next: "وجبتك الجاية: {slot} — {name} ({kcal} سعرة).",
      how: "طريقة {name}: {steps}",
      ing: "مكونات {name}: {ing}",
      kcal: "أكلت {eaten} من {target} سعرة اليوم. باقي لك {left} سعرة.",
      today: "جدول اليوم ({plan}):",
      workout: "جدول تمارينك هنا: {link}", workout_none: "الأخصائية لسا ما أضافت جدول تمارين.", workout_basic: "باقتك ما فيها جدول تمارين. باقة تغذية + تمارين فيها جدول.",
      offday: "لو تبي اليوم يوم أوف اضغط زر \"🌿 يوم أوف\" فوق الوجبات.",
      change: "تغيير السعرات أو الجدول ترجع فيه للأخصائية نجود، أنا ما أقدر أغيّره.",
      health: "هذا سؤال صحي ولازم تسأل فيه الأخصائية نجود مباشرة. أنا ما أقدر أجاوب عليه.",
      skip: "لو ما تبي الوجبة اضغط \"تخطّي\" وتنتقل للي بعدها.",
      thanks: "العفو! 🌿", fallback: "ما فهمت عليك 😅 جرّب واحد من هذي:"
    },
    en: {
      title: "Nojood helper", open: "Ask the helper", ph: "Type your question…", send: "Send",
      hi: "Hi! I'm the Nojood helper 🌿 I can tell you your next meal, how to make it, the ingredients, and how many calories you have left today.",
      chips: ["What's my next meal?", "How do I make it?", "Calories left?", "Today's plan"],
      no_plan: "You haven't picked today's plan yet. Pick one of your 7 days above, then ask me.",
      no_days: "You haven't chosen your 7 days yet. Choose them above, then I can help.",
      wait: "Your dietitian hasn't set your calories yet. Your plan shows up as soon as she does.",
      off: "Today is an off day 🌿 No plan today. Enjoy and come back tomorrow!",
      done: "You finished all of today's meals 🎉 Tap \"Start the next plan\" if you want a new day.",
      next: "Your next meal: {slot} — {name} ({kcal} kcal).",
      how: "How to make {name}: {steps}",
      ing: "Ingredients for {name}: {ing}",
      kcal: "You've eaten {eaten} of {target} kcal today. {left} kcal left.",
      today: "Today's plan ({plan}):",
      workout: "Your workout plan is here: {link}", workout_none: "Your dietitian hasn't added a workout plan yet.", workout_basic: "Your package doesn't include a workout plan. The Nutrition + Workout package does.",
      offday: "If you want today off, tap the \"🌿 Off day\" button above your meals.",
      change: "Changing your calories or plan is up to your dietitian Nojood. I can't change it.",
      health: "That's a health question, so please ask your dietitian Nojood directly. I can't answer it.",
      skip: "If you don't want a meal, tap \"Skip\" to move to the next one.",
      thanks: "You're welcome! 🌿", fallback: "Sorry, I didn't get that 😅 Try one of these:"
    }
  };
  const ct = (k, vars) => { let s = (CHAT[LANG] || CHAT.en)[k] || CHAT.en[k]; for (const v in (vars || {})) s = s.split("{" + v + "}").join(vars[v]); return s; };
  // make Arabic easier to match: remove tashkeel and unify letters
  const norm = s => String(s || "").toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const has = (q, words) => words.some(w => q.includes(norm(w)));
  const W = {
    health: ["حامل", "حمل", "سكري", "عندي سكر", "السكر", "ضغط", "دوا", "علاج", "حساسيه", "دوخه", "دايخ", "اتالم", "يوجع", "يعور", "مريض", "مرض", "رضاعه", "pregnan", "diabet", "medic", "allerg", "pain", "sick", "dizzy", "blood pressure", "breastfeed"],
    change: ["غير", "اغير", "زود", "قلل", "نقص", "change", "increase", "decrease", "more calories", "less calories"],
    how: ["كيف", "طريقه", "اسوي", "اطبخ", "how", "make", "cook", "recipe", "steps"],
    ing: ["مكونات", "وش فيها", "ايش فيها", "ingredient", "what's in", "whats in"],
    kcal: ["سعر", "كالوري", "باقي", "calor", "kcal", "left"],
    next: ["الجايه", "الجاي", "التاليه", "بعدين", "next", "now"],
    today: ["جدول اليوم", "وجبات اليوم", "اليوم", "today", "plan", "meals"],
    workout: ["تمرين", "تمارين", "رياضه", "workout", "exercise", "gym"],
    offday: ["اوف", "راحه", "off", "rest", "break"],
    skip: ["تخطي", "ما ابي", "مابي", "ماابي", "skip", "don't want", "dont want"],
    thanks: ["شكرا", "يعطيك", "مشكور", "thank", "thx"],
    hi: ["هلا", "مرحبا", "السلام", "هاي", "hello", "hi", "hey", "help", "مساعده"]
  };
  const SLOT_WORDS = { b: ["فطور", "breakfast"], l: ["غدا", "lunch"], d: ["عشا", "dinner"], s2: ["سناك 2", "snack 2", "السناك الثاني", "second snack"], s1: ["سناك", "snack"] };
  function slotFromText(q) { for (const k of ["b", "l", "d", "s2", "s1"]) if (has(q, SLOT_WORDS[k])) return k; return null; }

  // the brain: read the question, decide which rule matches, answer from the client's own data
  function chatAnswer(text) {
    const q = norm(text), c = me;
    if (has(q, W.health)) return ct("health");             // health always goes to the dietitian first
    if (has(q, W.thanks)) return ct("thanks");
    if (has(q, W.change) && has(q, W.kcal.concat(["جدول", "plan"]))) return ct("change");
    if (has(q, W.workout)) {
      if (!(PACKAGES[c.package] && PACKAGES[c.package].workout)) return ct("workout_basic");
      return c.workout_link ? ct("workout", { link: c.workout_link }) : ct("workout_none");
    }
    if (has(q, W.offday)) return isOffToday(c) ? ct("off") : ct("offday");
    if (has(q, W.skip)) return ct("skip");
    if (!c.kcal) return ct("wait");
    if ((c.plans || []).length < 7) return ct("no_days");
    if (isOffToday(c)) return ct("off");
    const st = dayState(c);
    if (!st) return ct("no_plan");
    const slotAsked = slotFromText(q);
    const target = slotAsked ? st.slots.find(s => s.k === slotAsked) : st.next;
    const kcalOf = s => Math.round((s.recipe ? s.recipe.kcal : 0) * st.factor);
    if (has(q, W.how) || has(q, W.ing)) {
      if (!target) return ct("done");
      const r = target.recipe; if (!r) return ct("fallback");
      return has(q, W.ing) ? ct("ing", { name: rText(r, "name"), ing: rText(r, "ing") }) : ct("how", { name: rText(r, "name"), steps: rText(r, "steps") });
    }
    if (has(q, W.kcal)) return ct("kcal", { eaten: st.kcal, target: st.plan.kcal, left: Math.max(0, st.plan.kcal - st.kcal) });
    if (slotAsked || has(q, W.next)) {
      if (!target) return ct("done");
      return ct("next", { slot: slotLabel(target.k), name: target.recipe ? rText(target.recipe, "name") : "—", kcal: kcalOf(target) });
    }
    if (has(q, W.today)) return ct("today", { plan: planTitle(st.plan) }) + "\n" + st.slots.map(s => (s.status === "done" ? "✅ " : s.status === "skip" ? "⏭️ " : "• ") + slotLabel(s.k) + ": " + (s.recipe ? rText(s.recipe, "name") : "—") + " (" + kcalOf(s) + ")").join("\n");
    if (has(q, W.hi)) return ct("hi");
    return null;   // didn't understand
  }

  // chat window
  const chatBox = document.createElement("div");
  chatBox.innerHTML = '<button class="chat-fab" id="chat-fab" type="button" hidden>💬 <span id="chat-fab-txt"></span></button>' +
    '<div class="chat-panel" id="chat-panel" hidden><div class="chat-head"><b id="chat-title"></b><button class="link-btn" id="chat-close" type="button">✕</button></div>' +
    '<div class="chat-msgs" id="chat-msgs" aria-live="polite"></div><div class="chat-chips" id="chat-chips"></div>' +
    '<form class="chat-form" id="chat-form"><input id="chat-input" autocomplete="off"><button class="btn small" id="chat-send"></button></form></div>';
  document.body.appendChild(chatBox);
  function chatSay(who, text) {
    const m = document.createElement("div"); m.className = "chat-msg " + who; m.dir = "auto"; m.textContent = text;
    $("chat-msgs").appendChild(m); $("chat-msgs").scrollTop = $("chat-msgs").scrollHeight;
  }
  function chatChips() { $("chat-chips").innerHTML = ct("chips").map(x => '<button type="button" class="chat-chip">' + esc(x) + "</button>").join(""); }
  function chatAsk(text) {
    text = String(text || "").trim(); if (!text || !me) return;
    chatSay("me", text);
    // answer in the language the client typed in
    const keep = LANG; LANG = /[\u0600-\u06FF]/.test(text) ? "ar" : /[a-z]/i.test(text) ? "en" : LANG;
    let a; try { a = chatAnswer(text); } finally { LANG = keep; }
    setTimeout(() => { chatSay("bot", a || ct("fallback")); chatChips(); }, 250);
  }
  function chatLabels() {
    $("chat-fab-txt").textContent = ct("open"); $("chat-title").textContent = ct("title");
    $("chat-input").placeholder = ct("ph"); $("chat-send").textContent = ct("send"); chatChips();
  }
  $("chat-fab").addEventListener("click", () => {
    $("chat-panel").hidden = false; $("chat-fab").hidden = true;
    if (!$("chat-msgs").children.length) chatSay("bot", ct("hi"));
    $("chat-input").focus();
  });
  $("chat-close").addEventListener("click", () => { $("chat-panel").hidden = true; $("chat-fab").hidden = !me; });
  $("chat-chips").addEventListener("click", e => { const b = e.target.closest(".chat-chip"); if (b) chatAsk(b.textContent); });
  $("chat-form").addEventListener("submit", e => { e.preventDefault(); chatAsk($("chat-input").value); $("chat-input").value = ""; });
  chatLabels(); document.addEventListener("langchange", chatLabels);
  window.__chatAnswer = chatAnswer;   // used by the test file

  document.addEventListener("langchange", render);
  refresh();
}

// Example one-day plans, added automatically the first time the dietitian signs in (she can delete them)
const DEMO_SCHEDULES = () => [
  { name: "1200", kcal: 1200, days: [{ b: "b1", s1: "s6", l: "l2", s2: "s9", d: "d8" }] },
  { name: "1300", kcal: 1300, days: [{ b: "b3", s1: "s4", l: "l4", s2: "s6", d: "d4" }] },
  { name: "1350", kcal: 1350, days: [{ b: "b4", s1: "s1", l: "l13", s2: "s10", d: "d1" }] },
  { name: "1450", kcal: 1450, days: [{ b: "b2", s1: "s3", l: "l8", s2: "s4", d: "d7" }] },
  { name: "1500", kcal: 1500, days: [{ b: "b5", s1: "s1", l: "l6", s2: "s4", d: "d3" }] },
  { name: "1800", kcal: 1800, days: [{ b: "b6", s1: "s1", l: "l1", s2: "s2", d: "d2" }] }
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
      return '<div class="card sched-card"><h3>' + esc(planTitle(s)) + "</h3>" +
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
    const kcal = +$("s-kcal").value, name = String(kcal);
    if (!kcal || !SLOTS.every(k => editing[k])) { $("sched-err").textContent = t("err_sched"); return; }
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
      "<p class='meal-meta'><b>" + r.kcal + "</b> " + esc(t("kcal_short")) + (r.est ? ' <span class="status-pill">' + esc(LANG === "ar" ? "سعرات تقديرية — راجعيها" : "estimated — please check") + "</span>" : "") + " · " + (r.protein || 0) + " " + esc(t("protein_short")) + "</p>" +
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
    return st ? st.done + " / " + SLOTS.length : isOffToday(c) ? "🌿 " + esc(t("off_title")) : "—";
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
    if (typeof renderAttention === "function") renderAttention();
  }

  async function renderDetail() {
    const c = clientById(openClient);
    if (!c) { openClient = null; return renderClients(); }
    $("cd-name").textContent = c.name;
    if (typeof renderSuggest === "function") renderSuggest();
    const rows = [
      [t("f_phone"), c.phone], [t("f_email"), c.email], [t("f_age"), c.age], [t("f_height"), c.height], [t("f_weight"), c.weight],
      [t("f_goal"), c.goal ? t("goal_" + c.goal) : "—"], [t("ad_c_target"), (c.kcal || "—") + " " + t("kcal_short")],
      [t("pt_package"), PACKAGES[c.package] ? t(PACKAGES[c.package].nameKey) : "—"], [t("f_health"), c.health || "—"], [t("f_food"), c.food || "—"]
    ];
    $("cd-info").innerHTML = rows.map(r => "<div><span class='muted small-label'>" + esc(r[0]) + "</span><div>" + esc(r[1]) + "</div></div>").join("");
    $("wa-client").href = waLink(saudiNumber(c.phone), (LANG === "ar" ? "مرحباً " : "Hi ") + (c.name || "").split(" ")[0] + "، " + t("ib_alert_text"));
    $("cd-ib-pending").hidden = !c.inbody_requested;
    $("cd-workout").value = c.workout_link || "";
    $("cd-workout-card").hidden = !(PACKAGES[c.package] && PACKAGES[c.package].workout);  // basic package has no workout plan
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
      const planCards = plans.slice(0, 7).map((p, i) => '<div class="mini-plan' + (st && st.today.plan === i ? " is-today" : "") + '"><b>' + esc(t("pt_day")) + " " + (i + 1) + " · " + esc(planTitle(p)) + "</b>" + mealNamesHTML(p.meals) + "</div>").join("");
      const hist = (c.history || []).slice().reverse().slice(0, 14);
      const offNow = isOffToday(c);
      const histRows = (st ? [{ date: st.today.date, plan: st.today.plan, done: st.done, skipped: st.slots.filter(x => x.status === "skip").length, isToday: true }] : offNow ? [{ date: c.today.date, off: true, isToday: true }] : []).concat(hist);
      $("cd-progress").innerHTML = (st ? "<p><b>" + esc(t("ad_today")) + ":</b> " + esc(planTitle(st.plan)) + " — " + st.done + " / " + SLOTS.length + " " + esc(t("h_meals")) + "</p>" : offNow ? "<p><b>" + esc(t("ad_today")) + ":</b> 🌿 " + esc(t("off_title")) + "</p>" : "") +
        "<div class='mini-plans'>" + planCards + "</div>" +
        "<h4>" + esc(t("ad_history")) + "</h4>" +
        (histRows.length ? "<div class='table-wrap'><table><tr><th>" + [t("h_date"), t("h_plan"), t("h_meals"), t("cd_skipped")].map(esc).join("</th><th>") + "</th></tr>" +
          histRows.map(h => "<tr><td>" + esc(h.date) + (h.isToday ? " (" + esc(t("ad_today")) + ")" : "") + "</td>" + (h.off ? "<td>🌿 " + esc(t("off_title")) + "</td><td>—</td><td>—</td>" : "<td>" + esc(plans[h.plan] ? planTitle(plans[h.plan]) : "—") + "</td><td>" + h.done + " / " + SLOTS.length + "</td><td>" + (h.skipped || 0) + "</td>") + "</tr>").join("") + "</table></div>"
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

  // =====================================================================
  // Nojood agent (Pro): 1) suggests calories + 7 plans  2) lists clients who need attention
  // It only SUGGESTS. Nothing reaches a client until Nojood presses an approve button.
  // Rules follow SKILL.md in the course folder.
  // =====================================================================
  const AG = {
    ar: {
      att_title: "👀 يحتاجون انتباهك", att_none: "كل العملاء تمام اليوم ✓",
      att_kcal: "ينتظر سعراته من {d} أيام", att_days: "ما اختار أيامه السبعة من {d} أيام", att_idle: "ما فتح التطبيق من {d} أيام",
      att_skip: "يتخطى وجبات كثير (آخر ٧ أيام: {s} تخطي، {k} تم)", att_ib: "طلبتي InBody من {d} أيام وما رد", att_pay: "إيصال تحويل ينتظر مراجعتك", att_health: "عنده ملاحظات صحية — راجعيه بنفسك",
      sg_title: "🤖 اقتراح المساعد", sg_btn: "اقترح سعرات وجداول", sg_note: "المساعد يقترح بس. ما يوصل شي للعميل إلا لما تعتمدين.",
      sg_bmr_ib: "BMR من InBody: {v}", sg_bmr_fat: "BMR من نسبة الدهون ({f}%): {v}", sg_bmr_std: "BMR بمعادلة Mifflin-St Jeor: {v}",
      sg_act: "× النشاط {m} = {v}", sg_goal_lose: "− 500 للنزول = {v}", sg_goal_gain: "+ 300 للزيادة = {v}", sg_goal_keep: "بدون تغيير (ثبات) = {v}",
      sg_min: "⚠️ المعادلة طلعت {v} — رفعتها للحد الأدنى {m}", sg_health: "⚠️ ملاحظات صحية: \"{h}\" — ما أقترح سعرات. هذا يحتاج مراجعتك.",
      sg_missing: "⚠️ ناقص معلومات ({f}). ما أقدر أحسب.", sg_dislike: "شلت {n} وصفات فيها أكل ما يحبه ({w})", sg_current: "سعراته الحالية: {v}",
      sg_kcal: "السعرات المقترحة", sg_use_kcal: "اعتمدي السعرات بس", sg_optA: "خيار أ: الأقرب للسعرات", sg_optB: "خيار ب: بروتين أعلى",
      sg_avg: "متوسط {k} سعرة · {p} جم بروتين", sg_portion: "ما فيه أيام كفاية ضمن ±150، الحصص بتتعدل ×{f}",
      sg_approve: "اعتمدي السعرات + الجداول", sg_replace: "متأكدة؟ هذا يبدل أيامه الحالية", sg_done: "✓ اعتمدتي — وصل للعميل",
      sg_day: "يوم", sg_inactive_note: "النشاط هو اللي اختاره العميل وقت التسجيل — تأكدي منه لو تغير."
    },
    en: {
      att_title: "👀 Need your attention", att_none: "All clients look fine today ✓",
      att_kcal: "Waiting for calories for {d} days", att_days: "Hasn't chosen 7 days for {d} days", att_idle: "Hasn't opened the app for {d} days",
      att_skip: "Skipping a lot (last 7 days: {s} skipped, {k} done)", att_ib: "InBody requested {d} days ago, no reply", att_pay: "Transfer receipt waiting for review", att_health: "Has health notes — review yourself",
      sg_title: "🤖 Agent suggestion", sg_btn: "Suggest calories & plans", sg_note: "The agent only suggests. Nothing reaches the client until you approve.",
      sg_bmr_ib: "BMR from InBody: {v}", sg_bmr_fat: "BMR from body fat ({f}%): {v}", sg_bmr_std: "BMR with Mifflin-St Jeor: {v}",
      sg_act: "× activity {m} = {v}", sg_goal_lose: "− 500 to lose = {v}", sg_goal_gain: "+ 300 to gain = {v}", sg_goal_keep: "no change (keep) = {v}",
      sg_min: "⚠️ Formula gave {v} — raised to the minimum {m}", sg_health: "⚠️ Health notes: \"{h}\" — no calorie suggestion. This needs your review.",
      sg_missing: "⚠️ Missing info ({f}). Can't calculate.", sg_dislike: "Removed {n} recipes with food they don't eat ({w})", sg_current: "Current calories: {v}",
      sg_kcal: "Suggested calories", sg_use_kcal: "Approve calories only", sg_optA: "Option A: closest to target", sg_optB: "Option B: more protein",
      sg_avg: "avg {k} kcal · {p} g protein", sg_portion: "Not enough days within ±150, portions will be scaled ×{f}",
      sg_approve: "Approve calories + plans", sg_replace: "Sure? This replaces their current days", sg_done: "✓ Approved — sent to the client",
      sg_day: "Day", sg_inactive_note: "Activity is what the client picked at sign-up — check it if it changed."
    }
  };
  const ag = (k, v) => { let s = (AG[LANG] || AG.en)[k] || AG.en[k]; for (const x in (v || {})) s = s.split("{" + x + "}").join(v[x]); return s; };
  const nrm = s => String(s || "").toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
  const daysSince = iso => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 864e5) : 0;

  // ---- rule 6: health notes that stop the calorie suggestion ----
  const HEALTH_STOP = ["حامل", "حمل", "رضاعه", "سكري", "السكر", "كلى", "كلي", "غده", "الغده", "دوا", "علاج", "ادويه", "اكل اضطراب", "فقدان الشهيه", "شره",
    "pregnan", "breastfeed", "diabet", "kidney", "thyroid", "medic", "eating disorder", "anorex", "bulim"];
  const EMPTY_NOTE = ["", "لا", "لايوجد", "لا يوجد", "ما فيه", "مافيه", "none", "no", "nothing", "-", "—"];
  function healthFlag(c) {
    const h = nrm(c.health).trim();
    if (EMPTY_NOTE.includes(h)) return null;
    return HEALTH_STOP.some(w => h.includes(nrm(w))) ? c.health : null;
  }
  // ---- rule 9: foods the client doesn't eat ----
  const FOOD_GROUPS = [
    ["سمك", "تونه", "سلمون", "fish", "tuna", "salmon"], ["بيض", "egg", "اومليت", "شكشوكه", "omelette", "shakshuka"],
    ["حليب", "لبن", "زبادي", "جبن", "لبنه", "حلوم", "dairy", "milk", "yogurt", "cheese", "labneh", "halloumi", "laban"],
    ["دجاج", "chicken"], ["لحم", "كفته", "beef", "kofta", "meat"], ["مكسرات", "لوز", "فول سوداني", "nuts", "almond", "peanut"],
    ["فطر", "مشروم", "mushroom"], ["تمر", "dates"], ["عدس", "lentil"], ["حمص", "hummus", "chickpea"]
  ];
  function dislikeWords(c) {
    const f = nrm(c.food); if (!f || EMPTY_NOTE.includes(f.trim())) return [];
    const out = new Set();
    FOOD_GROUPS.forEach(g => { if (g.some(w => f.includes(nrm(w)))) g.forEach(w => out.add(nrm(w))); });
    return [...out];
  }
  const allLangs = v => v == null ? "" : typeof v === "string" ? v : [v.ar, v.en].join(" ");
  const recipeText = r => nrm(allLangs(r.name) + " " + allLangs(r.ing));

  // ---- rules 2-5: the calorie number, step by step ----
  function suggestKcal(c, ib) {
    const missing = ["weight", "height", "age"].filter(k => !c[k]);
    if (missing.length) return { stop: ag("sg_missing", { f: missing.join(", ") }) };
    const h = healthFlag(c);
    if (h) return { stop: ag("sg_health", { h }) };
    const steps = []; let bmr;
    if (ib && ib.bmr) { bmr = ib.bmr; steps.push(ag("sg_bmr_ib", { v: bmr })); }
    else if (ib && ib.fat) { bmr = Math.round(370 + 21.6 * c.weight * (1 - ib.fat / 100)); steps.push(ag("sg_bmr_fat", { f: ib.fat, v: bmr })); }
    else { bmr = Math.round(10 * c.weight + 6.25 * c.height - 5 * c.age + (c.sex === "male" ? 5 : -161)); steps.push(ag("sg_bmr_std", { v: bmr })); }
    const act = +c.activity || 1.2; let v = Math.round(bmr * act); steps.push(ag("sg_act", { m: act, v }));
    if (c.goal === "lose") { v -= 500; steps.push(ag("sg_goal_lose", { v })); }
    else if (c.goal === "gain") { v += 300; steps.push(ag("sg_goal_gain", { v })); }
    else steps.push(ag("sg_goal_keep", { v }));
    v = Math.round(v / 10) * 10;
    const min = c.sex === "male" ? 1500 : 1200; const flags = [];
    if (v < min) { flags.push(ag("sg_min", { v, m: min })); v = min; }
    flags.push(ag("sg_inactive_note"));
    return { kcal: v, steps, flags };
  }

  // ---- rules 7-10: build 7 one-day plans ----
  function suggestPlans(c, target) {
    const bad = dislikeWords(c);
    const all = allRecipes();
    const ok = all.filter(r => !bad.some(w => recipeText(r).includes(w)));
    const removed = all.length - ok.length;
    const by = { b: [], l: [], d: [], s: [] }; ok.forEach(r => by[r.meal] && by[r.meal].push(r));
    const combos = [];
    for (const b of by.b) for (const l of by.l) for (const d of by.d)
      for (let i = 0; i < by.s.length; i++) for (let j = i + 1; j < by.s.length; j++) {
        const m = [b, by.s[i], l, by.s[j], d];
        combos.push({ meals: { b: b.id, s1: by.s[i].id, l: l.id, s2: by.s[j].id, d: d.id }, kcal: m.reduce((a, r) => a + r.kcal, 0), protein: m.reduce((a, r) => a + (r.protein || 0), 0) });
      }
    const inRange = combos.filter(x => Math.abs(x.kcal - target) <= MATCH_RANGE);
    const pool = inRange.length >= 7 ? inRange : combos;   // not enough → closest days, portions get scaled
    const pick = sorter => {
      const out = [], cnt = { b: {}, l: {}, d: {} };
      for (const x of pool.slice().sort(sorter)) {
        if (["b", "l", "d"].some(k => (cnt[k][x.meals[k]] || 0) >= 2)) continue;   // rule 10: same lunch/dinner max twice
        out.push(x); ["b", "l", "d"].forEach(k => cnt[k][x.meals[k]] = (cnt[k][x.meals[k]] || 0) + 1);
        if (out.length === 7) break;
      }
      return out;
    };
    const A = pick((x, y) => Math.abs(x.kcal - target) - Math.abs(y.kcal - target));
    const B = pick((x, y) => (y.protein - x.protein) || (Math.abs(x.kcal - target) - Math.abs(y.kcal - target)));
    const notes = [];
    if (removed) notes.push(ag("sg_dislike", { n: removed, w: c.food }));
    if (inRange.length < 7 && A.length) notes.push(ag("sg_portion", { f: portionFactor(target, A[0].meals) }));
    return { A, B, notes };
  }

  // ---- the suggestion card in the client's page ----
  const sgCard = document.createElement("div");
  sgCard.className = "card agent-card"; sgCard.id = "agent-card"; sgCard.style.marginTop = "12px";
  sgCard.innerHTML = '<h3 style="margin-top:0" id="sg-title"></h3><p class="muted" id="sg-note" style="margin-top:0"></p>' +
    '<button class="btn" id="sg-btn" type="button"></button><div id="sg-out"></div>';
  const kcalBox = document.querySelector(".kcal-set");
  kcalBox.closest(".card").after(sgCard);
  let sgState = null, sgOpt = "A", approveArmed = false;
  function sgLabels() { $("sg-title").textContent = ag("sg_title"); $("sg-note").textContent = ag("sg_note"); $("sg-btn").textContent = ag("sg_btn"); }
  sgLabels();
  async function runSuggest() {
    const c = clientById(openClient); if (!c) return;
    busy($("sg-btn"), true);
    let ib = null;
    try { const ibs = await DB.select("inbody", "select=*&user_id=eq." + c.id + "&order=date.desc"); ib = ibs[0] || null; } catch (e) {}
    const k = suggestKcal(c, ib);
    sgState = { id: c.id, k, plans: k.kcal ? suggestPlans(c, k.kcal) : null };
    sgOpt = "A"; approveArmed = false; renderSuggest();
    busy($("sg-btn"), false);
  }
  function renderSuggest() {
    const out = $("sg-out");
    if (!sgState || sgState.id !== openClient) { out.innerHTML = ""; return; }
    const c = clientById(openClient), { k, plans } = sgState;
    if (k.stop) { out.innerHTML = '<p class="note">' + esc(k.stop) + "</p>"; return; }
    const opt = plans[sgOpt] || [];
    const avgK = opt.length ? Math.round(opt.reduce((a, x) => a + x.kcal, 0) / opt.length) : 0;
    const avgP = opt.length ? Math.round(opt.reduce((a, x) => a + x.protein, 0) / opt.length) : 0;
    out.innerHTML =
      '<ol class="sg-steps">' + k.steps.map(s => "<li>" + esc(s) + "</li>").join("") + "</ol>" +
      '<div class="sg-kcal"><span class="muted small-label">' + esc(ag("sg_kcal")) + '</span><b><bdi dir="ltr">' + k.kcal + "</bdi> " + esc(t("kcal_short")) + "</b>" +
      (c.kcal ? ' <span class="muted">(' + esc(ag("sg_current", { v: c.kcal })) + ")</span>" : "") + "</div>" +
      k.flags.concat(plans.notes).map(f => '<p class="sg-flag">' + esc(f) + "</p>").join("") +
      '<div class="tabs" style="margin-top:10px"><button class="tab' + (sgOpt === "A" ? " active" : "") + '" data-sgopt="A">' + esc(ag("sg_optA")) + '</button><button class="tab' + (sgOpt === "B" ? " active" : "") + '" data-sgopt="B">' + esc(ag("sg_optB")) + "</button></div>" +
      '<p class="muted">' + esc(ag("sg_avg", { k: avgK, p: avgP })) + "</p>" +
      '<div class="mini-plans">' + opt.map((x, i) => '<div class="mini-plan"><b>' + esc(ag("sg_day")) + " " + (i + 1) + "</b> <small class='muted'>" + x.kcal + " " + esc(t("kcal_short")) + " · " + x.protein + "g</small>" + mealNamesHTML(x.meals) + "</div>").join("") + "</div>" +
      '<div class="btn-row" style="justify-content:flex-start;margin-top:12px"><button class="btn" id="sg-approve">' + esc(approveArmed ? ag("sg_replace") : ag("sg_approve")) + '</button><button class="btn outline" id="sg-kcal-only">' + esc(ag("sg_use_kcal")) + "</button></div>" +
      '<p class="muted" id="sg-msg"></p>';
    out.querySelectorAll("[data-sgopt]").forEach(b => b.addEventListener("click", () => { sgOpt = b.dataset.sgopt; approveArmed = false; renderSuggest(); }));
    $("sg-kcal-only").addEventListener("click", async () => { await changeClient({ kcal: k.kcal }); renderSuggest(); $("sg-msg").textContent = ag("sg_done"); });
    $("sg-approve").addEventListener("click", async () => {
      if ((c.plans || []).length && !approveArmed) { approveArmed = true; return renderSuggest(); }
      const newPlans = opt.map((x, i) => ({ name: String(k.kcal), kcal: k.kcal, meals: x.meals, source: "agent" }));
      approveArmed = false;
      await changeClient({ kcal: k.kcal, plans: newPlans, today: null });
      renderSuggest(); $("sg-msg").textContent = ag("sg_done");
    });
  }
  $("sg-btn").addEventListener("click", runSuggest);

  // ---- 2) clients who need attention ----
  const attCard = document.createElement("div");
  attCard.className = "card attention-card"; attCard.id = "attention-card"; attCard.style.marginBottom = "14px";
  $("clients-list").prepend(attCard);
  function lastActive(c) {
    const dates = (c.history || []).map(h => h.date).concat(c.today ? [c.today.date] : []).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }
  function attentionList() {
    const items = [];
    CLIENTS.forEach(c => {
      const add = (level, text) => items.push({ c, level, text });
      if (!isPaid(c)) { if (c.pay_status === "pending" && c.receipt_path) add(2, ag("att_pay")); return; }
      if (!c.kcal) { const d = daysSince(c.created_at); add(d >= 2 ? 3 : 2, ag("att_kcal", { d })); if (healthFlag(c)) add(3, ag("att_health")); return; }
      if ((c.plans || []).length < 7) { const d = daysSince(c.created_at); if (d >= 3) add(2, ag("att_days", { d })); return; }
      const la = lastActive(c);
      if (la) { const d = daysSince(la + "T12:00:00"); if (d >= 3) add(d >= 7 ? 3 : 2, ag("att_idle", { d })); }
      const last7 = (c.history || []).filter(h => !h.off).slice(-7);
      const s = last7.reduce((a, h) => a + (h.skipped || 0), 0), k = last7.reduce((a, h) => a + (h.done || 0), 0);
      if (last7.length >= 3 && s > k) add(2, ag("att_skip", { s, k }));
      if (c.inbody_requested && daysSince(c.inbody_requested_at) >= 5) add(1, ag("att_ib", { d: daysSince(c.inbody_requested_at) }));
    });
    return items.sort((a, b) => b.level - a.level);
  }
  function renderAttention() {
    const items = attentionList();
    attCard.innerHTML = '<h3 style="margin-top:0">' + esc(ag("att_title")) + "</h3>" +
      (items.length ? '<ul class="att-list">' + items.map(x => '<li class="lvl-' + x.level + '"><span class="grow"><b>' + esc(x.c.name) + "</b> — " + esc(x.text) + '</span><button class="btn outline small" data-att="' + esc(x.c.id) + '">' + esc(t("ad_open")) + "</button></li>").join("") + "</ul>"
        : '<p class="muted" style="margin:0">' + esc(ag("att_none")) + "</p>");
    attCard.hidden = !CLIENTS.length;
    attCard.querySelectorAll("[data-att]").forEach(b => b.addEventListener("click", () => { openClient = b.dataset.att; renderClients(); }));
  }
  document.addEventListener("langchange", () => { sgLabels(); renderSuggest(); });
  window.__agent = { suggestKcal, suggestPlans, attentionList, healthFlag, dislikeWords };   // used by the test file

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

// ===== Clients' site: hide sign-up for signed-in clients =====
if (!$("admin-view") && !$("login-form")) {
  (async () => {
    try {
      const u = await DB.user();
      if (!u) return;
      const rows = await DB.select("profiles", "select=id,role&id=eq." + u.id);
      const isClient = rows[0] && rows[0].role !== "admin";
      markSignedIn(isClient);
      // already has an account → the sign-up page sends them straight to their account
      if (isClient && $("info-form") && $("step-1").classList.contains("show")) location.replace("portal.html");
    } catch (e) {}
  })();
}
