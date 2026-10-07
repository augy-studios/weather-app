// Shared UI helpers. Plain script, not a module: published on window.UwuUI.

(function () {
  const { icon } = window.UwuIcons;

  // Safe to call repeatedly; re-renders when data-icon changes.
  function hydrateIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach((el) => {
      const name = el.dataset.icon;
      if (el.dataset.iconRendered === name) return;
      el.innerHTML = icon(name);
      el.dataset.iconRendered = name;
    });
  }

  // Focus moves into a modal when it opens and back to whatever opened it when it
  // closes, so a keyboard reader isn't left behind the backdrop.
  const openers = {};

  function openModal(id) {
    const backdrop = document.getElementById(id);
    openers[id] = document.activeElement;
    backdrop.classList.remove("hidden");
    document.body.classList.add("modal-open");
    backdrop.querySelector("[data-close-modal]")?.focus();
  }

  function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
    if (!document.querySelector(".modal-backdrop:not(.hidden)")) {
      document.body.classList.remove("modal-open");
    }
    openers[id]?.focus?.();
    delete openers[id];
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

  window.UwuUI = { hydrateIcons, openModal, closeModal, esc };
})();
