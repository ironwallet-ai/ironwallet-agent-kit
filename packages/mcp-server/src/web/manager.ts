/**
 * Local browser-based wallet manager. An MCP tool starts this and hands the
 * user a URL; the seed phrase is only ever typed into / shown by this page in
 * the user's browser and never crosses the agent boundary.
 *
 * Security posture:
 *   - binds 127.0.0.1 only,
 *   - all routes live under an unguessable random token path (a capability),
 *   - the server self-destructs after a period of inactivity.
 *
 * The keystore passphrase is resolved locally (generated on first use). Forms
 * only ask for wallet name / mnemonic / count.
 *
 * Deleting a wallet is a manager-only action (no MCP tool): it is irreversible
 * and destroys the local copy of a seed, so it needs a human on a separate
 * confirmation page rather than an agent acting on a chat phrase.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadKeystore,
  getEntry,
  importWallet,
  createWallets,
  revealMnemonic,
  markBackedUp,
  removeWallet,
} from "../keystore/store.js";
import { requirePassphrase } from "../passphrase.js";
import { logError, logInfo } from "../log.js";
import {
  depositCaption,
  depositPayload,
  renderDepositQrPng,
  uniqueDepositTargets,
  walletOwnsDeposit,
} from "../qr/deposit-qr.js";
import type { NetworkId } from "../networks.js";
import {
  CONSENT_BULLETS,
  CONSENT_CHECKBOX,
  CONSENT_LEAD,
  CONSENT_TITLE,
} from "../consent/copy.js";
import { hasCurrentConsent, recordConsent } from "../consent/store.js";

const INACTIVITY_MS = 15 * 60 * 1000;

interface Manager {
  url: string;
  server: Server;
}

let current: Manager | null = null;
let inactivityTimer: NodeJS.Timeout | null = null;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JS string literal safe to embed inside an inline <script> (no `</script>` break-out). */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028|\u2029/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

function armInactivityTimer(): void {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => shutdown(), INACTIVITY_MS);
  inactivityTimer.unref?.();
}

function shutdown(): void {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = null;
  const c = current;
  current = null;
  c?.server.close();
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

/**
 * Visual language mirrors the IronWallet mobile app (lib/themes):
 *   - surfaces #FAFAFA / cards #FFFFFF, text #1B2028 / muted #9498A5,
 *   - signature UI gradient #3650AB → #2A81A6 (buttons, accents),
 *   - logo gradient #2C32BA → #0BB4EA (wordmark),
 *   - 10px cards, 14px inputs/buttons, 48px button height,
 *   - full dark theme (#1B2028 bg / #31353F cards) via prefers-color-scheme.
 */
const STYLE = `
  :root {
    --bg:#FAFAFA; --surface:#FFFFFF; --surface-2:#F4F5F7;
    --text:#1B2028; --text-2:#686869; --muted:#9498A5;
    --border:#E5E8EB; --primary:#396DC3;
    --ui-grad:linear-gradient(135deg,#3650AB 0%,#2A81A6 100%);
    --logo-grad:linear-gradient(135deg,#2C32BA 0%,#0BB4EA 100%);
    --success:#51BF9D; --success-bg:#DCF2EB;
    --warning:#F18827; --warning-bg:#FCE7D4;
    --danger:#F04E58;
    --shadow:0 1px 2px rgba(27,32,40,.06), 0 8px 24px rgba(27,32,40,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#1B2028; --surface:#31353F; --surface-2:#272B33;
      --text:#FFFFFF; --text-2:#E5E8EB; --muted:#9498A5;
      --border:#3A3F4A; --primary:#3C72C9;
      --logo-grad:linear-gradient(135deg,#2B2FA0 0%,#169FCA 100%);
      --success-bg:#20362F; --warning-bg:#3A2A18;
      --shadow:0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.25);
    }
  }
  * { box-sizing:border-box; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--bg); color:var(--text); margin:0;
    padding:32px 16px 64px; line-height:1.45; -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:760px; margin:0 auto; }
  .hero {
    display:flex; flex-direction:column; align-items:center; text-align:center;
    gap:6px; padding:12px 0 20px; margin-bottom:4px;
  }
  .hero .wordmark { height:34px; width:auto; display:block; }
  .hero .knight {
    height:200px; width:auto; margin:6px 0 2px;
    filter:drop-shadow(0 12px 24px rgba(27,32,40,.14));
  }
  .hero-tag { color:var(--text-2); font-size:14px; margin:0; max-width:360px; }
  @media (max-width:520px) { .hero .knight { height:168px; } }
  h2 { font-size:16px; font-weight:600; margin:0 0 4px; }
  .section-hint { color:var(--muted); font-size:13px; margin:0 0 14px; }
  .card {
    background:var(--surface); border:1px solid var(--border); border-radius:14px;
    padding:18px 20px; margin:16px 0; box-shadow:var(--shadow);
  }
  .ok { color:var(--success); } .warn { color:var(--warning); } .err { color:var(--danger); }

  /* wallet list */
  .wallet { padding:14px 0; border-bottom:1px solid var(--border); }
  .wallet:last-child { border-bottom:0; padding-bottom:0; }
  .wallet:first-child { padding-top:0; }
  .wallet-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
  .wallet-name { font-size:16px; font-weight:600; display:flex; align-items:center; gap:10px; }
  .avatar {
    width:28px; height:28px; border-radius:9px; background:var(--ui-grad);
    display:grid; place-items:center; color:#fff; font-size:13px; font-weight:700; flex:none;
  }
  .badge {
    font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px;
    display:inline-flex; align-items:center; gap:5px;
  }
  .badge.ok { background:var(--success-bg); color:var(--success); }
  .badge.warn { background:var(--warning-bg); color:var(--warning); }

  .addr { display:flex; align-items:center; gap:10px; padding:8px 0; }
  .net {
    font-size:11px; font-weight:700; color:var(--muted); min-width:42px; flex:none;
    text-transform:uppercase; letter-spacing:.4px;
  }
  .addr code {
    flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    background:var(--surface-2); border:1px solid var(--border); border-radius:9px;
    padding:8px 10px; font-size:13px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--text);
  }
  .copy, .qr {
    flex:none; margin:0; padding:8px 12px; font-size:12px; font-weight:600;
    background:var(--surface-2); color:var(--primary); border:1px solid var(--border);
    border-radius:9px; cursor:pointer;
  }
  .copy:hover, .qr:hover { border-color:var(--primary); }
  .copy.copied { color:var(--success); border-color:var(--success); }
  .qr-modal {
    display:none; position:fixed; inset:0; z-index:40; padding:20px;
    background:rgba(27,32,40,.55); place-items:center;
  }
  .qr-modal.open { display:grid; }
  .qr-dialog {
    background:var(--surface); border:1px solid var(--border); border-radius:16px;
    padding:16px; box-shadow:var(--shadow); max-width:min(480px,100%); width:100%;
  }
  .qr-dialog img { width:100%; height:auto; display:block; border-radius:12px; background:#fafafa; }
  .qr-dialog .qr-actions { display:flex; justify-content:flex-end; margin-top:12px; }

  label { display:block; font-size:13px; color:var(--text-2); margin:14px 0 6px; }
  input, textarea, button { font:inherit; }
  input, textarea {
    width:100%; background:var(--surface-2); color:var(--text);
    border:1px solid var(--border); border-radius:14px; padding:11px 14px;
  }
  input:focus, textarea:focus { outline:none; border-color:var(--primary); }
  textarea { min-height:72px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  button.btn {
    margin-top:16px; height:48px; padding:0 22px; background:var(--ui-grad); color:#fff;
    border:0; border-radius:14px; font-size:15px; font-weight:600; cursor:pointer;
    box-shadow:var(--shadow);
  }
  button.btn:hover { filter:brightness(1.05); }
  button.btn:disabled { opacity:.45; cursor:not-allowed; filter:none; }
  .consent-list { margin:12px 0 0; padding-left:20px; color:var(--text); }
  .consent-list li { margin:8px 0; }
  .consent-check {
    display:flex; align-items:flex-start; gap:10px; margin:18px 0 8px; font-size:14px;
  }
  .consent-check input { width:auto; margin-top:3px; accent-color:var(--primary); }
  .consent-actions { display:flex; align-items:center; gap:16px; margin-top:8px; }
  .consent-actions .btn { margin-top:0; }
  .consent-cancel { color:var(--muted); font-size:14px; }
  button.ghost {
    margin:0; height:auto; padding:8px 14px; background:transparent; color:var(--primary);
    border:1px solid var(--border); border-radius:10px; font-size:13px; font-weight:600;
    cursor:pointer; box-shadow:none;
  }
  button.ghost:hover { border-color:var(--primary); }
  button.ghost.danger { color:var(--danger); }
  button.ghost.danger:hover { border-color:var(--danger); }
  button.btn.danger { background:var(--danger); }
  .notice {
    background:var(--success-bg); color:var(--success); border-radius:14px;
    padding:12px 16px; margin:0 0 16px; font-size:14px; font-weight:600;
  }

  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  ol.words {
    columns:3; column-gap:14px; margin:6px 0 0; padding:0; list-style:none; counter-reset:w;
  }
  ol.words li {
    counter-increment:w; display:flex; align-items:center; gap:8px; margin:6px 0;
    background:var(--surface-2); border:1px solid var(--border); border-radius:10px;
    padding:8px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:14px;
  }
  ol.words li::before {
    content:counter(w); color:var(--muted); font-size:11px; font-family:inherit;
    min-width:16px; text-align:right;
  }
  .empty { color:var(--muted); font-size:14px; text-align:center; padding:18px 0; }
  a.back { color:var(--primary); font-size:14px; font-weight:600; text-decoration:none; }
  a.back:hover { text-decoration:underline; }
  @media (max-width:480px) { ol.words { columns:2; } }
`;

const PAGE_SCRIPT = `
<script>
document.addEventListener('click', function(e){
  var copy = e.target.closest('.copy');
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.addr).then(function(){
      var t = copy.textContent; copy.textContent = 'Copied'; copy.classList.add('copied');
      setTimeout(function(){ copy.textContent = t; copy.classList.remove('copied'); }, 1200);
    });
    return;
  }
  var qr = e.target.closest('.qr');
  var modal = document.getElementById('qr-modal');
  var img = document.getElementById('qr-img');
  if (qr && modal && img) {
    img.src = qr.dataset.src;
    modal.classList.add('open');
    return;
  }
  if (e.target.id === 'qr-modal' || e.target.closest('#qr-close')) {
    if (modal) modal.classList.remove('open');
    if (img) img.removeAttribute('src');
  }
});
document.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  var modal = document.getElementById('qr-modal');
  var img = document.getElementById('qr-img');
  if (modal) modal.classList.remove('open');
  if (img) img.removeAttribute('src');
});
</script>`;

function layout(token: string, title: string, inner: string, showBack = true): string {
  const back = showBack
    ? `<p style="margin-top:28px"><a class="back" href="/${token}">&larr; Back to wallets</a></p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>
<div class="wrap">
<div class="hero">
  <img class="wordmark" src="/${token}/assets/wordmark.svg" alt="IronWallet">
  <img class="knight" src="/${token}/assets/knight.png" alt="" aria-hidden="true">
  <p class="hero-tag">Local wallet manager — keys never leave this machine</p>
</div>
${inner}
${back}
</div>
<div id="qr-modal" class="qr-modal" role="dialog" aria-modal="true" aria-label="Deposit QR">
  <div class="qr-dialog">
    <img id="qr-img" alt="Deposit QR">
    <div class="qr-actions"><button class="ghost" id="qr-close" type="button">Close</button></div>
  </div>
</div>
${PAGE_SCRIPT}
</body></html>`;
}

function initials(name: string): string {
  const s = name.trim();
  return (s.slice(0, 2) || "IW").toUpperCase();
}

function walletCard(token: string, w: { name: string; backedUp?: boolean; addresses: Record<string, string> }): string {
  const backed = w.backedUp
    ? '<span class="badge ok">Backed up</span>'
    : '<span class="badge warn">Not backed up</span>';
  const addrs = renderAddresses(token, w.addresses);
  return `<div class="wallet">
  <div class="wallet-head">
    <div class="wallet-name"><span class="avatar">${escapeHtml(initials(w.name))}</span>${escapeHtml(w.name)}</div>
    <div style="display:flex;align-items:center;gap:10px">
      ${backed}
      <form method="POST" action="/${token}/backup" style="margin:0">
        <input type="hidden" name="name" value="${escapeHtml(w.name)}">
        <button class="ghost" type="submit">Reveal phrase</button>
      </form>
      <form method="POST" action="/${token}/delete" style="margin:0">
        <input type="hidden" name="name" value="${escapeHtml(w.name)}">
        <button class="ghost danger" type="submit">Delete</button>
      </form>
    </div>
  </div>
  ${addrs}
</div>`;
}

/**
 * Deletion is confirmed on a separate page, never inline: the user retypes the
 * wallet name, and for a wallet that was never backed up also acknowledges that
 * the recovery phrase is about to be destroyed. The server re-checks both.
 */
function deleteConfirmPage(
  token: string,
  w: { name: string; backedUp?: boolean; addresses: Record<string, string> },
  notice = "",
): string {
  const err = notice ? `<p class="err">${escapeHtml(notice)}</p>` : "";
  const seedWarning = w.backedUp
    ? ""
    : `<label class="consent-check">
      <input id="delete-seed" type="checkbox" name="lose_seed" value="1" required>
      <span>This wallet was never backed up. Deleting it destroys the only copy of its recovery phrase. I understand any funds on these addresses will be unrecoverable.</span>
    </label>`;
  return layout(
    token,
    `Delete "${w.name}"`,
    `<div class="card">
  <h2 style="margin-top:0" class="err">Delete "${escapeHtml(w.name)}"?</h2>
  <p>This removes the encrypted seed of this wallet from this machine. Funds are not moved: anything on these addresses stays on-chain and can only be reached again by importing the recovery phrase. The manager does not check balances before deleting.</p>
  ${addressesBlock(token, w.addresses)}
  ${err}
  <form method="POST" action="/${token}/delete/confirm" id="delete-form">
    <input type="hidden" name="name" value="${escapeHtml(w.name)}">
    ${seedWarning}
    <label>Type the wallet name to confirm</label>
    <input id="delete-confirm" name="confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(w.name)}" required>
    <div class="consent-actions" style="margin-top:16px">
      <button class="btn danger" id="delete-go" type="submit" disabled>Delete wallet</button>
      <a class="back" href="/${token}">Cancel</a>
    </div>
  </form>
</div>
<script>
(function(){
  var name = ${jsString(w.name)};
  var input = document.getElementById('delete-confirm');
  var seed = document.getElementById('delete-seed');
  var go = document.getElementById('delete-go');
  if (!input || !go) return;
  function sync(){ go.disabled = input.value.trim() !== name || (seed ? !seed.checked : false); }
  input.addEventListener('input', sync);
  if (seed) seed.addEventListener('change', sync);
  sync();
})();
</script>`,
    false,
  );
}

function netLabel(net: string): string {
  const map: Record<string, string> = {
    ethereum: "EVM",
    bsc: "BSC",
    polygon: "POL",
    base: "BASE",
    arbitrum: "ARB",
    optimism: "OP",
    avalanche: "AVAX",
    tron: "TRON",
    bitcoin: "BTC",
    litecoin: "LTC",
    doge: "DOGE",
    solana: "SOL",
    ton: "TON",
    xrp: "XRP",
  };
  return map[net] ?? net.toUpperCase();
}

function addressRow(token: string, net: string, addr: string): string {
  const src = `/${token}/qr?network=${encodeURIComponent(net)}&address=${encodeURIComponent(addr)}`;
  return `<div class="addr">
  <span class="net">${escapeHtml(netLabel(net))}</span>
  <code title="${escapeHtml(addr)}">${escapeHtml(addr)}</code>
  <button class="copy" data-addr="${escapeHtml(addr)}" type="button">Copy</button>
  <button class="qr" data-src="${escapeHtml(src)}" type="button">QR</button>
</div>`;
}

/**
 * Render one row per *unique* address. All EVM chains share the same address, so
 * collapsing avoids repeating the same value 7 times; the first network that
 * produced a given address supplies the label (ethereum → EVM, bitcoin → BTC).
 */
function renderAddresses(token: string, addresses: Record<string, string>): string {
  return uniqueDepositTargets(addresses)
    .map((t) => addressRow(token, t.network, t.address))
    .join("");
}

function consentPage(token: string, notice = ""): string {
  const bullets = CONSENT_BULLETS.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
  const err = notice ? `<p class="err">${escapeHtml(notice)}</p>` : "";
  return layout(
    token,
    CONSENT_TITLE,
    `<div class="card">
  <h2 style="margin-top:0">${escapeHtml(CONSENT_TITLE)}</h2>
  <p>${escapeHtml(CONSENT_LEAD)}</p>
  <ul class="consent-list">${bullets}</ul>
  ${err}
  <form method="POST" action="/${token}/consent" id="consent-form">
    <label class="consent-check">
      <input id="consent-box" type="checkbox" name="understood" value="1" required>
      <span>${escapeHtml(CONSENT_CHECKBOX)}</span>
    </label>
    <div class="consent-actions">
      <button class="btn" id="consent-go" type="submit" disabled>Continue</button>
      <span class="consent-cancel">Close this tab to cancel.</span>
    </div>
  </form>
</div>
<script>
(function(){
  var box = document.getElementById('consent-box');
  var go = document.getElementById('consent-go');
  if (!box || !go) return;
  function sync(){ go.disabled = !box.checked; }
  box.addEventListener('change', sync);
  sync();
})();
</script>`,
    false,
  );
}

function dashboard(token: string, notice = ""): string {
  const ks = loadKeystore();
  const list = ks.wallets.length
    ? ks.wallets.map((w) => walletCard(token, w)).join("")
    : '<div class="empty">No wallets yet. Import or create one below.</div>';
  const banner = notice ? `<div class="notice">${escapeHtml(notice)}</div>` : "";

  return layout(
    token,
    "IronWallet manager",
    `${banner}
<div class="card">
  <h2>Your wallets</h2>
  <p class="section-hint">${ks.wallets.length} wallet${ks.wallets.length === 1 ? "" : "s"} · Copy or QR to receive</p>
  ${list}
</div>

<div class="card">
  <h2>Import an existing wallet</h2>
  <p class="section-hint">Your recovery phrase is encrypted locally and never sent anywhere.</p>
  <form method="POST" action="/${token}/import">
    <label>Name (optional)</label>
    <input name="name" placeholder="e.g. trading" autocomplete="off">
    <label>Recovery phrase (12 or 24 words)</label>
    <textarea name="mnemonic" placeholder="word1 word2 …" autocomplete="off" spellcheck="false"></textarea>
    <button class="btn" type="submit">Import wallet</button>
  </form>
</div>

<div class="card">
  <h2>Create new wallet(s)</h2>
  <p class="section-hint">Fresh keys are generated on this machine. Back them up right after.</p>
  <form method="POST" action="/${token}/create">
    <label>How many</label>
    <input name="count" type="number" min="1" max="50" value="1">
    <label>Name prefix (optional)</label>
    <input name="prefix" placeholder="e.g. agent-hot" autocomplete="off">
    <button class="btn" type="submit">Create wallet</button>
  </form>
</div>`,
    false,
  );
}

function wordsBlock(mnemonic: string): string {
  const words = mnemonic.split(/\s+/).filter(Boolean);
  return `<ol class="words">${words
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("")}</ol>`;
}

function addressesBlock(token: string, addresses: Record<string, string>): string {
  return renderAddresses(token, addresses);
}

/**
 * POST → 303 → GET so the browser lands on a real, refreshable URL. Rendering
 * the dashboard straight from the POST left the tab on /consent, where Refresh
 * either re-posted the form or (Safari, bfcache) showed a stale wallet list.
 */
function redirect(res: import("node:http").ServerResponse, location: string): void {
  res.writeHead(303, {
    Location: location,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end();
}

function html(res: import("node:http").ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

/** Static brand assets bundled with the package (see package.json "files"). */
const ASSETS: Record<string, { file: string; type: string }> = {
  "wordmark.svg": { file: "wordmark.svg", type: "image/svg+xml" },
  "knight.png": { file: "knight.png", type: "image/png" },
};

function serveAsset(res: import("node:http").ServerResponse, name: string): boolean {
  const asset = ASSETS[name];
  if (!asset) return false;
  try {
    // compiled at dist/web/manager.js → package root is two levels up.
    const path = fileURLToPath(new URL(`../../assets/${asset.file}`, import.meta.url));
    const buf = readFileSync(path);
    res.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "max-age=3600",
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/** Stop the manager now instead of waiting for the inactivity timeout (tests, shutdown). */
export function closeManager(): void {
  shutdown();
}

/** Start the manager (or reuse a running one) and return its base URL. */
export async function ensureManager(): Promise<string> {
  if (current) {
    armInactivityTimer();
    logInfo("manager.reuse", { url: current.url });
    return current.url;
  }

  const token = randomBytes(16).toString("hex");
  const base = `/${token}`;
  logInfo("manager.start", { base });

  const server = createServer((req, res) => {
    armInactivityTimer();
    const url = (req.url ?? "").split("?")[0];
    if (!url.startsWith(base)) {
      html(res, 404, "not found");
      return;
    }
    const sub = url.slice(base.length) || "/";
    const method = req.method ?? "GET";
    logInfo("manager.request", { method, path: sub });

    void (async () => {
      try {
        if (method === "GET" && sub === "/") {
          if (!hasCurrentConsent()) {
            html(res, 200, consentPage(token));
            return;
          }
          const deleted = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("deleted");
          html(res, 200, dashboard(token, deleted ? `Deleted "${deleted}".` : ""));
          return;
        }

        if (method === "POST" && sub === "/consent") {
          const form = await readForm(req);
          if (form.understood !== "1" && form.understood !== "on") {
            html(res, 400, consentPage(token, "Check the box to continue."));
            return;
          }
          recordConsent("manager");
          logInfo("manager.consent.ok", {});
          redirect(res, `${base}/`);
          return;
        }

        // A stale /consent URL (bookmark, history, refresh after the redirect
        // was blocked) should land on the live dashboard, not on 404.
        if (method === "GET" && sub === "/consent") {
          redirect(res, `${base}/`);
          return;
        }

        if (method === "GET" && sub.startsWith("/assets/")) {
          const name = sub.slice("/assets/".length);
          if (serveAsset(res, name)) return;
          html(res, 404, "not found");
          return;
        }

        if (method === "GET" && sub === "/qr") {
          const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
          const network = parsed.searchParams.get("network") ?? "";
          const address = parsed.searchParams.get("address") ?? "";
          const owner = loadKeystore().wallets.find((w) =>
            walletOwnsDeposit(w.addresses, network, address),
          );
          if (!owner) {
            html(
              res,
              404,
              layout(
                token,
                "Not found",
                `<div class="card"><p class="err">Unknown address.</p></div>`,
              ),
            );
            return;
          }
          // The dashboard lists one row per address (EVM collapsed), so the
          // caption should say the same thing the row does.
          const target =
            uniqueDepositTargets(owner.addresses).find(
              (t) => t.network === network && t.address === address,
            ) ?? { network: network as NetworkId, address };
          const png = await renderDepositQrPng(
            address,
            depositPayload(network, address),
            depositCaption(target),
          );
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "no-store, no-cache, must-revalidate, private",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(png);
          return;
        }

        if (method === "POST" && sub === "/import") {
          if (!hasCurrentConsent()) {
            html(res, 403, consentPage(token, "Accept the disclaimer before importing a wallet."));
            return;
          }
          const form = await readForm(req);
          const created = importWallet(
            form.mnemonic ?? "",
            requirePassphrase(),
            form.name?.trim() || undefined,
          );
          logInfo("manager.import.ok", { name: created.name, addresses: created.addresses });
          html(
            res,
            200,
            layout(
              token,
              "Imported",
              `<div class="card"><h2 style="margin-top:0" class="ok">Imported "${escapeHtml(
                created.name,
              )}"</h2><p>Addresses:</p>${addressesBlock(token, created.addresses)}</div>`,
            ),
          );
          return;
        }

        if (method === "POST" && sub === "/create") {
          if (!hasCurrentConsent()) {
            html(res, 403, consentPage(token, "Accept the disclaimer before creating a wallet."));
            return;
          }
          const form = await readForm(req);
          const count = Math.max(1, Math.min(50, parseInt(form.count ?? "1", 10) || 1));
          const created = createWallets(count, requirePassphrase(), {
            namePrefix: form.prefix?.trim() || undefined,
            revealMnemonic: true,
          });
          const blocks = created
            .map(
              (c) =>
                `<div class="card"><h2 style="margin-top:0">${escapeHtml(
                  c.name,
                )}</h2><p class="warn">Write these words down offline. The wallet stays marked as not backed up until you use Reveal phrase.</p>${wordsBlock(
                  c.mnemonic ?? "",
                )}<p>Addresses:</p>${addressesBlock(token, c.addresses)}</div>`,
            )
            .join("");
          logInfo("manager.create.ok", {
            count: created.length,
            names: created.map((c) => c.name),
          });
          html(res, 200, layout(token, "Created", blocks));
          return;
        }

        if (method === "POST" && sub === "/backup") {
          const form = await readForm(req);
          const name = form.name ?? "";
          const mnemonic = revealMnemonic(name, requirePassphrase());
          markBackedUp(name);
          logInfo("manager.backup.ok", {
            name,
            wordCount: mnemonic.trim().split(/\s+/).length,
          });
          html(
            res,
            200,
            layout(
              token,
              "Backup",
              `<div class="card"><h2 style="margin-top:0">Recovery phrase for "${escapeHtml(
                name,
              )}"</h2><p class="warn">Anyone with these words controls the funds. Keep them offline.</p>${wordsBlock(
                mnemonic,
              )}</div>`,
            ),
          );
          return;
        }

        // Step 1: the Delete button on a card only opens the confirmation page.
        if (method === "POST" && sub === "/delete") {
          if (!hasCurrentConsent()) {
            html(res, 403, consentPage(token, "Accept the disclaimer before deleting a wallet."));
            return;
          }
          const form = await readForm(req);
          const entry = getEntry(form.name ?? "");
          if (!entry) {
            redirect(res, `${base}/`);
            return;
          }
          html(res, 200, deleteConfirmPage(token, entry));
          return;
        }

        // Step 2: typed name (and, for never-backed-up wallets, the seed
        // acknowledgement) are validated here regardless of the page's JS.
        if (method === "POST" && sub === "/delete/confirm") {
          if (!hasCurrentConsent()) {
            html(res, 403, consentPage(token, "Accept the disclaimer before deleting a wallet."));
            return;
          }
          const form = await readForm(req);
          const entry = getEntry(form.name ?? "");
          if (!entry) {
            redirect(res, `${base}/`);
            return;
          }
          if ((form.confirm ?? "").trim() !== entry.name) {
            html(res, 400, deleteConfirmPage(token, entry, "The name you typed does not match."));
            return;
          }
          if (!entry.backedUp && form.lose_seed !== "1" && form.lose_seed !== "on") {
            html(
              res,
              400,
              deleteConfirmPage(token, entry, "Confirm that you understand the recovery phrase will be destroyed."),
            );
            return;
          }
          removeWallet(entry.name);
          logInfo("manager.delete.ok", { name: entry.name, backedUp: entry.backedUp });
          redirect(res, `${base}/?deleted=${encodeURIComponent(entry.name)}`);
          return;
        }

        // Stale delete URLs (refresh on the confirmation page) go back to the list.
        if (method === "GET" && (sub === "/delete" || sub === "/delete/confirm")) {
          redirect(res, `${base}/`);
          return;
        }

        html(res, 404, "not found");
      } catch (e) {
        logError("manager.request.fail", e, { method, path: sub });
        const message = e instanceof Error ? e.message : String(e);
        html(
          res,
          400,
          layout(
            token,
            "Error",
            `<div class="card"><p class="err">Error: ${escapeHtml(message)}</p></div>`,
          ),
        );
      }
    })();
  });

  return new Promise<string>((resolve, reject) => {
    server.on("error", (e) => {
      logError("manager.listen.fail", e, {});
      reject(e);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("failed to bind manager server"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${base}`;
      current = { url, server };
      armInactivityTimer();
      logInfo("manager.listen.ok", { url });
      resolve(url);
    });
  });
}
