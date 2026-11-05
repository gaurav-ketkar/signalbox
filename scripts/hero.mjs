// Builds docs/hero-light.svg and docs/hero-dark.svg. Run: node scripts/hero.mjs
import { writeFileSync } from "node:fs";
const themes = {
  light: { bg:"#ffffff", panel:"#f6f8fa", border:"#d1d9e0", fg:"#1f2328", muted:"#59636e", faint:"#818b98", noise:"#afb8c1",
    accent:"#0969da", accentSoft:"#ddf4ff", box:"#1f2328", boxFg:"#ffffff", boxMuted:"#9198a1", p1:"#cf222e", p1Soft:"#ffebe9", fyi:"#1a7f37", fyiSoft:"#dafbe1", latest:"#8250df", latestSoft:"#fbefff", card:"#ffffff" },
  dark: { bg:"#0d1117", panel:"#151b23", border:"#3d444d", fg:"#f0f6fc", muted:"#9198a1", faint:"#656c76", noise:"#3d444d",
    accent:"#4493f8", accentSoft:"#121d2f", box:"#f0f6fc", boxFg:"#0d1117", boxMuted:"#59636e", p1:"#ff7b72", p1Soft:"#2d1517", fyi:"#3fb950", fyiSoft:"#12261e", latest:"#ab7df8", latestSoft:"#211a33", card:"#0d1117" },
};
const W = 1200, H = 360, BX = 520, BW = 160, BY = 120, BH = 120, cy = BY + BH / 2;
const font = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
// Noise: fragments of a busy inbox, scattered and tilted.
const frags = [
  ["Bump lodash from 4.17.21 to 4.17.22", 36, 62, -3, 13],
  ["CI: 3 checks failed", 336, 56, 4, 12],
  ["re: re: Re: standup notes", 70, 112, 2, 12],
  ["+1", 400, 104, -9, 15],
  ["dependabot opened #4812", 236, 146, -3, 12],
  ["LGTM 👀", 120, 168, 5, 13],
  ["nit: trailing whitespace", 30, 226, -2, 12],
  ["Weekly digest: 214 new", 262, 222, 4, 12],
  ["@team can someone look?", 96, 270, 3, 13],
  ["👍", 428, 262, 0, 15],
  ["Closed as duplicate", 312, 296, -5, 12],
  ["bot: nightly build #993", 34, 322, -3, 12],
  ["subscribed via team", 236, 336, 2, 11],
];
// Particles flowing into the intake slit.
const seeds = [[-6, 90], [-6, 300], [-6, 190], [-6, 40], [-6, 240], [-6, 140], [-6, 330], [-6, 60]];
// Jagged random-walk static, deterministic.
let s = 7; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
const jag = () => { let d = `M2 ${cy}`; for (let x = 10; x < BX; x += 7) { const spike = rnd() < .18 ? 2.4 : 1; d += ` L${x} ${(cy + (rnd() - .5) * 64 * spike).toFixed(1)}`; } return d + ` L${BX} ${cy}`; };
// Clean signal: one smooth pulse from the outlet to the right edge.
const ox = BX + BW, fork = ox + 140, CX = 860, CH = 58, mids = [75, 180, 285];
const pulse = `M${ox} ${cy} L${ox + 20} ${cy} C${ox + 46} ${cy} ${ox + 50} ${cy - 46} ${ox + 70} ${cy - 46} C${ox + 90} ${cy - 46} ${ox + 94} ${cy} ${ox + 120} ${cy} L${fork} ${cy}`;
const branch = (m) => `${pulse} C${fork + 30} ${cy} ${CX - 30} ${m} ${CX} ${m}`;
const cards = [
  ["P1", "p1", "Approve the Q4 rollout plan", "maya-vp · Needs your response"],
  ["FYI", "fyi", "Billing migration shipped", "release-bot · No action needed"],
  ["Latest", "latest", "Auth service redesign", "jordan-sec · Decision posted"],
];
function svg(t) {
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" font-family="${font}">`);
  out.push(`<title id="t">Signalbox</title><desc id="d">A jumble of noisy GitHub notifications flows into the Signalbox and comes out the other side as one clean signal line and three short, prioritized summaries.</desc>`);
  out.push(`<style>
.frag{animation:drift 6s cubic-bezier(.4,0,.6,1) infinite}
@keyframes drift{0%,100%{transform:translateX(0)}50%{transform:translateX(10px)}}
.w{opacity:0;animation:flick .45s steps(1) infinite}.w0{opacity:1}
@keyframes flick{0%{opacity:1}33%,100%{opacity:0}}
.sig{stroke-dasharray:420;animation:draw 6s cubic-bezier(.16,1,.3,1) infinite}
@keyframes draw{0%{stroke-dashoffset:420}30%,100%{stroke-dashoffset:0}}
.card{opacity:1;animation:rise 6s cubic-bezier(.16,1,.3,1) infinite}
@keyframes rise{0%,8%{opacity:0;transform:translateY(8px)}30%,92%{opacity:1;transform:none}100%{opacity:0}}
.led{animation:blink 1.2s steps(2,start) infinite}
@keyframes blink{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.anim,.w1,.w2{display:none}.w0{opacity:1}}
</style>`);
  out.push(`<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="16" fill="${t.panel}" stroke="${t.border}"/>`);
  // Noise side.
  s = 7; for (let i = 0; i < 3; i++) out.push(`<path class="w w${i}" style="animation-delay:-${(i * .15).toFixed(2)}s" d="${jag()}" fill="none" stroke="${t.noise}" stroke-width="1.5" stroke-linejoin="round"/>`);
  seeds.forEach(([x, y], i) => {
    const path = `M${x} ${y} C${x + 160} ${y} ${BX - 160} ${cy + (y - cy) * .25} ${BX + 6} ${cy}`;
    out.push(`<circle class="anim" r="3" fill="${t.accent}" opacity="0"><animateMotion dur="2.4s" begin="${(i * .3).toFixed(1)}s" repeatCount="indefinite" path="${path}" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".5 0 .9 .6"/><animate attributeName="opacity" values="0;.7;.7;0" keyTimes="0;.15;.85;1" dur="2.4s" begin="${(i * .3).toFixed(1)}s" repeatCount="indefinite"/></circle>`);
  });
  frags.forEach(([txt, x, y, r, size], i) => {
    const w = Math.round(txt.length * size * .56 + 18), h = size + 12;
    out.push(`<g class="frag" style="animation-delay:-${(i * .73).toFixed(2)}s"><g transform="translate(${x} ${y}) rotate(${r})">` +
      `<rect x="0" y="${-h + 6}" width="${w}" height="${h}" rx="6" fill="${t.card}" stroke="${t.border}" opacity=".9"/>` +
      `<text x="9" y="${-h / 2 + 6 + size * .35}" font-size="${size}" fill="${i % 3 ? t.faint : t.muted}">${txt}</text></g></g>`);
  });
  // The box.
  out.push(`<rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="20" fill="${t.box}"/>`);
  out.push(`<circle class="led" cx="${BX + 24}" cy="${BY + 24}" r="4" fill="${t.fyi}"/>`);
  out.push(`<text x="${BX + BW / 2}" y="${cy + 2}" text-anchor="middle" font-size="22" font-weight="700" letter-spacing="-.4" fill="${t.boxFg}">Signalbox</text>`);
  out.push(`<text x="${BX + BW / 2}" y="${cy + 26}" text-anchor="middle" font-size="11.5" fill="${t.boxMuted}">summarize · rank · sweep</text>`);
  // Signal side.
  mids.forEach((m) => out.push(`<path class="sig" d="${branch(m)}" fill="none" stroke="${t.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`));
  const cx0 = CX, cw = W - 40 - cx0;
  cards.forEach(([pill, key, title, meta], i) => {
    const pw = pill.length * 7.4 + 18;
    const yy = mids[i] - CH / 2;
    out.push(`<g class="card" style="animation-delay:${(.5 + i * .35).toFixed(2)}s;transform-box:fill-box">` +
      `<rect x="${cx0}" y="${yy}" width="${cw}" height="${CH}" rx="10" fill="${t.card}" stroke="${t.border}"/>` +
      `<rect x="${cx0 + 14}" y="${yy + 12}" width="${pw}" height="20" rx="10" fill="${t[key + "Soft"]}" stroke="${t[key]}" stroke-opacity=".5"/>` +
      `<text x="${cx0 + 14 + pw / 2}" y="${yy + 26}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${t[key]}">${pill}</text>` +
      `<text x="${cx0 + 24 + pw}" y="${yy + 27}" font-size="14" font-weight="600" fill="${t.fg}">${title}</text>` +
      `<text x="${cx0 + 14}" y="${yy + 48}" font-size="12" fill="${t.muted}">${meta}</text></g>`);
  });
  out.push(`</svg>`);
  return out.join("\n");
}
const dir = process.argv[2] || new URL("../docs", import.meta.url).pathname;
for (const [name, t] of Object.entries(themes)) writeFileSync(`${dir}/hero-${name}.svg`, svg(t));
