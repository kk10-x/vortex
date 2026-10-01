import Lenis from "lenis";
import { Api } from "./api.ts";
import { VortexScene, WORKER_COLORS } from "./scene.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const api = new Api();

// ---- 3D scene (optional: the page still works without WebGL) ---------------------------------
let scene: VortexScene | null = null;
try {
  scene = new VortexScene($("stage") as HTMLCanvasElement, reduced);
  api.on((e) => scene?.handle(e));
} catch {
  document.documentElement.classList.add("no-gl");
}

// ---- scroll: chapter index drives the camera --------------------------------------------------
const chapters = [...document.querySelectorAll<HTMLElement>("[data-chapter]")];
function onScroll() {
  scene?.setStop(scrollY / innerHeight);
}
if (!reduced) {
  const lenis = new Lenis({ lerp: 0.1 });
  const raf = (t: number) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  lenis.on("scroll", onScroll);
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ---- controls ---------------------------------------------------------------------------------
const rps = $<HTMLInputElement>("rps");
const rate = $<HTMLInputElement>("rate");
rps.addEventListener("input", () => {
  $("rps-out").textContent = rps.value;
  api.setConfig({ rps: Number(rps.value) });
});
rate.addEventListener("input", () => {
  $("rate-out").textContent = rate.value;
  api.setConfig({ rateLimit: { rate: Number(rate.value), burst: Number(rate.value) * 1.5 } });
});
document.querySelectorAll<HTMLButtonElement>("[data-kill]").forEach((b) =>
  b.addEventListener("click", () => api.kill(Number(b.dataset.kill))),
);
$("revive").addEventListener("click", () => [1, 2, 3].forEach((id) => api.revive(id)));
$("burst").addEventListener("click", () => api.burst(200));

// Scrolling into a chapter sets the gateway's behaviour for that chapter.
const onChapter: Record<number, () => void> = {
  0: () => api.setConfig({ rps: 6, strategy: "round-robin", rateLimit: { rate: 40, burst: 60 } }),
  1: () => api.setConfig({ rps: Number(rps.value), strategy: "round-robin", rateLimit: { rate: 40, burst: 60 } }),
  2: () => api.setConfig({ rps: Math.max(Number(rps.value), 10), strategy: "hash" }),
  3: () => api.setConfig({ rps: Math.max(Number(rps.value), 14), strategy: "hash" }),
  4: () =>
    api.setConfig({
      rps: 18,
      strategy: "round-robin",
      rateLimit: { rate: Number(rate.value), burst: Number(rate.value) * 1.5 },
    }),
};
let current = -1;
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const i = Number((en.target as HTMLElement).dataset.chapter);
      if (i === current) continue;
      current = i;
      onChapter[i]?.();
    }
  },
  { threshold: 0.55 },
);
chapters.forEach((c) => io.observe(c));

// ---- ledger -----------------------------------------------------------------------------------
const workersEl = $("l-workers");
workersEl.innerHTML = [1, 2, 3]
  .map((id) => `<li id="lw-${id}" style="--c:#${WORKER_COLORS[id - 1]!.getHexString()}"><span>w${id}</span><span class="n">0</span></li>`)
  .join("");
const fmt = (n: number) => n.toLocaleString("en-US");
setInterval(() => {
  const v = api.view;
  const mode = $("mode");
  mode.dataset.mode = v.mode;
  mode.textContent = v.mode === "simulated" ? "simulated · no backend" : v.mode === "live" ? "live" : "connecting";
  $("l-sent").textContent = fmt(v.sent);
  $("l-limited").textContent = fmt(v.limited);
  $("l-retried").textContent = fmt(v.rerouted);
  $("l-failed").textContent = fmt(v.failed);
  for (const w of v.workers) {
    const li = $(`lw-${w.id}`);
    li.classList.toggle("down", !w.healthy);
    li.querySelector(".n")!.textContent = w.healthy ? fmt(w.served) : "down";
  }
}, 150);

api.connect().then(() => onChapter[Math.max(current, 0)]?.());
