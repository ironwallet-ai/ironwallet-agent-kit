/**
 * Deposit QR: payment URI in the code, IW mark in the middle, address under it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { ALL_NETWORKS, isEvmNetwork, type NetworkId } from "../config.js";
import { networkLabel } from "../networks.js";
import { GLYPH_H, GLYPH_W, glyph } from "./font.js";

const QR_PX = 440;
const TEXT_SCALE = 2;
const TITLE_SCALE = 3;
const FOOTER_PX = 56;
const HEADER_PAD = 16;
/** Space between the caption block and the top of the QR quiet zone. */
const HEADER_GAP = 10;
const LOGO_RATIO = 0.2;
const TEXT = [0x1b, 0x20, 0x28, 0xff] as const;
const MUTED = [0x68, 0x68, 0x69, 0xff] as const;
const WHITE = [0xff, 0xff, 0xff, 0xff] as const;
const PAGE = [0xfa, 0xfa, 0xfa, 0xff] as const;

export interface DepositTarget {
  network: NetworkId;
  address: string;
  /**
   * Other networks in the wallet that use the same address (EVM chains). Set
   * only when targets were collapsed by address, so the caption can say the
   * one 0x… code works on all of them.
   */
  sharedWith?: NetworkId[];
}

/** Text drawn on the PNG: network name above the code, address below. */
export interface DepositCaption {
  title: string;
  subtitle?: string;
}

export function depositCaption(target: DepositTarget): DepositCaption {
  const title = networkLabel(target.network);
  const shared = target.sharedWith ?? [];
  if (shared.length === 0) return { title };
  return {
    title,
    subtitle: `Same address on ${shared.map(networkLabel).join(", ")}`,
  };
}

/** One line for JSON / chat: "Ethereum (same address on BSC, Polygon, …)". */
export function depositLabel(target: DepositTarget): string {
  const c = depositCaption(target);
  return c.subtitle ? `${c.title} (${c.subtitle[0].toLowerCase()}${c.subtitle.slice(1)})` : c.title;
}

export function depositPayload(network: string, address: string): string {
  const a = address.trim();
  switch (network) {
    case "bitcoin":
      return `bitcoin:${a}`;
    case "litecoin":
      return `litecoin:${a}`;
    case "doge":
      return `dogecoin:${a}`;
    case "tron":
      return `tron:${a}`;
    case "solana":
      return `solana:${a}`;
    case "ton":
      return `ton://transfer/${encodeURIComponent(a)}`;
    case "xrp":
      return `xrpl:${a}`;
    default:
      if (isEvmNetwork(network as NetworkId)) return `ethereum:${a}`;
      return a;
  }
}

/** Local manager PNG for one deposit target (`ensureManager()` base URL). */
export function depositQrUrl(baseUrl: string, network: string, address: string): string {
  const root = baseUrl.replace(/\/$/, "");
  return `${root}/qr?network=${encodeURIComponent(network)}&address=${encodeURIComponent(address)}`;
}

/** One row per unique address; EVM chains share a key so they collapse. */
export function uniqueDepositTargets(
  addresses: Record<string, string>,
): DepositTarget[] {
  const byAddress = new Map<string, DepositTarget>();
  const out: DepositTarget[] = [];
  const order = [
    ...ALL_NETWORKS,
    ...Object.keys(addresses).filter((k) => !ALL_NETWORKS.includes(k as NetworkId)),
  ];
  for (const net of order) {
    const address = addresses[net];
    if (!address) continue;
    const existing = byAddress.get(address);
    if (existing) {
      (existing.sharedWith ??= []).push(net as NetworkId);
      continue;
    }
    const target: DepositTarget = { network: net as NetworkId, address };
    byAddress.set(address, target);
    out.push(target);
  }
  return out;
}

/** Targets for one QR (a named network) or one per unique address. */
export function selectDepositTargets(
  addresses: Record<string, string>,
  network?: NetworkId,
): DepositTarget[] {
  if (network) {
    const address = addresses[network];
    if (!address) throw new Error(`Wallet has no ${network} address.`);
    return [{ network, address }];
  }
  const targets = uniqueDepositTargets(addresses);
  if (!targets.length) throw new Error("Wallet has no addresses.");
  return targets;
}

export function walletOwnsDeposit(
  addresses: Record<string, string>,
  network: string,
  address: string,
): boolean {
  return Boolean(network && address && addresses[network] === address);
}

function logoPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "logo-mark.png");
}

function setPx(img: PNG, x: number, y: number, rgba: readonly number[]): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (img.width * y + x) << 2;
  img.data[i] = rgba[0];
  img.data[i + 1] = rgba[1];
  img.data[i + 2] = rgba[2];
  img.data[i + 3] = rgba[3];
}

function fillRect(
  img: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: readonly number[],
): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) setPx(img, xx, yy, rgba);
  }
}

function fillRoundRect(
  img: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  rgba: readonly number[],
): void {
  const rr = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const dx = xx < x + rr ? x + rr - xx : xx >= x + w - rr ? xx - (x + w - 1 - rr) : 0;
      const dy = yy < y + rr ? y + rr - yy : yy >= y + h - rr ? yy - (y + h - 1 - rr) : 0;
      if (dx && dy && dx * dx + dy * dy > rr * rr) continue;
      setPx(img, xx, yy, rgba);
    }
  }
}

function blitScaled(dst: PNG, src: PNG, dx: number, dy: number, dw: number, dh: number): void {
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
      const si = (src.width * sy + sx) << 2;
      const a = src.data[si + 3];
      if (a === 0) continue;
      if (a === 255) {
        setPx(dst, dx + x, dy + y, [
          src.data[si],
          src.data[si + 1],
          src.data[si + 2],
          255,
        ]);
        continue;
      }
      const di = (dst.width * (dy + y) + (dx + x)) << 2;
      const inv = 255 - a;
      dst.data[di] = (src.data[si] * a + dst.data[di] * inv) / 255;
      dst.data[di + 1] = (src.data[si + 1] * a + dst.data[di + 1] * inv) / 255;
      dst.data[di + 2] = (src.data[si + 2] * a + dst.data[di + 2] * inv) / 255;
      dst.data[di + 3] = 255;
    }
  }
}

/** Break on spaces when possible (captions); hard-split otherwise (addresses). */
function wrapText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (word.length > maxChars) {
      if (current) lines.push(current);
      current = "";
      for (let i = 0; i < word.length; i += maxChars) {
        const chunk = word.slice(i, i + maxChars);
        if (chunk.length === maxChars) lines.push(chunk);
        else current = chunk;
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawTextLine(
  img: PNG,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: readonly number[] = TEXT,
): void {
  let cx = x;
  for (const ch of text) {
    const rows = glyph(ch);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const bits = rows[gy] ?? 0;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (bits & (1 << (GLYPH_W - 1 - gx))) {
          fillRect(img, cx + gx * scale, y + gy * scale, scale, scale, color);
        }
      }
    }
    cx += (GLYPH_W + 1) * scale;
  }
}

function lineHeight(scale: number): number {
  return (GLYPH_H + 2) * scale;
}

function wrapForWidth(text: string, width: number, scale: number): string[] {
  const charW = (GLYPH_W + 1) * scale;
  const maxChars = Math.max(8, Math.floor((width - 24) / charW));
  return wrapText(text, maxChars);
}

/** Draws the lines and returns the y just below them. */
function drawCenteredLines(
  img: PNG,
  text: string,
  top: number,
  scale: number,
  color: readonly number[] = TEXT,
): number {
  const charW = (GLYPH_W + 1) * scale;
  const lines = wrapForWidth(text, img.width, scale);
  let y = top;
  for (const line of lines) {
    const w = line.length * charW - scale;
    const x = Math.max(12, Math.floor((img.width - w) / 2));
    drawTextLine(img, line, x, y, scale, color);
    y += lineHeight(scale);
  }
  return y;
}

/**
 * Deposit PNG layout, top to bottom: network name (and the "same address on…"
 * note for a collapsed EVM address), the QR with the IW mark, the address.
 * The network has to be on the image itself — when several QRs land in a chat
 * the JSON next to them is not what a person scanning the code is looking at.
 */
export async function renderDepositQrPng(
  address: string,
  payload: string,
  caption: DepositCaption,
): Promise<Buffer> {
  const qrBuf = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: "H",
    type: "png",
    margin: 2,
    width: QR_PX,
    color: { dark: "#1B2028", light: "#FFFFFF" },
  });
  const qr = PNG.sync.read(qrBuf);
  const logo = PNG.sync.read(readFileSync(logoPath()));

  const charW = (GLYPH_W + 1) * TEXT_SCALE;
  const width = Math.max(QR_PX, address.length * charW + 24);
  const titleLines = wrapForWidth(caption.title, width, TITLE_SCALE).length;
  const subtitleLines = caption.subtitle
    ? wrapForWidth(caption.subtitle, width, TEXT_SCALE).length
    : 0;
  const headerPx =
    HEADER_PAD +
    titleLines * lineHeight(TITLE_SCALE) +
    (subtitleLines > 0 ? 4 + subtitleLines * lineHeight(TEXT_SCALE) : 0) +
    HEADER_GAP;
  const height = headerPx + QR_PX + FOOTER_PX;
  const out = new PNG({ width, height });
  fillRect(out, 0, 0, out.width, out.height, PAGE);

  let y = drawCenteredLines(out, caption.title, HEADER_PAD, TITLE_SCALE);
  if (caption.subtitle) {
    drawCenteredLines(out, caption.subtitle, y + 4, TEXT_SCALE, MUTED);
  }

  const ox = Math.floor((width - qr.width) / 2);
  const oy = headerPx;
  for (let yy = 0; yy < qr.height; yy++) {
    for (let x = 0; x < qr.width; x++) {
      const si = (qr.width * yy + x) << 2;
      setPx(out, ox + x, oy + yy, [qr.data[si], qr.data[si + 1], qr.data[si + 2], 255]);
    }
  }

  const logoBox = Math.round(QR_PX * LOGO_RATIO);
  const pad = Math.round(logoBox * 0.18);
  const lx = ox + Math.round((QR_PX - logoBox) / 2);
  const ly = oy + Math.round((QR_PX - logoBox) / 2);
  fillRoundRect(out, lx - pad, ly - pad, logoBox + pad * 2, logoBox + pad * 2, pad, WHITE);
  blitScaled(out, logo, lx, ly, logoBox, logoBox);
  drawCenteredLines(out, address, oy + QR_PX + 18, TEXT_SCALE);

  return PNG.sync.write(out);
}
