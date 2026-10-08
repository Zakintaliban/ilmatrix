import type { Context } from "hono";
import { PLANS } from "../config/plans.js";
import { getCatalog, isPaymentsEnabled } from "../services/paymentService.js";

/**
 * Public pricing page (/harga), rendered on the server from the same catalogue
 * checkout charges, so prices are visible without JavaScript and can't drift.
 */

export const CONTACT_EMAIL = "hasbizakin0804@gmail.com";

const escape = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

export function renderPricingPage(): string {
  const catalog = getCatalog();
  const free = PLANS.free;
  const paymentsOn = isPaymentsEnabled();

  const card = (item: { code: string; kind: string; name: string; priceIdr: number; description: string }) => `
          <li class="flex flex-col rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
            <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${item.kind === "plan" ? "Paket langganan" : "Kredit tambahan"}</p>
            <h3 class="mt-1 text-lg font-semibold">${escape(item.name)}</h3>
            <p class="mt-2 text-3xl font-bold">${escape(rupiah(item.priceIdr))}</p>
            <p class="mt-3 flex-1 text-sm text-gray-600 dark:text-gray-300">${escape(item.description)}.${
              item.kind === "plan" ? " Bayar sekali, tidak diperpanjang otomatis." : ""
            }</p>
            <a href="/checkout.html?product=${encodeURIComponent(item.code)}" class="mt-6 rounded-md bg-primary px-4 py-2 text-center text-sm font-semibold text-white hover:opacity-90">Beli ${escape(item.name)}</a>
          </li>`;

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="./logo.svg" />
    <title>Harga - ILMATRIX</title>
    <meta name="description" content="Harga ILMATRIX: asisten belajar AI untuk mahasiswa. Gratis 150 kredit per minggu, Pass 7 Hari ${escape(rupiah(9900))}, paket Bulanan dan Semester. Bayar dengan QRIS dan e-wallet.">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = { darkMode: 'class', theme: { extend: { fontFamily: { sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'] }, colors: { primary: "#0f0e85", secondary: "#e44c99", tertiary: "#1b612f" } } } };
        (function () { let saved = null; try { saved = localStorage.getItem('theme'); } catch {} if (saved ? saved === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark'); })();
    </script>
</head>
<body class="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white">
    <header class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-800">
        <div class="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
            <a href="/" class="text-lg font-bold text-primary dark:text-blue-300">ILMATRIX</a>
            <nav class="flex gap-4 text-sm text-gray-600 dark:text-gray-300">
                <a href="/app" class="hover:underline">Aplikasi</a>
                <a href="/about" class="hover:underline">Tentang</a>
                <a href="/login.html" class="hover:underline">Masuk</a>
            </nav>
        </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 py-10">
        <h1 class="text-3xl font-bold">Harga ILMATRIX</h1>
        <p class="mt-3 max-w-3xl text-gray-700 dark:text-gray-300">
            ILMATRIX adalah asisten belajar berbasis AI untuk mahasiswa. Unggah materi kuliahmu (PDF, PPTX, DOCX, foto),
            lalu minta penjelasan, kuis pilihan ganda, flashcard, latihan diskusi, dan persiapan ujian yang bersumber dari
            materimu sendiri. Setiap fitur AI memakai <strong>kredit</strong>.
        </p>

        <section class="mt-8" aria-labelledby="kredit-title">
            <h2 id="kredit-title" class="text-xl font-semibold">Cara kerja kredit</h2>
            <ul class="mt-3 list-disc pl-5 text-sm text-gray-700 dark:text-gray-300 space-y-1">
                <li>Contoh pemakaian: satu penjelasan materi sekitar 9 kredit, kuis 10 soal sekitar 17 kredit, membaca foto/gambar sekitar 36 kredit.</li>
                <li>Kredit mingguan dari paket terisi lagi setiap Senin pukul 07.00 WIB. Kredit tambahan (Pass dan Top-up) dipakai setelah kredit mingguan habis, sesuai masa berlakunya.</li>
                <li>Semua harga dalam Rupiah dan sudah final. Kredit tidak dapat diuangkan atau dipindahkan ke akun lain.</li>
            </ul>
        </section>

        <section class="mt-10" aria-labelledby="produk-title">
            <h2 id="produk-title" class="text-xl font-semibold">Pilihan</h2>
            <ul class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <li class="flex flex-col rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
            <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Paket</p>
            <h3 class="mt-1 text-lg font-semibold">${escape(free.name)}</h3>
            <p class="mt-2 text-3xl font-bold">${escape(rupiah(0))}</p>
            <p class="mt-3 flex-1 text-sm text-gray-600 dark:text-gray-300">${escape(free.weeklyKredit.toLocaleString("id-ID"))} kredit per minggu. Cukup daftar dengan email.</p>
            <a href="/register.html" class="mt-6 rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-center text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-700">Daftar gratis</a>
          </li>${catalog.map(card).join("")}
            </ul>
            ${paymentsOn ? "" : `<p class="mt-4 text-sm text-gray-600 dark:text-gray-300">Pembayaran online sedang disiapkan. Untuk membeli sekarang, hubungi kami di <a class="underline" href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>`}
        </section>

        <section class="mt-10" aria-labelledby="cara-title">
            <h2 id="cara-title" class="text-xl font-semibold">Cara membeli</h2>
            <ol class="mt-3 list-decimal pl-5 text-sm text-gray-700 dark:text-gray-300 space-y-1">
                <li>Daftar atau masuk ke akun ILMATRIX.</li>
                <li>Pilih produk di atas, lalu tekan <strong>Beli</strong>.</li>
                <li>Di halaman checkout ILMATRIX, bayar lewat jendela pembayaran Midtrans (QRIS, e-wallet, atau metode lain yang tersedia).</li>
                <li>Kredit atau paket aktif otomatis setelah pembayaran diterima. Riwayat pembayaran ada di Dashboard.</li>
            </ol>
            <p class="mt-3 text-sm text-gray-700 dark:text-gray-300">
                Pembelian tunduk pada <a class="underline" href="/syarat-ketentuan.html">Syarat &amp; Ketentuan</a> dan
                <a class="underline" href="/kebijakan-pengembalian.html">Kebijakan Pengembalian Dana</a>.
            </p>
        </section>

        <section id="kontak" class="mt-10" aria-labelledby="kontak-title">
            <h2 id="kontak-title" class="text-xl font-semibold">Kontak</h2>
            <p class="mt-3 text-sm text-gray-700 dark:text-gray-300">
                Pertanyaan tentang produk, pembayaran, atau pengembalian dana:
                <a class="font-semibold underline" href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
            </p>
        </section>
    </main>

    <footer class="border-t border-gray-200 dark:border-gray-800">
        <div class="mx-auto max-w-5xl px-4 py-6 text-xs text-gray-600 dark:text-gray-400 flex flex-wrap gap-x-4 gap-y-2">
            <span>© ILMATRIX</span>
            <a href="/syarat-ketentuan.html" class="hover:underline">Syarat &amp; Ketentuan</a>
            <a href="/kebijakan-pengembalian.html" class="hover:underline">Kebijakan Pengembalian Dana</a>
            <span>Kontak: <a href="mailto:${CONTACT_EMAIL}" class="hover:underline">${CONTACT_EMAIL}</a></span>
        </div>
    </footer>
</body>
</html>`;
}

export function pricingPage(c: Context) {
  return c.html(renderPricingPage());
}
