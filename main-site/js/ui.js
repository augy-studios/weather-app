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

  function openModal(id) {
    document.getElementById(id).classList.remove("hidden");
    document.body.classList.add("modal-open");
  }

  function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
    if (!document.querySelector(".modal-backdrop:not(.hidden)")) {
      document.body.classList.remove("modal-open");
    }
  }

  window.UwuUI = { hydrateIcons, openModal, closeModal };
})();
