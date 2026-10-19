/* ==========================================================================
   Pujo Hisab — script.js
   jQuery app logic: data loading, state, rendering, auth, modals, admin forms.

   Data flow:
     data.json is the single source of truth and is fetched fresh on every
     page load. Admin panel changes live in memory for the current session
     only — download the updated data.json and replace the file to keep them.
     (The app must be served over HTTP; browsers block fetch() on file://.)
   ========================================================================== */

(function ($) {
  "use strict";

  /* ------------------------------------------------------------------
     Config & constants
     ------------------------------------------------------------------ */
  const DATA_URL = "data.json";
  const AUTH_KEY = "pujoHisab.auth.v1";
  const SORT_KEY = "pujoHisab.sort.v1";
  // Keys from earlier versions that cached ledger data in localStorage
  const LEGACY_KEYS = ["pujoHisab.data.v1", "pujoHisab.meta.v1"];

  // NOTE: This is a static site, so these credentials are visible to anyone
  // who reads the source. Treat the login as a convenience lock, not security.
  const CREDENTIALS = { username: "sauvik", password: "helloWorld@01" };

  const SORT_MODES = [
    { key: "default", label: "Default" },
    { key: "high", label: "Highest" },
    { key: "low", label: "Lowest" },
    { key: "name", label: "A–Z" },
  ];

  /* ------------------------------------------------------------------
     App state
     ------------------------------------------------------------------ */
  const state = {
    data: null,          // { version, currency, updatedAt, people: [...] }
    unsaved: false,       // true once admin edits differ from data.json
    exported: false,      // true after edits were downloaded / copied
    activePersonId: null, // person shown in breakdown modal
    editingBillId: null,  // bill currently being edited inline
    search: "",
    sort: readStorage(SORT_KEY) || "default",
  };

  /* ------------------------------------------------------------------
     Small utilities
     ------------------------------------------------------------------ */

  /** Safe localStorage read (private mode / blocked storage may throw). */
  function readStorage(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStorage(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function removeStorage(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /** Escape user-provided text before injecting into HTML strings. */
  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Short unique id. */
  function uid(prefix) {
    return (prefix || "id") + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Turn a display name into a stable id slug. */
  function slugify(name) {
    return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "person";
  }

  /** Round to 2 decimals to dodge floating point noise (e.g. 0.1 + 0.2). */
  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  const numberFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

  /** ₹1,615 — absolute value with currency symbol. */
  function money(n) {
    const cur = (state.data && state.data.currency) || "₹";
    return cur + numberFmt.format(Math.abs(round2(n)));
  }

  /** +₹1,615 / −₹3,471 — signed value. */
  function signedMoney(n) {
    if (round2(n) === 0) return money(0);
    return (n > 0 ? "+" : "−") + money(n);
  }

  /** CSS class for a balance. */
  function toneClass(n) {
    const v = round2(n);
    return v > 0 ? "is-pos" : v < 0 ? "is-neg" : "is-zero";
  }

  function initials(name) {
    const parts = String(name).trim().split(/\s+/);
    const first = parts[0] ? parts[0][0] : "?";
    const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + second).toUpperCase();
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  function todayISO() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }

  /** Parse a user-entered amount like "1,076.50" -> 1076.5 (or NaN). */
  function parseAmount(raw) {
    const cleaned = String(raw).replace(/[₹,\s]/g, "");
    if (!/^\d*\.?\d+$/.test(cleaned)) return NaN;
    return round2(parseFloat(cleaned));
  }

  /* ------------------------------------------------------------------
     Data model helpers
     ------------------------------------------------------------------ */

  function balanceOf(person) {
    return round2(person.bills.reduce(function (sum, b) { return sum + Number(b.amount || 0); }, 0));
  }

  function findPerson(id) {
    return state.data.people.find(function (p) { return p.id === id; }) || null;
  }

  function totals() {
    let pos = 0, neg = 0;
    state.data.people.forEach(function (p) {
      const bal = balanceOf(p);
      if (bal > 0) pos += bal; else neg += bal;
    });
    return { pos: round2(pos), neg: round2(neg), net: round2(pos + neg) };
  }

  /**
   * Validate + normalise any incoming data (from storage, file or import).
   * Returns a clean object or throws an Error describing the problem.
   */
  function normalizeData(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.people)) {
      throw new Error("JSON must contain a \"people\" array.");
    }
    const seenIds = {};
    const people = raw.people.map(function (p, pi) {
      if (!p || typeof p.name !== "string" || !p.name.trim()) {
        throw new Error("Person #" + (pi + 1) + " is missing a name.");
      }
      let id = typeof p.id === "string" && p.id ? p.id : slugify(p.name);
      while (seenIds[id]) id = id + "-" + pi;
      seenIds[id] = true;

      const bills = (Array.isArray(p.bills) ? p.bills : []).map(function (b, bi) {
        const amount = Number(b && b.amount);
        if (!isFinite(amount)) {
          throw new Error("Bill #" + (bi + 1) + " for " + p.name + " has an invalid amount.");
        }
        const bill = {
          id: typeof b.id === "string" && b.id ? b.id : id + "-" + (bi + 1),
          amount: round2(amount),
          description: (typeof b.description === "string" && b.description.trim()) || "Shared Expense",
        };
        if (typeof b.date === "string" && b.date) bill.date = b.date;
        return bill;
      });

      return { id: id, name: p.name.trim(), bills: bills };
    });

    return {
      version: Number(raw.version) || 1,
      currency: typeof raw.currency === "string" && raw.currency ? raw.currency : "₹",
      updatedAt: raw.updatedAt || new Date().toISOString(),
      people: people,
    };
  }

  /** Apply an in-memory change (session only) and refresh the UI. */
  function commit(message) {
    state.data.updatedAt = new Date().toISOString();
    state.unsaved = true;
    renderAll();
    if (message) toast(message, "success");
  }

  /**
   * Fetch data.json fresh from the server (cache-busted on every call).
   * Rejects with a human-readable message if it can't be loaded or parsed.
   */
  function loadData() {
    const dfd = $.Deferred();
    $.ajax({ url: DATA_URL, dataType: "json", cache: false, timeout: 8000 })
      .done(function (json) {
        try { dfd.resolve(normalizeData(json)); }
        catch (e) { dfd.reject("data.json is invalid: " + e.message); }
      })
      .fail(function (xhr, status) {
        if (location.protocol === "file:") {
          dfd.reject("Browsers can't read data.json when index.html is opened directly. " +
            "Serve this folder instead, e.g. run \"python -m http.server\" here and open http://localhost:8000");
        } else if (status === "parsererror") {
          dfd.reject("data.json contains a JSON syntax error. Check for missing commas or quotes.");
        } else {
          dfd.reject("Couldn't load data.json (" + (xhr.status || status) + ").");
        }
      });
    return dfd.promise();
  }

  /* ------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------ */

  const ICON_CHEVRON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_EDIT =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  const ICON_TRASH =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderAll() {
    renderSummary();
    renderPeople();
    renderPersonSelect();
    renderDataPanel();
    updateBillPreview();
    if (state.activePersonId && $("#breakdownModal").is(":visible")) {
      renderBreakdown(state.activePersonId);
    }
  }

  function renderSummary() {
    const t = totals();
    $("#sumPos").text(money(t.pos));
    $("#sumNeg").text(money(t.neg));
    $("#sumNet").text(signedMoney(t.net));

    let hint = "All settled";
    if (t.net > 0) hint = "Overall, friends owe you";
    else if (t.net < 0) hint = "Overall, you owe friends";
    $("#sumNetHint").text(hint);
  }

  function sortedPeople() {
    const list = state.data.people.slice();
    switch (state.sort) {
      case "high": list.sort(function (a, b) { return balanceOf(b) - balanceOf(a); }); break;
      case "low": list.sort(function (a, b) { return balanceOf(a) - balanceOf(b); }); break;
      case "name": list.sort(function (a, b) { return a.name.localeCompare(b.name); }); break;
      default: break; // insertion order
    }
    return list;
  }

  function renderPeople() {
    const q = state.search.trim().toLowerCase();
    const people = sortedPeople().filter(function (p) {
      return !q || p.name.toLowerCase().indexOf(q) !== -1;
    });

    const html = people.map(function (p, i) {
      const bal = balanceOf(p);
      const tone = toneClass(bal);
      const n = p.bills.length;
      const status = bal > 0 ? "owes you" : bal < 0 ? "you owe" : "settled";
      return (
        '<li>' +
          '<button type="button" class="person-card" data-person="' + esc(p.id) + '" ' +
            'style="animation-delay:' + Math.min(i * 40, 400) + 'ms" ' +
            'aria-label="' + esc(p.name) + ', ' + esc(status) + ' ' + esc(money(bal)) + '. View breakdown">' +
            '<span class="avatar" aria-hidden="true">' + esc(initials(p.name)) + '</span>' +
            '<span class="person-info">' +
              '<span class="person-name">' + esc(p.name) + '</span>' +
              '<span class="person-meta">' + n + (n === 1 ? " bill" : " bills") + ' · ' + status + '</span>' +
            '</span>' +
            '<span class="amount-pill ' + tone + '">' + esc(signedMoney(bal)) + ICON_CHEVRON + '</span>' +
          '</button>' +
        '</li>'
      );
    }).join("");

    $("#peopleList").html(html);
    $("#emptyState")
      .prop("hidden", people.length > 0)
      .find("p").text(state.data.people.length ? "No friends match your search." : "No one here yet. Log in to add people.");

    const mode = SORT_MODES.find(function (m) { return m.key === state.sort; }) || SORT_MODES[0];
    $("#sortLabel").text(mode.label);
  }

  function renderPersonSelect() {
    const $sel = $("#billPerson");
    const current = $sel.val();
    const opts = state.data.people
      .slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name) + " (" + esc(signedMoney(balanceOf(p))) + ")</option>";
      });
    $sel.html(opts.length ? opts.join("") : '<option value="">Add a person first</option>');
    if (current && findPerson(current)) $sel.val(current);
  }

  function renderBreakdown(personId) {
    const p = findPerson(personId);
    if (!p) { closeModal($("#breakdownModal")); return; }

    const bal = balanceOf(p);
    const tone = toneClass(bal);

    $("#bdAvatar").text(initials(p.name));
    $("#bdName").text(p.name);
    $("#bdStatus").text(
      bal > 0 ? p.name + " owes you" : bal < 0 ? "You owe " + p.name : "All settled up"
    );
    $("#bdTotal").attr("class", "bd-total-value " + tone).text(signedMoney(bal));

    // Show the original arithmetic, e.g. "-6000 + 1076 + 508 = -4416"
    if (p.bills.length > 1) {
      const expr = p.bills.map(function (b, i) {
        const v = numberFmt.format(Math.abs(b.amount));
        if (i === 0) return (b.amount < 0 ? "−" : "") + v;
        return (b.amount < 0 ? "− " : "+ ") + v;
      }).join(" ");
      $("#bdFormula").text(expr + " = " + (bal < 0 ? "−" : "") + numberFmt.format(Math.abs(bal))).show();
    } else {
      $("#bdFormula").hide();
    }

    if (!p.bills.length) {
      $("#bdList").html('<li class="bill-empty">No bills yet.</li>');
      return;
    }

    const html = p.bills.map(function (b, i) {
      const t = toneClass(b.amount);

      // Inline editor for the bill being edited
      if (state.editingBillId === b.id) {
        return (
          '<li class="bill-item ' + t + '" data-bill="' + esc(b.id) + '">' +
            '<form class="bill-edit-form" data-bill="' + esc(b.id) + '">' +
              '<input type="text" name="description" maxlength="80" value="' + esc(b.description) + '" aria-label="Description" />' +
              '<div class="bill-edit-row">' +
                '<input type="text" name="amount" inputmode="decimal" value="' + esc(b.amount) + '" aria-label="Amount (use minus sign if you owe them)" />' +
                '<button type="button" class="btn btn-ghost bill-edit-cancel">Cancel</button>' +
                '<button type="submit" class="btn btn-gold">Save</button>' +
              '</div>' +
            '</form>' +
          '</li>'
        );
      }

      const date = formatDate(b.date);
      return (
        '<li class="bill-item ' + t + '" data-bill="' + esc(b.id) + '">' +
          '<span class="bill-index">' + (i + 1) + '</span>' +
          '<div class="bill-body">' +
            '<div class="bill-desc">' + esc(b.description) + '</div>' +
            (date ? '<div class="bill-date">' + esc(date) + '</div>' : '') +
          '</div>' +
          '<span class="bill-amount">' + esc(signedMoney(b.amount)) + '</span>' +
          '<div class="bill-actions">' +
            '<button type="button" class="bill-edit" aria-label="Edit bill">' + ICON_EDIT + '</button>' +
            '<button type="button" class="bill-del" aria-label="Delete bill">' + ICON_TRASH + '</button>' +
          '</div>' +
        '</li>'
      );
    }).join("");

    $("#bdList").html(html);
  }

  function renderDataPanel() {
    const json = JSON.stringify(state.data, null, 2);
    $("#jsonPreview").val(json);
    let status = "Showing data.json as loaded.";
    if (state.unsaved) status = "Unsaved changes — download data.json and replace the file in the project to keep them.";
    else if (state.exported) status = "Exported. Replace data.json in the project with the downloaded file to make it permanent.";
    $("#lastUpdated").text(status).toggleClass("is-unsaved", state.unsaved);
  }

  /* ------------------------------------------------------------------
     Views (Ledger / Admin)
     ------------------------------------------------------------------ */

  function showView(name) {
    if (name === "admin" && !isAdmin()) {
      openLogin(function () { showView("admin"); });
      return;
    }
    $(".view").prop("hidden", true).removeClass("is-active");
    $(name === "admin" ? "#viewAdmin" : "#viewLedger").prop("hidden", false).addClass("is-active");

    $(".tab").each(function () {
      const active = $(this).data("view") === name;
      $(this).toggleClass("is-active", active).attr("aria-current", active ? "page" : null);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ------------------------------------------------------------------
     Modals
     ------------------------------------------------------------------ */
  function openModal($modal) {
    // Remember what had focus so it can be restored when this modal closes
    $modal.data("lastFocus", document.activeElement);
    $modal.removeClass("is-closing").prop("hidden", false);
    $("body").addClass("modal-open");
    // Focus the first sensible control for keyboard / screen-reader users
    setTimeout(function () {
      const $focus = $modal.find("[autofocus], input:visible, .modal-sheet button:visible").first();
      if ($focus.length) $focus.trigger("focus");
    }, 60);
  }

  function closeModal($modal) {
    if ($modal.prop("hidden") || $modal.hasClass("is-closing")) return;
    $modal.addClass("is-closing");
    setTimeout(function () {
      $modal.prop("hidden", true).removeClass("is-closing");
      if (!$(".modal:not([hidden])").length) $("body").removeClass("modal-open");
      const lastFocus = $modal.data("lastFocus");
      if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
      $modal.trigger("modal:closed");
    }, 220);
  }

  /** Promise-based confirm dialog. */
  function confirmDialog(opts) {
    const dfd = $.Deferred();
    const $m = $("#confirmModal");
    $("#confirmTitle").text(opts.title || "Are you sure?");
    $("#confirmMsg").text(opts.message || "");
    $("#confirmOk").text(opts.okText || "Confirm");

    let decided = false;
    $("#confirmOk").off("click.confirm").on("click.confirm", function () {
      decided = true;
      closeModal($m);
      dfd.resolve();
    });
    $m.off("modal:closed.confirm").one("modal:closed.confirm", function () {
      if (!decided) dfd.reject();
    });

    openModal($m);
    return dfd.promise();
  }

  /* ------------------------------------------------------------------
     Toasts
     ------------------------------------------------------------------ */
  function toast(message, type) {
    const $t = $('<div class="toast"></div>').addClass(type ? "is-" + type : "").text(message);
    $("#toastStack").append($t);
    setTimeout(function () {
      $t.addClass("is-leaving");
      setTimeout(function () { $t.remove(); }, 260);
    }, 2600);
  }

  /* ------------------------------------------------------------------
     Authentication (client-side only)
     ------------------------------------------------------------------ */
  let afterLogin = null;

  function isAdmin() {
    try {
      const auth = JSON.parse(readStorage(AUTH_KEY) || "null");
      return !!(auth && auth.user === CREDENTIALS.username);
    } catch (e) { return false; }
  }

  function applyAuthUI() {
    const admin = isAdmin();
    $("body").toggleClass("is-admin", admin);
    $(".admin-badge").prop("hidden", !admin);
    $("#headerAuthBtn").attr("aria-label", admin ? "Log out" : "Admin login");
  }

  function openLogin(callback) {
    afterLogin = callback || null;
    $("#loginForm")[0].reset();
    $("#loginError").text("");
    $("#loginPass").attr("type", "password");
    $("#pwToggle").text("Show").attr("aria-label", "Show password");
    openModal($("#loginModal"));
  }

  function logout() {
    removeStorage(AUTH_KEY);
    state.editingBillId = null;
    applyAuthUI();
    showView("ledger");
    if (state.activePersonId) renderBreakdown(state.activePersonId);
    toast("Logged out");
  }

  /* ------------------------------------------------------------------
     Admin: add bill form
     ------------------------------------------------------------------ */

  function billSign() {
    return $("input[name='billType']:checked").val() === "neg" ? -1 : 1;
  }

  /** Live "balance before → after" preview under the add-bill form. */
  function updateBillPreview() {
    const p = findPerson($("#billPerson").val());
    const amt = parseAmount($("#billAmount").val());
    if (!p) { $("#billPreview").empty(); return; }

    const before = balanceOf(p);
    if (!isFinite(amt) || amt <= 0) {
      $("#billPreview").html(esc(p.name) + "'s balance: <strong>" + esc(signedMoney(before)) + "</strong>");
      return;
    }
    const after = round2(before + billSign() * amt);
    $("#billPreview").html(
      esc(p.name) + ": <strong>" + esc(signedMoney(before)) + "</strong> → <strong>" +
      esc(signedMoney(after)) + "</strong>"
    );
  }

  function setFieldError(inputId, message) {
    const $input = $("#" + inputId);
    $input.closest(".field").toggleClass("has-error", !!message);
    $input.attr("aria-invalid", message ? "true" : null);
    $('.field-error[data-for="' + inputId + '"]').text(message || "");
  }

  function handleAddBill(e) {
    e.preventDefault();
    const p = findPerson($("#billPerson").val());
    const amt = parseAmount($("#billAmount").val());

    if (!p) { toast("Add a person first.", "error"); $("#personName").trigger("focus"); return; }
    if (!isFinite(amt) || amt <= 0) {
      setFieldError("billAmount", "Enter an amount greater than 0.");
      $("#billAmount").trigger("focus");
      return;
    }
    setFieldError("billAmount", "");

    const bill = {
      id: uid(p.id),
      amount: round2(billSign() * amt),
      description: $.trim($("#billDesc").val()) || "Shared Expense",
    };
    const date = $("#billDate").val();
    if (date) bill.date = date;

    p.bills.push(bill);
    commit("Added " + signedMoney(bill.amount) + " for " + p.name);

    // Keep person + type selected for quick repeated entry
    $("#billAmount, #billDesc").val("");
    $("#billDate").val(todayISO());
    updateBillPreview();
  }

  /* ------------------------------------------------------------------
     Admin: add person form
     ------------------------------------------------------------------ */
  function handleAddPerson(e) {
    e.preventDefault();
    const name = $.trim($("#personName").val()).replace(/\s+/g, " ");

    if (!name) { setFieldError("personName", "Please enter a name."); return; }
    const exists = state.data.people.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); });
    if (exists) { setFieldError("personName", name + " is already in the list."); return; }
    setFieldError("personName", "");

    // Ensure a unique id
    let id = slugify(name), n = 2;
    while (findPerson(id)) id = slugify(name) + "-" + n++;

    state.data.people.push({ id: id, name: name, bills: [] });
    commit(name + " added");

    $("#personName").val("");
    // Pre-select the new person in the bill form and guide the user there
    $("#billPerson").val(id);
    updateBillPreview();
    $("#addBillForm")[0].scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(function () { $("#billAmount").trigger("focus"); }, 350);
  }

  /* ------------------------------------------------------------------
     Admin: data tools (copy / download / import / reset)
     ------------------------------------------------------------------ */
  function exportJSON() {
    return JSON.stringify(state.data, null, 2);
  }

  /** Once exported, stop warning about unsaved changes on page leave. */
  function markExported() {
    state.unsaved = false;
    state.exported = true;
    renderDataPanel();
  }

  function copyJSON() {
    const text = exportJSON();
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(function () { toast("JSON copied to clipboard", "success"); markExported(); })
        .catch(legacyCopy);
    } else {
      legacyCopy();
    }

    // Fallback for http:// or older mobile browsers
    function legacyCopy() {
      const $ta = $("#jsonPreview");
      $ta.closest("details").prop("open", true);
      $ta.val(text).trigger("focus").trigger("select");
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      toast(ok ? "JSON copied to clipboard" : "Select the JSON below and copy it manually", ok ? "success" : "error");
    }
  }

  function downloadJSON() {
    const blob = new Blob([exportJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const $a = $("<a>").attr({ href: url, download: "data.json" }).appendTo("body");
    $a[0].click();
    $a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("Downloaded — replace data.json in the project with this file", "success");
    markExported();
  }

  function importJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let incoming;
      try {
        incoming = normalizeData(JSON.parse(reader.result));
      } catch (err) {
        toast("Import failed: " + err.message, "error");
        return;
      }
      confirmDialog({
        title: "Replace current data?",
        message: "This will replace all " + state.data.people.length + " people in this session with " +
          incoming.people.length + " from the imported file.",
        okText: "Import",
      }).done(function () {
        state.data = incoming;
        commit("Data imported");
      });
    };
    reader.onerror = function () { toast("Couldn't read that file.", "error"); };
    reader.readAsText(file);
  }

  /** Discard session changes and re-read data.json from the server. */
  function reloadFromFile() {
    loadData()
      .done(function (data) {
        state.data = data;
        state.unsaved = false;
        state.exported = false;
        renderAll();
        toast("Reloaded data.json", "success");
      })
      .fail(function (msg) { toast(msg, "error"); });
  }

  function resetData() {
    if (!state.unsaved) { reloadFromFile(); return; }
    confirmDialog({
      title: "Discard unsaved changes?",
      message: "Changes made in this session will be lost and data.json will be loaded again.",
      okText: "Reload",
    }).done(reloadFromFile);
  }

  /* ------------------------------------------------------------------
     Breakdown modal actions (admin only)
     ------------------------------------------------------------------ */
  function openBreakdown(personId) {
    state.activePersonId = personId;
    state.editingBillId = null;
    renderBreakdown(personId);
    openModal($("#breakdownModal"));
  }

  function saveInlineEdit($form) {
    const p = findPerson(state.activePersonId);
    if (!p) return;
    const bill = p.bills.find(function (b) { return b.id === $form.data("bill"); });
    if (!bill) return;

    const raw = String($form.find("[name='amount']").val()).trim();
    const negative = /^[-−]/.test(raw);
    const amt = parseAmount(raw.replace(/^[-−+]/, ""));
    if (!isFinite(amt) || amt === 0) {
      toast("Enter a valid non-zero amount (prefix with − if you owe them).", "error");
      $form.find("[name='amount']").trigger("focus");
      return;
    }

    bill.amount = negative ? -amt : amt;
    bill.description = $.trim($form.find("[name='description']").val()) || "Shared Expense";
    state.editingBillId = null;
    commit("Bill updated");
  }

  /* ------------------------------------------------------------------
     Event wiring
     ------------------------------------------------------------------ */
  function bindEvents() {
    // --- Tabs ---
    $(".tabbar").on("click", ".tab", function () { showView($(this).data("view")); });

    // --- Header auth button: login or logout ---
    $("#headerAuthBtn").on("click", function () {
      if (isAdmin()) {
        confirmDialog({ title: "Log out?", message: "You'll need to log in again to make changes.", okText: "Log out" })
          .done(logout);
      } else {
        openLogin(function () { showView("admin"); });
      }
    });
    $("#logoutBtn").on("click", logout);

    // --- Search & sort ---
    $("#searchInput").on("input", function () {
      state.search = $(this).val();
      renderPeople();
    });
    $("#sortBtn").on("click", function () {
      const idx = SORT_MODES.findIndex(function (m) { return m.key === state.sort; });
      state.sort = SORT_MODES[(idx + 1) % SORT_MODES.length].key;
      writeStorage(SORT_KEY, state.sort);
      renderPeople();
    });

    // --- Open breakdown from a person card ---
    $("#peopleList").on("click", ".person-card", function () {
      openBreakdown($(this).data("person"));
    });

    // --- Generic modal close (backdrop, X, cancel) + Escape key ---
    $(document).on("click", ".modal [data-close]", function () {
      closeModal($(this).closest(".modal"));
    });
    $(document).on("keydown", function (e) {
      if (e.key === "Escape") {
        const $open = $(".modal:not([hidden])").last();
        if ($open.length) closeModal($open);
      }
    });
    $("#breakdownModal").on("modal:closed", function () {
      state.activePersonId = null;
      state.editingBillId = null;
    });

    // --- Login form ---
    $("#loginForm").on("submit", function (e) {
      e.preventDefault();
      const user = $.trim($("#loginUser").val());
      const pass = $("#loginPass").val();

      if (user === CREDENTIALS.username && pass === CREDENTIALS.password) {
        writeStorage(AUTH_KEY, JSON.stringify({ user: user, at: new Date().toISOString() }));
        applyAuthUI();
        closeModal($("#loginModal"));
        toast("Welcome back, " + user + "!", "success");
        if (state.activePersonId) renderBreakdown(state.activePersonId);
        const cb = afterLogin;
        afterLogin = null;
        if (cb) setTimeout(cb, 240);
      } else {
        $("#loginError").text("Incorrect username or password.");
        const $sheet = $("#loginModal .modal-sheet");
        $sheet.removeClass("shake");
        void $sheet[0].offsetWidth; // restart animation
        $sheet.addClass("shake");
        $("#loginPass").val("").trigger("focus");
      }
    });
    $("#pwToggle").on("click", function () {
      const $pw = $("#loginPass");
      const show = $pw.attr("type") === "password";
      $pw.attr("type", show ? "text" : "password");
      $(this).text(show ? "Hide" : "Show").attr("aria-label", show ? "Hide password" : "Show password");
    });

    // --- Admin forms ---
    $("#addBillForm").on("submit", handleAddBill);
    $("#addPersonForm").on("submit", handleAddPerson);
    $("#billPerson, input[name='billType']").on("change", updateBillPreview);
    $("#billAmount").on("input", function () {
      setFieldError("billAmount", "");
      updateBillPreview();
    });
    $("#personName").on("input", function () { setFieldError("personName", ""); });

    // --- Data tools ---
    $("#copyJsonBtn").on("click", copyJSON);
    $("#downloadJsonBtn").on("click", downloadJSON);
    $("#importJsonInput").on("change", function () {
      importJSON(this.files && this.files[0]);
      this.value = ""; // allow re-importing the same file
    });
    $("#resetDataBtn").on("click", resetData);

    // --- Breakdown modal: admin actions ---
    $("#bdList")
      .on("click", ".bill-edit", function () {
        state.editingBillId = $(this).closest(".bill-item").data("bill");
        renderBreakdown(state.activePersonId);
        $("#bdList .bill-edit-form input[name='description']").trigger("focus");
      })
      .on("click", ".bill-edit-cancel", function () {
        state.editingBillId = null;
        renderBreakdown(state.activePersonId);
      })
      .on("submit", ".bill-edit-form", function (e) {
        e.preventDefault();
        saveInlineEdit($(this));
      })
      .on("click", ".bill-del", function () {
        const p = findPerson(state.activePersonId);
        const billId = $(this).closest(".bill-item").data("bill");
        const bill = p && p.bills.find(function (b) { return b.id === billId; });
        if (!bill) return;
        confirmDialog({
          title: "Delete this bill?",
          message: bill.description + " · " + signedMoney(bill.amount) + " will be removed from " + p.name + ".",
          okText: "Delete",
        }).done(function () {
          p.bills = p.bills.filter(function (b) { return b.id !== billId; });
          commit("Bill deleted");
        });
      });

    $("#bdAddBillBtn").on("click", function () {
      const id = state.activePersonId;
      closeModal($("#breakdownModal"));
      showView("admin");
      $("#billPerson").val(id);
      updateBillPreview();
      setTimeout(function () { $("#billAmount").trigger("focus"); }, 300);
    });

    $("#bdDeletePersonBtn").on("click", function () {
      const p = findPerson(state.activePersonId);
      if (!p) return;
      confirmDialog({
        title: "Remove " + p.name + "?",
        message: "This deletes " + p.name + " and all " + p.bills.length + " of their bills (" +
          signedMoney(balanceOf(p)) + "). This can't be undone.",
        okText: "Remove",
      }).done(function () {
        state.data.people = state.data.people.filter(function (x) { return x.id !== p.id; });
        closeModal($("#breakdownModal"));
        commit(p.name + " removed");
      });
    });
  }

  /* ------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------ */
  $(function () {
    bindEvents();
    applyAuthUI();
    $("#billDate").val(todayISO());

    // Remove ledger data cached by earlier versions — data.json is the only source now
    LEGACY_KEYS.forEach(removeStorage);

    // Warn before leaving if admin edits haven't been exported
    $(window).on("beforeunload", function (e) {
      if (state.unsaved) {
        e.preventDefault();
        e.originalEvent.returnValue = "";
        return "";
      }
    });

    loadData()
      .done(function (data) {
        state.data = data;
        renderAll();
        $("#loader").remove();
        showView("ledger");
      })
      .fail(function (msg) {
        $("#loader")
          .addClass("is-error")
          .html('<strong>Couldn\'t load your ledger</strong><span></span>')
          .find("span").text(msg);
      });
  });
})(jQuery);
