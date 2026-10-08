/**
 * Guest verification (Cloudflare Turnstile).
 *
 * Wraps window.fetch: when an /api/ call answers 401 GUEST_VERIFICATION_REQUIRED,
 * runs one Turnstile challenge (shared by concurrent requests), sends the token to
 * /api/guest/verify and retries the original request. Signed-in users never see it.
 * If verification fails the caller gets a 403 JSON response with a readable
 * `error`/`answer`, so existing error handling shows the message.
 */
(function () {
  if (window.__guestVerifyInstalled) return;
  window.__guestVerifyInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  const FAILED_MESSAGE = "Verifikasi gagal. Muat ulang halaman lalu coba lagi.";
  const CANCELLED_MESSAGE = "Verifikasi dibatalkan. Coba lagi kapan saja.";

  let scriptPromise = null;
  let pending = null;

  function isApiRequest(input) {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      return url.origin === window.location.origin && url.pathname.startsWith("/api/");
    } catch (_) {
      return false;
    }
  }

  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!scriptPromise) {
      scriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = SCRIPT_URL;
        script.onload = () =>
          window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile unavailable"));
        script.onerror = () => {
          script.remove();
          scriptPromise = null;
          reject(new Error("Turnstile failed to load"));
        };
        document.head.appendChild(script);
      });
    }
    return scriptPromise;
  }

  function getDialog() {
    let dialog = document.getElementById("guest-verify-dialog");
    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = "guest-verify-dialog";
    dialog.setAttribute("aria-labelledby", "guest-verify-title");
    dialog.setAttribute("aria-describedby", "guest-verify-status");
    dialog.className =
      "rounded-xl max-w-sm w-[calc(100%-2rem)] p-6 text-center bg-white text-gray-900 dark:bg-gray-800 dark:text-white backdrop:bg-black/50";
    dialog.innerHTML = `
      <h2 id="guest-verify-title" class="text-lg font-bold mb-2">Memastikan kamu bukan bot…</h2>
      <p id="guest-verify-status" class="text-sm text-gray-600 dark:text-gray-300 mb-4" role="status">
        Biasanya selesai otomatis dalam beberapa detik.
      </p>
      <div id="guest-verify-widget" class="flex justify-center min-h-0"></div>
      <form method="dialog" class="mt-4">
        <button value="cancel" class="text-sm text-gray-600 dark:text-gray-400 py-2 px-4 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700">
          Batal
        </button>
      </form>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  class VerificationError extends Error {
    constructor(message, response) {
      super(message);
      this.response = response;
    }
  }

  async function verify(siteKey) {
    const dialog = getDialog();
    const status = dialog.querySelector("#guest-verify-status");
    const widget = dialog.querySelector("#guest-verify-widget");
    status.textContent = "Biasanya selesai otomatis dalam beberapa detik.";
    widget.replaceChildren();
    if (!dialog.open) dialog.showModal();

    let widgetId = null;
    let onClose = null;
    try {
      let turnstile;
      try {
        turnstile = await loadTurnstile();
      } catch (_) {
        throw new VerificationError(FAILED_MESSAGE);
      }

      const token = await new Promise((resolve, reject) => {
        onClose = () => reject(new VerificationError(CANCELLED_MESSAGE));
        dialog.addEventListener("close", onClose, { once: true });
        widgetId = turnstile.render(widget, {
          sitekey: siteKey,
          appearance: "interaction-only",
          retry: "never",
          callback: resolve,
          "error-callback": () => {
            reject(new VerificationError(FAILED_MESSAGE));
            return true;
          },
          "timeout-callback": () => reject(new VerificationError(FAILED_MESSAGE)),
        });
      });

      status.textContent = "Memverifikasi…";
      const res = await nativeFetch("/api/guest/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) return;

      // Network-wide guest cap: hand back the same 401 the app already shows as "sign up".
      if (data && data.requiresAuth) throw new VerificationError(data.error, jsonResponse(data, 401));
      throw new VerificationError((data && data.error) || FAILED_MESSAGE);
    } finally {
      if (onClose) dialog.removeEventListener("close", onClose);
      if (widgetId !== null && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch (_) {
          /* widget already gone */
        }
      }
      if (dialog.open) dialog.close();
    }
  }

  window.fetch = async function (input, init) {
    if (!isApiRequest(input)) return nativeFetch(input, init);

    // A Request body can only be read once; keep a copy for the retry.
    const retryInput = input instanceof Request ? input.clone() : input;
    const res = await nativeFetch(input, init);
    if (res.status !== 401) return res;

    let data;
    try {
      data = await res.clone().json();
    } catch (_) {
      return res;
    }
    if (!data || data.code !== "GUEST_VERIFICATION_REQUIRED" || !data.turnstile_site_key) return res;
    if (init && init.body instanceof ReadableStream) return res;

    try {
      if (!pending) pending = verify(data.turnstile_site_key).finally(() => (pending = null));
      await pending;
    } catch (error) {
      if (error instanceof VerificationError && error.response) return error.response.clone();
      const message = (error instanceof VerificationError && error.message) || FAILED_MESSAGE;
      return jsonResponse({ error: message, answer: message, code: "GUEST_VERIFICATION_FAILED" }, 403);
    }
    return nativeFetch(retryInput, init);
  };
})();
